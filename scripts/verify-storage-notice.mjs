import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const { chromium } = await import(pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href)
const notice = { id:'system:storage-migration:1', kind:'system', action:'storage-migration', companionId:'', companionName:'伙伴插件', title:'需要升级数据目录', summary:'当前版本 **0**，目标版本 **1**。不会自动迁移，请先备份。', createdAt:1 }
const bundle = await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {PartnerPendant} from './src/pendant/widget';import {GeneralSettingsPanel} from './src/ui/storage-settings';function App(){const [page,setPage]=React.useState('');return <><PartnerPendant controller={{open:(id,d)=>{window.destination=d;setPage(d.page)}}}/>{page==='general'&&<main className="dsh-partner-workspace"><GeneralSettingsPanel/></main>}</>}createRoot(document.getElementById('app')).render(<App/>);`},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'text','.module.css':'text'}})
const css=(await Promise.all(['client.css','pendant/widget.css'].map(p=>readFile('src/'+p,'utf8')))).join('\n')
let read=false, migrations=0
const server=createServer((req,res)=>{
 res.setHeader('content-type','application/json')
 if(req.url.endsWith('/pendant/inbox')||req.url.endsWith('/pendant/read')){if(req.url.endsWith('/read'))read=true;return res.end(JSON.stringify({items:[{...notice,...(read?{readAt:2}:{})}],unread:read?0:1}))}
 if(req.url.endsWith('/storage/status'))return res.end(JSON.stringify({currentVersion:0,targetVersion:1}))
 if(req.url.endsWith('/storage/migrate')){migrations++;return res.end('{}')}
 if(req.url.endsWith('/pendant/renderer.js')){res.statusCode=503;return res.end('{}')}
 res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html')
 res.end(req.url==='/app.js'?bundle.outputFiles[0].contents:'<meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="app"></div><script src="/app.js"></script>')
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({args:['--no-sandbox']})
try {
 for(const width of [375,1024]) {
  read=false
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'})
  const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto('http://127.0.0.1:'+server.address().port)
  await page.getByRole('button',{name:/伙伴消息，1 条未读/}).click()
  await page.getByRole('button',{name:'前往升级迁移',exact:true}).waitFor()
  await page.screenshot({path:`/tmp/partner-storage-notice-${width}.png`})
  await page.getByRole('button',{name:'前往升级迁移',exact:true}).click()
  await page.getByRole('button',{name:'检查迁移',exact:true}).waitFor()
  assert.deepEqual(await page.evaluate(()=>window.destination),{page:'general'})
  assert.equal(migrations,0);assert.deepEqual(errors,[])
  await page.close()
 }
 console.log('Storage notice: card → reader → migration settings, no automatic migration; mobile/desktop passed')
} finally {await browser.close();server.close()}
