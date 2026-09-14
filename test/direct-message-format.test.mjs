import test from 'node:test'
import assert from 'node:assert/strict'
import {formatDirectMessages} from '../lib/channels/direct/message-format.js'
import {fromMarkdown} from 'mdast-util-from-markdown'

test('Matrix HTML supports headings, emphasis, code, lists, links, tables and tasks',()=>{
 const [part]=formatDirectMessages('# 标题\n\n**粗体** 和 *斜体* ~~删除~~ [链接](https://example.com)\n\n- [x] 完成\n\n```js\na < b\n```\n\n| 列 | 值 |\n| --- | --- |\n| A | B |')
 for(const fragment of ['<h1>标题</h1>','<strong>粗体</strong>','<em>斜体</em>','<del>删除</del>','href="https://example.com"','language-js','a &lt; b','<table>','[x]'])assert.ok(part.formattedBody.includes(fragment),fragment)
 assert.match(part.markdown,/\*\*粗体\*\*/)
 assert.equal(part.body,part.markdown)
})
test('untrusted HTML and unsafe URLs cannot become active content',()=>{
 const parts=formatDirectMessages('<script>alert(1)</script>\n\n[bad](javascript:alert%281%29) ![pic](data:text/html,evil)\n\n![safe](https://example.com/tracker)')
 for(const part of parts){assert.doesNotMatch(part.formattedBody,/<script|<img|href="javascript:|href="data:/);assert.doesNotMatch(part.markdown,/javascript:|data:text/)}
 assert.match(parts[0].formattedBody,/&lt;script&gt;/)
})
test('long fenced code splits into valid independent code blocks without losing Unicode',()=>{
 const code='中文😀 <tag> & "value"\n'.repeat(1200)
 const parts=formatDirectMessages('```text\n'+code+'```')
 assert.ok(parts.length>1)
 const restored=parts.flatMap(p=>fromMarkdown(p.markdown).children).map(n=>n.value).join('')
 assert.equal(restored,code.trimEnd())
 for(const part of parts){assert.ok(Buffer.byteLength(part.markdown)<=6000);assert.ok(Buffer.byteLength(JSON.stringify({body:part.body,formatted_body:part.formattedBody}))<60000);assert.doesNotMatch(part.markdown,/\uFFFD/)}
})
test('reference links remain usable after chunk boundaries',()=>{
 const parts=formatDirectMessages(('paragraph '.repeat(300)+'\n\n').repeat(3)+'[source][ref]\n\n[ref]: https://example.com/doc')
 assert.ok(parts.length>1)
 assert.match(parts.at(-1).formattedBody,/href="https:\/\/example.com\/doc"/)
})
test('large tables repeat header instead of cutting cells mid-row',()=>{
 const parts=formatDirectMessages('| ID | 标题 |\n| --- | --- |\n'+Array.from({length:200},(_,i)=>`| ${i} | ${'测试'.repeat(12)} |`).join('\n'))
 assert.ok(parts.length>1)
 for(const part of parts)assert.match(part.formattedBody,/<th>ID<\/th>/)
})
