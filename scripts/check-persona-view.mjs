import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {build} from 'esbuild'
const {chromium} = await import(process.env.PARTNER_PLAYWRIGHT_MODULE || 'playwright')
const bundle = await build({
  stdin:{contents:`import React from 'react'; import {createRoot} from 'react-dom/client';
    import {PersonaView} from './src/ui/memory/persona-view.tsx';
    const view={status:'ready',version:'v1',stale:false,paragraphs:[{id:'one',topic:'collaboration',basis:'observed',text:'从近期交流看，用户倾向于先确认可行性，再安排开发。'.repeat(4),evidence:[{id:'t1',kind:'turn',text:'先核验可行性再开发',at:1,signature:'s',turnIds:['t1']}]}]};
    createRoot(document.getElementById('root')).render(<div className="dsh-partner-memory-page"><div className="dsh-partner-memory-profile"><PersonaView view={view} base="/companions/c" scopeId="s" enabled={true} changed={async()=>{}} /></div></div>);`,
    resolveDir:process.cwd(),loader:'tsx'},
  bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',
  plugins:[{name:'icons',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'icons',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const IconAgentPresetOutline16=()=>null; export const IconCloseOutline16=()=>null;',loader:'js'}))}}],
})
const css=(await Promise.all(['src/client.css','src/ui/workspace-ui.css','src/ui/form-surface.css','src/ui/memory/memory-ui.css'].map(file=>readFile(file,'utf8')))).join('\n')
const browser=await chromium.launch({headless:true})
try {
  for(const viewport of [{width:1200,height:800},{width:390,height:844},{width:900,height:420}]) {
    const page=await browser.newPage({viewport})
    const errors=[]
    page.on('pageerror',error=>errors.push(error.message))
    await page.setContent(`<style>${css}
      body{margin:0;padding:16px;box-sizing:border-box} #root{--partner-font-family:system-ui;--partner-font-body:14px;--partner-font-caption:12px;--partner-solid-panel:#eee;--partner-text:#222}
    </style><div id="root"></div>`)
    await page.addScriptTag({content:bundle.outputFiles[0].text})
    assert.equal(await page.getByRole('button',{name:'纠正这段理解'}).isVisible(),false)
    await page.locator('.dsh-partner-persona > summary').click()
    await page.getByText('依据与修正',{exact:true}).click()
    await page.getByRole('button',{name:'纠正这段理解'}).click()
    await page.waitForFunction(()=>document.querySelector('dialog')?.matches(':modal'))
    const rect=await page.locator('.dsh-partner-workspace-dialog').boundingBox()
    assert.ok(rect.x>=0 && rect.x+rect.width<=viewport.width+1)
    assert.ok(rect.y>=0 && rect.y+rect.height<=viewport.height+1)
    await page.getByLabel('正确的理解').fill('这个偏好仅适用于开发项目')
    await page.keyboard.press('Escape')
    await page.waitForFunction(()=>!document.querySelector('dialog'))
    await page.getByText('查看依据 · 1',{exact:true}).click()
    assert.ok(await page.getByText('先核验可行性再开发',{exact:true}).isVisible())
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
    assert.deepEqual(errors,[])
    console.log(`PASS persona ${viewport.width}x${viewport.height}: evidence, correction dialog, no overflow`)
    await page.close()
  }
} finally {await browser.close()}
