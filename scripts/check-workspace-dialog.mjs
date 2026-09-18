import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {build} from 'esbuild'

// Optional browser check: point PARTNER_PLAYWRIGHT_MODULE at an existing installation.
const {chromium} = await import(process.env.PARTNER_PLAYWRIGHT_MODULE || 'playwright')
const bundle = await build({
  stdin: {contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {WorkspaceDialog} from './src/ui/workspace-components.tsx';
    function App(){const [open,setOpen]=React.useState(false);return <><button id="open" onClick={()=>setOpen(true)}>打开</button>{open&&<WorkspaceDialog title="每日回顾" detail="定位回归测试" close={()=>setOpen(false)}><div style={{height:1400}}>长内容</div><button>保存</button></WorkspaceDialog>}</>}
    createRoot(document.getElementById('root')).render(<App/>);`, resolveDir:process.cwd(), loader:'tsx'},
  bundle:true, write:false, format:'iife', platform:'browser', jsx:'automatic',
  plugins:[{name:'test-icons',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'icons',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const IconAgentPresetOutline16=()=>null; export const IconCloseOutline16=()=>null;',loader:'js'}))}}],
})
const css=await readFile('src/ui/workspace-ui.css','utf8')
const browser=await chromium.launch({headless:true})
try {
  for(const viewport of [{width:1200,height:800},{width:390,height:844},{width:900,height:420}]) {
    const page=await browser.newPage({viewport,reducedMotion:'reduce'})
    await page.setContent(`<style>${css}
      body{margin:0} #root{position:relative;transform:translateZ(0);height:3000px;--partner-dialog-veil:transparent;--partner-solid-panel:#eee;--partner-solid-raised:#eee;--partner-text:#222} #open{margin-top:1700px}
      </style><div id="root"></div>`)
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
    for(let i=0;i<4;i++) await page.keyboard.press('Tab')
    assert.ok(await page.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)))
    await page.keyboard.press('Escape')
    await page.waitForFunction(()=>!document.querySelector('dialog'))
    assert.equal(await page.evaluate(()=>scrollY),before)
    assert.equal(await page.evaluate(()=>document.activeElement.id),'open')
    await page.close()
    console.log(`PASS dialog viewport ${viewport.width}x${viewport.height}: centered, focus-contained, scroll-preserved`)
  }
} finally {await browser.close()}
