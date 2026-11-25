// Native dialog + real components. All API responses are synthetic.
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createServer} from 'node:http'
const {chromium}=await import(process.env.DSH_PLAYWRIGHT_MODULE??'playwright')
const repo=fileURLToPath(new URL('../',import.meta.url)),temp=await fs.mkdtemp(path.join(os.tmpdir(),'partner-dialog-'))
const report=process.env.DSH_DIALOG_REPORT
let browser,server
try{
 await build({stdin:{resolveDir:repo,loader:'tsx',contents:`
import {createRoot} from 'react-dom/client';import {useState} from 'react';
import {installStyles} from './src/client.tsx';import {WorkspaceDialog,DiscardChangesDialog} from './src/ui/workspace-components.tsx';
import {CompanionCreateDialog} from './src/ui/companion-create.tsx';import {CharacterWizard} from './src/ui/character-editor.tsx';
import {emptyCharacterCard} from './src/character/domain.ts';import {McpEditor} from './src/ui/mcp-editor.tsx';
import {SkillImportDialog} from './src/ui/skill-import-dialog.tsx';import {MemoryDetail} from './src/ui/memory/memory-detail.tsx';
import {PushChannels} from './src/ui/push-channels.tsx';import {BrowserSettings} from './src/ui/browser-settings.tsx';
import {TtsSettings} from './src/ui/tts-settings.tsx';import {ScheduleForm} from './src/ui/schedule-panel.tsx';
import {RequirementForm} from './src/ui/requirement-dialog.tsx';import {ICON_SYMBOLS} from '@deepseek-ai/dsh-client-ui-primitives';
const oldCleanup=installStyles();installStyles();oldCleanup();window.styleCount=()=>document.querySelectorAll('style[id="@lemoncat7/dsh-partner/client"]').length;
const sprite=document.createElementNS('http://www.w3.org/2000/svg','svg');sprite.style.display='none';for(const[id,markup]of Object.entries(ICON_SYMBOLS)){const svg=new DOMParser().parseFromString(markup,'image/svg+xml').documentElement,symbol=document.createElementNS(sprite.namespaceURI,'symbol');symbol.id=id;for(const a of svg.attributes)if(a.name!=='xmlns')symbol.setAttribute(a.name,a.value);symbol.innerHTML=svg.innerHTML;sprite.append(symbol)}document.body.append(sprite);
window.calls=[];window.fetch=async(url,init={})=>{window.calls.push({url:String(url),method:init.method||'GET'});return Response.json({config:null,items:[],profiles:[],bindings:[],providers:[]})};
const companion={id:'fixture',name:'测试伙伴',enabled:true,capabilities:[],profile:{},automation:{}};const noop=()=>{},done=async()=>{};
const memory={id:'memory',kind:'fact',subject:'测试记录',content:'连续内容用于检查滚动区域。'.repeat(120),status:'active',confidence:0.9,createdAt:1,updatedAt:1,sources:[],evidence:[],metadata:{},tags:[]};
function App(){const[mode,setMode]=useState('none');window.show=setMode;const close=()=>setMode('none');const wrap=(title,children,wide=false)=><WorkspaceDialog title={title} detail="检查微透材质、标题、滚动与按钮" close={close} width={wide?'wide':'regular'}>{children}</WorkspaceDialog>;return <main className="dsh-partner-workspace" style={{height:'100vh',padding:32}}><h1>伙伴工作区</h1><button id="launcher">打开</button><div style={{height:500,padding:24,background:'linear-gradient(135deg,#a4c7cf60,#d2bbcf50)'}}>伙伴 · 任务 · 记忆</div><div id="dsh-partner-channels">
{mode==='create'&&<CompanionCreateDialog close={close} create={async value=>{window.created=value;close()}}/>}
{mode==='role'&&<CharacterWizard companion={companion} initial={emptyCharacterCard()} close={close} complete={noop} relationshipText=""/>}
{mode==='mcp'&&<McpEditor value="new" close={close} saved={noop}/>}
{mode==='mcp-import'&&<McpEditor value="import" close={close} saved={noop}/>}
{mode==='skill'&&<SkillImportDialog close={close} changed={done}/>}
{mode==='memory'&&<MemoryDetail companionId="fixture" item={memory} close={close} changed={done}/>}
{mode==='bark'&&<PushChannels companion={companion} snapshot={{pushChannels:[]}} onChanged={done} adding closeAdd={close}/>}
{mode==='browser'&&wrap('浏览器',<BrowserSettings companionId="fixture" onChanged={done} onEdit={noop}/>)}
{mode==='tts'&&wrap('通用 TTS',<TtsSettings companionId="fixture" channels={[]} onChanged={done} onEdit={noop}/>)}
{mode==='schedule'&&wrap('新建定时任务',<ScheduleForm companions={[companion]} close={close} changed={done}/>,true)}
{mode==='requirement'&&wrap('新建需求',<RequirementForm directory={[companion]} close={close} created={done}/>)}
{mode==='capability'&&<WorkspaceDialog title="管理伙伴访问" detail="长列表滚动" close={close} className="is-capability-resources">{Array.from({length:35},(_,i)=><label key={i} style={{display:'flex',padding:12,gap:12}}><input type="checkbox"/>可访问伙伴 {i}</label>)}<button onClick={close}>完成</button></WorkspaceDialog>}
{mode==='long-title'&&wrap('长名字检查标题换行'.repeat(7),<form className="dsh-partner-feature-form">{Array.from({length:12},(_,i)=><label key={i}>字段 {i}<input/></label>)}<footer><button type="button" onClick={close}>取消</button><button type="button">保存</button></footer></form>)}
{mode==='confirm'&&<DiscardChangesDialog keepEditing={close} discard={close}/>}
</div></main>};createRoot(document.getElementById('root')).render(<App/>);
`},outfile:path.join(temp,'fixture.js'),bundle:true,platform:'browser',jsx:'automatic',loader:{'.css':'text','.module.css':'local-css'},alias:{react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom')},nodePaths:(process.env.DSH_BROWSER_NODE_PATH??'').split(path.delimiter).filter(Boolean),plugins:[{name:'test-exports',setup(b){b.onLoad({filter:/\/src\/(client|ui\/character-editor|ui\/schedule-panel)\.tsx$/},async({path:file})=>({contents:await fs.readFile(file,'utf8')+'\nexport {'+({'client.tsx':'installStyles','character-editor.tsx':'CharacterWizard','schedule-panel.tsx':'ScheduleForm'}[path.basename(file)])+'};',loader:'tsx'}))}}]})
 const [js,css]=await Promise.all(['fixture.js','fixture.css'].map(f=>fs.readFile(path.join(temp,f))))
 server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':req.url==='/fixture.css'?'text/css':'text/html;charset=utf-8');res.end(req.url==='/fixture.js'?js:req.url==='/fixture.css'?css:'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>body{margin:0;background:#e9e9ed}body[data-ds-dark-theme]{background:#101719}</style><div id="root"></div><script src="/fixture.js"></script>')});await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({...(process.env.DSH_CHROMIUM_EXECUTABLE?{executablePath:process.env.DSH_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox','--no-proxy-server']})
 const errors=[],results=[],modes=['create','role','mcp','mcp-import','skill','memory','bark','browser','tts','schedule','requirement','capability','long-title','confirm']
 for(const viewport of [{width:1280,height:560},{width:390,height:500},{width:844,height:390}])for(const dark of [false,true]){
  const page=await browser.newPage({viewport,reducedMotion:'reduce'});page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.show);await page.evaluate(d=>document.body.toggleAttribute('data-ds-dark-theme',d),dark);assert.equal(await page.evaluate(()=>window.styleCount()),1,'stale cleanup must not remove newly installed styles')
  for(const mode of modes){
   const label=JSON.stringify({mode,viewport,dark});console.log('Checking',label);await page.locator('#launcher').focus();const outside=await page.screenshot({clip:{x:0,y:0,width:4,height:4},animations:'disabled'});await page.evaluate(mode=>window.show(mode),mode)
   const dialog=page.locator('dialog[open]').last(),panel=dialog.locator('.dsh-partner-workspace-dialog').last(),body=panel.locator(':scope > .dsh-partner-workspace-dialog-body'),header=panel.locator(':scope > header');await panel.waitFor({timeout:5000});if(mode==='tts')await dialog.getByRole('button',{name:'添加服务',exact:true}).click();if(mode==='browser')await dialog.getByRole('textbox',{name:'CDP 地址',exact:true}).waitFor();if(mode==='bark'){await dialog.getByRole('textbox',{name:'渠道名称',exact:true}).fill('隔离测试');await dialog.locator('summary').click()}
   const initial=await header.boundingBox();const geometry=await panel.evaluate(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect(),body=e.querySelector(':scope > .dsh-partner-workspace-dialog-body'),h=e.querySelector(':scope > header').getBoundingClientRect(),b=body.getBoundingClientRect();return{background:s.backgroundColor,filter:s.backdropFilter,radius:s.borderRadius,top:r.top,bottom:r.bottom,width:r.width,overflow:e.scrollWidth>e.clientWidth,bodyTop:b.top,headerBottom:h.bottom,bodyBackground:getComputedStyle(body).backgroundColor,bodyBorder:getComputedStyle(body).borderTopWidth,scrollRange:body.scrollHeight-body.clientHeight}})
   assert.ok(geometry.filter.includes('32px'),label+JSON.stringify(geometry));assert.ok(geometry.background.includes(dark?'0.16':'0.24'),label+JSON.stringify(geometry));assert.equal(geometry.bodyBackground,'rgba(0, 0, 0, 0)');assert.equal(geometry.bodyBorder,'0px');assert.ok(geometry.top>=0&&geometry.bottom<=viewport.height+1,label+JSON.stringify(geometry));assert.equal(geometry.overflow,false,label);assert.ok(geometry.bodyTop>=geometry.headerBottom-1,label)
   for(const fraction of [0,.5,1]){await body.evaluate((e,n)=>{e.scrollTop=(e.scrollHeight-e.clientHeight)*n},fraction);const current=await header.boundingBox();assert.ok(Math.abs(current.y-initial.y)<1,label);assert.equal(await header.evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.left+r.width/2,r.bottom-2))}),true,'scroll must not paint into header: '+label)}
   const last=body.getByRole('button',{disabled:false}).or(body.getByRole('textbox',{disabled:false})).or(body.getByRole('combobox',{disabled:false})).or(body.getByRole('checkbox',{disabled:false})).or(body.getByRole('link')).last();if(await last.count()){await last.focus();const rect=await last.boundingBox();assert.ok(rect&&rect.y>=geometry.headerBottom-1&&rect.y+rect.height<=viewport.height+1,'last control reachable: '+label+JSON.stringify(rect));await page.keyboard.press('Tab');assert.ok(await dialog.evaluate(e=>e.contains(document.activeElement)),'focus trapped: '+label);await page.keyboard.press('Shift+Tab')}
   assert.equal(await dialog.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');assert.equal(await dialog.evaluate(e=>getComputedStyle(e,'::backdrop').backgroundColor),'rgba(0, 0, 0, 0)');assert.ok(outside.equals(await page.screenshot({clip:{x:0,y:0,width:4,height:4},animations:'disabled'})),'background pixels unchanged: '+label);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,label)
   if(report&&['create','role','browser','memory','bark'].includes(mode))await page.screenshot({path:path.join(report,mode+'-'+viewport.width+'-'+(dark?'dark':'light')+'.png'),animations:'disabled'});results.push({mode,viewport,dark,...geometry});await page.evaluate(()=>window.show('none'));await dialog.waitFor({state:'detached'})
  }
  // Dirty role editor opens a nested confirmation; keeping the draft restores
  // focus to the same editor and preserves the glass and top-layer behavior.
  await page.evaluate(()=>window.show('role'));const editor=page.locator('dialog[open]');await editor.locator('textarea').first().fill('测试中的角色草稿');await editor.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('alertdialog').getByRole('button',{name:'继续编辑',exact:true}).click();assert.equal(await editor.locator('textarea').first().inputValue(),'测试中的角色草稿');await page.evaluate(()=>window.show('none'))
  await page.evaluate(()=>window.show('create'));await page.locator('input[name=name]').fill('浏览器回归');await page.locator('input[name=role]').fill('测试');await page.getByRole('button',{name:'创建伙伴',exact:true}).click();await page.waitForFunction(()=>window.created?.name==='浏览器回归');assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.method!=='GET')),[],'inspection must not modify real resources')
  const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'},{name:'prefers-reduced-motion',value:'reduce'}]});await page.evaluate(()=>window.show('create'));assert.equal(await page.locator('.dsh-partner-workspace-dialog').evaluate(e=>getComputedStyle(e).backdropFilter),'none');assert.ok(!(await page.locator('.dsh-partner-workspace-dialog').evaluate(e=>getComputedStyle(e).backgroundColor)).includes('0.24'));await page.close()
 }
 assert.deepEqual(errors,[]);if(report)await fs.writeFile(path.join(report,'browser-results.json'),JSON.stringify({results,pageErrors:errors,apiStubbed:true,nativeDialog:true},null,2));console.log('PASS: '+results.length+' dialog cases; continuous glass, undimmed canvas, clipped content below fixed titles, reachable actions, nested confirmation and draft retention, native focus/Save, mobile/landscape, dark/light and opaque accessibility fallback.')
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await fs.rm(temp,{recursive:true,force:true})}
