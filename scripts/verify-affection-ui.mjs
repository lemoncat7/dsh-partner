import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {build} from 'esbuild'
const {chromium}=await import(pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href)
const bundle=await build({nodePaths:(process.env.DSH_UI_TEST_NODE_PATH??'').split(':').filter(Boolean),alias:{react:fileURLToPath(new URL('../node_modules/react',import.meta.url))},stdin:{resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'tsx',contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {IdentityEditor} from './src/ui/identity-editor';import {createDefaultCompanion} from './src/domain';import {emptyCharacterCard} from './src/character/domain';
function Fixture(){const [c,setC]=useState({...createDefaultCompanion(),name:'测试伙伴',characterCard:{...emptyCharacterCard(),enabled:true,roleText:'坦率、好奇的同行者。'}});return <main className="dsh-partner-workspace" style={{display:'block',height:'auto',overflow:'visible',padding:20,boxSizing:'border-box'}}><IdentityEditor companion={c} onChanged={async()=>setC({...c,...window.savedIdentity,updatedAt:Date.now()})}/></main>}createRoot(document.getElementById('app')).render(<Fixture/>);`},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'text','.module.css':'text'}})
const css=(await Promise.all(['client.css','ui/workspace-ui.css','ui/responsive-ui.css','ui/identity-editor.css','ui/character-editor.css','ui/form-surface.css','ui/interaction-theme.css','ui/control-surfaces.css'].map(x=>readFile(new URL('../src/'+x,import.meta.url),'utf8')))).join('\n')
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].contents:'<meta name="viewport" content="width=device-width,initial-scale=1"><body id="root"><div id="app"></div><script src="/app.js"></script>')})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({headless:true})
try{
 for(const dark of [false,true])for(const width of [390,1280]){
  const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message)})
  let fail=false,saved,reads=0
  await page.route('**/partner-local/v1**',async route=>{
   const req=route.request(),url=req.url()
   if(url.endsWith('/character/affection')){reads++;return route.fulfill(fail?{status:500,json:{error:'模拟读取失败'}}:{json:{score:68,level:4,name:'信赖',behavior:'更愿意延续共同话题、主动关心，合适时使用已开启的语音。',nextName:'默契',nextAt:80,remaining:12,multiplier:1.68,updatedAt:Date.now()}})}
   if(req.method()==='PUT'&&url.endsWith('/identity')){saved=req.postDataJSON().identity;await page.evaluate(v=>window.savedIdentity=v,saved);return route.fulfill({json:saved})}
   await route.fulfill({json:{companions:[],channels:[],sessions:[],pairings:[]}})
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.addStyleTag({content:css});await page.evaluate(dark=>{document.body.toggleAttribute('data-ds-dark-theme',dark);document.body.style.margin='0';document.body.style.background=dark?'#181a1c':'#f6f6f8'},dark)
  assert.deepEqual(errors,[]);await page.getByRole('tab',{name:'角色聊天',exact:false}).click()
  assert.equal(reads,0,'hidden affection panel must not poll')
  await page.getByRole('tab',{name:'好感度',exact:true}).click()
  const meter=page.getByRole('progressbar',{name:'测试伙伴的好感度'})
  await page.waitForFunction(()=>document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')==='68')
  assert.equal(await meter.getAttribute('aria-valuetext'),'68 / 100，等级 4，信赖')
  await page.getByText('距离「默契」还差 12 点',{exact:true}).waitFor()
  assert.equal(await page.getByRole('switch',{name:'启用好感度累计与主动加成'}).getAttribute('aria-checked'),'true')
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false,'horizontal overflow')
  await page.screenshot({path:`/tmp/partner-affection-${dark?'dark':'light'}-${width}.png`,fullPage:true})
  await page.getByRole('switch',{name:'启用好感度累计与主动加成'}).click()
  await page.getByText('累计与加成已暂停',{exact:true}).waitFor()
  await page.getByRole('button',{name:'保存身份',exact:true}).click()
  await page.getByText('身份已保存，下一轮将使用新身份',{exact:false}).waitFor()
  assert.equal(saved.characterCard.affectionEnabled,false)
  fail=true;await page.getByRole('button',{name:'刷新进度',exact:true}).click();await page.getByRole('alert').filter({hasText:'读取失败'}).waitFor()
  assert.equal(await meter.getAttribute('aria-valuenow'),'68','read failure preserves last known progress')
  fail=false;await page.getByRole('button',{name:'刷新进度',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.dsh-partner-affection [role=alert]'))
  assert.deepEqual(errors,[]);console.log(JSON.stringify({dark,width,reads,passed:true}));await page.close()
 }
}finally{await browser.close();await new Promise(r=>server.close(r))}
