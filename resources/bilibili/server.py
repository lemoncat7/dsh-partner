"""Private Bilibili bridge. No MCP dependency, arbitrary URL fetch or credential export."""
import asyncio, base64, hashlib, hmac, json, os, re, sqlite3, time
from pathlib import Path
from aiohttp import web, ClientSession, ClientTimeout
from bilibili_api import video, search, comment, Credential, dynamic, hot, user, session, favorite_list
from bilibili_api.login_v2 import QrCodeLoginEvents
from io import BytesIO
from urllib.parse import urlparse, parse_qs
import qrcode

ROOT = Path(os.environ.get('BILI_DATA', '/state'))
ROOT.mkdir(parents=True, exist_ok=True)
TOKEN = Path(os.environ.get('BILI_TOKEN_FILE', '/run/bridge-token')).read_text().strip()
PUBLIC = {'search','hot','video','comments','subtitle','user_videos','user_dynamics','share_link','video_stream'}
READ = PUBLIC | {'favorite_lists','favorite_content','replies','mentions','unread','upload_status','upload_categories','upload_health'}
WRITE = {'like','favorite','follow','comment','dynamic','share_dynamic','repost','upload_draft','publish_video','image_dynamic'}
ACCOUNT = {'status','login','login_check','logout'}
LOGINS = {}
LOGIN_TASKS = {}
LOGIN_RESULTS = {}
LOCKS = {}
LAST = {}
DB = sqlite3.connect(ROOT / 'receipts.sqlite')
DB.execute('CREATE TABLE IF NOT EXISTS receipts(channel TEXT, id TEXT, at REAL, status TEXT, result TEXT, PRIMARY KEY(channel,id))')
DB.commit()
os.chmod(ROOT / 'receipts.sqlite', 0o600)

def credential(channel):
    path = ROOT / (channel + '.json')
    return Credential(**json.loads(path.read_text())) if path.exists() else Credential()

def save_credential(channel, cred):
    fields = ['sessdata','bili_jct','buvid3','dedeuserid','ac_time_value']
    data = {k:getattr(cred,k,None) for k in fields if getattr(cred,k,None)}
    path = ROOT / (channel + '.json'); tmp = path.with_suffix('.tmp')
    fd = os.open(tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(data,f); f.flush(); os.fsync(f.fileno())
    os.replace(tmp,path)

def bounded(value, depth=0):
    if depth > 8: return None
    if isinstance(value,int) and abs(value)>9007199254740991:return str(value)
    if isinstance(value,str):return value[:6000]
    if isinstance(value,list):return [bounded(v,depth+1) for v in value[:30]]
    if isinstance(value,dict):return {k:bounded(v,depth+1) for k,v in list(value.items())[:50] if not re.search(r'cookie|token|sessdata|bili_jct|buvid|password|secret',k,re.I)}
    return value

def videos(items):
    return [{k:x.get(k) for k in ['bvid','aid','title','author','owner','description','desc','duration','stat']} for x in items[:20]]

def login_credential(data, cookies):
    # Current web login issues credentials in Set-Cookie, not necessarily the redirect URL.
    query = parse_qs(urlparse(data.get('url','')).query)
    values = {k.lower():v[-1] for k,v in query.items() if v}
    values.update({k.lower():v.value for k,v in cookies.items()})
    return Credential(sessdata=values.get('sessdata'),bili_jct=values.get('bili_jct'),
                      dedeuserid=values.get('dedeuserid'),ac_time_value=data.get('refresh_token'))

class QrCodeLogin:
    async def generate_qrcode(self):
        async with ClientSession(timeout=ClientTimeout(total=15), headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36','Referer':'https://www.bilibili.com/'}) as client:
            async with client.get('https://passport.bilibili.com/x/passport-login/web/qrcode/generate',params={'source':'main-fe-header'}) as response:
                response.raise_for_status(); payload=await response.json()
        if payload.get('code') != 0: raise ValueError('B 站暂时无法生成二维码')
        data=payload['data']; self.key=data['qrcode_key']
        image=BytesIO(); qrcode.make(data['url']).save(image,format='PNG'); self.image=image.getvalue()
    def get_qrcode_picture(self):
        return type('Picture',(),{'content':self.image})()
    async def check_state(self):
        async with ClientSession(timeout=ClientTimeout(total=15), headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36','Referer':'https://www.bilibili.com/'}) as client:
            async with client.get('https://passport.bilibili.com/x/passport-login/web/qrcode/poll',params={'qrcode_key':self.key,'source':'main-fe-header'},allow_redirects=False) as response:
                response.raise_for_status(); payload=await response.json(); cookies=response.cookies
        if payload.get('code') != 0: raise ValueError('B 站扫码状态查询失败')
        data=payload['data']; code=data.get('code')
        if code == 86101: return QrCodeLoginEvents.SCAN
        if code == 86090: return QrCodeLoginEvents.CONF
        if code == 86038: return QrCodeLoginEvents.TIMEOUT
        if code != 0: raise ValueError('B 站扫码尚未完成')
        self.cred=login_credential(data,cookies)
        if not self.cred.sessdata or not self.cred.bili_jct:
            raise ValueError('扫码响应缺少登录凭证，请重新扫码')
        return QrCodeLoginEvents.DONE
    def get_credential(self):
        return self.cred

async def identity(cred):
    result = {'logged_in':True,'uid':str(cred.dedeuserid)}
    try:
        info = await asyncio.wait_for(user.get_self_info(credential=cred),8)
        result['name'] = str(info.get('name',''))[:100]
        face = str(info.get('face',''))
        from urllib.parse import urlparse
        if urlparse(face).scheme == 'https' and (urlparse(face).hostname or '').endswith('.hdslb.com'):
            result['avatar'] = face
    except Exception:
        pass  # Profile failure must not erase a valid login.
    return result

async def monitor_login(channel, qr):
    try:
        for _ in range(60):
            await asyncio.sleep(3)
            state = await qr.check_state()
            if state == QrCodeLoginEvents.DONE:
                cred = qr.get_credential()
                if not cred.sessdata or not cred.bili_jct or not await cred.check_valid():
                    raise ValueError('扫码凭证未通过登录验证')
                if not cred.dedeuserid:
                    info = await user.get_self_info(credential=cred)
                    cred.dedeuserid = str(info['mid'])
                save_credential(channel,cred)
                LOGIN_RESULTS[channel] = {'status':'done', **await identity(cred)}
                return
            if state == QrCodeLoginEvents.TIMEOUT:
                break
            LOGIN_RESULTS[channel] = {'status':'scanned' if state == QrCodeLoginEvents.CONF else 'waiting'}
        LOGIN_RESULTS[channel] = {'status':'expired'}
    except asyncio.CancelledError:
        raise
    except Exception:
        LOGIN_RESULTS[channel] = {'status':'error'}
    finally:
        if LOGINS.get(channel, (None,None))[1] is qr:
            LOGINS.pop(channel,None)

async def account(channel, op):
    cred = credential(channel)
    if op == 'logout':
        await MEDIA.cancel(channel)
        task=LOGIN_TASKS.pop(channel,None)
        if task:
            task.cancel()
            await asyncio.gather(task,return_exceptions=True)
        (ROOT/(channel+'.json')).unlink(missing_ok=True); LOGINS.pop(channel,None); LOGIN_RESULTS.pop(channel,None)
        return {'logged_in':False}
    if op == 'status':
        valid = bool(cred.sessdata) and await cred.check_valid()
        return await identity(cred) if valid else {'logged_in':False,'uid':None}
    if op == 'login':
        old=LOGIN_TASKS.pop(channel,None)
        if old:
            old.cancel()
            await asyncio.gather(old,return_exceptions=True)
        qr=QrCodeLogin(); await qr.generate_qrcode(); LOGINS[channel]=(time.time(),qr)
        LOGIN_RESULTS[channel]={'status':'waiting'}
        LOGIN_TASKS[channel]=asyncio.create_task(monitor_login(channel,qr))
        return {'status':'qrcode','image':'data:image/png;base64,'+base64.b64encode(qr.get_qrcode_picture().content).decode(),'expiresIn':180}
    return LOGIN_RESULTS.get(channel,{'status':'expired'})

from media import Media, media_url, HEADERS
MEDIA = Media(ROOT, credential)

async def execute(channel, op, p):
    cred=credential(channel)
    if op not in PUBLIC and (not cred.sessdata or not await cred.check_valid()):
        raise ValueError('B 站登录已失效，请重新扫码；公开浏览仍可使用')
    if op=='video_stream':
        v=video.Video(bvid=p['bvid'],credential=cred)
        info=await v.get_download_url(page_index=p.get('page',1)-1,html5=True)
        def link(stream):
            urls=[stream.get('baseUrl') or stream.get('base_url') or stream.get('url'),*(stream.get('backupUrl') or stream.get('backup_url') or [])]
            for url in urls:
                if not url:continue
                try:return media_url(url)
                except ValueError:pass
            raise ValueError('暂未获得可用的视频播放直链')
        parts=info.get('durl') or []
        result={'bvid':p['bvid'],'page':p.get('page',1),'headers':HEADERS,'downloaded':False,'interpreted':False,'temporary':True,'message':'仅返回临时播放链接，未下载、合并或分析。模型自行决定是否读取与处理；链接失效请重新获取。'}
        if parts:
            result.update(mode='progressive',segments=[{'url':link(x),'durationMs':x.get('length')} for x in parts])
        else:
            dash=info.get('dash') or {}
            if not dash.get('video'):raise ValueError('该视频暂无可用播放流')
            stream=min(dash['video'],key=lambda x:(not str(x.get('codecs','')).startswith('avc'),x.get('bandwidth',10**9)))
            result.update(mode='dash',video={'url':link(stream),'codec':stream.get('codecs'),'width':stream.get('width'),'height':stream.get('height')})
            if dash.get('audio'):
                audio=min(dash['audio'],key=lambda x:x.get('bandwidth',10**9));result['audio']={'url':link(audio),'codec':audio.get('codecs')}
        return result
    if op in ('upload_draft','image_dynamic'):return await MEDIA.start(channel,op,p)
    if op=='upload_health':return {'cooldown':MEDIA.cooldown(channel),'instruction':'有冷却记录时不要重试。无记录仅表示本地未拦截，不代表平台放行。'}
    if op=='upload_status':
        _,job=MEDIA.load(channel,p['job_id'])
        return MEDIA.public(job)
    if op=='publish_video':return await MEDIA.publish(channel,p)
    if op=='upload_categories':
        from bilibili_api.utils.network import Api
        r=await Api(url='https://member.bilibili.com/x/vupre/web/archive/pre',method='GET',verify=True,credential=cred).update_params(lang='cn').result
        return {'types':r.get('typelist',r.get('types',[]))}
    page=p.get('page',1)
    if op=='search':
        r=await search.search_by_type(keyword=p['keyword'],search_type=search.SearchObjectType.VIDEO,page=page)
        return {'videos':videos(r.get('result',[]))}
    if op=='hot':return {'videos':videos((await hot.get_hot_videos(pn=page,ps=20)).get('list',[]))}
    if op in {'user_videos','user_dynamics','follow'}:
        u=user.User(int(p['uid']),credential=cred)
        if op=='user_videos':return await u.get_videos(pn=page,ps=20)
        if op=='user_dynamics':return await u.get_dynamics_new(offset=p.get('offset',''))
        return await u.modify_relation(user.RelationType.SUBSCRIBE if p['follow'] else user.RelationType.UNSUBSCRIBE)
    if op=='favorite_lists':return await favorite_list.get_video_favorite_list(int(cred.dedeuserid),credential=cred)
    if op=='favorite_content':return await favorite_list.FavoriteList(media_id=int(p['media_id']),credential=cred).get_content(page=page)
    if op=='replies':return await session.get_replies(credential=cred)
    if op=='mentions':return await session.get_at(credential=cred)
    if op=='unread':return await session.get_unread_messages(credential=cred)
    if op=='repost':return await dynamic.Dynamic(int(p['dynamic_id']),credential=cred).repost(p['text'])
    if op in {'dynamic','share_dynamic'}:
        content=p['text']
        if op=='share_dynamic':content+='\nhttps://www.bilibili.com/video/'+p['bvid']
        return await dynamic.send_dynamic(info=dynamic.BuildDynamic.empty().add_plain_text(content),credential=cred)
    v=video.Video(bvid=p['bvid'],credential=cred)
    if op=='share_link':return {'url':'https://www.bilibili.com/video/'+p['bvid'],'published':False,'instruction':'仅生成链接，尚未发送给任何人；使用已授权聊天渠道分享。'}
    if op=='video':return await v.get_info()
    if op=='like':return await v.like(p['status'])
    if op=='favorite':return await v.set_favorite(add_media_ids=[int(p['media_id'])] if p['add'] else [],del_media_ids=[] if p['add'] else [int(p['media_id'])])
    if op=='comments':return await comment.get_comments(oid=v.get_aid(),type_=comment.CommentResourceType.VIDEO,page_index=page,credential=cred)
    if op=='comment':return await comment.send_comment(text=p['text'],oid=v.get_aid(),type_=comment.CommentResourceType.VIDEO,root=int(p['root']) if p.get('root') else None,parent=int(p['parent']) if p.get('parent') else None,credential=cred)
    if op=='subtitle':
        cid=await v.get_cid(page_index=0)
        subtitles=(await v.get_subtitle(cid=cid) or {}).get('subtitles',[])
        if not subtitles:return {'available':False,'message':'没有可用字幕，不能据此声称看过视频。'}
        item=next((s for s in subtitles if s.get('lan') in ['ai-zh','zh-CN','zh']),subtitles[0])
        url=item['subtitle_url'];url='https:'+url if url.startswith('//') else url
        from urllib.parse import urlparse
        parsed=urlparse(url)
        if parsed.scheme!='https' or not (parsed.hostname or '').endswith('.hdslb.com'):raise ValueError('字幕来源不受支持')
        async with ClientSession(timeout=ClientTimeout(total=15), headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36','Referer':'https://www.bilibili.com/'}) as client:
            async with client.get(url,allow_redirects=False) as response:
                if response.status!=200:raise ValueError('字幕暂不可用')
                chunks=[];size=0
                async for chunk in response.content.iter_chunked(65536):
                    size+=len(chunk)
                    if size>1024*1024:raise ValueError('字幕过大')
                    chunks.append(chunk)
                content=json.loads(b''.join(chunks))
        return {'available':True,'language':item.get('lan'),'text':'\n'.join(s.get('content','') for s in content.get('body',[]))[:12000]}
    raise ValueError('未实现的操作')

@web.middleware
async def authentication(request,handler):
    if not hmac.compare_digest(request.headers.get('Authorization',''),'Bearer '+TOKEN):return web.json_response({'error':'Unauthorized'},status=401)
    return await handler(request)

async def call(request):
    try:
        body=await request.json(); channel=body['channelId']; op=body['operation'];p=body.get('params',{})
        if not re.fullmatch(r'bilibili-[a-zA-Z0-9-]{1,80}',channel) or op not in READ|WRITE|ACCOUNT or not isinstance(p,dict):raise ValueError('请求无效')
        if len(LOCKS)>500 and channel not in LOCKS:raise ValueError('账号数量超限')
        async with LOCKS.setdefault(channel,asyncio.Lock()):
            if op in ACCOUNT:return web.json_response(await asyncio.wait_for(account(channel,op),30))
            if time.time()-LAST.get(channel,0)<2:raise ValueError('请求过快，请稍后再试')
            LAST[channel]=time.time()
            if op not in PUBLIC:
                cred=credential(channel)
                if not cred.sessdata or not await cred.check_valid():
                    return web.json_response({'error':'B 站登录已失效，请重新扫码；公开浏览仍可使用','code':'LOGIN_REQUIRED','notSubmitted':True},status=401)
            rid=body.get('requestId')
            if op in WRITE:
                if not isinstance(rid,str) or not re.fullmatch('[a-f0-9]{64}',rid):raise ValueError('缺少操作幂等标识')
                row=DB.execute('SELECT at,status,result FROM receipts WHERE channel=? AND id=?',(channel,rid)).fetchone()
                if row and time.time()-row[0]<86400:
                    replay=json.loads(row[2]) if row[1]=='confirmed' else None
                    safe_retry=row[1]=='failed'
                    if replay and op in ('upload_draft','image_dynamic'):
                        job=replay.get('result',{}).get('id')
                        if job:
                            try:
                                old=MEDIA.load(channel,job)[1];safe_retry=old['status'] in ('failed','interrupted') and old.get('published') is False
                            except ValueError:pass
                    if not safe_retry:
                        if replay:return web.json_response(replay)
                        raise ValueError('该操作结果尚未确认，请勿重复提交')
                DB.execute('INSERT OR REPLACE INTO receipts VALUES(?,?,?,?,?)',(channel,rid,time.time(),'pending',''));DB.commit()
            try:result=bounded(await asyncio.wait_for(execute(channel,op,p),35))
            except ValueError as e:
                if op in ('upload_draft','image_dynamic'):
                    DB.execute('UPDATE receipts SET status=? WHERE channel=? AND id=?',('failed',channel,rid));DB.commit()
                    return web.json_response({'error':str(e)[:250],'notSubmitted':True},status=400)
                raise
            result={'result':result}
            if op in WRITE:
                DB.execute('UPDATE receipts SET status=?,result=? WHERE channel=? AND id=?',('confirmed',json.dumps(result),channel,rid));DB.commit()
                DB.execute('DELETE FROM receipts WHERE at<?',(time.time()-7*86400,));DB.commit()
            return web.json_response(result)
    except asyncio.TimeoutError:return web.json_response({'error':'B 站请求超时；若为发布操作请先核实结果，勿重复发送'},status=504)
    except Exception as e:
        # Do not expose transport headers, cookies, or traceback to the model.
        message=str(e) if isinstance(e,ValueError) else 'B 站接口暂不可用（'+type(e).__name__+'），请稍后检查登录或连接'
        return web.json_response({'error':message[:250]},status=400)

app=web.Application(middlewares=[authentication],client_max_size=32768)
app.router.add_post('/call',call)
async def media_endpoint(request):
    try:
        return await MEDIA.stage(request)
    except ValueError as e:return web.json_response({'error':str(e)[:250]},status=400)
    except Exception:return web.json_response({'error':'媒体传输失败'},status=500)
app.router.add_post('/stage/{channel}',media_endpoint)
app.router.add_post('/stage-images/{channel}',media_endpoint)
app.on_cleanup.append(MEDIA.close)
if __name__=='__main__':web.run_app(app,host='0.0.0.0',port=8091,access_log=None)
