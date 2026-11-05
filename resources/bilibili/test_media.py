import asyncio,json,tempfile,unittest,sys,subprocess
from pathlib import Path
from unittest.mock import AsyncMock,patch
sys.path.insert(0,str(Path(__file__).parent))
from media import Media,UploadOnly,media_url

class MediaTest(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
  self.cred=type('Cred',(),{'dedeuserid':'123','bili_jct':'fixture','check_valid':AsyncMock(return_value=True)})()
  self.m=Media(self.root,lambda _:self.cred);self.channel='bilibili-test';self.jid='a'*32
 async def asyncTearDown(self):
  await self.m.close(None);self.tmp.cleanup()
 def job(self,status='draft',op='upload_draft'):
  d=self.m.directory(self.channel,self.jid);j={'id':self.jid,'operation':op,'status':status,'uid':'123','createdAt':__import__('time').time(),'meta':{'title':'fixture'},'uploaded':{'videos':[{'filename':'fixture'}],'cover':'https://i0.hdslb.com/fixture.jpg'}};self.m.save(d,j);return d,j
 async def test_upload_override_never_publishes(self):
  result=await UploadOnly._submit(object(),[{'filename':'fixture','cid':1}],'cover')
  self.assertEqual(result,{'videos':[{'filename':'fixture','cid':1}],'cover':'cover'})
 async def test_publish_requires_matching_account_and_ready_draft(self):
  self.job();self.cred.dedeuserid='456'
  with self.assertRaisesRegex(ValueError,'不属于'):await self.m.publish(self.channel,{'draft_id':self.jid})
  self.cred.dedeuserid='123';self.job('running')
  with self.assertRaisesRegex(ValueError,'未就绪'):await self.m.publish(self.channel,{'draft_id':self.jid})
 async def test_publish_returns_receipt_and_prevents_repeat(self):
  self.job()
  class Fake:
   def __init__(self,**kw):pass
   def update_params(self,**kw):return self
   def update_data(self,**kw):self.data=kw;return self
   @property
   def result(self):return AsyncMock(return_value={'bvid':'BV1xx411c7mD','aid':1})()
  with patch('media.Api',Fake):r=await self.m.publish(self.channel,{'draft_id':self.jid})
  self.assertEqual(r['status'],'submitted');self.assertTrue(r['published'])
  with self.assertRaises(ValueError):await self.m.publish(self.channel,{'draft_id':self.jid})
 async def test_unknown_publish_is_durable(self):
  self.job()
  with patch('media.Api',side_effect=TimeoutError()):
   with self.assertRaises(TimeoutError):await self.m.publish(self.channel,{'draft_id':self.jid})
  self.assertEqual(self.m.load(self.channel,self.jid)[1]['status'],'unknown')
 async def test_restart_does_not_replay_submission(self):
  self.job('submitting');m=Media(self.root,lambda _:self.cred)
  self.assertEqual(m.load(self.channel,self.jid)[1]['status'],'unknown')
 async def test_logout_cancels_inflight_upload(self):
  gate=asyncio.Event()
  async def wait(*args):await gate.wait()
  d,j=self.job('queued')
  (d/'video').write_bytes(b'fixture')
  from PIL import Image
  Image.new('RGB',(16,16)).save(d/'cover',format='PNG')
  with patch('media.UploadOnly') as uploader:
   uploader.return_value.start=AsyncMock(side_effect=wait)
   task=asyncio.create_task(self.m.run(self.channel,d,j,{'title':'test','tid':1,'tags':['test']},self.cred));self.m.tasks[self.jid]=(self.channel,task)
   await asyncio.sleep(0);await self.m.cancel(self.channel)
  self.assertEqual(self.m.load(self.channel,self.jid)[1]['status'],'interrupted')
 async def test_channel_isolation_and_url_restrictions(self):
  self.job()
  with self.assertRaises(ValueError):self.m.load('bilibili-other',self.jid)
  for url in ['file:///etc/passwd','http://cdn.bilivideo.com/a','https://localhost/a','https://cdn.bilivideo.com.evil/a','https://user:pass@cdn.bilivideo.com/a','https://cdn.bilivideo.com:8443/a']:
   with self.assertRaises(ValueError):media_url(url)
  self.assertEqual(media_url('https://upos-sz-mirrorcos.bilivideo.com/a'),'https://upos-sz-mirrorcos.bilivideo.com/a')
 async def test_probe_real_video_and_reject_text(self):
  path=self.root/'small.mp4'
  subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=black:s=64x64:d=0.1','-c:v','mpeg4',str(path)],check=True)
  await self.m.probe(path)
  path.write_text('not a video')
  with self.assertRaises(ValueError):await self.m.probe(path)
 async def test_rate_limit_preserves_code_and_persists_cooldown_without_uploading(self):
  from media import UploadRejected
  uploader=object.__new__(UploadOnly);uploader.line={'os':'upos','upcdn':'bda2','probe_version':'20211012'}
  uploader.credential=type('Cred',(),{'get_buvid_cookies':AsyncMock(return_value={})})()
  response=type('Response',(),{'code':406,'json':lambda _: {'OK':0,'code':601,'message':'secret-token-should-not-escape'}})()
  client=type('Client',(),{'request':AsyncMock(return_value=response)})()
  page=type('Page',(),{'path':'video.mp4','get_size':lambda _:100})()
  with patch('media.get_client',return_value=client):
   with self.assertRaises(UploadRejected) as caught:await uploader._preupload(page)
  self.assertEqual(client.request.await_count,1)
  self.assertEqual(caught.exception.details['code'],601);self.assertNotIn('secret-token',str(caught.exception))
  d,j=self.job();self.m.record_failure(self.channel,j,caught.exception)
  self.assertTrue(self.m.cooldown(self.channel));self.assertGreater(j['retryAt'],__import__('time').time())
  restarted=Media(self.root,lambda _:self.cred)
  with self.assertRaisesRegex(ValueError,'冷却'):await restarted.start(self.channel,'upload_draft',{})
 async def test_ordered_images_publish_once_and_unknown_submission_stays_unknown(self):
  from PIL import Image
  for fail in (False,True):
   d,j=self.job('queued','image_dynamic');j.update(imageCount=2,published=False)
   for i in range(2):Image.new('RGB',(16+i,16)).save(d/f'image{i}',format='PNG')
   seen=[]
   async def upload(pic,cred):
    seen.append((pic.width,pic._to_biliapifile().path));return {'image_url':'http://i0.hdslb.com/test.png'}
   class Fake:
    def __init__(self,**kw):pass
    def update_data(self,**kw):
     assert kw['dyn_req']['pics'][0]['img_src'].startswith('https://')
     self.data=kw;return self
    def update_params(self,**kw):return self
    @property
    def result(self):return AsyncMock(side_effect=TimeoutError() if fail else None,return_value={'dyn_id_str':'1234567890123456789'})()
   with patch('media.dynamic.upload_image',side_effect=upload),patch('media.Api',Fake):await self.m.run_images(self.channel,d,j,{'text':'漫画'},self.cred)
   saved=self.m.load(self.channel,self.jid)[1]
   self.assertEqual(saved['status'],'unknown' if fail else 'submitted')
   self.assertEqual([x[0] for x in seen],[16,17]);self.assertNotEqual(seen[0][1],seen[1][1])
   self.assertFalse((d/'image0').exists())
   if not fail:self.assertEqual(saved['dynamic_id'],'1234567890123456789')
 async def test_image_upload_failure_never_calls_dynamic_publish(self):
  from PIL import Image
  d,j=self.job('queued','image_dynamic');j.update(imageCount=1,published=False);Image.new('RGB',(16,16)).save(d/'image0',format='PNG')
  with patch('media.dynamic.upload_image',side_effect=ValueError('图片上传被拒绝')),patch('media.Api') as api:
   await self.m.run_images(self.channel,d,j,{},self.cred);api.assert_not_called()
  self.assertEqual(self.m.load(self.channel,self.jid)[1]['status'],'failed')
if __name__=='__main__':unittest.main()
