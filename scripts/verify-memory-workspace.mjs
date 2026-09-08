// Isolated API fixtures; uses production components and styles without user-data writes.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {build} from 'esbuild'
const {chromium} = await import(process.env.PARTNER_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = fileURLToPath(new URL('../', import.meta.url))
const companion = {id:'fixture',name:'莫殇',automation:{memory:{enabled:true,retentionDays:90,dailyReviewEnabled:true,dailyReviewHour:3},heartbeat:{enabled:true,intervalMinutes:60,quietStartHour:23,quietEndHour:8,dailyLimit:3}}}
const bundle = await build({stdin:{resolveDir:root,loader:'tsx',contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {MemoryPanel} from './src/ui/memory/memory-panel';import {ConcernPanel} from './src/ui/memory/concern-panel';
const companion=${JSON.stringify(companion)};
const snapshot={sessions:[{id:'route',companionId:'fixture',kind:'local',channelId:'local',userId:'a',sessionId:'session',lastMessageAt:1}],heartbeatStates:[]};
const noop=async()=>{};
function App(){const [watch,setWatch]=useState(false);return <main className="dsh-partner-workspace"><div className="dsh-partner-stage-scroll"><nav><button onClick={()=>setWatch(false)}>记忆页</button><button onClick={()=>setWatch(true)}>关注页</button></nav>{watch?<ConcernPanel companion={companion} snapshot={snapshot} onChanged={noop}/>:<MemoryPanel companion={companion} snapshot={snapshot} openSession={noop} startSession={noop} renewSession={noop} onChanged={noop}/>}</div></main>}
createRoot(document.getElementById('app')).render(<App/>);`},bundle:true,write:false,format:'iife',jsx:'automatic',platform:'browser',target:'es2022',loader:{'.css':'text','.module.css':'text'}})
const styles=(await Promise.all(['src/client.css','src/ui/workspace-ui.css','src/ui/responsive-ui.css','src/ui/memory/memory-ui.css'].map(p=>readFile(root+p,'utf8')))).join('\n')
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].contents:'<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}body{background:#eceff1}body[data-ds-dark-theme]{background:#202427}</style><div id="app"></div><script src="/app.js"></script>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try {
 const page=await browser.newPage({reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));let graphs=0,writes=0
 const item=(scopeId,status='active')=>({id:scopeId+status,scopeId,kind:'profile',subject:scopeId==='local:a'?'明确的项目背景':'另一位联系人的背景',content:'只保留有可靠对话依据的信息。',status,confidence:0.95,updatedAt:Date.now(),createdAt:Date.now(),evidence:[],locked:false})
 const profiles=['local:a','channel:b'].map(scopeId=>({scopeId,label:scopeId,entries:[item(scopeId)],preferences:[],evidenceCount:2,lockedCount:0,version:'version01',updatedAt:Date.now()}))
 await page.route('**/partner-local/v1/**',async route=>{
  const url=new URL(route.request().url()),path=url.pathname,scope=url.searchParams.get('scopeId')||'local:a';let body={}
  if(route.request().method()!=='GET'){writes++;body=path.endsWith('/automation')?companion:{...item(scope),locked:true}}
  else if(path.endsWith('/memory'))body={memories:[item(scope),item(scope,'expired')],reflections:[],profiles}
  else if(path.endsWith('/layers'))body={scenes:[],experiences:[],jobs:[]}
  else if(path.endsWith('/history'))body=[{id:'turn',at:Date.now(),user:'记录一次对话',assistant:'这是历史回答'}]
  else if(path.endsWith('/graph')){graphs++;body={memories:[item(scope)],relations:[]}}
  else if(path.endsWith('/models'))body={defaultSelection:{provider:'local',model:'default'},providers:[]}
  else if(path.endsWith('/concerns'))body={concerns:[{id:'watch',subject:'关注版本变化',reason:'等待正式修复',state:'active',nextCheckAt:Date.now()+3600000,resources:[],origin:'explicit',watchKind:'auto'}],observations:[]}
  await route.fulfill({json:body})
 })
 const fits=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow')
 for(const dark of [false,true])for(const width of [375,844,1440]){
  await page.setViewportSize({width,height:width===844?500:900});await page.goto(`http://127.0.0.1:${server.address().port}`);await page.addStyleTag({content:styles});await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark)
  await page.getByRole('heading',{name:'伙伴对你的理解'}).waitFor();await fits();const count=graphs
  await page.getByRole('button',{name:'记忆',exact:true}).click();await page.getByLabel('记忆状态').selectOption('expired');await page.getByText('已过期',{exact:true}).last().waitFor();assert.equal(graphs,count)
  await page.getByLabel('当前联系人').selectOption('channel:b');await page.getByRole('button',{name:/另一位联系人的背景/}).waitFor();assert.equal(await page.getByRole('button',{name:/明确的项目背景/}).count(),0)
  await page.getByRole('button',{name:'记忆设置',exact:true}).click();await page.getByRole('dialog').waitFor();await fits();const before=writes
  await page.getByRole('button',{name:'保存设置',exact:true}).evaluate(b=>{b.click();b.click()});await page.getByText('设置已保存',{exact:true}).waitFor();assert.equal(writes,before+1)
  await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'})
  await page.getByRole('button',{name:'回顾',exact:true}).click();await page.getByRole('button',{name:'对话历史',exact:true}).click();await page.getByText('记录一次对话',{exact:true}).first().waitFor()
  await page.getByLabel('更多记忆内容').click();await page.getByRole('button',{name:'关系图谱',exact:true}).click();await page.getByText('还没有可靠关系',{exact:true}).waitFor();assert.equal(graphs,count+1)
  await page.getByRole('button',{name:'记忆',exact:true}).click();await page.screenshot({path:`/tmp/partner-memory-${width}-${dark?'dark':'light'}.png`});await fits()
  await page.getByRole('button',{name:'关注页',exact:true}).click();await page.getByRole('button',{name:'关注设置',exact:true}).waitFor();await fits();await page.getByRole('button',{name:/关注版本变化/}).waitFor();assert.equal(await page.locator('.dsh-partner-concern-row').evaluate(el=>getComputedStyle(el).display),'grid')
 }
 assert.deepEqual(errors,[]);console.log('Memory workspace: 6 viewport/theme cases; scope isolation, filters, lazy graph/history, settings and duplicate prevention passed.')
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
