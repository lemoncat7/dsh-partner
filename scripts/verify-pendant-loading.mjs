import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { pendantFixtureOptions } from './pendant-fixture.mjs'

const { chromium } = await import(process.env.PARTNER_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = fileURLToPath(new URL('../', import.meta.url))
const app = await build({ ...pendantFixtureOptions, stdin: { contents: `
  import React from 'react'; import {createRoot} from 'react-dom/client';
  import {PartnerPendant} from './src/pendant/widget';
  import {prepareCardImage} from './src/pendant/card-image';
  import {savePendantSettings} from './src/pendant/use-settings';
  import {DEFAULT_PENDANT_SETTINGS} from './src/pendant/settings';
  window.prepareCardImage=prepareCardImage;
  window.changeSettings=patch=>savePendantSettings({...DEFAULT_PENDANT_SETTINGS,...patch});
  const root=createRoot(document.getElementById('app'));window.unmountPendant=()=>root.unmount();
  root.render(<PartnerPendant controller={{open(){},openSession:async()=>{}}}/>);
`, loader: 'tsx', resolveDir: root }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: `var require={async(path){window.chunkPaths.push(path);return new Promise((resolve,reject)=>{window.__ModuleLoader__={load(module){try{resolve(module.factory(require))}catch(error){reject(error)}}};const script=document.createElement('script');script.src='/'+path.replace('./','');script.onerror=()=>reject(Error('offline'));document.head.append(script)})}};` },
})
const renderer = await readFile(new URL('../lib/client.pendant.js', import.meta.url))
const styles = (await Promise.all(['src/client.css','src/pendant/widget.css'].map(p=>readFile(new URL('../'+p,import.meta.url),'utf8')))).join('\n')
const notice={id:'test',kind:'reply',companionId:'test',companionName:'测试伙伴',title:'测试消息',summary:'静态卡牌也可以查看消息',createdAt:1}
const server=createServer(async(req,res)=>{
  if(req.url?.startsWith('/partner-local/v1/pendant/')) {
    res.setHeader('content-type','application/json');res.end(JSON.stringify({items:[notice],unread:1}));return
  }
  if(req.url==='/client.pendant.js') {res.setHeader('content-type','text/javascript');res.setHeader('cache-control','public,max-age=31536000,immutable');res.end(renderer);return}
  if(req.url==='/app.js') {res.setHeader('content-type','text/javascript');res.end(app.outputFiles[0].contents);return}
  res.setHeader('content-type','text/html');res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}\nbody{margin:0;background:#e8e9eb}body[data-ds-dark-theme]{background:#1d2328}</style><div id="app"></div><script>window.chunkPaths=[];if(location.search.includes('dark'))document.body.setAttribute('data-ds-dark-theme','')</script><script src="/app.js"></script>`)
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']})
const url=`http://127.0.0.1:${server.address().port}`
try {
  for(const width of [1280,375]) {
    const page=await browser.newPage({viewport:{width,height:850},reducedMotion:'reduce'})
    const errors=[];page.on('pageerror',e=>errors.push(e.message))
    let release
    const gate=new Promise(resolve=>release=resolve)
    await page.route('**/client.pendant.js',async route=>{await gate;await route.continue()})
    await page.goto(url+(width===375?'?dark':''))
    const staticArt=page.locator('.dsh-partner-pendant-static-art')
    await staticArt.waitFor()
    await page.locator('.dsh-partner-pendant-unread:not([hidden])').waitFor()
    assert.equal(await page.locator('canvas[data-ready=true]').count(),0)
    await page.locator('.dsh-partner-pendant-hit').click()
    await page.locator('#dsh-partner-pendant-inbox').waitFor()
    assert.match(await page.locator('#dsh-partner-pendant-inbox').innerText(),/静态卡牌也可以查看消息|测试消息/)
    await page.screenshot({path:`/tmp/partner-static-card-${width}.png`})
    release()
    await page.waitForSelector('.dsh-partner-pendant[data-rendered=true]',{timeout:45000})
    assert.equal(await staticArt.count(),0)
    assert.deepEqual(await page.evaluate(()=>chunkPaths),['./client.pendant.js'])
    await page.evaluate(()=>changeSettings({enabled:false}))
    await page.waitForFunction(()=>!document.querySelector('.dsh-partner-pendant'))
    await page.evaluate(()=>changeSettings({enabled:true}))
    await page.waitForSelector('.dsh-partner-pendant[data-rendered=true]',{timeout:45000})
    assert.equal(await page.evaluate(()=>chunkPaths.length),1,'renderer module is reused after enabling')
    assert.deepEqual(errors,[])
    await page.close()
  }
  const offline=await browser.newPage()
  await offline.route('**/client.pendant.js',route=>route.abort())
  await offline.goto(url)
  await offline.getByTitle('3D 暂不可用，仍可点击查看伙伴消息').waitFor({timeout:15000})
  await offline.locator('.dsh-partner-pendant-hit').click()
  await offline.locator('#dsh-partner-pendant-inbox').waitFor()
  await offline.locator('.dsh-partner-pendant-static-art').waitFor()
  await offline.close()

  const disabled=await browser.newPage()
  await disabled.addInitScript(()=>localStorage.setItem('dsh-partner:pendant-settings:v1',JSON.stringify({enabled:false})))
  await disabled.goto(url);await disabled.waitForTimeout(3000)
  assert.deepEqual(await disabled.evaluate(()=>chunkPaths),[])
  const compression=await disabled.evaluate(async()=>{
    const c=document.createElement('canvas');c.width=1600;c.height=1000;const x=c.getContext('2d')
    const g=x.createLinearGradient(0,0,1600,1000);g.addColorStop(0,'#284745');g.addColorStop(1,'#a6c6a2');x.fillStyle=g;x.fillRect(0,0,1600,1000)
    x.fillStyle='white';x.font='100px sans-serif';x.fillText('PARTNER · 卡牌图案',60,240)
    const png=c.toDataURL('image/png'),blob=await(await fetch(png)).blob()
    const result=await prepareCardImage(new File([blob],'art.png',{type:'image/png'}))
    const image=new Image();image.src=result;await image.decode()
    return {before:png.length,after:result.length,type:result.slice(0,23),width:image.width,height:image.height}
  })
  assert.ok(compression.type.startsWith('data:image/webp;'))
  assert.ok(compression.after<compression.before)
  assert.deepEqual([compression.width,compression.height],[1536,960])
  await disabled.close()
  console.log(JSON.stringify({staticAnd3D:true,lightAndDark:true,narrowAndWide:true,offlineFallback:true,disabledDoesNotLoad:true,reusesRenderer:true,compression}))
} finally {await browser.close();await new Promise(resolve=>server.close(resolve))}
