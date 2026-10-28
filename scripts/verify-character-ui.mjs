import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {build} from 'esbuild'
import { BUILTIN_STICKERS } from '../lib/chat/sticker-builtins.js'
const {chromium}=await import(pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href)
const bundle=await build({nodePaths:(process.env.DSH_UI_TEST_NODE_PATH??'').split(':').filter(Boolean),alias:{react:fileURLToPath(new URL('../node_modules/react',import.meta.url))},stdin:{resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'tsx',contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {IdentityEditor} from './src/ui/identity-editor';import {AutomationSettings} from './src/ui/memory/automation-settings';import {createDefaultCompanion} from './src/domain';
function Fixture(){const [c,setC]=useState({...createDefaultCompanion(),name:'通用测试伙伴'});const [settings,setSettings]=useState(false);return <main className="dsh-partner-workspace" style={{display:"block",height:"auto",overflow:"visible"}}><button id="refresh-fixture" onClick={()=>setC({...c,model:'updated-model',updatedAt:Date.now()})}>模拟配置刷新</button><button onClick={()=>setSettings(true)}>打开记忆设置</button><IdentityEditor companion={c} onChanged={async()=>setC({...c,...window.savedCompanion,updatedAt:Date.now()})}/>{settings&&<AutomationSettings companion={c} kind="memory" close={()=>setSettings(false)} onChanged={async()=>{}}/>}</main>};createRoot(document.getElementById('app')).render(<Fixture/>);
`},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'text','.module.css':'text'}})
const css=(await Promise.all(['client.css','ui/workspace-ui.css','ui/responsive-ui.css','ui/identity-editor.css','ui/character-editor.css','ui/memory/memory-ui.css','ui/form-surface.css','ui/interaction-theme.css','ui/control-surfaces.css'].map(x=>readFile(new URL('../src/'+x,import.meta.url),'utf8')))).join('\n')
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].contents:'<meta name="viewport" content="width=device-width,initial-scale=1"><body id="root"><div id="app"></div><script src="/app.js"></script>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({headless:true})
try {
 for(const dark of [false,true])for(const width of [375,1280]) {
  const page=await browser.newPage({viewport:{width,height:960},reducedMotion:'reduce'});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/partner-local/v1/**',async route=>{
   const req=route.request(),url=req.url();let result={}
   if(req.method()==='PUT'&&url.endsWith('/companion-default')){const data=req.postDataJSON();await page.evaluate(c=>window.savedCompanion=c,data.companion);result=data.companion}
   else if(url.endsWith('/preview'))result={reply:'先缓一缓，愿意说说发生了什么吗？'}
   else if(url.endsWith('/models'))result={providers:[],defaultSelection:{provider:'test',model:'test'}}
   else if(url.endsWith('/renewal'))result={items:[]}
   else if(url.endsWith('/stickers'))result={items:BUILTIN_STICKERS.map(({data,...s})=>({...s,builtin:true}))}
   else if(url.includes('/stickers/builtin-')){await route.fulfill({contentType:'image/png',body:Buffer.from(BUILTIN_STICKERS.find(s=>url.endsWith(s.id)).data,'base64')});return}
   await route.fulfill({json:result})
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.addStyleTag({content:css});await page.evaluate(dark=>{document.body.toggleAttribute('data-ds-dark-theme',dark);document.body.style.background=dark?'#181a1c':'#f6f6f8';document.body.style.fontFamily='sans-serif'},dark)
  await page.getByRole('tab',{name:'角色聊天',exact:false}).click()
  assert.equal(await page.getByRole('switch',{name:'启用角色聊天'}).getAttribute('aria-checked'),'false')
  await page.getByRole('button',{name:'设置角色',exact:true}).click()
  await page.getByRole('button',{name:'继续',exact:true}).click();await page.getByRole('alert').filter({hasText:'请写下角色设定'}).waitFor()
  await page.getByRole('button',{name:'填入通用示例'}).click();assert.equal(await page.getByRole('dialog').getByText(/莫殇/).count(),0)
  await page.getByRole('textbox',{name:/角色设定/}).fill('坦率的同行者，闲聊简短，有自己的偏好。')
  await page.getByRole('button',{name:'继续',exact:true}).click();await page.getByLabel('闲聊节奏',{exact:false}).selectOption('short')
  await page.getByRole('button',{name:'继续',exact:true}).click()
  await page.getByRole('button',{name:'发送试聊'}).click();await page.getByText('先缓一缓，愿意说说发生了什么吗？',{exact:false}).waitFor()
  assert.equal(await page.getByRole('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth),true)
  await page.screenshot({path:`/tmp/partner-role-wizard-${width}-${dark?'dark':'light'}.png`})
  await page.getByRole('button',{name:'应用到身份草稿'}).click();assert.equal(await page.getByRole('dialog').count(),0)
  await page.getByText('背景资料', {exact:false}).click()
  await page.getByRole('button',{name:'添加世界条目'}).click();await page.getByLabel('条目标题').fill('图书馆');await page.getByLabel('触发词',{exact:false}).fill('图书馆，书架');await page.getByLabel('设定内容').fill('虚构场景里有一面蓝色书架。')
  await page.getByRole('tab',{name:'聊天方式',exact:true}).click()
  await page.getByLabel('额外聊天偏好（可选）',{exact:false}).fill('不习惯性追问，不把闲聊变成建议清单。')
  await page.getByRole('checkbox',{name:/分段回复/}).check()
  await page.getByRole('checkbox',{name:/表情包/}).check()
  await page.getByRole('button',{name:'管理表情库'}).click()
  await page.getByRole('dialog').getByText('6 张内置',{exact:false}).waitFor()
  assert.equal(await page.getByRole('dialog').getByRole('img').count(),6)
  assert.equal(await page.getByRole('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth),true)
  await page.screenshot({path:`/tmp/partner-stickers-${width}-${dark?'dark':'light'}.png`})
  await page.getByLabel('查找表情').fill('困')
  assert.equal(await page.getByRole('dialog').getByRole('img').count(),1)
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog').count(),0)
  assert.equal(await page.getByRole('button',{name:'管理表情库'}).evaluate(e=>document.activeElement===e),true)
  await page.getByRole('tab',{name:'角色设定',exact:true}).click()
  assert.equal(await page.getByLabel('闲聊节奏',{exact:false}).isVisible(),false)
  await page.getByRole('tab',{name:'基本身份',exact:false}).click()
  await page.getByLabel('名字',{exact:true}).fill('未保存的名字')
  await page.locator('#refresh-fixture').click()
  assert.equal(await page.getByLabel('名字',{exact:true}).inputValue(),'未保存的名字')
  await page.getByRole('tab',{name:'角色聊天',exact:false}).click()
  await page.getByRole('tab',{name:'聊天方式',exact:true}).click()
  assert.equal(await page.getByLabel('额外聊天偏好（可选）',{exact:false}).inputValue(),'不习惯性追问，不把闲聊变成建议清单。')
  await page.getByRole('tab',{name:'聊天方式',exact:true}).focus(); await page.keyboard.press('Home')
  assert.equal(await page.getByRole('tab',{name:'角色设定',exact:true}).getAttribute('aria-selected'),'true')
  await page.getByRole('button',{name:'保存身份',exact:true}).click();await page.getByText('已保存，下一轮将使用新身份').waitFor()
  assert.equal(await page.evaluate(()=>window.savedCompanion.model),'updated-model')
  assert.equal(await page.evaluate(()=>window.savedCompanion.name),'未保存的名字')
  assert.equal(await page.evaluate(()=>window.savedCompanion.characterCard.roleText),'坦率的同行者，闲聊简短，有自己的偏好。')
  assert.equal(await page.evaluate(()=>window.savedCompanion.characterCard.lore[0].title),'图书馆')
  assert.equal(await page.evaluate(()=>window.savedCompanion.characterCard.segmentedReplies),true)
  assert.equal(await page.evaluate(()=>window.savedCompanion.characterCard.stickersEnabled),true)
  assert.equal(await page.getByRole('button',{name:'设置角色',exact:true}).count(),0)
  assert.equal(await page.getByRole('switch',{name:'启用角色聊天'}).getAttribute('aria-checked'),'true')
  await page.getByRole('switch',{name:'启用角色聊天'}).click();assert.ok((await page.getByRole('textbox',{name:/角色设定/}).inputValue()).length>0)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await page.screenshot({path:`/tmp/partner-role-settings-${width}-${dark?'dark':'light'}.png`})
  await page.getByRole('button',{name:'打开记忆设置'}).click()
  assert.equal(await page.getByLabel('每日上下文焕新时间').isVisible(),false)
  await page.getByRole('switch',{name:'启用伙伴学习'}).click()
  await page.getByRole('tab',{name:'上下文焕新',exact:false}).click()
  assert.equal(await page.getByRole('switch',{name:'启用每日上下文焕新'}).getAttribute('aria-checked'),'true')
  assert.equal(await page.getByLabel('每日上下文焕新时间').inputValue(),'4')
  await page.getByLabel('每日上下文焕新时间').selectOption('5')
  await page.getByRole('tab',{name:'每日终审',exact:false}).click()
  await page.getByRole('tab',{name:'上下文焕新',exact:false}).click()
  assert.equal(await page.getByLabel('每日上下文焕新时间').inputValue(),'5')
  assert.equal(await page.getByRole('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth),true)
  await page.screenshot({path:`/tmp/partner-character-memory-${width}-${dark?'dark':'light'}.png`})
  await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0)
  assert.deepEqual(errors,[]);await page.close()
 }
 console.log('Role document, optional examples, chat settings, trial, independent renewal settings: desktop/mobile, light/dark passed.')
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
