import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const { chromium } = await import(process.env.PARTNER_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx', contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {IdentityEditor} from './src/ui/identity-editor';import {ChannelsPanel} from './src/ui/channels-panel';
const companion={id:'fixture',name:'测试伙伴',role:'资料整理',description:'',instructions:'测试身份',capabilities:[],updatedAt:1};
const snapshot={channels:[{id:'c',companionId:'fixture',platform:'matrix',name:'Matrix',enabled:false,runtimeStatus:'stopped'}],pairings:Array.from({length:3},(_,i)=>({id:'p'+i,channelId:'c',userId:'u'+i,displayName:'联系人'+i,status:'approved',updatedAt:1}))};
function Fixture(){const [channel,setChannel]=useState(false);return <main className="dsh-partner-workspace"><button id="switch" onClick={()=>setChannel(!channel)}>切换页面</button>{channel?<ChannelsPanel companion={companion} snapshot={snapshot} onChanged={async()=>{}} weixin={<p>微信配置</p>}/>:<IdentityEditor companion={companion} count={2} onChanged={async()=>{}} onRemoved={async()=>{}}/>}</main>};createRoot(document.getElementById('app')).render(<Fixture/>);
` }, bundle:true, write:false, format:'iife', jsx:'automatic', loader:{'.css':'text','.module.css':'text'} })
const css = (await Promise.all(['client.css','ui/workspace-ui.css','ui/responsive-ui.css','ui/identity-editor.css','ui/form-surface.css'].map(name=>readFile(new URL('../src/'+name,import.meta.url),'utf8')))).join('\n')
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].contents:'<meta name="viewport" content="width=device-width,initial-scale=1"><body id="root"><div id="app"></div><script src="/app.js"></script>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({headless:true})
try {
  for(const dark of [false,true]) for(const width of [375,1024]) {
    const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'})
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.addStyleTag({content:css})
    await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark)
    await page.addStyleTag({content:'#root button,#root input,#root textarea,#root select,#root form,#root dialog {background: magenta !important;border-radius:0 !important;color:lime !important;font-family:serif !important;box-shadow:0 0 20px red !important;} '})
    const check=async locator=>{const style=await locator.evaluate(el=>{const s=getComputedStyle(el);return {radius:s.borderRadius,bg:s.backgroundColor,font:s.fontFamily}});assert.equal(style.radius,'10px');assert.notEqual(style.bg,'rgb(255, 0, 255)');assert.notEqual(style.font,'serif')}
    await check(page.getByRole('button',{name:'保存身份',exact:true}))
    await check(page.locator('#dsh-partner-identity-editor input').first())
    await page.locator('#switch').click()
    await check(page.getByRole('button',{name:'添加渠道',exact:true}))
    await page.getByRole('button',{name:'添加渠道',exact:true}).click()
    await check(page.getByRole('button',{name:'保存渠道',exact:true}))
    const dialog=page.getByRole('dialog')
    assert.notEqual(await dialog.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 0, 255)')
    assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true)
    await page.screenshot({path:`/tmp/partner-form-${width}-${dark?'dark':'light'}.png`})
    await page.keyboard.press('Escape')
    assert.equal(await dialog.count(),0)
    await page.locator('.dsh-partner-channel-notifications button').click()
    assert.equal(await page.getByLabel('通知发送到').inputValue(),'recent')
    assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true)
    assert.ok((await dialog.boundingBox()).height<600,'delivery is content sized, not full height')
    await page.screenshot({path:`/tmp/partner-delivery-${width}-${dark?'dark':'light'}.png`})
    await page.getByLabel('通知发送到').selectOption('selected')
    await page.getByRole('checkbox',{name:'Matrix（已停用）',exact:true}).check()
    assert.equal(await page.locator('.dsh-partner-notification-users input').count(),3)
    await page.keyboard.press('Escape')
    await page.close()
  }
  console.log('Identity/channel controls resist late theme overrides; mobile/desktop and light/dark passed.')
} finally {await browser.close();await new Promise(resolve=>server.close(resolve))}
