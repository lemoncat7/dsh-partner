import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const { chromium } = await import(process.env.PARTNER_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const bundle = await build({ nodePaths: (process.env.DSH_UI_TEST_NODE_PATH ?? '').split(':').filter(Boolean), alias: {react: fileURLToPath(new URL('../node_modules/react',import.meta.url))}, stdin: { resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx', contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ChannelsPanel} from './src/ui/channels-panel';
const companion={id:'fixture',name:'测试伙伴',role:'资料整理',description:'',instructions:'测试身份',capabilities:[],updatedAt:1};
const initial={channels:[{id:'qq-fixture',companionId:'fixture',platform:'qq',name:'QQ · SnowLuma',accountId:'12345678',enabled:true,runtimeStatus:'running',updatedAt:1,direct:{baseUrl:'ws://snowluma:3001',targetId:''}}],pairings:[{id:'p1',channelId:'qq-fixture',userId:'22345678',displayName:'测试联系人',status:'approved'},{id:'p2',channelId:'qq-fixture',userId:'group:99887766:22345678',displayName:'群 99887766 · QQ 22345678',status:'pending',pairingCode:'123456'}]};
function Fixture(){const [snapshot,setSnapshot]=useState(initial);return <main className="dsh-partner-workspace"><ChannelsPanel companion={companion} snapshot={snapshot} onChanged={async()=>{const s=await (await fetch('/fixture')).json();setSnapshot(s)}} weixin={<p>微信配置</p>}/></main>};createRoot(document.getElementById('app')).render(<Fixture/>);
` }, bundle:true, write:false, format:'iife', jsx:'automatic', loader:{'.css':'text','.module.css':'text'} })
const css = (await Promise.all(['client.css','ui/workspace-ui.css','ui/responsive-ui.css','ui/identity-editor.css','ui/form-surface.css','ui/interaction-theme.css','ui/control-surfaces.css','ui/qq-channel-settings.css'].map(name=>readFile(new URL('../src/'+name,import.meta.url),'utf8')))).join('\n')
const server=createServer((req,res)=>{if(req.url==='/fixture'){res.setHeader('content-type','application/json');res.end(JSON.stringify({channels:[{id:'qq-fixture',companionId:'fixture',platform:'qq',name:'QQ · SnowLuma',accountId:'12345678',enabled:true,runtimeStatus:'running',updatedAt:1,direct:{baseUrl:'ws://snowluma:3001',targetId:''}}],pairings:[{id:'p1',channelId:'qq-fixture',userId:'22345678',displayName:'测试联系人',status:'approved'}]}));return}res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].contents:'<meta name="viewport" content="width=device-width,initial-scale=1"><body id="root"><div id="app"></div><script src="/app.js"></script>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({headless:true})
try {
  for(const dark of [false,true]) for(const width of [375,1024]) {
    const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'})
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.addStyleTag({content:css})
    await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark)
    let sends=0,saveBody
    await page.route('**/partner-local/v1/**',async route=>{
      const url=route.request().url()
      if(url.endsWith('/send'))sends++
      if(url.endsWith('/settings'))saveBody=route.request().postDataJSON()
      const result=url.endsWith('/groups')?{groups:[{id:'99887766',name:'产品交流群'},{id:'88776655',name:'较长名称的另一个群组，测试移动端换行布局'}]}:url.endsWith('/friends')?{friends:[{id:'22345678',name:'测试联系人'}]}:url.endsWith('/faces')?{faces:[{id:'14',name:'微笑',category:'经典表情'},{id:'1',name:'撇嘴',category:'经典表情'}]}:{ok:true}
      await route.fulfill({json:result})
    })
    await page.getByRole('button',{name:'配置 QQ · SnowLuma',exact:true}).click()
    const dialog=page.getByRole('dialog')
    const noOverflow=async()=>assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true)
    await noOverflow()
    assert.equal(await dialog.getByLabel('WS Access Token',{exact:false}).count(),0)
    await page.screenshot({path:`/tmp/partner-qq-settings-home-${width}-${dark?'dark':'light'}.png`})
    await dialog.getByRole('button',{name:/群聊回复.*选择群组/}).click()
    assert.equal(await dialog.getByRole('switch',{name:'群聊回复'}).getAttribute('aria-checked'),'false')
    await dialog.getByRole('switch',{name:'群聊回复'}).click()
    assert.equal(await dialog.getByLabel('其他群何时回复').inputValue(),'mention')
    await dialog.getByRole('button',{name:/选择群组.*从机器人/}).click()
    await dialog.getByRole('button',{name:'读取已加入的群'}).click()
    await dialog.getByRole('checkbox',{name:/产品交流群/}).check()
    await noOverflow()
    assert.equal(await dialog.getByRole('checkbox').first().evaluate(el=>getComputedStyle(el).appearance),'auto')
    assert.equal(await dialog.locator('.dsh-partner-qq-save').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)')
    await page.screenshot({path:`/tmp/partner-qq-settings-groups-${width}-${dark?'dark':'light'}.png`})
    await page.keyboard.press('Escape')
    const confirm=page.getByRole('alertdialog')
    await confirm.getByRole('button',{name:'继续编辑'}).click()
    await Promise.all([page.waitForResponse(r=>r.url().endsWith('/qq/settings')),dialog.getByRole('button',{name:'保存设置',exact:true}).click()])
    await dialog.getByRole('status').filter({hasText:'设置已保存'}).waitFor()
    assert.equal(saveBody.settings.groupReplies,true);assert.deepEqual(saveBody.settings.groupIds,['99887766'])
    assert.equal(saveBody.settings.stickerSource,'channel')
    // Fixture refresh is intentionally static; restore local changes before browsing.
    await dialog.getByRole('button',{name:'‹ 群聊回复',exact:true}).click()
    await dialog.getByRole('button',{name:/自主回复白名单/}).click()
    await dialog.getByRole('checkbox').first().check()
    await noOverflow()
    await dialog.getByRole('button',{name:'‹ 群聊回复',exact:true}).click()
    await dialog.getByRole('button',{name:/选择群组.*从机器人/}).click()
    await dialog.getByRole('button',{name:'还原',exact:true}).click()
    await dialog.getByRole('button',{name:'‹ 群聊回复',exact:true}).click()
    await dialog.getByRole('button',{name:'‹ QQ 设置',exact:true}).click()
    await dialog.getByRole('button',{name:/会话与记忆.*独立聊天/}).click()
    await dialog.getByRole('button',{name:'读取好友与群'}).click()
    await dialog.getByRole('checkbox',{name:/测试联系人/}).check()
    await dialog.getByRole('button',{name:'群聊',exact:true}).click()
    await dialog.getByRole('checkbox',{name:/产品交流群/}).check()
    await noOverflow()
    await page.screenshot({path:`/tmp/partner-qq-settings-sessions-${width}-${dark?'dark':'light'}.png`})
    await Promise.all([page.waitForResponse(r=>r.url().endsWith('/qq/settings')),dialog.getByRole('button',{name:'保存设置',exact:true}).click()])
    await dialog.getByRole('status').filter({hasText:'设置已保存'}).waitFor()
    assert.deepEqual(saveBody.settings.mainSessionPeers,['private:22345678','group:99887766'])
    await dialog.getByRole('button',{name:'还原',exact:true}).click()
    await dialog.getByRole('button',{name:'‹ QQ 设置',exact:true}).click()
    await dialog.getByRole('button',{name:/发送消息.*选择已授权/}).click()
    await dialog.getByRole('button',{name:'QQ 表情',exact:true}).click()
    await dialog.getByRole('button',{name:/微笑/}).click()
    await noOverflow()
    assert.equal(await dialog.getByRole('button',{name:'发送到所选接收人'}).isDisabled(),true)
    await dialog.getByLabel(/^接收人/).selectOption('22345678')
    assert.equal(await dialog.getByRole('button',{name:'发送到所选接收人'}).isEnabled(),true)
    assert.equal(sends,0)
    await page.screenshot({path:`/tmp/partner-qq-settings-faces-${width}-${dark?'dark':'light'}.png`})
    await page.keyboard.press('Escape');assert.equal(await dialog.count(),0)
    await page.close()
  }
  console.log('QQ settings: layered navigation, group selection, draft save/discard, native face preview, mobile/desktop light/dark; browsing never sends messages.')
} finally {await browser.close();await new Promise(resolve=>server.close(resolve))}
