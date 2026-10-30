import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {build} from 'esbuild'
const {chromium}=await import(pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href)
const bundle=await build({nodePaths:(process.env.DSH_UI_TEST_NODE_PATH??'').split(':').filter(Boolean),alias:{react:fileURLToPath(new URL('../node_modules/react',import.meta.url))},stdin:{resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'tsx',contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {CompanionVitals} from './src/ui/companion-vitals';import {CompanionDeletion} from './src/ui/companion-deletion';import {IdentityEditor} from './src/ui/identity-editor';import {createDefaultCompanion} from './src/domain';import {emptyCharacterCard} from './src/character/domain';
function Fixture(){const [page,setPage]=useState('home'),[paused,setPaused]=useState(false);const c={...createDefaultCompanion(),id:'test',name:'测试伙伴',characterCard:{...emptyCharacterCard(),enabled:true,affectionEnabled:!paused,roleText:'喜欢观察、直率好奇的同行者。'},sleepPolicy:{enabled:!paused,dreamsEnabled:true}};return <main className="dsh-partner-workspace" style={{display:'block',height:'auto',overflow:'visible',padding:20,boxSizing:'border-box'}}><nav><button onClick={()=>setPage('home')}>总览</button><button onClick={()=>setPage('identity')}>身份</button><button onClick={()=>setPaused(!paused)}>切换暂停</button></nav>{page==='home'?<><CompanionDeletion companion={c} count={2} channelCount={1} onRemoved={async()=>{}}/><div className="dsh-partner-home"><header className="dsh-partner-home-heading"><span><small>工作台</small><h2>测试伙伴已准备就绪</h2></span></header><CompanionVitals key={c.id} companion={c}/></div></>:<IdentityEditor companion={c} onChanged={async()=>{}}/>}</main>}createRoot(document.getElementById('app')).render(<Fixture/>);`},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'text','.module.css':'text'}})
const css=(await Promise.all(['client.css','ui/workspace-ui.css','ui/responsive-ui.css','ui/identity-editor.css','ui/character-editor.css','ui/form-surface.css','ui/interaction-theme.css','ui/control-surfaces.css'].map(x=>readFile(new URL('../src/'+x,import.meta.url),'utf8')))).join('\n')
assert.match(await readFile(new URL('../src/client.tsx',import.meta.url),'utf8'),/<CompanionVitals key=\{companion.id\} companion=\{companion\}/)
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].contents:'<meta name="viewport" content="width=device-width,initial-scale=1"><body id="root"><div id="app"></div><script src="/app.js"></script>')})
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true})
try{
 for(const dark of [false,true])for(const width of [390,1280]){
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message))
  const now=Date.now();let fail=false,reads=0,deletes=0,score=68
  await page.route('**/partner-local/v1**',async route=>{
   const url=route.request().url()
   if(route.request().method()==='DELETE'){deletes++;return route.fulfill({json:{ok:true}})}
   if(url.endsWith('/character/affection')){reads++;return route.fulfill({json:{score,level:4,name:'信赖',multiplier:1.68}})}
   if(url.endsWith('/sleep'))return route.fulfill(fail?{status:500,json:{error:'模拟读取失败'}}:{json:{serverNow:now,state:{fatigue:{value:72,at:now},episode:{id:'e',startedAt:now-60_000,wakeAt:now+3600_000,dream:'pending'}}}})
   return route.fulfill({json:{companions:[],channels:[],sessions:[],pairings:[]}})
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.addStyleTag({content:css});await page.evaluate(dark=>{document.body.toggleAttribute('data-ds-dark-theme',dark);document.body.style.margin='0';document.body.style.background=dark?'#181a1c':'#f6f6f8'},dark)
  const affection=page.getByRole('progressbar',{name:'测试伙伴的好感度'}),fatigue=page.getByRole('meter',{name:'测试伙伴的疲惫值'})
  await page.waitForFunction(()=>document.querySelector('[role=meter]')?.getAttribute('aria-valuenow')==='72')
  assert.equal(await affection.getAttribute('aria-valuenow'),'68');assert.equal(await fatigue.getAttribute('aria-valuetext'),'72 / 100，睡眠中')
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false)
  assert.ok(await fatigue.evaluate(el=>el.getBoundingClientRect().bottom<600),'status visible without scrolling')
  const remove=page.getByRole('button',{name:'删除伙伴',exact:true});assert.ok(await remove.evaluate(el=>parseFloat(getComputedStyle(el).paddingLeft)>=12))
  await page.screenshot({path:`/tmp/partner-overview-${dark?'dark':'light'}-${width}.png`,fullPage:true})
  await remove.click();await page.getByRole('alertdialog').waitFor();assert.equal(await page.locator('.dsh-partner-workspace-dialog.is-confirmation').count(),1)
  await page.screenshot({path:`/tmp/partner-delete-${dark?'dark':'light'}-${width}.png`,fullPage:true})
  await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(deletes,0)
  await page.clock.install();score=69;fail=true;await page.clock.fastForward(15001);await page.getByText('部分状态刷新失败',{exact:false}).waitFor();assert.equal(await fatigue.getAttribute('aria-valuenow'),'72');assert.equal(await affection.getAttribute('aria-valuenow'),'69')
  fail=false;await page.getByRole('button',{name:'重试',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.dsh-partner-vitals-error'))
  await page.getByRole('button',{name:'切换暂停'}).click();assert.equal(await page.getByText('已暂停',{exact:true}).count(),2);assert.equal(await fatigue.getAttribute('aria-valuenow'),'72')
  await page.getByRole('button',{name:'身份',exact:true}).click()
  await page.getByText('基本身份参考模板',{exact:true}).click();await page.getByText('名字：小岚',{exact:false}).waitFor()
  await page.getByRole('tab',{name:'关系设定',exact:false}).click();await page.getByText('关系设定参考模板',{exact:true}).click();await page.getByText('## 我们的关系',{exact:false}).waitFor()
  await page.getByRole('tab',{name:'角色聊天',exact:false}).click();await page.getByText('角色设定参考模板',{exact:true}).click();await page.getByText('# 角色卡：小岚',{exact:false}).waitFor()
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false)
  assert.deepEqual(errors,[]);console.log(JSON.stringify({dark,width,reads,deletes,passed:true}));await page.close()
 }
}finally{await browser.close();await new Promise(r=>server.close(r))}
