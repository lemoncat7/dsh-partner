import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const {chromium}=await import(process.env.PARTNER_PLAYWRIGHT_MODULE?pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href:'playwright-core')
const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {GeneralSettingsPanel} from './src/ui/storage-settings';createRoot(document.getElementById('app')).render(<main className="dsh-partner-workspace"><div className="dsh-partner-stage-scroll"><GeneralSettingsPanel/></div></main>);`},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'text','.module.css':'text'}})
const css=(await Promise.all(['client.css','ui/workspace-ui.css','ui/responsive-ui.css','ui/form-surface.css'].map(p=>readFile('src/'+p,'utf8')))).join('\n')
let posts=0,fail=false,submitted=false,recovery=0
const server=createServer(async(req,res)=>{
 if(req.url?.startsWith('/partner-local/v1/storage/')) {
  res.setHeader('content-type','application/json')
  if(req.url.endsWith('/status')){
   if(submitted&&recovery++<2){res.statusCode=recovery===1?504:404;return res.end('{}')}
   return res.end(JSON.stringify({currentVersion:submitted&&!fail?1:0,targetVersion:1,running:false,...(submitted&&fail?{lastError:'伙伴正在执行，请稍后重试'}:{})}))
  }
  if(req.url.endsWith('/inspect'))return res.end(JSON.stringify({currentVersion:0,targetVersion:1,migrationAvailable:true,consistentSnapshot:false,blockers:[],notices:['旧目录保留'],steps:[{id:'v0-to-v1',from:0,to:1,title:'目录整理',available:true}],items:[{label:'伙伴记忆',source:'/workspace/'+ 'long-directory/'.repeat(12)+'memory',target:'/workspace/partners/one/.partner/memory',exists:true,files:10,bytes:1024}]}))
  if(req.url.endsWith('/migrate')){let body='';for await(const part of req)body+=part;assert.deepEqual(JSON.parse(body),{confirm:true,expectedVersion:0});posts++;submitted=true;res.statusCode=fail?409:202;return res.end(JSON.stringify(fail?{error:'伙伴正在执行，请稍后重试'}:{accepted:true}))}
 }
 res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].contents:'<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#eef0f2}body[data-ds-dark-theme]{background:#171b20}'+css+'</style><div id="app"></div><script src="/app.js"></script>')
})
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({args:['--no-sandbox']})
try {
 for(const width of [375,1024])for(const dark of [false,true]) {
  submitted=false;recovery=0
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(d=>document.body.toggleAttribute('data-ds-dark-theme',d),dark)
  const before=posts
  await page.getByRole('button',{name:'检查迁移',exact:true}).click()
  await page.getByText('查看目录与检查详情',{exact:true}).click()
  await page.getByRole('button',{name:'升级迁移',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(posts,before)
  await page.getByRole('button',{name:'升级迁移',exact:true}).click()
  await page.screenshot({path:`/tmp/partner-storage-${width}-${dark}.png`})
  assert.ok(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1))
  fail=dark
  await page.getByRole('button',{name:'确认迁移目录和数据',exact:true}).click()
  await page.getByText(dark?'伙伴正在执行，请稍后重试':/已连接，存储版本 v1/).waitFor();assert.equal(posts,before+1)
  assert.deepEqual(errors,[]);await page.close()
 }
 console.log('Storage settings: confirmation/cancel, success/failure, desktop/mobile, light/dark passed')
}finally{await browser.close();server.close()}
