import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const { chromium } = await import(process.env.PARTNER_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = fileURLToPath(new URL('../', import.meta.url))
const app = await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{PartnerPendant}from'./src/pendant/widget';import{PendantSettingsPanel}from'./src/pendant/settings-panel';import{drawCardImage}from'./src/pendant/card-image';window.drawCardImage=drawCardImage;createRoot(document.getElementById('app')).render(<><div className="dsh-partner-workspace"><PendantSettingsPanel/></div><PartnerPendant controller={{}}/></>);`, loader:'tsx',resolveDir:root },bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'text','.module.css':'text'},define:{'process.env.NODE_ENV':'"production"'}})
const renderer=await readFile(new URL('../lib/pendant-renderer.js',import.meta.url))
const styles=(await Promise.all(['src/client.css','src/ui/workspace-ui.css','src/ui/responsive-ui.css','src/pendant/widget.css','src/pendant/settings-panel.css'].map(p=>readFile(new URL('../'+p,import.meta.url),'utf8')))).join('\n')
let polls=0
const server=createServer((req,res)=>{
  if(req.url==='/partner-local/v1/pendant/inbox'){polls++;res.setHeader('content-type','application/json');res.end('{"items":[],"unread":0}');return}
  res.setHeader('content-type',req.url?.endsWith('.js')?'text/javascript':'text/html; charset=utf-8')
  res.end(req.url==='/app.js'?app.outputFiles[0].contents:req.url==='/partner-local/v1/pendant/renderer.js'?renderer:`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}\nbody{margin:0;background:#e8e9eb}body[data-ds-dark-theme]{background:#1d2328}.dsh-partner-workspace{height:auto;min-height:100vh;padding:24px;box-sizing:border-box}</style><div id="app"></div><script src="/app.js"></script>`)
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']})
try{
  const context=await browser.newContext({viewport:{width:1440,height:960}})
  const page=await context.newPage(),errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  const url=`http://127.0.0.1:${server.address().port}`
  await page.goto(url)
  await page.waitForSelector('canvas[data-ready="true"]',{timeout:40000})
  const save=page.getByRole('button',{name:'保存设置',exact:true}),toggle=page.getByRole('switch',{name:'显示卡片挂饰'})
  assert.equal(await page.getByRole('button',{name:'30 FPS 均衡'}).getAttribute('aria-pressed'),'true')
  await page.locator('canvas').evaluate(el=>{window.originalCanvas=el})
  for(const fps of [24,60,30,24]){
    await page.getByRole('button',{name:new RegExp('^'+fps+' FPS ')}).click();await save.click()
    await page.waitForSelector('canvas[data-fps="'+fps+'"]')
    assert.equal(await page.locator('canvas').evaluate(el=>el===window.originalCanvas),true,'changing frame rate reuses renderer')
  }
  await page.getByRole('button',{name:'皮革 平整缝线'}).click()
  await page.getByRole('textbox',{name:'自定义绳子颜色'}).fill('#123456')
  await save.click()
  await page.waitForSelector('.dsh-partner-pendant-strap[data-material="leather"][data-color="#123456"]')
  await page.reload();await page.waitForSelector('.dsh-partner-pendant-strap[data-material="leather"][data-color="#123456"]',{timeout:40000})
  assert.equal(await page.getByRole('button',{name:'24 FPS 省电'}).getAttribute('aria-pressed'),'true')
  await page.waitForSelector('canvas[data-fps="24"]')
  await page.getByRole('textbox',{name:'自定义绳子颜色'}).fill('oops');await save.click()
  assert.match(await page.getByRole('alert').innerText(),/六位/)
  await page.getByRole('textbox',{name:'自定义绳子颜色'}).fill('#123456')
  await toggle.click();await save.click()
  await page.waitForFunction(()=>!document.querySelector('.dsh-partner-pendant'))
  assert.equal(await page.locator('canvas,.dsh-partner-pendant-strap').count(),0)
  const stopped=polls;await page.waitForTimeout(4300);assert.equal(polls,stopped,'disabled pendant stops polling')
  // Storage failures must preserve the committed state and keep the local draft.
  await page.evaluate(()=>{window.originalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('full','QuotaExceededError')}})
  await toggle.click();await save.click()
  assert.match(await page.getByRole('alert').innerText(),/原设置未更改/)
  assert.equal(await page.locator('.dsh-partner-pendant').count(),0)
  await page.evaluate(()=>{Storage.prototype.setItem=window.originalSet});await save.click()
  await page.waitForSelector('canvas[data-ready="true"]',{timeout:40000})
  const file=page.getByLabel('上传卡片图片')
  await file.setInputFiles({name:'bad.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')})
  assert.match(await page.getByRole('alert').innerText(),/PNG/)
  await file.setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('not an image')})
  await page.waitForFunction(()=>document.querySelector('[role=alert]')?.textContent.includes('无法解码'))
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=200;c.height=300;const x=c.getContext('2d');x.fillStyle='#b57455';x.fillRect(0,0,200,300);return c.toDataURL('image/png').split(',')[1]})
  await file.setInputFiles({name:'art.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')})
  await page.waitForSelector('img[alt="自定义卡片正面预览"]');await save.click()
  await page.waitForSelector('canvas[data-art="custom"]')
  const dimensions=await page.evaluate(async()=>{const s=JSON.parse(localStorage.getItem('dsh-partner:pendant-settings:v1'));const image=new Image();image.src=s.image;await image.decode();return[image.width,image.height,s.image.length]})
  assert.deepEqual(dimensions.slice(0,2),[200,300]);assert.ok(dimensions[2]<=700000)
  // New uploads retain the full source; fitting is reversible and only repaints
  // the existing GPU texture. Verify horizontal, vertical and square sources.
  await page.locator('.dsh-partner-pendant-canvas').evaluate(el=>{window.fitCanvas=el})
  for(const [width,height] of [[1600,800],[800,1600],[900,900]]){
    const data=await page.evaluate(([w,h])=>{const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');x.fillStyle='#2244aa';x.fillRect(0,0,w,h);x.fillStyle='#ee2222';x.fillRect(0,0,w*.1,h);x.fillStyle='#22ee22';x.fillRect(w*.9,0,w*.1,h);return c.toDataURL('image/png').split(',')[1]},[width,height])
    await file.setInputFiles({name:'proportions.png',mimeType:'image/png',buffer:Buffer.from(data,'base64')})
    await page.getByRole('button',{name:'更换图片',exact:true}).waitFor();await save.click()
    await page.waitForSelector('canvas[data-art="custom"]')
    const original=await page.evaluate(()=>JSON.parse(localStorage.getItem('dsh-partner:pendant-settings:v1')).image)
    for(const [fit,name] of [['cover','铺满裁切'],['contain','完整显示']]){
      await page.getByRole('button',{name:new RegExp('^'+name)}).click();await save.click()
      await page.waitForSelector('canvas[data-image-fit="'+fit+'"]')
      assert.equal(await page.locator('.dsh-partner-pendant-canvas').evaluate(el=>el===window.fitCanvas),true,'image fitting does not rebuild the renderer')
      assert.equal(await page.locator('img[alt="自定义卡片正面预览"]').evaluate(el=>getComputedStyle(el).objectFit),fit)
      const pixels=await page.evaluate(async()=>{const s=JSON.parse(localStorage.getItem('dsh-partner:pendant-settings:v1')),image=new Image();image.src=s.image;await image.decode();const c=document.createElement('canvas');c.width=512;c.height=704;window.drawCardImage(c,image,s.imageFit);const x=c.getContext('2d');return{source:s.image,width:image.width,height:image.height,left:[...x.getImageData(5,352,1,1).data],top:[...x.getImageData(256,5,1,1).data]} })
      assert.equal(pixels.source,original,'changing fit never crops or re-encodes the saved source')
      assert.ok(pixels.width<=1536&&pixels.height<=1536)
      assert.equal(pixels.width/pixels.height,width/height)
      if(width===1600&&fit==='contain') {assert.ok(pixels.left[0]>200&&pixels.left[1]<60,'complete left edge is retained');assert.deepEqual(pixels.top,[37,50,53,255],'letterbox uses the card background')}
      if(width===1600&&fit==='cover') assert.ok(pixels.left[2]>120&&pixels.left[0]<60,'cover crops the side markers without stretching')
    }
  }
  await page.reload();await page.waitForSelector('canvas[data-art="custom"]',{timeout:40000})
  await page.getByRole('slider',{name:'绳子长度'}).fill('160'); await save.click()
  await page.waitForSelector('canvas[data-strap-length="160"]')
  await page.getByRole('slider',{name:'卡片清晰度'}).fill('45'); await save.click()
  await page.waitForSelector('canvas[data-quality="45"]')
  await page.getByLabel('上传绳子纹理').setInputFiles({name:'texture.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')})
  await page.getByRole('button',{name:'更换绳子纹理'}).waitFor(); await save.click()
  await page.waitForSelector('.dsh-partner-pendant-strap[data-custom-texture="true"]')
  const strips = page.locator('.dsh-partner-pendant-strap [data-texture-mapping="material"] rect')
  assert.equal(await strips.count(), 48, 'texture uses a bounded reusable strip pool')
  await strips.first().evaluate(el => { window.textureStrip = el })
  await page.getByRole('slider',{name:'绳子长度'}).fill('60'); await save.click()
  await page.waitForSelector('canvas[data-strap-length="60"]')
  assert.equal(await strips.first().evaluate(el => el === window.textureStrip), true, 'length change reuses texture geometry')
  assert.ok(await strips.evaluateAll(nodes => nodes.every(el => /^matrix\(/.test(el.getAttribute('transform') || '') && !/NaN|Infinity/.test(el.getAttribute('transform') || ''))))
  await page.getByRole('slider',{name:'绳子长度'}).fill('160'); await save.click()
  await page.waitForSelector('canvas[data-strap-length="160"]')
  await page.reload(); await page.waitForSelector('canvas[data-strap-length="160"][data-quality="45"]',{timeout:40000})
  assert.equal(await page.getByRole('button',{name:/^完整显示/}).getAttribute('aria-pressed'),'true')
  await page.screenshot({path:'/tmp/partner-pendant-settings-desktop.png',fullPage:true})
  for(const dark of [false,true]){
    await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark)
    for(const width of [375,768]){
      await page.setViewportSize({width,height:844})
      assert.ok(await page.locator('.dsh-partner-pendant-settings').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'settings fit narrow viewport')
      assert.equal(await file.isVisible(),false,'native file control remains hidden')
      await page.getByRole('group',{name:'图片适应方式'}).scrollIntoViewIfNeeded()
      if(width===375)await page.screenshot({path:`/tmp/partner-pendant-settings-mobile-${dark?'dark':'light'}.png`,fullPage:true})
    }
  }
  await page.getByRole('button',{name:'恢复默认图案'}).click();await save.click();await page.waitForSelector('canvas[data-art="default"]')
  // Other tabs update a clean form, but cannot overwrite unsaved user input.
  const other=await page.context().newPage();await other.goto(url)
  await other.evaluate(()=>{const k='dsh-partner:pendant-settings:v1',s=JSON.parse(localStorage.getItem(k));s.color='#abcdef';localStorage.setItem(k,JSON.stringify(s))})
  await page.waitForFunction(()=>document.querySelector('input[aria-label="自定义绳子颜色"]').value==='#abcdef')
  await page.getByRole('textbox',{name:'自定义绳子颜色'}).fill('#111111')
  await other.evaluate(()=>{const k='dsh-partner:pendant-settings:v1',s=JSON.parse(localStorage.getItem(k));s.color='#222222';localStorage.setItem(k,JSON.stringify(s))})
  await page.waitForSelector('.dsh-partner-pendant-strap[data-color="#222222"]')
  assert.equal(await page.getByRole('textbox',{name:'自定义绳子颜色'}).inputValue(),'#111111')
  assert.deepEqual(errors,[])
  console.log('Settings verified: persisted appearance, disable cleanup/poll stop, storage failure, image validation/contain/cover/reset, reversible bounded source, stable GPU canvas, mobile/dark, cross-tab draft protection.')
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
