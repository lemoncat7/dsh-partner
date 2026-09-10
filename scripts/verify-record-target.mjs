// Isolated UI smoke: no live partner state or note writes.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const { chromium } = await import(process.env.PARTNER_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
import {RecordTargetPicker} from './src/ui/memory/record-target-picker';
function App(){const [value,setValue]=useState();return <main className="dsh-partner-workspace"><form className="dsh-partner-concern-compose"><RecordTargetPicker companionId="test" value={value} onChange={setValue}/><output>{value?.locator ?? 'none'}</output></form></main>}
createRoot(document.getElementById('app')).render(<App/>);` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
const css = await readFile(new URL('../src/client.css', import.meta.url), 'utf8')
const server = createServer((req, res) => {
  if (req.url.includes('recording-sources')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ items: [{kind:'note',locator:'note1',label:'禅道问题单及很长的记录名称.md'},{kind:'file',locator:'docs/log.md',label:'docs/log.md'}] })); return }
  res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="app"></div><script>'+bundle.outputFiles[0].text+'</script>')
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser = await chromium.launch({headless:true, ...(process.env.PARTNER_CHROMIUM ? {executablePath:process.env.PARTNER_CHROMIUM}:{}),args:['--no-sandbox']})
try {
  const page = await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.addStyleTag({content:css+' body{margin:0} .dsh-partner-workspace{display:block;width:100%;box-sizing:border-box} .dsh-partner-concern-compose{box-sizing:border-box} input{box-sizing:border-box} '})
  for(const width of [375,1024]){
    await page.setViewportSize({width,height:800})
    await page.getByRole('textbox').focus()
    const note=page.getByRole('button',{name:/笔记文档 禅道/});await note.waitFor();await note.focus();await page.keyboard.press('Enter')
    assert.equal(await page.locator('output').textContent(),'note1')
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
    await page.getByRole('button',{name:'取消记录'}).click();assert.equal(await page.locator('output').textContent(),'none')
  }
  await page.screenshot({path:'/tmp/partner-record-target.png',fullPage:true})
  assert.deepEqual(errors,[]);console.log('record target picker: 375/1024px, keyboard selection, clear, no overflow passed')
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
