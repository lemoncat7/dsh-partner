import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {readFile} from 'node:fs/promises'
import {build} from 'esbuild'
const {chromium}=await import(process.env.PARTNER_PLAYWRIGHT_MODULE?pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href:'playwright-core')
const root=fileURLToPath(new URL('../',import.meta.url))
const bundle=await build({stdin:{resolveDir:root,loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';import {ArchivedConcerns} from './src/ui/memory/concern-deletion';
createRoot(document.getElementById('app')).render(<div className="dsh-partner-workspace"><ArchivedConcerns companionId="c" onChanged={async()=>{}}/></div>);
`},bundle:true,write:false,outfile:'/tmp/concern-delete-smoke.js',format:'iife',jsx:'automatic',loader:{'.css':'empty','.module.css':'local-css'},define:{'process.env.NODE_ENV':'"production"'}})
let deleted=false, fail=true, deletes=0, lists=0
const css=await readFile(new URL('../src/client.css',import.meta.url),'utf8')
const server=createServer(async(req,res)=>{
 if(req.method==='DELETE'){deletes++;let raw='';for await(const chunk of req)raw+=chunk;assert.equal(JSON.parse(raw).expectedUpdatedAt,12);res.setHeader('content-type','application/json');res.statusCode=fail?409:200;deleted=!fail;res.end(JSON.stringify(fail?{error:'心跳正在执行'}:{ok:true}));return}
 if(req.url.includes('/archived')){lists++;res.setHeader('content-type','application/json');res.end(JSON.stringify({items:deleted?[]:[{id:'old',subject:'旧关注',state:'archived',updatedAt:12}],hasMore:false}));return}
 res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width"><div id="app"></div><script>'+bundle.outputFiles[0].text+'</script>')
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({headless:true,...(process.env.PARTNER_CHROMIUM?{executablePath:process.env.PARTNER_CHROMIUM}:{}),args:['--no-sandbox']})
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.addStyleTag({content:css+' body{margin:0}.dsh-partner-workspace{display:block;width:100%;box-sizing:border-box}'})
 assert.equal(lists,0)
 await page.getByRole('button',{name:'已归档关注 · 查看与清理'}).click()
 await page.locator('.dsh-partner-concern-archive-details summary').click()
 await page.getByText('伙伴内部观察记录（未指定文档）',{exact:true}).waitFor()
 for(const width of [375,768,1024]){
   await page.setViewportSize({width,height:800})
   const title=await page.locator('.dsh-partner-concern-archive-details summary').boundingBox()
   const button=await page.getByRole('button',{name:'删除关注',exact:true}).boundingBox()
   assert.ok(title.width>100);assert.ok(button.width>=88);assert.ok(title.x+title.width<=button.x)
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 }
 await page.screenshot({path:'/tmp/partner-archive-ui.png',fullPage:true})
 await page.getByRole('button',{name:'删除关注',exact:true}).click()
 await page.getByRole('dialog').waitFor();assert.equal(deletes,0)
 for(const width of [375,1024]){await page.setViewportSize({width,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)}
 await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(deletes,0)
 await page.getByRole('button',{name:'删除关注',exact:true}).click();await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.getByRole('alert').waitFor()
 assert.equal(await page.getByRole('dialog').isVisible(),true)
 fail=false;await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
 await page.getByText('此页没有已归档关注。').waitFor();assert.deepEqual(errors,[])
 console.log('delete UI passed: lazy archived list, responsive confirmation, Escape cancellation, failure retained, success removed')
}finally{await browser.close();await new Promise(r=>server.close(r))}
