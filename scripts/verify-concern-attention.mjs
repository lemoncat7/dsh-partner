import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
const {chromium}=await import(process.env.PARTNER_PLAYWRIGHT_MODULE?pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href:'playwright-core')
const root=fileURLToPath(new URL('../',import.meta.url))
// The harness supplies its icon package at runtime; this isolated interaction
// fixture substitutes only decorative icons, not controls or API behavior.
const icons={name:'fixture-icons',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'icons',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:['Check','ChevronDown','Plus','Link','Data','AgentPreset','Close'].map(name=>`export const Icon${name}OutlineRegular=()=>null;`).join('\n')}))}}
const item={id:'watch',subject:'上游发布进展',reason:'等待兼容性修复',origin:'implicit',state:'watching',control:'auto',priority:.3,confidence:.9,score:.8,watchKind:'web',resources:[],updatedAt:1,nextCheckAt:Date.now()+86400000,adjustments:[{at:Date.now(),actor:'partner',priority:.3,state:'watching',reason:'已有替代方案，降低检查频率'}]}
const bundle=await build({stdin:{resolveDir:root,loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';import {ConcernBoard} from './src/ui/memory/concern-board';
createRoot(document.getElementById('app')).render(<div className="dsh-partner-workspace"><ConcernBoard companionId="c" activity={{concerns:[${JSON.stringify(item)}],observations:[]}} value="" busy={false} onValue={()=>{}} onAdd={async()=>true} onEdited={async()=>{}} onCheck={()=>{}} onAct={(_,action)=>document.getElementById('result').textContent=action}/></div>);
`},plugins:[icons],bundle:true,write:false,outfile:'/tmp/concern-attention-smoke.js',format:'iife',jsx:'automatic',loader:{'.css':'empty','.module.css':'local-css'},define:{'process.env.NODE_ENV':'"production"'}})
const css=await readFile(new URL('../src/client.css',import.meta.url),'utf8')
let restored=false
const server=createServer(async(req,res)=>{
 if(req.url.includes('/action')){let body='';for await(const chunk of req)body+=chunk;assert.deepEqual(JSON.parse(body),{action:'watch',expectedUpdatedAt:1});restored=true;res.setHeader('content-type','application/json');res.end('{"ok":true}');return}
 if(req.url.includes('/archived')){res.setHeader('content-type','application/json');res.end(JSON.stringify({items:restored?[]:[{...item,id:'archive',state:'archived',subject:'旧发布进展'}],hasMore:false}));return}
 res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width"><div id="app"></div><output id="result"></output><script>'+bundle.outputFiles[0].text+'</script>')
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto(`http://127.0.0.1:${server.address().port}`)
 await page.addStyleTag({content:css+' body{margin:0}.dsh-partner-workspace{display:block;width:100%;box-sizing:border-box}'})
 assert.ok(await page.getByText('关注度 30',{exact:true}).isVisible())
 assert.ok(await page.getByText('伙伴自主发现',{exact:true}).isVisible())
 const colors=await page.locator('.dsh-partner-concern-list > article').first().evaluate(article=>{
   const original=article.getAttribute('data-attention')
   const result=['focus','follow','observe'].map(stage=>{article.setAttribute('data-attention',stage);return getComputedStyle(article.querySelector('.dsh-partner-concern-state i')).backgroundColor})
   article.setAttribute('data-attention',original)
   return result
 })
 assert.equal(new Set(colors).size,3)
 await page.getByRole('button',{name:/暂时观察.*上游发布进展/}).click()
 await page.getByText('关注调整记录',{exact:true}).click()
 assert.ok(await page.getByText(/已有替代方案，降低检查频率/).isVisible())
 await page.getByRole('button',{name:'置顶关注',exact:true}).click()
 assert.equal(await page.locator('#result').textContent(),'prioritize')
 for(const dark of [false,true]){
   await page.evaluate(on=>{if(on)document.body.setAttribute('data-ds-dark-theme','');else document.body.removeAttribute('data-ds-dark-theme')},dark)
   for(const width of [375,1280]){await page.setViewportSize({width,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)}
 }
 await page.getByRole('button',{name:'已归档关注 · 查看与恢复'}).click()
 await page.getByRole('button',{name:'恢复关注',exact:true}).click()
 await page.waitForFunction(()=>!document.querySelector('.dsh-partner-concern-archive'))
 assert.equal(restored,true);assert.deepEqual(errors,[])
 await page.getByRole('button',{name:'交代一件事',exact:true}).click()
 const toggle=page.getByRole('switch',{name:'有变化时交给伙伴处理'})
 assert.equal(await toggle.getAttribute('aria-checked'),'false')
 await toggle.click()
 await page.getByLabel(/后续执行要求/).waitFor({state:'visible'})
 await page.getByLabel(/后续执行要求/).fill('生成文章并上传草稿，不公开发布')
 for(const dark of [false,true]){
   await page.evaluate(on=>{if(on)document.body.setAttribute('data-ds-dark-theme','');else document.body.removeAttribute('data-ds-dark-theme')},dark)
   for(const width of [375,1280]){await page.setViewportSize({width,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)}
 }
 await toggle.click()
 await page.getByLabel(/后续执行要求/).waitFor({state:'detached'})
 console.log('PASS concern stage/history/pin/archive restore; 375/1280px light/dark layout')
}finally{await browser.close();await new Promise(r=>server.close(r))}
