import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {build} from 'esbuild'
const {chromium}=await import(pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href)
const bundle=await build({nodePaths:(process.env.DSH_UI_TEST_NODE_PATH??'').split(':').filter(Boolean),alias:{react:fileURLToPath(new URL('../node_modules/react',import.meta.url))},stdin:{resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'tsx',contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {SleepEditor} from './src/ui/sleep-editor';import {createDefaultCompanion} from './src/domain';
function Fixture(){const c={...createDefaultCompanion(),name:'测试伙伴',sleepPolicy:{enabled:true,dreamsEnabled:true}};c.automation.memory.enabled=true;const [value,setValue]=useState(c.sleepPolicy);return <main className="dsh-partner-workspace" style={{display:'block',height:'auto',overflow:'visible',padding:20,boxSizing:'border-box'}}><SleepEditor companion={c} value={value} onChange={setValue} active={true} disabled={false}/></main>}createRoot(document.getElementById('app')).render(<Fixture/>);`},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'text','.module.css':'text'}})
const css=(await Promise.all(['client.css','ui/workspace-ui.css','ui/responsive-ui.css','ui/identity-editor.css','ui/character-editor.css','ui/form-surface.css','ui/interaction-theme.css','ui/control-surfaces.css'].map(x=>readFile(new URL('../src/'+x,import.meta.url),'utf8')))).join('\n')
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].contents:'<meta name="viewport" content="width=device-width,initial-scale=1"><body id="root"><div id="app"></div><script src="/app.js"></script>')})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({headless:true})
try{
 for(const dark of [false,true])for(const width of [390,1280]){
  const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message))
  let fail=false,awake=false,reads=0;const now=Date.now()
  await page.route('**/partner-local/v1/**/sleep',async route=>{
   if(route.request().method()==='POST'){assert.deepEqual(route.request().postDataJSON(),{action:'wake'});awake=true;return route.fulfill({json:{ok:true}})}
   reads++;await route.fulfill(fail?{status:500,json:{error:'模拟读取失败'}}:{json:{serverNow:now,state:{fatigue:{value:68,at:now},episode:{id:'episode',startedAt:now-30*60_000,wakeAt:now+60*60_000,...(awake?{wokeAt:now,wakeReason:'用户唤醒'}:{}),dream:'interrupted',reason:'有些困了'},reception:{at:now,state:'sleeping',calls:1,needed:3},dreams:[{id:'d1',at:now-60_000,segment:1,narrative:'雨滴在窗边变成一盏小灯。',feeling:'安静。',topic:''}]}}})
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.addStyleTag({content:css});await page.evaluate(dark=>{document.body.toggleAttribute('data-ds-dark-theme',dark);document.body.style.margin='0';document.body.style.background=dark?'#181a1c':'#f6f6f8'},dark)
  const meter=page.getByRole('meter',{name:'测试伙伴的疲惫值'});await page.waitForFunction(()=>document.querySelector('[role=meter]')?.getAttribute('aria-valuenow')==='68')
  assert.equal(await meter.getAttribute('aria-valuetext'),'68 / 100，很困了');await page.getByRole('heading',{name:'迷迷糊糊',exact:true}).waitFor()
  assert.ok(await page.locator('.dsh-partner-fatigue').evaluate(el=>el.getBoundingClientRect().height<180))
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'no horizontal overflow')
  await page.screenshot({path:`/tmp/partner-sleep-${dark?'dark':'light'}-${width}.png`,fullPage:true})
  await page.clock.install();fail=true;await page.clock.fastForward(15001);await page.getByRole('alert').filter({hasText:'读取失败'}).waitFor();assert.equal(await meter.getAttribute('aria-valuenow'),'68')
  fail=false;await page.getByRole('button',{name:'立即叫醒',exact:true}).click();await page.getByRole('heading',{name:'清醒',exact:true}).waitFor();assert.equal(await meter.getAttribute('aria-valuenow'),'68','wake does not zero fatigue')
  await page.getByRole('switch',{name:'允许做梦'}).click();assert.equal(await page.getByRole('switch',{name:'允许做梦'}).getAttribute('aria-checked'),'false')
  assert.deepEqual(errors,[]);console.log(JSON.stringify({dark,width,reads,passed:true}));await page.close()
 }
}finally{await browser.close();await new Promise(r=>server.close(r))}
