import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from '/home/moye/Online Document/infinite-canvas/node_modules/playwright/index.mjs'
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'partner-segment-ui-'))
let browser
try{
 const result=await build({stdin:{contents:`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{SegmentDelayFields}from'./src/ui/segment-delay-fields';import{emptyCharacterCard,normalizeCharacterCard}from'./src/character/domain';import css from './src/ui/character-editor.css';document.head.appendChild(Object.assign(document.createElement('style'),{textContent:css}));let saved=emptyCharacterCard();function App(){const[card,setCard]=useState(saved);const[error,setError]=useState('');return <main className="dsh-partner-character"><div className="dsh-partner-chat-options"><label><input type="checkbox" checked={!!card.segmentedReplies} onChange={e=>setCard({...card,segmentedReplies:e.target.checked})}/>允许分段回复</label><SegmentDelayFields card={card} onChange={setCard}/></div><button onClick={()=>{try{saved=JSON.parse(JSON.stringify(normalizeCharacterCard(card)));setError('已保存')}catch(e){setError(e.message)}}}>保存</button><button onClick={()=>setCard(saved)}>重新打开</button><output>{error}</output></main>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,format:'iife',write:false,loader:{'.css':'text'},jsx:'automatic'})
 browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-webgl']});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.setContent('<html><head><style>body{margin:16px;background:#20232b;color:#eee;--partner-border:#455;--partner-text-secondary:#bbc;--partner-control:#30343c;--partner-text:#eee}input{box-sizing:border-box;padding:8px}main{max-width:640px}</style></head><body><div id="root"></div></body></html>');await page.addScriptTag({content:result.outputFiles[0].text})
 assert.equal(await page.getByRole('checkbox',{name:'分段随机间隔'}).isDisabled(),true)
 await page.getByRole('checkbox',{name:'允许分段回复'}).check();await page.getByRole('checkbox',{name:'分段随机间隔'}).check();assert.equal(await page.getByLabel('最短').inputValue(),'1');assert.equal(await page.getByLabel('最长').inputValue(),'3')
 await page.getByLabel('最短').fill('5');await page.getByRole('button',{name:'保存',exact:true}).click();assert.match(await page.locator('output').innerText(),/最短不能大于最长/)
 await page.getByLabel('最长').fill('7.5');await page.getByRole('button',{name:'保存',exact:true}).click();assert.equal(await page.locator('output').innerText(),'已保存');await page.getByLabel('最短').fill('2');await page.getByRole('button',{name:'重新打开'}).click();assert.equal(await page.getByLabel('最短').inputValue(),'5');assert.equal(await page.getByLabel('最长').inputValue(),'7.5')
 await page.getByRole('checkbox',{name:'允许分段回复'}).uncheck();assert.equal(await page.getByLabel('最短').isDisabled(),true);await page.getByRole('checkbox',{name:'允许分段回复'}).check()
 for(const width of [390,1280]){await page.setViewportSize({width,height:844});const bounds=await page.locator('.dsh-partner-segment-range').evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth}));assert.ok(bounds.scroll<=bounds.width);await page.screenshot({path:process.env.REPORT_DIR+'/segment-'+width+'.png'})}
 await page.getByLabel('最短').fill('');await page.getByRole('button',{name:'保存',exact:true}).click();assert.match(await page.locator('output').innerText(),/随机间隔/);assert.deepEqual(errors,[])
 console.log(JSON.stringify({passed:true,defaultOff:true,invalidRangeRejected:true,savedRangeReloaded:true,mobileFits:true,realMessagesSent:false}))
}finally{await browser?.close();await fs.rm(temp,{recursive:true,force:true})}
