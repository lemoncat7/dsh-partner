// Isolated board fixture: never creates or dispatches real partner work.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const {chromium}=await import(process.env.PARTNER_PLAYWRIGHT_MODULE?pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href:'playwright-core')
const root=fileURLToPath(new URL('../',import.meta.url))
const bundle=await build({stdin:{resolveDir:root,loader:'tsx',contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {TaskBoardPanel} from './src/ui/task-board-panel';createRoot(document.getElementById('app')).render(<main className="dsh-partner-workspace"><div className="dsh-partner-content"><TaskBoardPanel/></div></main>);`},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'text','.module.css':'text'}})
const styles=(await Promise.all(['src/client.css','src/ui/workspace-ui.css','src/ui/responsive-ui.css'].map(path=>readFile(new URL('../'+path,import.meta.url),'utf8')))).join('\n')
const statuses=['backlog','ready','doing','review','blocked','done']
const tasks=statuses.flatMap((status,s)=>Array.from({length:10},(_,i)=>({id:`task-${s}-${i}`,title:`阶段任务 ${s}-${i} · 核验来源并整理交付物`,description:'输入来源、可验收文档与完成条件。',status,priority:'normal',assigneeCompanionId:'worker',autoRun:status==='ready',dependencyTaskIds:[],skillIds:[],createdBy:'user',revision:1,createdAt:1,updatedAt:1})))
const directory=[{id:'worker',name:'资料伙伴',role:'资料收集',description:'收集与核验公开信息',capabilities:[],enabledSkills:[],availability:'available'}]
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].contents:'<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#eceff1}body[data-ds-dark-theme]{background:#202427}</style><div id="app"></div><script src="/app.js"></script>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try{
 const page=await browser.newPage({reducedMotion:'reduce'}),errors=[];let submitted
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/partner-local/v1/**',async route=>{
  const req=route.request()
  if(req.method()==='POST'){submitted=req.postDataJSON();await route.fulfill({json:{...submitted,id:'created'}});return}
  await route.fulfill({json:req.url().endsWith('/tasks')?{tasks,activities:[]}:{companions:directory,delegations:[]}})
 })
 for(const dark of [false,true])for(const width of [375,844,1440]){
  await page.setViewportSize({width,height:width===844?500:900})
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.addStyleTag({content:styles})
  await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark)
  await page.locator('.dsh-partner-task-card').first().waitFor()
  const ready=page.locator('.dsh-partner-board > section[data-status=ready]')
  assert.equal(await ready.locator('.dsh-partner-task-card').count(),6)
  const list=ready.locator('.dsh-partner-board-column-list')
  assert.equal(await list.evaluate(el=>el.scrollHeight>el.clientHeight+1),false,'no inner vertical scroll box')
  if(width===1440){
   const a=await ready.locator('.dsh-partner-task-card').nth(0).boundingBox(),b=await ready.locator('.dsh-partner-task-card').nth(1).boundingBox()
   assert.ok(Math.abs(a.y-b.y)<1&&b.x>a.x,'desktop uses horizontal card grid')
  }
  await ready.getByRole('button',{name:/展开更多/}).click();assert.equal(await ready.locator('.dsh-partner-task-card').count(),10)
  await ready.locator('.dsh-partner-board-stage-toggle').click();assert.equal(await list.isVisible(),false)
  await ready.locator('.dsh-partner-board-stage-toggle').click();assert.equal(await list.isVisible(),true)
  await ready.locator('.dsh-partner-task-summary').first().click();await page.getByRole('dialog').waitFor()
  await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'})
  if(width<=760) await page.getByRole('combobox',{name:'按任务阶段筛选'}).selectOption('ready')
  else await page.locator('.dsh-partner-board-statuses').getByRole('button',{name:/^待开始/}).click()
  assert.equal(await page.locator('.dsh-partner-board > section').count(),1)
  const box=await ready.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1,'stage fits viewport')
  await page.screenshot({path:`/tmp/partner-board-stage-${width}-${dark?'dark':'light'}.png`})
 }
 await page.getByRole('button',{name:'新任务',exact:true}).click()
 const form=page.locator('.dsh-partner-task-form')
 await form.locator('[name=title]').fill('立即提交')
 await form.locator('[name=assignee]').selectOption('worker')
 await form.getByRole('button',{name:'创建任务',exact:true}).click()
 await page.getByRole('dialog').waitFor({state:'detached'});assert.equal(submitted.autoRun,true)
 await page.getByRole('button',{name:'新任务',exact:true}).click()
 await form.locator('[name=title]').fill('只规划')
 await form.locator('[name=assignee]').selectOption('worker')
 await form.locator('[name=submission]').selectOption('plan')
 await form.getByRole('button',{name:'创建任务',exact:true}).click()
 await page.getByRole('dialog').waitFor({state:'detached'});assert.equal(submitted.autoRun,false)
 assert.deepEqual(errors,[])
 console.log('Task board: 60 tasks, six responsive/theme cases, six cards per stage, horizontal layout, expand/collapse, dialogs, filters and explicit submission mode verified.')
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
