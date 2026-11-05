"""Staged video submission. Playback APIs only return links; no downloads."""
import asyncio, json, os, re, shutil, time, uuid
from pathlib import Path
from urllib.parse import urlparse
from aiohttp import ClientSession, ClientTimeout, ClientError, web
from bilibili_api import video, video_uploader, dynamic
from bilibili_api.utils.picture import Picture
from bilibili_api.utils.network import Api, get_client, BiliAPIFile

HEADERS={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36','Referer':'https://www.bilibili.com/'}
MAX_FILE=512*1024*1024
try:
    from imageio_ffmpeg import get_ffmpeg_exe
    FFMPEG=get_ffmpeg_exe()
except ImportError:
    FFMPEG='ffmpeg'

def media_url(url):
    p=urlparse(url)
    if p.scheme!='https' or p.username or p.password or p.port not in (None,443) or not any((p.hostname or '').endswith('.'+h) for h in ('bilivideo.com','bilivideo.cn','hdslb.com')):
        raise ValueError('视频来源不受支持')
    return url

class LocalPicture(Picture):
    def __init__(self,path):
        from PIL import Image
        self.path=str(path)
        with Image.open(path) as im:
            if im.format not in ('PNG','JPEG','WEBP') or im.width*im.height>25000000:raise ValueError('图片格式或尺寸无效')
            self.width,self.height=im.size;self.imageType={'PNG':'png','JPEG':'jpg','WEBP':'webp'}[im.format];self.mime=im.get_format_mimetype();im.verify()
        self.content=Path(path).read_bytes();self.size=len(self.content)//1024;self.url='file://'+str(path)
    def _to_biliapifile(self):
        return BiliAPIFile(path=self.path,mime_type=self.mime)

class UploadRejected(ValueError):
    def __init__(self, phase, status, payload=None):
        payload=payload if isinstance(payload,dict) else {}
        code=payload.get('code');code=code if isinstance(code,int) else None
        limited=code==601 or status==429
        self.details={'phase':phase,'httpStatus':status,'code':code,'rateLimited':limited}
        # Fixed descriptions prevent secrets or attacker-controlled upstream text leaking.
        message='平台提示上传过快，请稍作休息后再继续' if limited else '平台拒绝上传请求，请核实登录状态和创作中心提示'
        super().__init__(f'{phase}失败：HTTP {status}'+(f'，业务码 {code}' if code is not None else '')+'；'+message)

def checked_response(response,phase):
    try:data=response.json()
    except Exception:data={}
    if response.code>=400 or data.get('OK')==0 or isinstance(data.get('code'),int) and data['code']!=0:
        raise UploadRejected(phase,response.code,data)
    return data

class UploadOnly(video_uploader.VideoUploader):
    async def _preupload(self,page):
        # SDK 17.4.2 discards the body on HTTP errors. Keep bounded diagnostic fields.
        client=get_client()
        resp=await client.request(method='GET',url='https://member.bilibili.com/preupload',
            params={'profile':'ugcfx/bup','name':os.path.basename(page.path),'size':page.get_size(),'r':self.line['os'],'ssl':'0','version':'2.14.0','build':'2100400','upcdn':self.line['upcdn'],'probe_version':self.line['probe_version']},
            cookies=await self.credential.get_buvid_cookies(),headers=HEADERS)
        data=checked_response(resp,'预上传')
        if data.get('OK')!=1 or not all(k in data for k in ('auth','endpoint','upos_uri','chunk_size','biz_id')):raise ValueError('预上传返回缺少上传配置，未上传素材')
        data=self._switch_upload_endpoint(data,self.line)
        url=media_url(self._get_upload_url(data))
        resp=await client.request(method='POST',url=url,headers={**HEADERS,'x-upos-auth':data['auth']},params={'uploads':'','output':'json','profile':'ugcfx/bup','filesize':page.get_size(),'partsize':data['chunk_size'],'biz_id':data['biz_id']})
        result=checked_response(resp,'初始化分片')
        if result.get('OK')!=1 or not result.get('upload_id'):raise ValueError('分片初始化未返回任务编号')
        data['upload_id']=result['upload_id'];return data
    async def _submit(self, videos, cover_url=''):
        return {'videos':videos,'cover':cover_url}

class Media:
    def __init__(self, root, credential):
        self.root=root/'media';self.root.mkdir(exist_ok=True);self.credential=credential
        self.tasks={};self.limit=asyncio.Semaphore(2)
        for path in self.root.glob('*/*/job.json'):
            try:
                j=json.loads(path.read_text())
                if j['status'] in ('queued','running','submitting'):
                    j.update(status='unknown' if j['status']=='submitting' else 'interrupted',message='服务重启，任务未自动重试；若已提交投稿请在创作中心核实');self.save(path.parent,j)
            except (ValueError,KeyError,OSError):pass
    def directory(self,channel,jid):
        if not re.fullmatch(r'bilibili-[A-Za-z0-9-]{1,80}',channel) or not re.fullmatch(r'[a-f0-9]{32}',jid):raise ValueError('媒体任务 ID 无效')
        return self.root/channel/jid
    def save(self,d,j):
        d.mkdir(parents=True,exist_ok=True);p=d/'job.tmp';p.write_text(json.dumps(j));os.chmod(p,0o600);os.replace(p,d/'job.json')
    def load(self,channel,jid):
        d=self.directory(channel,jid)
        if not (d/'job.json').exists():raise ValueError('媒体任务不存在或不属于本渠道')
        return d,json.loads((d/'job.json').read_text())
    def cleanup(self):
        for p in self.root.glob('*/*/job.json'):
            if time.time()-p.stat().st_mtime>7*86400 and p.parent.name not in self.tasks:shutil.rmtree(p.parent,ignore_errors=True)
        size=sum(p.stat().st_size for p in self.root.glob('*/*/*') if p.is_file())
        if size>2*1024**3:raise ValueError('视频暂存空间已满，请清理旧任务后重试')
    def public(self,j):
        return {k:j[k] for k in ('id','operation','status','createdAt','title','message','bvid','page','size','mimeType','published','result','uid','phase','error','retryAt','dynamic_id') if k in j}
    def cooldown(self,channel):
        # Channel validation also prevents arbitrary filesystem reads.
        self.directory(channel,'0'*32)
        p=self.root/channel/'cooldown.json'
        if p.exists():
            data=json.loads(p.read_text())
            if data.get('retryAt',0)>time.time():return data
        return {}
    def record_failure(self,channel,j,e):
        details=getattr(e,'details',None)
        j.update(status='failed',published=False,message=str(e)[:250] if isinstance(e,ValueError) else '媒体操作失败（'+type(e).__name__+'）',phase=j.get('phase','上传素材'))
        if details:
            j['error']=details;j['phase']=details['phase']
            if details.get('rateLimited'):
                j['retryAt']=time.time()+900
                p=self.root/channel/'cooldown.json';tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps({'retryAt':j['retryAt'],'reason':'平台上传限流；十五分钟为本地保护间隔，不保证届时平台已解除限制'}));os.chmod(tmp,0o600);os.replace(tmp,p)
    async def stage(self,request):
        channel=request.match_info['channel'];jid=uuid.uuid4().hex;d=self.directory(channel,jid);self.cleanup()
        d.mkdir(parents=True,exist_ok=True)
        total=0;names=set();images=request.path.startswith('/stage-images/')
        try:
            reader=await request.multipart()
            while (field:=await reader.next()) is not None:
                if (not re.fullmatch(r'image[0-8]',field.name or '') if images else field.name not in ('video','cover')) or field.name in names:raise ValueError('只接受按顺序编号的1–9张图片' if images else '只接受一个视频和一个封面')
                names.add(field.name);size=0
                with (d/field.name).open('wb') as out:
                    while chunk:=await field.read_chunk(65536):
                        size+=len(chunk);total+=len(chunk)
                        if size>(MAX_FILE if field.name=='video' else 8*1024**2):raise ValueError('每张图片上限 8 MB' if images else '视频上限 512 MB，封面上限 8 MB')
                        out.write(chunk)
                if not size:raise ValueError('媒体文件为空')
            if images:
                if not names or names!={f'image{i}' for i in range(len(names))}:raise ValueError('漫画图片须为连续的 1–9 张')
                from PIL import Image
                for name in names:
                    with Image.open(d/name) as im:
                        if im.format not in ('PNG','JPEG','WEBP') or im.width*im.height>25000000:raise ValueError('漫画图片须为 PNG/JPEG/WebP，最多2500万像素')
                        im.verify()
            elif names!={'video','cover'}:raise ValueError('投稿需要视频与封面文件')
            j={'id':jid,'operation':'stage','status':'staged','createdAt':time.time(),'size':total,'imageCount':len(names) if images else 0};self.save(d,j)
            return web.json_response({'stageId':jid})
        except BaseException:
            shutil.rmtree(d,ignore_errors=True);raise
    async def probe(self,path):
        proc=await asyncio.create_subprocess_exec(FFMPEG,'-nostdin','-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,avi,flv','-i',str(path),'-map','0:v:0','-frames:v','1','-f','null','-',stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL)
        try:await asyncio.wait_for(proc.wait(),20)
        except BaseException:proc.kill();await proc.wait();raise
        if proc.returncode:raise ValueError('文件不是可读取的视频')
    async def start(self,channel,op,p):
        if op not in ('upload_draft','image_dynamic'):raise ValueError('不支持的上传操作')
        cooling=self.cooldown(channel) if op=='upload_draft' else {}
        if cooling:raise ValueError('B站上传限流冷却中，请勿立即重试；可用 upload_health 查询建议重试时间')
        self.cleanup()
        if any(x[0]==channel and not x[1].done() for x in self.tasks.values()):raise ValueError('本渠道已有媒体任务，请等待完成')
        jid=p.get('stageId')
        d=self.directory(channel,jid)
        cred=self.credential(channel)
        _,old=self.load(channel,jid)
        if old['status']!='staged':raise ValueError('素材已使用，请查询原任务')
        if op=='image_dynamic' and (not 1<=old.get('imageCount',0)<=9 or len(p.get('text',''))>2000):raise ValueError('漫画图片暂存无效或文字过长')
        if op=='upload_draft':
            _,old=self.load(channel,jid)
            if old['status']!='staged':raise ValueError('素材已使用，请查询原任务')
            await self.probe(d/'video')
            from PIL import Image
            with Image.open(d/'cover') as im:
                if im.format not in ('PNG','JPEG','WEBP') or im.width*im.height>25000000:raise ValueError('封面需为 PNG/JPEG/WebP 图片，最多 2500 万像素')
            if not str(p.get('title','')).strip() or not p.get('tags') or not isinstance(p.get('tid'),int):raise ValueError('缺少标题、标签或分区')
            if p.get('copyright')==2 and not p.get('source'):raise ValueError('转载投稿需要来源')
        j={'id':jid,'operation':op,'status':'queued','createdAt':time.time(),'published':False}
        j.update(uid=str(cred.dedeuserid))
        if op=='upload_draft':j.update(title=p['title'])
        else:j.update(imageCount=old['imageCount'])
        self.save(d,j)
        task=asyncio.create_task(self.run(channel,d,j,p,cred) if op=='upload_draft' else self.run_images(channel,d,j,p,cred));self.tasks[jid]=(channel,task)
        task.add_done_callback(lambda _:self.tasks.pop(jid,None))
        return self.public(j)
    async def run(self,channel,d,j,p,cred):
        try:
            async with self.limit:
                j['status']='running';j['phase']='上传素材';self.save(d,j)
                if not await cred.check_valid():raise ValueError('上传前登录失效，请重新登录')
                meta={'title':p['title'],'desc':p.get('description',''),'tid':p['tid'],'tag':','.join(p['tags']),'copyright':p.get('copyright',1),'source':p.get('source',''),'no_reprint':1,'desc_format_id':0}
                uploader=UploadOnly([video_uploader.VideoUploaderPage(str(d/'video'),p['title'])],meta,cred,cover=LocalPicture(d/'cover'))
                uploaded=await asyncio.wait_for(uploader.start(),1800)
                if not uploaded or not uploaded.get('videos'):raise ValueError('素材上传未完成')
                j.update(status='draft',meta=meta,uploaded=uploaded,message='素材已上传，待投稿草稿保存在伙伴服务中；尚未提交 B 站审核，不是创作中心云草稿。')
        except asyncio.CancelledError:
            j.update(status='interrupted',message='任务已中断，未自动重试或投稿');raise
        except Exception as e:
            self.record_failure(channel,j,e)
        finally:
            for name in ('video','cover'):(d/name).unlink(missing_ok=True)
            self.save(d,j)
    async def run_images(self,channel,d,j,p,cred):
        submitting=False
        try:
            async with self.limit:
                j.update(status='running',phase='上传漫画图片');self.save(d,j)
                if not await cred.check_valid():raise ValueError('登录失效，请重新扫码')
                pics=[]
                for index in range(j['imageCount']):
                    picture=LocalPicture(d/f'image{index}')
                    uploaded=await asyncio.wait_for(dynamic.upload_image(picture,cred),90)
                    image_url=uploaded.get('image_url','')
                    if image_url.startswith('http://'):image_url='https://'+image_url[7:]
                    media_url(image_url)
                    pics.append({'img_src':image_url,'img_width':picture.width,'img_height':picture.height})
                # Same request shape as bilibili-api send_dynamic; upload first so a
                # failure before this boundary is known not to have published anything.
                info=dynamic.BuildDynamic.empty().add_plain_text(p.get('text',''))
                data={'dyn_req':{'content':{'contents':await info.get_contents(credential=cred)},'scene':2,'meta':{'app_meta':{'from':'create.dynamic.web','mobi_app':'web'}},'pics':pics,'attach_card':None}}
                if str(self.credential(channel).dedeuserid)!=str(cred.dedeuserid):raise ValueError('登录账号已变化，图片动态未发布')
                j.update(status='submitting',phase='发布图片动态');self.save(d,j);submitting=True
                result=await asyncio.wait_for(Api(**dynamic.API['send']['instant'],credential=cred,json_body=True).update_data(**data).update_params(csrf=cred.bili_jct).result,35)
                did=str(result.get('dyn_id_str') or result.get('dynamic_id_str') or result.get('dynamic_id') or '')
                if not did.isdigit() or int(did)<=0:raise ValueError('动态返回缺少编号，请核实账号动态，不要重复发布')
                j.update(status='submitted',published=True,dynamic_id=did,result={'dynamic_id':did,'url':'https://t.bilibili.com/'+did},message='图片动态已提交，实际可见状态以B站为准')
        except BaseException as e:
            if submitting:j.update(status='unknown',message='图片动态提交结果不明，请查看账号动态，禁止自动重发')
            elif isinstance(e,asyncio.CancelledError):j.update(status='interrupted',message='图片上传已中断，尚未发布')
            else:self.record_failure(channel,j,e)
            if isinstance(e,asyncio.CancelledError):raise
        finally:
            for file in d.glob('image[0-8]'):file.unlink(missing_ok=True)
            self.save(d,j)

    async def publish(self,channel,p):
        d,j=self.load(channel,p['draft_id']);cred=self.credential(channel)
        if j.get('uid')!=str(cred.dedeuserid):raise ValueError('草稿不属于当前登录账号')
        if j['status']!='draft':raise ValueError('草稿未就绪或已提交，请查询原任务，不重复投稿')
        if time.time()-j['createdAt']>7*86400:raise ValueError('草稿已过期，请重新上传')
        j['status']='submitting';self.save(d,j)
        try:
            meta={**j['meta'],**j['uploaded'],'csrf':cred.bili_jct}
            r=await Api(url='https://member.bilibili.com/x/vu/web/add/v3',method='POST',verify=True,credential=cred,no_csrf=True,json_body=True).update_params(csrf=cred.bili_jct,t=time.time()*1000).update_data(**meta).result
            if not r or not r.get('bvid'):raise ValueError('投稿返回缺少 BV 号，请在创作中心核实')
            j.update(status='submitted',published=True,result={'bvid':r['bvid'],'aid':str(r.get('aid',''))},message='投稿已提交，实际公开状态以 B 站审核为准')
        except BaseException:
            j.update(status='unknown',message='投稿结果不明，请在创作中心核实，不自动重发');raise
        finally:self.save(d,j)
        return self.public(j)
    async def cancel(self,channel):
        tasks=[t for owner,t in self.tasks.values() if owner==channel]
        for t in tasks:t.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
    async def close(self,app):
        tasks=[t for _,t in self.tasks.values()]
        for t in tasks:t.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
