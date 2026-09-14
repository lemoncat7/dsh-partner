import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
const { chromium } = await import(process.env.PARTNER_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {WorkspaceGroupLinks,WorkspaceGroupTabs,GeneralSettingsPanel,workspaceGroup} from './src/ui/workspace-navigation';function App(){const [view,setView]=useState('board');return <main className="dsh-partner-workspace"><header className="dsh-partner-topbar">伙伴<nav className="dsh-partner-mobile-workspace-nav" aria-label="移动入口"><WorkspaceGroupLinks compact view={view} open={setView}/></nav></header><div className="dsh-partner-grid"><aside className="dsh-partner-roster"><nav className="dsh-partner-workspace-nav" aria-label="桌面入口"><WorkspaceGroupLinks view={view} open={setView}/></nav></aside><section className="dsh-partner-stage is-workspace-page"><div className="dsh-partner-group-heading"><h1>{workspaceGroup(view).label}</h1></div><WorkspaceGroupTabs view={view} open={setView}/><div className="dsh-partner-stage-scroll is-workspace-page">{view==='general'?<GeneralSettingsPanel/>:<p>{view}</p>}</div></section></div></main>}createRoot(document.getElementById('app')).render(<App/>);`},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'text','.module.css':'text'}})
const css=(await Promise.all(['client.css','ui/workspace-ui.css','ui/responsive-ui.css'].map(p=>readFile('src/'+p,'utf8')))).join('\n')
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].contents:'<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}'+css+'</style><div id="app"></div><script src="/app.js"></script>')})
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({args:['--no-sandbox']})
try {
 for(const width of [375,1024]) for(const dark of [false,true]) {
  const page=await browser.newPage({viewport:{width,height:850},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(d=>document.body.toggleAttribute('data-ds-dark-theme',d),dark)
  const nav=page.getByRole('navigation',{name:width===375?'移动入口':'桌面入口'});await nav.waitFor()
  assert.equal(await nav.getByRole('button').count(),2)
  const tabs=page.getByRole('navigation',{name:'功能标签页'});assert.equal(await tabs.getByRole('button').count(),3)
  for(const name of ['Skill 市场','定时任务','任务看板']) {await tabs.getByRole('button',{name,exact:true}).click();assert.equal(await tabs.getByRole('button',{name,exact:true}).getAttribute('aria-current'),'page')}
  await nav.getByRole('button',{name:/设置/}).click();const settings=page.getByRole('navigation',{name:'设置标签页'});assert.equal(await settings.getByRole('button').count(),2)
  await settings.getByRole('button',{name:'卡片设置',exact:true}).click();assert.equal(await settings.getByRole('button',{name:'卡片设置',exact:true}).getAttribute('aria-current'),'page')
  await nav.getByRole('button',{name:/设置/}).click();assert.equal(await settings.getByRole('button',{name:'卡片设置',exact:true}).getAttribute('aria-current'),'page')
  await settings.getByRole('button',{name:'基本设置',exact:true}).click()
  assert.ok(await page.locator('.dsh-partner-stage').evaluate(el=>el.scrollWidth<=el.clientWidth+1))
  await page.screenshot({path:'/tmp/partner-nav-'+width+'-'+dark+'.png'});assert.deepEqual(errors,[]);await page.close()
 }
 console.log('Navigation: desktop/mobile, light/dark, group ownership and tab switching passed')
} finally {await browser.close();server.close()}
