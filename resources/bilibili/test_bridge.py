import unittest,tempfile,os,importlib.util,json,asyncio,sys
sys.path.insert(0,str(__import__('pathlib').Path(__file__).parent))
from pathlib import Path
from unittest.mock import AsyncMock,patch
from aiohttp.test_utils import TestClient,TestServer

class BridgeTest(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.tmp=tempfile.TemporaryDirectory();root=Path(self.tmp.name);(root/'token').write_text('fixture-secret')
  os.environ['BILI_DATA']=str(root/'state');os.environ['BILI_TOKEN_FILE']=str(root/'token')
  spec=importlib.util.spec_from_file_location('bridge',Path(__file__).with_name('server.py'));self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
  self.client=TestClient(TestServer(self.m.app));await self.client.start_server()
 async def asyncTearDown(self):
  await self.client.close();self.m.DB.close();self.tmp.cleanup()
 async def post(self,operation,**extra):return await self.client.post('/call',json={'channelId':'bilibili-test','operation':operation,'params':{},**extra},headers={'Authorization':'Bearer fixture-secret'})
 async def test_private_bridge_and_public_share(self):
  r=await self.client.post('/call',json={});self.assertEqual(r.status,401)
  r=await self.post('share_link',params={'bvid':'BV1xx411c7mD'});self.assertEqual(r.status,200);self.assertFalse((await r.json())['result']['published'])
 async def test_missing_login_blocks_write(self):
  r=await self.post('like',params={'bvid':'BV1xx411c7mD','status':True},requestId='a'*64);self.assertEqual(r.status,401);self.assertIn('登录',(await r.json())['error'])
 async def test_write_replay_is_deduplicated(self):
  handler=AsyncMock(return_value={'rpid':123})
  with patch.object(self.m,'execute',handler),patch.object(self.m,'credential',return_value=type('Cred',(),{'sessdata':'test','check_valid':AsyncMock(return_value=True)})()):
   r=await self.post('comment',requestId='a'*64);self.assertEqual(r.status,200)
   self.m.LAST.clear();r=await self.post('comment',requestId='a'*64);self.assertEqual(r.status,200);self.assertEqual(handler.await_count,1)
 async def test_unknown_write_not_retried(self):
  handler=AsyncMock(side_effect=asyncio.TimeoutError())
  with patch.object(self.m,'execute',handler),patch.object(self.m,'credential',return_value=type('Cred',(),{'sessdata':'test','check_valid':AsyncMock(return_value=True)})()):
   r=await self.post('comment',requestId='a'*64);self.assertEqual(r.status,504)
   self.m.LAST.clear();r=await self.post('comment',requestId='a'*64);self.assertEqual(r.status,400);self.assertEqual(handler.await_count,1)
 async def test_invalid_channel_cannot_escape_storage(self):
  r=await self.post('status',channelId='../bad');self.assertEqual(r.status,400)
 async def test_long_comment_ids_remain_exact(self):
  self.assertEqual(self.m.bounded({'rpid':1234567890123456789})['rpid'],'1234567890123456789')
 async def test_login_completes_without_browser_polling(self):
  cred=type('Cred',(),{'sessdata':'fixture','bili_jct':'csrf','dedeuserid':'123','check_valid':AsyncMock(return_value=True)})()
  qr=type('Qr',(),{'check_state':AsyncMock(return_value=self.m.QrCodeLoginEvents.DONE),'get_credential':lambda self:cred})()
  self.m.LOGINS['bilibili-test']=(0,qr)
  with patch.object(self.m.asyncio,'sleep',AsyncMock()),patch.object(self.m.user,'get_self_info',AsyncMock(return_value={'name':'测试账号','face':'https://i0.hdslb.com/test.jpg'})):
   await self.m.monitor_login('bilibili-test',qr)
  self.assertTrue((self.m.ROOT/'bilibili-test.json').exists())
  r=await self.post('login_check');body=await r.json()
  self.assertEqual(body['status'],'done');self.assertEqual(body['name'],'测试账号');self.assertNotIn('sessdata',body)
 async def test_cookie_response_without_redirect_credentials(self):
  from http.cookies import SimpleCookie
  cookies=SimpleCookie();cookies['SESSDATA']='fixture-session';cookies['bili_jct']='fixture-csrf';cookies['DedeUserID']='123'
  cred=self.m.login_credential({'url':'https://www.bilibili.com/','refresh_token':'fixture-refresh'},cookies)
  self.assertTrue(cred.sessdata);self.assertEqual(cred.bili_jct,'fixture-csrf');self.assertEqual(cred.dedeuserid,'123')
 async def test_legacy_redirect_credentials(self):
  cred=self.m.login_credential({'url':'https://www.bilibili.com/?SESSDATA=fixture&bili_jct=csrf&DedeUserID=123'}, {})
  self.assertEqual(cred.dedeuserid,'123');self.assertTrue(cred.sessdata)
 async def test_incomplete_login_never_reports_success_or_saves(self):
  cred=type('Cred',(),{'sessdata':None,'bili_jct':None})()
  qr=type('Qr',(),{'check_state':AsyncMock(return_value=self.m.QrCodeLoginEvents.DONE),'get_credential':lambda self:cred})()
  with patch.object(self.m.asyncio,'sleep',AsyncMock()):await self.m.monitor_login('bilibili-test',qr)
  self.assertEqual(self.m.LOGIN_RESULTS['bilibili-test']['status'],'error')
  self.assertFalse((self.m.ROOT/'bilibili-test.json').exists())
 async def test_profile_failure_preserves_login(self):
  cred=type('Cred',(),{'dedeuserid':'123'})()
  with patch.object(self.m.user,'get_self_info',AsyncMock(side_effect=RuntimeError())):
   result=await self.m.identity(cred)
  self.assertEqual(result,{'logged_in':True,'uid':'123'})
 async def test_subtitle_resolves_cid_before_query(self):
  v=type('Video',(),{'get_cid':AsyncMock(return_value=456),'get_subtitle':AsyncMock(return_value={'subtitles':[]})})()
  with patch.object(self.m.video,'Video',return_value=v):
   r=await self.post('subtitle',params={'bvid':'BV1xx411c7mD'})
  self.assertEqual(r.status,200);self.assertFalse((await r.json())['result']['available'])
  v.get_cid.assert_awaited_once_with(page_index=0);v.get_subtitle.assert_awaited_once_with(cid=456)
 async def test_empty_subtitle_metadata_is_not_an_error(self):
  v=type('Video',(),{'get_cid':AsyncMock(return_value=456),'get_subtitle':AsyncMock(return_value=None)})()
  with patch.object(self.m.video,'Video',return_value=v):
   r=await self.post('subtitle',params={'bvid':'BV1xx411c7mD'})
  self.assertEqual(r.status,200);self.assertFalse((await r.json())['result']['available'])
 async def test_streaming_stage_keeps_uploads_private(self):
  from aiohttp import FormData
  form=FormData();form.add_field('video',b'x'*70000,filename='video.mp4');form.add_field('cover',b'fixture',filename='cover.png')
  r=await self.client.post('/stage/bilibili-test',data=form,headers={'Authorization':'Bearer fixture-secret'})
  self.assertEqual(r.status,200);jid=(await r.json())['stageId']
  d,j=self.m.MEDIA.load('bilibili-test',jid);self.assertEqual((d/'video').stat().st_size,70000)
  r=await self.post('upload_status',params={'job_id':jid});self.assertEqual(r.status,401)
 async def test_video_stream_returns_links_without_downloading(self):
  v=type('Video',(),{'get_download_url':AsyncMock(return_value={'durl':[{'url':'https://upos-sz-mirrorcos.bilivideo.com/video.mp4','length':10000}]})})()
  with patch.object(self.m.video,'Video',return_value=v):
   r=await self.post('video_stream',params={'bvid':'BV1xx411c7mD','page':2})
  result=(await r.json())['result'];self.assertEqual(r.status,200);self.assertFalse(result['downloaded']);self.assertEqual(result['mode'],'progressive')
  v.get_download_url.assert_awaited_once_with(page_index=1,html5=True)
  self.assertEqual(list(self.m.MEDIA.root.glob('*/*')),[])
 async def test_video_stream_exposes_separate_audio_and_official_backup(self):
  v=type('Video',(),{'get_download_url':AsyncMock(return_value={'dash':{'video':[{'baseUrl':'https://cdn.bilivideo.cn:8082/a','backupUrl':['https://upos-sz-mirrorcos.bilivideo.com/video'],'codecs':'avc1'}],'audio':[{'baseUrl':'https://upos-sz-mirrorcos.bilivideo.com/audio'}]}})})()
  with patch.object(self.m.video,'Video',return_value=v):r=await self.post('video_stream',params={'bvid':'BV1xx411c7mD'})
  result=(await r.json())['result'];self.assertEqual(result['mode'],'dash');self.assertTrue(result['audio']['url'].endswith('/audio'));self.assertFalse(result['interpreted'])
 async def test_logout_keeps_public_mode(self):
  r=await self.post('logout');self.assertEqual(r.status,200)
  r=await self.post('status');self.assertFalse((await r.json())['logged_in'])
 async def test_failed_media_job_can_retry_but_unknown_job_cannot(self):
  jid='b'*32;handler=AsyncMock(return_value={'id':jid,'status':'queued','published':False})
  cred=type('Cred',(),{'sessdata':'test','check_valid':AsyncMock(return_value=True)})()
  with patch.object(self.m,'execute',handler),patch.object(self.m,'credential',return_value=cred):
   self.assertEqual((await self.post('image_dynamic',requestId='b'*64)).status,200)
   d=self.m.MEDIA.directory('bilibili-test',jid)
   self.m.MEDIA.save(d,{'id':jid,'status':'failed','published':False})
   self.m.LAST.clear();self.assertEqual((await self.post('image_dynamic',requestId='b'*64)).status,200);self.assertEqual(handler.await_count,2)
   self.m.MEDIA.save(d,{'id':jid,'status':'unknown','published':False})
   self.m.LAST.clear();await self.post('image_dynamic',requestId='b'*64);self.assertEqual(handler.await_count,2)
 async def test_image_stage_validates_content_and_order(self):
  from aiohttp import FormData
  from PIL import Image
  from io import BytesIO
  pic=BytesIO();Image.new('RGB',(16,16)).save(pic,format='PNG')
  for names,expected in [(['image0','image1'],200),(['image1'],400),(['../bad'],400)]:
   form=FormData()
   for name in names:form.add_field(name,pic.getvalue(),filename='image.png',content_type='image/png')
   response=await self.client.post('/stage-images/bilibili-test',data=form,headers={'Authorization':'Bearer fixture-secret'})
   self.assertEqual(response.status,expected)
if __name__=='__main__':unittest.main()
