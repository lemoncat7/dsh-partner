import {fromMarkdown} from 'mdast-util-from-markdown'
import {gfmFromMarkdown,gfmToMarkdown} from 'mdast-util-gfm'
import {gfm} from 'micromark-extension-gfm'
import {toMarkdown} from 'mdast-util-to-markdown'

type Node = {type:string;value?:string;url?:string;alt?:string;identifier?:string;depth?:number;lang?:string|null;ordered?:boolean;start?:number|null;checked?:boolean|null;children?:Node[]}
const LIMIT=6000 // UTF-8 bytes, leaving room for Matrix's HTML and event envelope.
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
function safeUrl(value:string):boolean {
  if(/[\u0000-\u0020\u007f]/.test(value))return false
  try{return ['https:','http:','mailto:','matrix:'].includes(new URL(value).protocol)}catch{return false}
}
function html(node:Node):string {
  const children=()=>node.children?.map(html).join('')??''
  switch(node.type){
    case 'root': return children()
    case 'text': case 'html': return escape(node.value??'')
    case 'paragraph': return `<p>${children()}</p>`
    case 'heading': return `<h${node.depth}>${children()}</h${node.depth}>`
    case 'strong': return `<strong>${children()}</strong>`
    case 'emphasis': return `<em>${children()}</em>`
    case 'delete': return `<del>${children()}</del>`
    case 'inlineCode': return `<code>${escape(node.value??'')}</code>`
    case 'code': return `<pre><code${node.lang&&/^[a-zA-Z0-9_-]{1,40}$/.test(node.lang)?` class="language-${node.lang}"`:''}>${escape(node.value??'')}</code></pre>`
    case 'blockquote': return `<blockquote>${children()}</blockquote>`
    case 'break': return '<br>'
    case 'thematicBreak': return '<hr>'
    case 'list': return node.ordered?`<ol start="${node.start??1}">${children()}</ol>`:`<ul>${children()}</ul>`
    case 'listItem': return `<li>${typeof node.checked==='boolean'?(node.checked?'[x] ':'[ ] '):''}${children()}</li>`
    case 'link': return node.url&&safeUrl(node.url)?`<a href="${escape(node.url)}">${children()}</a>`:children()
    // Do not embed remote images (tracking) or permit arbitrary source HTML.
    case 'image': return node.url&&safeUrl(node.url)?`<a href="${escape(node.url)}">${escape(node.alt||'图片')}</a>`:escape(node.alt??'')
    case 'table': return '<table>'+ (node.children??[]).map((row,i)=>`<tr>${(row.children??[]).map(cell=>`<${i?'td':'th'}>${(cell.children??[]).map(html).join('')}</${i?'td':'th'}>`).join('')}</tr>`).join('')+'</table>'
    default: return children()||escape(node.value??'')
  }
}
function markdown(nodes:Node[]):string {
  return toMarkdown({type:'root',children:nodes} as Parameters<typeof toMarkdown>[0],{extensions:[gfmToMarkdown()],fences:true}).trimEnd()
}
function slices(value:string,limit:number):string[]{
  const result:string[]=[];let buffer='',bytes=0
  for(const char of value){const size=Buffer.byteLength(char);if(bytes+size>limit){result.push(buffer);buffer='';bytes=0}buffer+=char;bytes+=size}
  if(buffer)result.push(buffer)
  return result
}
function fragments(node:Node):Node[]{
  if(Buffer.byteLength(markdown([node]))<=LIMIT)return [node]
  if(node.type==='code')return slices(node.value??'',3000).map(value=>({...node,value}))
  if(node.type==='list'&&(node.children?.length??0)>1)return node.children!.flatMap((item,i)=>fragments({...node,...(node.ordered?{start:(node.start??1)+i}:{}),children:[item]}))
  if(node.type==='table'&&(node.children?.length??0)>2)return node.children!.slice(1).flatMap(row=>fragments({...node,children:[node.children![0]!,row]}))
  // An exceptionally large single inline/table/list unit cannot remain both intact
  // and within transport limits. Preserve all source text as literal code chunks.
  return slices(markdown([node]),3000).map(value=>({type:'code',value}))
}

export interface FormattedMessage {markdown:string;body:string;formattedBody:string}
/** Parse once, keep ordinary blocks intact, serialize each chunk independently. */
export function formatDirectMessages(source:string):FormattedMessage[]{
  if(!source.trim())return []
  const root=fromMarkdown(source,{extensions:[gfm()],mdastExtensions:[gfmFromMarkdown()]}) as Node
  const definitions=new Map((root.children??[]).filter(n=>n.type==='definition').map(n=>[n.identifier,n]))
  function resolve(node:Node):Node{
    if(node.type==='linkReference'||node.type==='imageReference'){
      const definition=definitions.get(node.identifier)
      if(definition?.url)return resolve({...node,type:node.type==='linkReference'?'link':'image',url:definition.url})
    }
    if(node.type==='html')return {type:'text',value:node.value??''}
    if((node.type==='link'||node.type==='image')&&(!node.url||!safeUrl(node.url)))return node.type==='image'?{type:'text',value:node.alt??''}:{type:'strong',children:(node.children??[]).map(resolve)}
    if(node.type==='footnoteReference')return {type:'text',value:`[${node.identifier??''}]`}
    if(node.type==='footnoteDefinition')return {type:'blockquote',children:[{type:'paragraph',children:[{type:'text',value:`[${node.identifier??''}]`}]},...(node.children??[]).map(resolve)]}
    return {...node,...(node.children?{children:node.children.map(resolve)}:{})}
  }
  const nodes=(root.children??[]).filter(n=>n.type!=='definition').map(resolve).flatMap(fragments)
  const groups:Node[][]=[];let group:Node[]=[]
  for(const node of nodes){
    if(group.length&&Buffer.byteLength(markdown([...group,node]))>LIMIT){groups.push(group);group=[]}
    group.push(node)
  }
  if(group.length)groups.push(group)
  return groups.map(children=>{const md=markdown(children);return {markdown:md,body:md,formattedBody:html({type:'root',children})}})
}
