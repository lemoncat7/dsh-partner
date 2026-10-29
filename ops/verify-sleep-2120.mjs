// Local deployment check: boot the actual web profile without sending any messages.
// Run where Docker is available, with PARTNER_PLAYWRIGHT_MODULE pointing to Playwright.
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
const container = process.env.PARTNER_CONTAINER || 'dsh-docker-dsh-1'
const base = 'http://127.0.0.1:3080'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 30e6 })
  if (result.status !== 0) throw Error('Docker readiness inspection failed')
  return (result.stdout || '') + (result.stderr || '')
}
async function verify() {
  assert.ok(process.env.PARTNER_PLAYWRIGHT_MODULE, 'Set PARTNER_PLAYWRIGHT_MODULE to the local Playwright module path')
  const { chromium } = await import(pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href)
  const deadline = Date.now() + 600_000
  let token
  while (Date.now() < deadline) {
    const ready = await fetch(base, { signal: AbortSignal.timeout(3000) }).then(response => response.ok || response.status === 401 || response.status === 403).catch(() => false)
    if (ready) {
      const started = docker(['inspect', '--format', '{{.State.StartedAt}}', container]).trim()
      token = [...docker(['logs', '--since', started, container]).matchAll(/\?token=([^\s)&]+)/g)].at(-1)?.[1]
      if (token) break
    }
    await delay(2000)
  }
  assert.ok(token, 'Web host did not become ready with a startup token')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-webgl'] })
  try {
    const page = await browser.newPage()
    try { await page.goto(base + '/?token=' + encodeURIComponent(decodeURIComponent(token)), { waitUntil: 'domcontentloaded', timeout: 60_000 }) }
    catch { throw Error('Authenticated local web page failed to load') }
    const pluginDeadline = Date.now() + 240_000
    while (Date.now() < pluginDeadline) {
      const response = await page.request.get(base + '/partner-local/v1', { timeout: 10_000 }).catch(() => undefined)
      if (response?.status() === 200) {
        const snapshot = await response.json()
        assert.ok(Array.isArray(snapshot.companions))
        await page.locator('.dsh-partner-sidebar-row, .dsh-partner-rail').first().click({timeout:30000})
        await page.locator('.dsh-partner-roster-list button').filter({hasText:'莫殇'}).click()
        await page.getByRole('button',{name:'身份',exact:true}).click()
        const configOnly=c=>{const {sleepState,...config}=c;return JSON.stringify(config)}
        const before=configOnly(snapshot.companions.find(c=>c.name==='莫殇'))
        const artifacts=mkdtempSync(join(tmpdir(),'partner-sleep-2120-'))
        for(const theme of ['light','dark']) for(const width of [1280,375]) {
          await page.evaluate(theme=>{document.body.toggleAttribute('data-ds-dark-theme',theme==='dark');document.documentElement.dataset.xiaoheiAppearance=theme},theme)
          await page.setViewportSize({width,height:1000})
          await page.getByRole('tab',{name:'闲时主动联系',exact:false}).click()
          const toggle=page.getByRole('switch',{name:'开启闲时主动联系',exact:true})
          if(await toggle.getAttribute('aria-checked')!=='true')await toggle.click()
          const section=page.getByRole('region',{name:'闲时主动联系',exact:true})
          const target=section.getByLabel('联系到哪里',{exact:false})
          await target.selectOption({index:1})
          assert.ok(await target.inputValue())
          await section.getByLabel('空闲多久后联系',{exact:false}).selectOption('60')
          assert.equal(await section.getByLabel('空闲多久后联系',{exact:false}).inputValue(),'60')
          await toggle.scrollIntoViewIfNeeded();await page.waitForTimeout(300)
          await page.screenshot({path:join(artifacts,`${theme}-${width}-idle.png`)})
          const checked=await toggle.evaluate(n=>({color:getComputedStyle(n).backgroundColor,x:n.querySelector('i').getBoundingClientRect().left-n.getBoundingClientRect().left}))
          await toggle.press('Space');await page.waitForTimeout(250)
          const unchecked=await toggle.evaluate(n=>({color:getComputedStyle(n).backgroundColor,x:n.querySelector('i').getBoundingClientRect().left-n.getBoundingClientRect().left}))
          assert.notEqual(checked.color,unchecked.color);assert.ok(checked.x-unchecked.x>=17)
          await toggle.click()
          assert.equal(await page.getByRole('switch',{name:'开启免打扰',exact:true}).count(),0)
          assert.equal(await section.getByText('每天最多联系',{exact:true}).count(),0)
          await page.getByRole('tab',{name:'睡眠与做梦',exact:false}).click()
          const sleep=page.getByRole('switch',{name:'开启自主睡眠',exact:true})
          if(await sleep.getAttribute('aria-checked')!=='true')await sleep.click()
          const dream=page.getByRole('switch',{name:'允许做梦',exact:true})
          const wasOn=await dream.getAttribute('aria-checked')
          await dream.press('Space');assert.notEqual(await dream.getAttribute('aria-checked'),wasOn)
          await dream.press('Space');assert.equal(await dream.getAttribute('aria-checked'),wasOn)
          await sleep.scrollIntoViewIfNeeded();await page.waitForTimeout(200)
          await page.screenshot({path:join(artifacts,`${theme}-${width}-sleep.png`)})
          assert.ok(await page.locator('#dsh-partner-identity-editor').evaluate(n=>n.scrollWidth<=n.clientWidth+1))

        }
        const after=await(await page.request.get(base+'/partner-local/v1')).json()
        assert.equal(configOnly(after.companions.find(c=>c.name==='莫殇')),before)
        console.log('Artifacts: '+artifacts)
        // Intercept all mutations in a separate mocked UI pass; never write to production.
        const mock=structuredClone(snapshot), target=mock.companions.find(c=>c.name==='莫殇')
        const card={schemaVersion:1,enabled:true,roleText:'AI 生效人格：直率但体贴。',identity:'',motivation:'',voice:'',relationship:'',greeting:'',length:'short',narration:false,examples:[],lore:[]}
        target.characterCard=card
        target.identityDraft={name:target.name,role:'人工原稿角色',description:'原稿定位',instructions:'人工原始准则',characterCard:{...card,roleText:'人工保留的人格原稿'}}
        target.sleepPolicy={enabled:true,dreamsEnabled:true}
        target.sleepState={episode:{id:'mock',routeId:'mock-route',startedAt:Date.now(),wakeAt:Date.now()+1800000,reason:'想休息一会儿',dream:'completed'},dreams:[{id:'mock-dream',routeId:'mock-route',at:Date.now(),narrative:'梦里，雨滴变成了窗边的小灯。',feeling:'觉得安静而放松。',topic:'下雨时喜欢做什么',sourceMemoryIds:[]}]}
        target.identityDraft.sleepPolicy={enabled:true,dreamsEnabled:true}
        let captured,awakened=false
        await page.route('**/partner-local/v1**',async route=>{
          const request=route.request(),url=new URL(request.url())
          if(request.method()==='GET'&&url.pathname==='/partner-local/v1')return route.fulfill({json:mock})
          if(url.pathname===`/partner-local/v1/companions/${target.id}/sleep`){
            if(request.method()==='POST'){
              assert.equal(request.postDataJSON().action,'wake');awakened=true
              target.sleepState.episode.wokeAt=Date.now();target.sleepState.episode.wakeReason='用户唤醒'
              return route.fulfill({json:{ok:true}})
            }
            return route.fulfill({json:{state:target.sleepState}})
          }
          if(request.method()==='PUT' &&url.pathname===`/partner-local/v1/companions/${target.id}/identity`){
            captured=request.postDataJSON()
            assert.equal(captured.expectedAt,target.updatedAt)
            assert.equal('capabilities' in captured.identity,false)
            Object.assign(target,captured.identity,{identityDraft:structuredClone(captured.identity),updatedAt:target.updatedAt+1})
            return route.fulfill({json:target})
          }
          if(!['GET','HEAD','OPTIONS'].includes(request.method()))return route.abort()
          return route.continue()
        })
        await page.reload({waitUntil:'domcontentloaded'})
        await page.setViewportSize({width:1280,height:1000})
        await page.locator('.dsh-partner-sidebar-row, .dsh-partner-rail').first().click({timeout:30000})
        await page.locator('.dsh-partner-roster-list button').filter({hasText:'莫殇'}).click()
        await page.getByRole('button',{name:'身份',exact:true}).click()
        await page.getByRole('tab',{name:'睡眠与做梦',exact:false}).click()
        const sleepSection=page.getByRole('region',{name:'睡眠与做梦',exact:true})
        await sleepSection.getByRole('button',{name:'叫醒他',exact:true}).waitFor()
        await sleepSection.locator('.dsh-partner-dream summary').click()
        assert.match(await sleepSection.innerText(),/雨滴变成了窗边的小灯/)
        await page.screenshot({path:join(artifacts,'dream-awake.png')})
        await sleepSection.getByRole('button',{name:'叫醒他',exact:true}).click()
        await sleepSection.getByRole('heading',{name:'清醒',exact:true}).waitFor();assert.equal(awakened,true)
        await page.getByRole('tab',{name:'基本身份',exact:false}).click()
        assert.equal(await page.getByLabel('角色',{exact:true}).inputValue(),'人工原稿角色')
        const effective=page.locator('.dsh-partner-effective-identity')
        await effective.locator('summary').click()
        assert.match(await effective.innerText(),/AI 生效人格/)
        await page.getByRole('tab',{name:'角色聊天',exact:false}).click()
        assert.equal(await page.getByRole('textbox',{name:/^角色设定/}).inputValue(),'人工保留的人格原稿')
        await effective.getByRole('button',{name:'将生效内容复制到编辑区'}).click()
        assert.equal(await page.getByRole('textbox',{name:/^角色设定/}).inputValue(),card.roleText)
        await page.getByRole('button',{name:'保存身份',exact:true}).click()
        await page.getByText('草稿已保存并应用，下一轮将使用新身份',{exact:false}).waitFor()
        assert.equal(captured.identity.characterCard.roleText,card.roleText)
        await page.screenshot({path:join(artifacts,'draft-effective.png')})
        const actual=await(await page.request.get(base+'/partner-local/v1')).json()
        assert.equal(configOnly(actual.companions.find(c=>c.name==='莫殇')),before)
        console.log('Autonomous sleep/dream switches, removed quiet hours, dream display, intercepted wake and identity save verified. 1280/375 light/dark screenshots; production settings unchanged, no messages sent.')
        return
      }
      await delay(2000)
    }
    throw Error('Web profile opened but partner API did not become ready')
  } finally { await browser.close() }
}
verify().catch(error => {
  // Playwright errors can contain the navigation URL; never log its authentication token.
  console.error(String(error.message).replace(/token=[^\s)&"']+/g, 'token=REDACTED'))
  process.exitCode = 1
})
