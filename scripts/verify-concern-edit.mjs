import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {readFile} from 'node:fs/promises'
import {build} from 'esbuild'
const {chromium}=await import(process.env.PARTNER_PLAYWRIGHT_MODULE?pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href:'playwright-core')
const root=fileURLToPath(new URL('../',import.meta.url))
const bundle=await build({stdin:{resolveDir:root,loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';import {ConcernEditor} from './src/ui/memory/concern-editor';
createRoot(document.getElementById('app')).render(<div className="dsh-partner-workspace"><ConcernEditor companionId="c" item={{id:'n',subject:'旧关注',reason:'原说明',updatedAt:12,resources:[{kind:'file',locator:'guide.md'}],recordTarget:{kind:'note',locator:'note1',label:'原笔记'}}} saved={async()=>{}} close={()=>{document.getElementById('result').textContent='closed'}}/></div>);
`},bundle:true,write:false,outfile:'/tmp/concern-edit-smoke.js',format:'iife',jsx:'automatic',loader:{'.css':'empty','.module.css':'local-css'},define:{'process.env.NODE_ENV':'"production"'}})
let fail=true;let body
const css=await readFile(new URL('../src/client.css',import.meta.url),'utf8')
const server=createServer(async(req,res)=>{
 if(req.method==='PATCH'){let raw='';for await(const chunk of req)raw+=chunk;body=JSON.parse(raw);res.setHeader('content-type','application/json');res.statusCode=fail?409:200;res.end(JSON.stringify(fail?{error:'版本已变化'}:{ok:true}));return}
 if(req.url.includes('recording-sources')){res.setHeader('content-type','application/json');res.end('{"items":[]}');return}
 res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width"><div id="app"></div><output id="result"></output><script>'+bundle.outputFiles[0].text+'</script>')
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({headless:true,...(process.env.PARTNER_CHROMIUM?{executablePath:process.env.PARTNER_CHROMIUM}:{}),args:['--no-sandbox']})
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.addStyleTag({content:css+' body{margin:0}.dsh-partner-workspace{display:block;width:100%;box-sizing:border-box}.dsh-partner-concern-compose input{box-sizing:border-box}'})
 for(const width of [375,1024]){await page.setViewportSize({width,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)}
 await page.getByLabel('关注事项',{exact:true}).fill('更新后的关注')
 await page.getByLabel('执行说明与记录格式').fill('按优先级整理表格，不重复追加')
 await page.getByRole('button',{name:'取消记录',exact:true}).click()
 await page.getByRole('button',{name:'保存修改'}).click();await page.getByRole('alert').waitFor()
 assert.equal(await page.getByLabel('关注事项',{exact:true}).inputValue(),'更新后的关注')
 fail=false;await page.getByRole('button',{name:'保存修改'}).click();await page.waitForFunction(()=>document.getElementById('result').textContent==='closed')
 assert.equal(body.expectedUpdatedAt,12);assert.equal(body.recordTarget,null);assert.equal(body.sources,'@"guide.md"');assert.deepEqual(errors,[])
 console.log('concern edit passed: responsive, preserve failed draft, clear target, revision payload, successful close')
}finally{await browser.close();await new Promise(r=>server.close(r))}
