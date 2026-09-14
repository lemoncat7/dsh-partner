import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {build} from 'esbuild'
const {chromium}=await import(process.env.PARTNER_PLAYWRIGHT_MODULE?pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href:'playwright-core')
const bundle=await build({stdin:{resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {ChannelsPanel} from './src/ui/channels-panel';
const companion={id:'fixture',name:'伙伴',capabilities:[]};
const snapshot={channels:[{id:'mx',companionId:'fixture',platform:'matrix',name:'Matrix',enabled:true,runtimeStatus:'running',lastError:'检测到 Matrix 加密会话，只有未加密的双人会话才能获取配对码；请新建未加密会话并邀请机器人。'},{id:'mm',companionId:'fixture',platform:'mattermost',name:'Mattermost',enabled:true}],pairings:[{id:'a',channelId:'mx',userId:'@alice:example.test',displayName:'Alice',status:'approved'},{id:'b',channelId:'mm',userId:'bob',displayName:'Bob',status:'approved'}]};
createRoot(document.getElementById('app')).render(<main className="dsh-partner-workspace"><ChannelsPanel companion={companion} snapshot={snapshot} onChanged={async()=>{}} weixin={<p>微信配置</p>}/></main>);
`},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'text','.module.css':'text'}})
const css=(await Promise.all(['client.css','ui/workspace-ui.css','ui/responsive-ui.css','ui/form-surface.css'].map(name=>readFile(new URL('../src/'+name,import.meta.url),'utf8')))).join('\n')
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].contents:'<meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script src="/app.js"></script>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try{
  for(const dark of [false,true])for(const width of [375,1024]){
    const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'})
    const errors=[];page.on('pageerror',error=>errors.push(error.message))
    let body,fail=true
    await page.route('**/companions/fixture/notifications',async route=>{body=route.request().postDataJSON();await route.fulfill({status:fail?400:200,contentType:'application/json',body:JSON.stringify(fail?{error:'测试：请重试'}:{ok:true})})})
    await page.goto('http://127.0.0.1:'+server.address().port)
    await page.addStyleTag({content:css})
    await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark)
    const notice=page.locator('.dsh-partner-channel-inline-notice')
    await notice.waitFor()
    assert.equal(await page.getByRole('dialog').count(),0)
    const bounds=await notice.boundingBox(),button=await page.getByRole('button',{name:'配置 Matrix',exact:true}).boundingBox()
    assert.ok(bounds.y>=button.y+button.height)
    assert.equal(await notice.evaluate(el=>el.scrollWidth<=el.clientWidth),true)
    await page.screenshot({path:'/tmp/partner-channel-notice-'+width+'-'+(dark?'dark':'light')+'.png'})
    await page.locator('.dsh-partner-channel-notifications button').click()
    const dialog=page.getByRole('dialog')
    await page.getByLabel('通知发送到').selectOption('selected')
    await page.getByRole('checkbox',{name:'Matrix',exact:true}).check()
    assert.equal(await page.getByRole('button',{name:'保存通知设置'}).isDisabled(),true)
    await page.getByRole('checkbox',{name:'Alice',exact:false}).check()
    await page.getByRole('checkbox',{name:'Mattermost',exact:true}).check()
    await page.getByRole('checkbox',{name:'Bob',exact:false}).check()
    await page.getByRole('button',{name:'保存通知设置'}).click()
    await page.getByRole('alert').waitFor()
    assert.deepEqual(body,{mode:'selected',targetPairingIds:['a','b']})
    assert.equal(await page.getByRole('checkbox',{name:'Alice',exact:false}).isChecked(),true)
    fail=false
    await page.getByRole('button',{name:'保存通知设置'}).click()
    await page.getByText('通知设置已保存',{exact:true}).waitFor()
    assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true)
    await page.screenshot({path:'/tmp/partner-notifications-'+width+'-'+(dark?'dark':'light')+'.png'})
    await page.getByLabel('通知发送到').selectOption('recent')
    await page.getByRole('button',{name:'保存通知设置'}).click()
    await page.waitForTimeout(100)
    assert.deepEqual(body,{mode:'recent',targetPairingIds:[]})
    await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'})
    assert.deepEqual(errors,[])
    await page.close()
  }
  console.log('Notification channel/user selection, retry, recent fallback, keyboard dismissal and 375/1024 light/dark layout passed.')
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
