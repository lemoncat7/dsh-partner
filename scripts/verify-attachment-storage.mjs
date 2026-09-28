import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from '/home/moye/.npm/_npx/fd3bca3c548369c0/node_modules/playwright-core/index.mjs'
// The host supplies its icon module at runtime; this standalone fixture isolates the form.
const icons={name:'host-icons',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'icons',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const IconAgentPresetOutlineRegular=()=>null; export const IconCloseOutlineRegular=()=>null;'}))}}
const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {AttachmentStoragePanel} from './src/ui/attachment-storage';createRoot(document.getElementById('app')).render(<main className="dsh-partner-workspace"><AttachmentStoragePanel/></main>);`},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'text','.module.css':'text'},plugins:[icons]})
const css=(await Promise.all(['client.css','ui/workspace-ui.css','ui/responsive-ui.css','ui/form-surface.css'].map(p=>readFile('src/'+p,'utf8')))).join('\n')
let limit=512,cleanups=0
const items=Array.from({length:30},(_,i)=>({id:String(i).padStart(64,'0'),name:'附件文件名很长时也应该保持列表紧凑-'+i+'.mp4',companionId:'a',companionName:'伙伴',size:1024,createdAt:Date.now(),channel:'sent',...(i===0?{protectedReason:'任务仍在使用'}:{})}))
const server=createServer(async(req,res)=>{
  if(req.url?.startsWith('/partner-local/v1/attachments/')){
    res.setHeader('content-type','application/json')
    if(req.method==='PUT'){let body='';for await(const chunk of req)body+=chunk;limit=JSON.parse(body).limitMiB;return res.end(JSON.stringify({limitMiB:limit}))}
    if(req.method==='POST'){cleanups++;return res.end(JSON.stringify({removed:29,freedBytes:29696,skipped:0,failed:0}))}
    return res.end(JSON.stringify({limitMiB:limit,usedBytes:501*1048576,count:30,eligibleBytes:29696,eligibleCount:29,filteredCount:30,items,owners:[{id:'a',name:'伙伴',bytes:30720,count:30,directory:'/data/partner/storage-v1/attachment-deliveries'}]}))
  }
  res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html')
  res.end(req.url==='/app.js'?bundle.outputFiles[0].contents:`<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:12px;background:#eef0f2}body[data-ds-dark-theme]{background:#171b20}${css}</style><div id="app"></div><script src="/app.js"></script>`)
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({args:['--no-sandbox']})
try{
  for(const width of [375,768,1280])for(const dark of [false,true]){
    const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'}),errors=[]
    page.on('pageerror',e=>errors.push(e.message))
    await page.goto('http://127.0.0.1:'+server.address().port)
    await page.evaluate(d=>document.body.toggleAttribute('data-ds-dark-theme',d),dark)
    await page.getByText('30 个副本 · 全部伙伴共享').waitFor()
    assert.equal(await page.locator('.attachment-storage-row').count(),0)
    assert.ok(await page.getByRole('button',{name:'保存额度'}).isDisabled())
    const height=await page.locator('.attachment-storage-block').evaluate(el=>el.getBoundingClientRect().height)
    assert.ok(height<230,`Collapsed panel too tall: ${height}`)
    await page.screenshot({path:`/tmp/partner-compact-${width}-${dark}.png`})
    await page.getByRole('button',{name:'管理副本'}).click()
    assert.equal(await page.locator('.attachment-storage-row').count(),30)
    assert.ok(await page.locator('input[type=checkbox]').first().isDisabled())
    assert.ok(await page.locator('#partner-attachment-storage').evaluate(el=>el.scrollWidth<=el.clientWidth+1))
    await page.getByRole('button',{name:'选择本页',exact:true}).click()
    await page.getByRole('button',{name:'清理所选（29）'}).click()
    await page.getByRole('dialog').waitFor({state:'visible'})
    assert.equal(await page.locator('dialog .dsh-partner-feature-form > footer').count(),1)
    assert.ok(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1))
    await page.screenshot({path:`/tmp/partner-cleanup-dialog-${width}-${dark}.png`})
    await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(cleanups,0)
    await page.getByRole('button',{name:'收起明细'}).click()
    await page.getByRole('spinbutton',{name:'总额度（MiB）'}).fill('1024')
    await page.getByRole('button',{name:'保存额度'}).click()
    await page.getByRole('status').waitFor();assert.equal(limit,1024)
    limit=512;assert.deepEqual(errors,[]);await page.close()
  }
  console.log('Compact storage: desktop/tablet/mobile, light/dark, collapse, protection, cancel and quota save passed')
}finally{await browser.close();server.close()}
