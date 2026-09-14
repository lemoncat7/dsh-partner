import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const { chromium } = await import(pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href)
const source = '# 更新\n\n**重点**和*说明*，~~旧内容~~。[详情](https://example.com)\n\n- [x] 完成\n- 第二项\n\n> 引用\n\n```js\n' + 'long_code_'.repeat(80) + '\n```\n\n| 名称 | 状态 | 详情 |\n| --- | --- | --- |\n| 示例 | 完成 | 内容 |\n\n<script>window.compromised=true</script>\n\n[危险](javascript:alert(1)) ![远程图](https://example.com/a.png)'
const result = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {NoticeMarkdown} from './src/pendant/markdown';createRoot(document.getElementById('root')).render(<NoticeMarkdown source={${JSON.stringify(source)}}/>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } })
const css = await readFile('src/pendant/widget.css', 'utf8')
const server = createServer((req,res) => { res.setHeader('content-type',req.url === '/app.js' ? 'text/javascript' : 'text/html');res.end(req.url === '/app.js' ? result.outputFiles[0].contents : '<meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div class="dsh-partner-pendant"><section id="dsh-partner-pendant-inbox" class="dsh-partner-pendant-inbox" style="left:12px;top:12px;width:min(380px,calc(100vw - 24px));max-height:90vh"><article class="dsh-partner-pendant-detail" id="root"></article></section></div><script src="/app.js"></script>') })
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
const browser = await chromium.launch({args:['--no-sandbox']})
try {
  const page = await browser.newPage({reducedMotion:'reduce'})
  const errors=[];page.on('pageerror',e=>errors.push(e.message))
  for (const width of [375,1024]) for (const dark of [false,true]) {
    await page.setViewportSize({width,height:800});await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.locator('strong').waitFor();await page.evaluate(d=>document.body.toggleAttribute('data-ds-dark-theme',d),dark)
    assert.equal(await page.locator('strong').textContent(),'重点')
    assert.equal(await page.locator('table').count(),1)
    assert.equal(await page.locator('img,a[href^="javascript:"]').count(),0)
    assert.equal(await page.evaluate(()=>window.compromised),undefined)
    assert.equal(await page.locator('a').first().getAttribute('rel'),'noopener noreferrer')
    assert.ok(await page.locator('pre').evaluate(el=>el.scrollWidth>el.clientWidth))
    assert.ok(await page.locator('article').evaluate(el=>el.scrollWidth<=el.clientWidth+1))
    await page.screenshot({path:`/tmp/pendant-md-${width}-${dark}.png`})
  }
  assert.deepEqual(errors,[]);console.log('Markdown: narrow/desktop, light/dark, overflow and safe content passed')
} finally { await browser.close();server.close() }
