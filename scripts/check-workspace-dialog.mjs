import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {build} from 'esbuild'

// Optional browser check: point PARTNER_PLAYWRIGHT_MODULE at an existing installation.
const {chromium} = await import(process.env.PARTNER_PLAYWRIGHT_MODULE || 'playwright')
const bundle = await build({
  stdin: {contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {WorkspaceDialog,DiscardChangesDialog} from './src/ui/workspace-components.tsx';
    function App(){const [open,setOpen]=React.useState(false),[confirm,setConfirm]=React.useState(false);return <><button id="open" onClick={()=>setOpen(true)}>打开</button>{open&&<WorkspaceDialog title="每日回顾" detail="定位回归测试" close={()=>setOpen(false)}><form onSubmit={e=>e.preventDefault()}><label>标题<input aria-label="标题" defaultValue="保留的草稿"/></label><div style={{height:1400}}>长内容</div><footer><button type="button" onClick={()=>setConfirm(true)}>关闭编辑</button><button type="submit">保存</button></footer></form></WorkspaceDialog>}{confirm&&<DiscardChangesDialog keepEditing={()=>setConfirm(false)} discard={()=>{setConfirm(false);setOpen(false)}}/>}</>}
    createRoot(document.getElementById('root')).render(<App/>);`, resolveDir:process.cwd(), loader:'tsx'},
  bundle:true, write:false, format:'iife', platform:'browser', jsx:'automatic',
  plugins:[{name:'test-icons',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'icons',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const IconAgentPresetOutlineRegular=()=>null; export const IconCloseOutlineRegular=()=>null;',loader:'js'}))}}],
})
const css=(await Promise.all(['src/client.css','src/ui/workspace-ui.css','src/ui/responsive-ui.css','src/ui/interaction-theme.css'].map(file=>readFile(file,'utf8')))).join('\n')
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try {
  for(const viewport of [{width:1200,height:800},{width:375,height:844},{width:900,height:420}]) for(const dark of [false,true]) {
    const page=await browser.newPage({viewport,reducedMotion:'reduce'})
    await page.setContent(`<style>${css}
      body{margin:0} #root{position:relative;transform:translateZ(0);height:3000px} #open{margin-top:1700px}
      </style><div id="root" class="dsh-partner-workspace"></div>`)
    await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark)
    await page.addScriptTag({content:bundle.outputFiles[0].text})
    await page.locator('#open').scrollIntoViewIfNeeded()
    const before=await page.evaluate(()=>scrollY)
    await page.locator('#open').click()
    await page.waitForFunction(()=>document.querySelector('dialog')?.matches(':modal'))
    const rect=await page.locator('.dsh-partner-workspace-dialog').boundingBox()
    assert.ok(Math.abs(rect.x+rect.width/2-viewport.width/2)<2)
    assert.ok(Math.abs(rect.y+rect.height/2-viewport.height/2)<2)
    assert.ok(rect.y>=0 && rect.y+rect.height<=viewport.height+1)
    assert.equal(await page.evaluate(()=>scrollY),before)
    assert.equal(await page.locator('.dsh-partner-workspace-dialog').evaluate(el=>getComputedStyle(el).borderRadius),viewport.width<=760?'22px':'24px')
    await page.getByRole('button',{name:'关闭编辑',exact:true}).click()
    await page.getByRole('alertdialog').waitFor()
    assert.equal(await page.evaluate(()=>document.activeElement.textContent),'继续编辑')
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('alertdialog').count(),0)
    assert.equal(await page.getByLabel('标题',{exact:true}).inputValue(),'保留的草稿')
    await page.screenshot({path:`/tmp/partner-style-dialog-${viewport.width}-${dark?'dark':'light'}.png`})
    for(let i=0;i<4;i++) await page.keyboard.press('Tab')
    assert.ok(await page.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)))
    await page.keyboard.press('Escape')
    await page.waitForFunction(()=>!document.querySelector('dialog'))
    assert.equal(await page.evaluate(()=>scrollY),before)
    assert.equal(await page.evaluate(()=>document.activeElement.id),'open')
    await page.close()
    console.log(`PASS dialog viewport ${viewport.width}x${viewport.height} dark=${dark}: centered, focus-contained, scroll-preserved, nested discard retains draft`)
  }
} finally {await browser.close()}
