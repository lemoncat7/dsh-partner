import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {build} from 'esbuild'
const {chromium}=await import(pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href)
// Host icons are supplied by DSH; isolate them from its full runtime in this fixture.
const icons={name:'host-icons',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'icons',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const IconAgentPresetOutlineRegular=()=>null; export const IconCloseOutlineRegular=()=>null;'}))}}
const bundle=await build({nodePaths:(process.env.DSH_UI_TEST_NODE_PATH??'').split(':').filter(Boolean),alias:{react:fileURLToPath(new URL('../node_modules/react',import.meta.url))},stdin:{resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {PushChannels} from './src/ui/push-channels';
createRoot(document.getElementById('app')).render(<main className="dsh-partner-workspace"><section id="dsh-partner-channels" className="dsh-partner-form"><PushChannels companion={{id:'fixture'}} snapshot={{pushChannels:[]}} onChanged={async()=>{}} adding={false} closeAdd={()=>{}}/></section></main>);
`},plugins:[icons],bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'text','.module.css':'text'}})
const css=(await Promise.all(['client.css','ui/workspace-ui.css','ui/responsive-ui.css','ui/form-surface.css','ui/interaction-theme.css','ui/control-surfaces.css'].map(name=>readFile(new URL('../src/'+name,import.meta.url),'utf8')))).join('\n')
const themeSource=process.env.PARTNER_THEME_CONTROLS_FILE?await readFile(process.env.PARTNER_THEME_CONTROLS_FILE,'utf8'):''
const themeCss=themeSource.slice(themeSource.indexOf('`')+1,themeSource.lastIndexOf('`'))
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].contents:'<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"><div id="app"></div></div><script src="/app.js"></script>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
let currentPage
try {
  for(const dark of [false,true])for(const width of [375,1024]) {
    const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'}),errors=[],requests=[]
    currentPage=page
    let failSave=false
    page.on('pageerror',e=>errors.push(e.message))
    await page.route(url=>url.pathname.startsWith('/partner-local/v1/push-channels'),async route=>{
      const req=route.request();requests.push({method:req.method(),url:req.url(),body:req.postData()?req.postDataJSON():null})
      let result={ok:true,message:'Bark 服务端已接受，请检查设备通知。'}
      if(req.method()==='POST'&&req.url().endsWith('/push-channels')||req.method()==='PUT') {
        if(failSave) {await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'fixture save failure'})});return}
        const body=req.postDataJSON();result={...body,id:'saved',revision:(body.revision??0)+1,targets:body.targets.map((t,i)=>({id:t.id||'target-'+i,name:t.name,enabled:t.enabled,configured:true}))}
      } else if(req.method()==='GET') result=[]
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)})
    })
    await page.goto('http://127.0.0.1:'+server.address().port);await page.addStyleTag({content:css})
    if(themeCss)await page.addStyleTag({content:themeCss})
    await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark)
    await page.getByRole('button',{name:'配置',exact:true}).click()
    // Merely inspecting a fresh form must not create an unsaved draft.
    await page.getByText('高级选项',{exact:true}).click()
    await page.getByLabel('通知内容',{exact:false}).focus()
    await page.getByLabel('通知内容',{exact:false}).selectOption('summary')
    await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click()
    assert.equal(await page.getByRole('alertdialog').count(),0)
    assert.equal(await page.getByRole('dialog').count(),0)
    await page.getByRole('button',{name:'配置',exact:true}).click()
    await page.getByLabel('渠道名称',{exact:true}).fill('temporary')
    await page.getByLabel('渠道名称',{exact:true}).fill('')
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('alertdialog').count(),0)
    assert.equal(await page.getByRole('dialog').count(),0)
    await page.getByRole('button',{name:'配置',exact:true}).click()
    const surfaces=await page.locator('.dsh-partner-workspace-dialog-body').evaluate(el=>({body:getComputedStyle(el).backgroundColor,footer:getComputedStyle(el.querySelector('form > footer')).backgroundColor}))
    assert.equal(surfaces.footer,surfaces.body,'sticky footer and body share one opaque surface')
    const enabled=page.getByRole('checkbox',{name:'启用完成通知',exact:true})
    assert.equal(await enabled.isChecked(),true)
    assert.equal(await enabled.evaluate(el=>getComputedStyle(el).opacity),'0')
    const marker=enabled.locator('..').locator('i')
    assert.equal(await marker.evaluate(el=>getComputedStyle(el,'::after').content),'""')
    await enabled.focus();await page.keyboard.press('Space')
    assert.equal(await enabled.isChecked(),false)
    assert.equal(await marker.evaluate(el=>getComputedStyle(el,'::after').content),'none')
    assert.notEqual(await marker.evaluate(el=>getComputedStyle(el).outlineStyle),'none')
    await enabled.locator('..').click();assert.equal(await enabled.isChecked(),true)
    const device=page.getByRole('checkbox',{name:'启用目标 1',exact:true})
    await device.locator('..').click();assert.equal(await device.isChecked(),false)
    await device.locator('..').click();assert.equal(await device.isChecked(),true)
    await page.getByLabel('渠道名称',{exact:true}).fill('测试 Bark')
    await page.keyboard.press('Escape')
    await page.getByRole('alertdialog').waitFor()
    await page.screenshot({path:`/tmp/partner-style-discard-${width}-${dark?'dark':'light'}.png`})
    await page.getByRole('button',{name:'继续编辑',exact:true}).click()
    assert.equal(await page.getByLabel('渠道名称',{exact:true}).inputValue(),'测试 Bark','discard confirmation must retain the draft')
    await page.getByLabel('Device Key 1',{exact:true}).fill('https://bark.example.test/device-test')
    assert.equal(await page.getByLabel('服务器地址',{exact:true}).inputValue(),'https://bark.example.test')
    await page.getByRole('button',{name:'添加目标',exact:true}).click()
    await page.getByLabel('Device Key 2',{exact:true}).fill('second-device')
    await page.getByLabel('设备名称 2',{exact:true}).fill('iPad')
    await page.getByRole('button',{name:'保存渠道',exact:true}).click()
    await page.getByText('已保存，下一次完成事件起自动通知。',{exact:true}).waitFor()
    assert.equal(await page.getByLabel('Device Key 1',{exact:true}).inputValue(),'')
    assert.equal(await page.getByRole('button',{name:'保存渠道',exact:true}).isDisabled(),true)
    await page.getByLabel('Device Key 1',{exact:true}).fill('replacement-key')
    assert.equal(await page.getByRole('button',{name:'保存渠道',exact:true}).isEnabled(),true)
    await page.getByLabel('Device Key 1',{exact:true}).fill('')
    assert.equal(await page.getByRole('button',{name:'保存渠道',exact:true}).isDisabled(),true)
    await page.getByLabel('渠道名称',{exact:true}).fill('failed change')
    failSave=true
    await page.getByRole('button',{name:'保存渠道',exact:true}).click()
    await page.getByRole('alert').waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('alertdialog').waitFor()
    await page.getByRole('button',{name:'继续编辑',exact:true}).click()
    assert.equal(await page.getByLabel('渠道名称',{exact:true}).inputValue(),'failed change')
    failSave=false
    await page.getByLabel('渠道名称',{exact:true}).fill('测试 Bark')
    assert.equal(await page.getByRole('button',{name:'保存渠道',exact:true}).isDisabled(),true)
    await page.getByRole('button',{name:'测试',exact:true}).first().click()
    await page.getByText('Bark 服务端已接受，请检查设备通知。',{exact:true}).waitFor()
    await page.getByText('高级选项',{exact:true}).click()
    const problems=page.getByRole('checkbox',{name:'同时通知最终失败或需要处理的受阻结果',exact:true})
    await problems.locator('..').click();assert.equal(await problems.isChecked(),true)
    await page.getByLabel('通知内容',{exact:false}).selectOption('title')
    await page.getByRole('button',{name:'保存渠道',exact:true}).click()
    await page.getByText('已保存，下一次完成事件起自动通知。',{exact:true}).waitFor()
    assert.equal(requests.at(-1).body.targets[0].key,'')
    await page.getByRole('button',{name:'发送记录',exact:true}).click()
    await page.getByText('暂无通知。保存只影响之后的新结果，不补发历史对话。',{exact:true}).waitFor()
    const dialog=page.getByRole('dialog')
    assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true)
    assert.equal(await page.locator('.dsh-partner-push-targets').evaluate(el=>el.scrollWidth<=el.clientWidth),true)
    await page.screenshot({path:'/tmp/partner-bark-'+width+'-'+(dark?'dark':'light')+'.png'})
    await page.getByRole('button',{name:'删除渠道',exact:true}).click()
    await page.getByRole('button',{name:'确认删除',exact:true}).waitFor()
    assert.ok(!requests.some(r=>r.method==='DELETE'))
    await page.getByRole('button',{name:'取消',exact:true}).click()
    assert.deepEqual(errors,[]);await page.close()
  }
  console.log('Bark creation, masked edit, URL paste, multiple targets, test, records, delete confirmation and 375/1024 light/dark layout passed.')
} catch(error) {await currentPage?.screenshot({path:'/tmp/partner-style-bark-failure.png'});console.error(await currentPage?.locator('body').innerText());throw error}
finally {await browser.close();await new Promise(resolve=>server.close(resolve))}
