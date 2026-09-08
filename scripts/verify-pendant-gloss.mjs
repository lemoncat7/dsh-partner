// Real WebGL regression for print washout; isolated fixture, no user data.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const { chromium } = await import(process.env.PARTNER_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { createBadgeFaceMaterial, BADGE_LIGHTING } from './src/pendant/surface'
import { createMotionGlare } from './src/pendant/motion-glare'
const glare = createMotionGlare()
const renderer=new THREE.WebGLRenderer({alpha:true,antialias:false,preserveDrawingBuffer:true})
renderer.setSize(240,320);renderer.outputColorSpace=THREE.SRGBColorSpace
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.95
const camera=new THREE.OrthographicCamera(-.9,.9,1.2,-1.2,.1,10);camera.position.z=5
const scene=new THREE.Scene(),group=new THREE.Group();scene.add(group)
const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment(),environment=pmrem.fromScene(room)
room.dispose();pmrem.dispose();scene.environment=environment.texture
const ambient=new THREE.AmbientLight(0xffffff,BADGE_LIGHTING.ambient);scene.add(ambient)
const light=new THREE.DirectionalLight(0xffffff,BADGE_LIGHTING.key);light.position.set(-3,4,5);scene.add(light)
const source=document.createElement('canvas');source.width=128;source.height=128
const texture=new THREE.CanvasTexture(source);texture.colorSpace=THREE.SRGBColorSpace
const recipe={map:texture,metalness:0,roughness:.24,clearcoat:.45,clearcoatRoughness:.16,specularIntensity:.35,envMapIntensity:.18}
const materials={original:new THREE.MeshPhysicalMaterial(recipe),noTone:new THREE.MeshPhysicalMaterial({...recipe,toneMapped:false}),noCoat:new THREE.MeshPhysicalMaterial({...recipe,clearcoat:0,specularIntensity:0}),noEnvironment:new THREE.MeshPhysicalMaterial({...recipe,envMap:environment.texture,envMapIntensity:0}),fixed:createBadgeFaceMaterial(texture,environment.texture),glare:createBadgeFaceMaterial(texture,environment.texture,glare.uniforms),plain:new THREE.MeshBasicMaterial({map:texture,toneMapped:false})}
const geometry=new THREE.PlaneGeometry(1.42,1.96),front=new THREE.Mesh(geometry,materials.fixed),back=new THREE.Mesh(geometry,materials.fixed)
front.position.z=.003;back.position.z=-.003;back.rotation.y=Math.PI;group.add(front,back)
function capture(mode:string){front.material=back.material=materials[mode];renderer.render(scene,camera);const gl=renderer.getContext(),pixels=new Uint8Array(240*320*4);gl.readPixels(0,0,240,320,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return{pixels,image:renderer.domElement.toDataURL(),calls:renderer.info.render.calls}}
window.sample=(color:string,angle:number|string=0,mode='fixed',stress=false,show=false,fill=BADGE_LIGHTING.ambient)=>{
 ambient.intensity=fill
 const ctx=source.getContext('2d')!;ctx.fillStyle=color;ctx.fillRect(0,0,128,128)
 if(color==='chart'){
  const colors=['#000000','#ffffff','#808080','#253235','#cbd2d5','#2244aa','#dd3322','#33aa55']
  colors.forEach((c,i)=>{ctx.fillStyle=c;ctx.fillRect((i%4)*32,Math.floor(i/4)*64,32,64)})
  ctx.fillStyle='#ffffff';ctx.font='bold 12px sans-serif';ctx.fillText('IMAGE / 123',4,112)
 }
 texture.needsUpdate=true
 if(angle==='specular')group.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),light.position.clone().normalize().add(new THREE.Vector3(0,0,1)).normalize())
 else if(angle!=='hold')group.rotation.set(0,Number(angle),0)
 light.intensity=stress?50:BADGE_LIGHTING.key
 materials.fixed.envMapIntensity=materials.glare.envMapIntensity=stress?1:.18
 const a=capture('plain'),b=capture(mode);let total=0,maxDelta=0,energy=0,highlight=0,unchanged=0,cx=0,weight=0;const rgb=[0,0,0]
 for(let i=0;i<a.pixels.length;i+=4){if(a.pixels[i+3]<250)continue;total++;let pixelDelta=0;for(let c=0;c<3;c++){const d=Math.abs(b.pixels[i+c]-a.pixels[i+c]);maxDelta=Math.max(maxDelta,d);pixelDelta=Math.max(pixelDelta,d);energy+=d;rgb[c]+=b.pixels[i+c]}if(pixelDelta>20)highlight++;if(pixelDelta<=5)unchanged++;cx+=pixelDelta*((i/4)%240);weight+=pixelDelta}
 if(show){
  const figure=document.createElement('figure')
  figure.innerHTML='<figcaption>'+color+' / '+mode+(mode==='glare'?' / progress '+glare.uniforms.badgeGlareProgress.value:'')+'</figcaption>'
  if(mode==='glare'){
   // Browser CSS reference, exactly the upstream GlareHover gradient and size.
   const reference=document.createElement('span');reference.style.cssText='position:relative;display:inline-block;width:120px;height:160px;vertical-align:top'
   const base=new Image();base.src=a.image;reference.append(base)
   const clip=document.createElement('span');clip.style.cssText='position:absolute;overflow:hidden;left:12.667px;top:14.667px;width:94.666px;height:130.666px'
   const strip=document.createElement('span');const pos=-100+200*glare.uniforms.badgeGlareProgress.value
   strip.style.cssText='position:absolute;inset:0;background:linear-gradient(-45deg,transparent 60%,rgba(255,255,255,'+glare.uniforms.badgeGlareOpacity.value+') 70%,transparent 85%,transparent 100%);background-size:250% 250%;background-repeat:no-repeat;background-position:'+pos+'% '+pos+'%'
   clip.append(strip);reference.append(clip);figure.append(reference)
  }else{const img=new Image();img.src=a.image;figure.append(img)}
  const rendered=new Image();rendered.src=b.image;figure.append(rendered)
  document.getElementById('cases')!.append(figure)
 }
 return {maxDelta,average:energy/total/3,rgb:rgb.map(v=>Math.round(v/total)),highlight:highlight/total,unchanged:unchanged/total,centroid:weight?cx/weight:0,calls:b.calls,plainCalls:a.calls,image:b.image}
}
window.setGlare=(progress:number,opacity:number)=>{glare.uniforms.badgeGlareProgress.value=progress;glare.uniforms.badgeGlareOpacity.value=opacity}
window.orientGlare=(angle:number)=>{glare.update(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),angle),false);return [glare.uniforms.badgeGlareProgress.value,glare.uniforms.badgeGlareOpacity.value]}
window.rotateLight=()=>light.position.set(3,-4,5)
window.exposure=(value:number)=>renderer.toneMappingExposure=value
window.noLight=()=>{scene.environment=null;for(const m of [materials.fixed,materials.glare]){m.envMap=null;m.needsUpdate=true;}light.intensity=0;ambient.intensity=0;BADGE_LIGHTING.key=0}
window.cleanup=()=>{Object.values(materials).forEach(m=>m.dispose());texture.dispose();geometry.dispose();environment.dispose();renderer.dispose();renderer.forceContextLoss()}
` },bundle:true,write:false,format:'iife' })
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/fixture.js'?'text/javascript':'text/html; charset=utf-8');res.end(req.url==='/fixture.js'?bundle.outputFiles[0].contents:'<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:16px;background:#e8e9eb;color:#263238;font:14px sans-serif}#cases{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0}img{width:120px}figcaption{padding:8px}</style><div id="cases"></div><script src="/fixture.js"></script>')})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']})
try {
 const page=await browser.newPage({viewport:{width:1040,height:980}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())})
 await page.goto('http://127.0.0.1:'+server.address().port)
 const sample=(...args)=>page.evaluate(args=>window.sample(...args),args)
 const summary=r=>({rgb:r.rgb,maxDelta:r.maxDelta,average:r.average,highlight:r.highlight,unchanged:r.unchanged,centroid:r.centroid})
 const diagnostics={}
 for(const color of ['#253235','#cbd2d5','#2244aa']){
  diagnostics[color]={}
  for(const mode of ['original','noTone','noCoat','noEnvironment','fixed'])diagnostics[color][mode]=summary(await sample(color,0,mode,false,mode==='original'||mode==='fixed'))
 }
 console.log('Washout isolation:',JSON.stringify(diagnostics))
 // Normal viewing keeps colour close to the source, with no diffuse darkening.
 for(const color of ['#253235','#cbd2d5','#2244aa','#808080','#dd3322','chart']){
  const current=await sample(color,0,'fixed',false,true)
  assert.ok(current.maxDelta<=15,'normal reflection must not recolour the whole image: '+color+' '+current.maxDelta)
  const unfilled=await sample(color,0,'fixed',false,false,0)
  const overfilled=await sample(color,0,'fixed',false,false,100)
  assert.equal(unfilled.image,overfilled.image,'ambient light cannot brighten or darken the image layer')
  const stress=await sample(color,'specular','fixed',true)
  assert.ok(stress.maxDelta<=103,'HDR reflection cannot erase the image')
  for(const angle of [0,.4,-.4,Math.PI]){
   const tilted=await sample(color,angle,'fixed')
   assert.equal(tilted.calls,tilted.plainCalls,'logical layers still use one draw per visible face')
   assert.ok(tilted.maxDelta<=103,'reflection preserves at least 60% source contrast')
  }
 }
 const a=await sample('#253235','specular','fixed',false,true),repeat=await sample('#253235','specular')
 assert.deepEqual(a,repeat,'retain static original light')
 await page.evaluate(()=>window.rotateLight())
 assert.ok(a.maxDelta>=20,'native glossy reflection remains visible at the highlight angle')
 await sample('chart','specular','fixed',false,true)
 console.log('Native reflection peak RGB shift:',a.maxDelta)
 const moved=await sample('#253235','hold')
 assert.notEqual(moved.image,a.image,'native reflection still responds to light')
 const glareCases=[]
 for(const progress of [0,.25,.35,.45,.55,.65,.75,1]){
  await page.evaluate(p=>window.setGlare(p,.5),progress)
  const result=await sample('#253235',0,'glare',false,true)
  assert.equal(result.calls,result.plainCalls,'glare uses the same draw calls')
  assert.ok(result.maxDelta<=128,'glare never exceeds the reference opacity')
  if(progress===0||progress===1)assert.ok(result.maxDelta<=1,'glare is off-card at the sweep endpoints')
  glareCases.push({progress,...summary(result)})
 }
 assert.ok(glareCases.some(r=>r.maxDelta>80),'the moving gradient is visible')
 const active=glareCases.filter(r=>r.highlight>.04)
 assert.ok(active.length>=2,'the sweep remains visible across multiple frames')
 assert.ok(Math.max(...active.map(r=>r.centroid))-Math.min(...active.map(r=>r.centroid))>30,'gradient travels across the front')
 console.log('Motion glare sweep:',JSON.stringify(glareCases))
 const poses=[]
 for(const angle of [-.5,-.25,0,.25,.5]){
  const uniforms=await page.evaluate(a=>window.orientGlare(a),angle)
  const result=await sample('#253235',angle,'glare',false,true)
  assert.ok(result.maxDelta<=97,'angle-driven reflection preserves source contrast')
  poses.push({angle,uniforms,...summary(result)})
 }
 assert.ok(poses.some(p=>p.maxDelta>25),'angle-driven highlight is visible')
 assert.ok(new Set(poses.map(p=>p.centroid.toFixed(0))).size>=3,'angle changes highlight position')
 console.log('Angle reflection:',JSON.stringify(poses))
 await page.evaluate(()=>window.setGlare(.55,0))
 for(const color of ['#000000','#253235','#cbd2d5','#2244aa','chart']){
  const idle=await sample(color,'specular','glare',true)
  assert.ok(idle.maxDelta<=1,'front is exact source colour when stationary, even in strong lights')
 }
 // Zero reflection: light/exposure must not alter any source colour or text.
 await page.evaluate(()=>window.noLight())
 for(const exposure of [.05,.95,8]){
  await page.evaluate(value=>window.exposure(value),exposure)
  for(const color of ['#000000','#ffffff','#808080','#253235','#cbd2d5','#2244aa','#dd3322','#33aa55','chart']){
   for(const angle of [0,.6,Math.PI]){
    const result=await sample(color,angle,'fixed',false,exposure===.95&&angle===0,100)
    const front=await sample(color,angle,'glare',false,false,100)
    assert.ok(front.maxDelta<=1,'stationary front preserves the original image')
    assert.ok(result.maxDelta<=1,'unreflected source must round-trip within one RGB step: '+JSON.stringify({color,angle,exposure,delta:result.maxDelta}))
   }
  }
 }
 await page.screenshot({path:'/tmp/partner-motion-glare-comparison.png',fullPage:true})
 await page.evaluate(()=>window.cleanup());assert.deepEqual(errors,[])
 console.log('Image/coating verified: 162 unlit face/colour/exposure/pose cases within 1 RGB step, motion-triggered glare, unchanged back, preserved contrast, same draw calls.')
} finally {await browser.close();await new Promise(r=>server.close(r))}
