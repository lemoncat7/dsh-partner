import React, { memo, useMemo } from 'react'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import type { RootContent, Definition } from 'mdast'

// Render an allowlisted AST with React escaping, never source HTML. Images are
// links: opening a notice must not automatically contact third-party servers.
export function renderNoticeMarkdown(source: string): React.ReactNode {
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const definitions = new Map<string, Definition>()
  const collect = (node: RootContent): void => {
    if (node.type === 'definition') definitions.set(node.identifier.toUpperCase(), node)
    if ('children' in node) node.children.forEach(collect)
  }
  tree.children.forEach(collect)
  const link = (url: string | undefined, children: React.ReactNode): React.ReactNode =>
    url && !/[\s\u0000-\u001f\u007f]/.test(url) && /^(https?:\/\/|mailto:|matrix:)/i.test(url)
      ? <a href={url} target="_blank" rel="noopener noreferrer">{children}</a> : children
  const render = (node: RootContent, key: number): React.ReactNode => {
    const children = 'children' in node ? node.children.map(render) : null
    let content: React.ReactNode
    switch (node.type) {
      case 'text': case 'html': content = node.value; break
      case 'paragraph': content = <p>{children}</p>; break
      case 'heading': content = React.createElement(`h${Math.min(6, node.depth + 2)}`, null, children); break
      case 'strong': content = <strong>{children}</strong>; break
      case 'emphasis': content = <em>{children}</em>; break
      case 'delete': content = <del>{children}</del>; break
      case 'inlineCode': content = <code>{node.value}</code>; break
      case 'code': content = <pre tabIndex={0} aria-label="代码块"><code>{node.value}</code></pre>; break
      case 'blockquote': content = <blockquote>{children}</blockquote>; break
      case 'break': content = <br />; break
      case 'thematicBreak': content = <hr />; break
      case 'list': content = node.ordered ? <ol start={node.start ?? 1}>{children}</ol> : <ul>{children}</ul>; break
      case 'listItem': content = <li>{typeof node.checked === 'boolean' && <input type="checkbox" checked={node.checked} disabled aria-label={node.checked ? '已完成' : '未完成'} />}{children}</li>; break
      case 'link': content = link(node.url, children); break
      case 'image': content = link(node.url, node.alt || '图片'); break
      case 'linkReference': content = link(definitions.get(node.identifier.toUpperCase())?.url, children); break
      case 'imageReference': content = link(definitions.get(node.identifier.toUpperCase())?.url, node.alt || '图片'); break
      case 'table': content = <div className="dsh-partner-pendant-table" tabIndex={0} role="region" aria-label="表格"><table><thead><tr>{node.children[0]?.children.map((cell, i) => <th key={i} scope="col" style={{ textAlign: node.align?.[i] ?? undefined }}>{cell.children.map(render)}</th>)}</tr></thead><tbody>{node.children.slice(1).map((row, i) => <tr key={i}>{row.children.map((cell, j) => <td key={j} style={{ textAlign: node.align?.[j] ?? undefined }}>{cell.children.map(render)}</td>)}</tr>)}</tbody></table></div>; break
      case 'definition': content = null; break
      default: content = children
    }
    return <React.Fragment key={key}>{content}</React.Fragment>
  }
  return tree.children.map(render)
}

export const NoticeMarkdown = memo(function NoticeMarkdown({ source }: { source: string }) {
  const content = useMemo(() => renderNoticeMarkdown(source), [source])
  return <div className="dsh-partner-pendant-markdown">{content}</div>
})
