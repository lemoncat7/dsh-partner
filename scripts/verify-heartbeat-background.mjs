import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {build} from 'esbuild'
const {chromium} = await import(process.env.PARTNER_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({stdin:{resolveDir:root,loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';import {ConcernPanel} from './src/ui/memory/concern-panel';
createRoot(document.getElementById('app')).render(<ConcernPanel companion={{id:'test',automation:{heartbeat:{enabled:true}}}} snapshot={{heartbeatStates:[]}} onChanged={async()=>{}}/>);
`},bundle:true,write:false,outfile:'/tmp/heartbeat-ui-smoke.js',format:'iife',jsx:'automatic',loader:{'.css':'empty','.module.css':'local-css'},define:{'process.env.NODE_ENV':'"production"'}})
let running=false;let posts=0;let result=null
const server=createServer((req,res)=>{
  res.setHeader('content-type','application/json')
  if(req.url.endsWith('/trigger')){posts++;running=true;res.statusCode=202;res.end(JSON.stringify({running:true,accepted:true}));return}
  if(req.url.endsWith('/status')){res.end(JSON.stringify({running,result}));return}
  if(req.url.endsWith('/concerns')){res.end(JSON.stringify({concerns:[],observations:[]}));return}
  res.setHeader('content-type','text/html');res.end('<div id="app"></div><script>'+bundle.outputFiles[0].text+'</script>')
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({headless:true,...(process.env.PARTNER_CHROMIUM ? {executablePath:process.env.PARTNER_CHROMIUM}:{}),args:['--no-sandbox']})
try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button',{name:'检查到期项'}).click()
  const button=page.getByRole('button',{name:'后台检查中…'})
  await button.waitFor();assert.equal(await button.isDisabled(),true);assert.equal(posts,1)
  running=false;result={sent:false,reason:'检查完成测试'}
  await page.getByText('检查完成测试',{exact:true}).waitFor({timeout:10000})
  assert.equal(await page.getByRole('button',{name:'检查到期项'}).isEnabled(),true)
  assert.deepEqual(errors,[])
  console.log('background heartbeat browser smoke passed: immediate feedback, disabled duplicate, completion refresh')
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
