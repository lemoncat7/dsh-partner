// Read-only regression against an authenticated DSH instance. Never save,
// synthesize speech, test CDP or change channel configuration.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
const {chromium}=await import(process.env.DSH_PLAYWRIGHT_MODULE??'playwright')
const browser=await chromium.launch({...(process.env.DSH_CHROMIUM_EXECUTABLE?{executablePath:process.env.DSH_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox','--no-proxy-server']})
let page,requests=[]
try{
 const context=await browser.newContext({viewport:{width:1440,height:1100}})
 if(process.env.DSH_BROWSER_COOKIES)await context.addCookies(JSON.parse(await readFile(process.env.DSH_BROWSER_COOKIES,'utf8')))
 page=await context.newPage();const errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 // A cached page can request a no-longer-current chunk after deployment.
 // Make those resources unavailable and verify both settings remain usable.
 await page.route(/\/plugins\/.*\/client\.(tts|browser)\.js(?:\?|$)/,async route=>{requests.push(route.request().url());await route.fulfill({status:404,contentType:'text/plain',body:'expired client revision'})})
 await page.goto(process.env.DSH_BROWSER_URL??'http://127.0.0.1:3080/',{waitUntil:'domcontentloaded'})
 await page.locator('.dsh-partner-sidebar-row').first().click({timeout:30000})
 await page.getByRole('button',{name:'渠道',exact:true}).click()
 for(let cycle=0;cycle<3;cycle++){
  await page.getByRole('button',{name:'配置通用 TTS',exact:true}).click()
  const tts=page.getByRole('dialog',{name:'通用 TTS',exact:true})
  await tts.getByRole('button',{name:'添加服务',exact:true}).waitFor({state:'visible',timeout:5000})
  assert.equal(await tts.getByRole('alert').count(),0)
  await tts.getByRole('button',{name:'关闭',exact:true}).click()
  await page.getByRole('button',{name:'配置浏览器',exact:true}).click()
  const web=page.getByRole('dialog',{name:'浏览器',exact:true})
  const address=web.getByRole('textbox',{name:'CDP 地址',exact:true})
  await address.waitFor({state:'visible',timeout:5000})
  await page.waitForFunction(()=>{const input=document.querySelector('dialog[open] input[aria-label="CDP 地址"]');return input&&!input.disabled},{timeout:10000})
  assert.equal(await web.getByRole('alert').count(),0)
  await web.getByRole('button',{name:'关闭',exact:true}).click()
 }
 assert.deepEqual(requests,[],'common settings must work without fetching revision-bound chunks')
 assert.deepEqual(errors,[])
 console.log('PASS: TTS and browser settings open three times with unavailable lazy chunks; no page errors or configuration writes.')
}catch(error){console.error(JSON.stringify({alerts:await page?.getByRole('alert').allTextContents(),expiredChunkRequests:requests.length}));throw error}finally{await browser.close()}
