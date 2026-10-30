import type {ToolDefinition,ToolRuntime,ToolRunContext,ToolExecutionResult} from '@deepseek-ai/dsh-tools'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {scopeTarget} from '@deepseek-ai/dsh-scope'
import type {PartnerStore} from '../store.js'
import {resolveToolAccess} from '../execution/tool-access-adapter.js'

export interface DiscoverableTool {tool:ToolDefinition;allowed:()=>boolean}
export const PARTNER_TOOL_ENTRIES=['partner_tools','partner_channel_access'] as const
const GROUPS=[
 {id:'chat',title:'聊天回复',description:'文字、表情与语音'},
 {id:'media',title:'图片创作',description:'生图、画图、图生图与图片编辑'},
 {id:'identity',title:'身份与生活',description:'人格参考模板、角色与关系设定、睡眠和头像'},
 {id:'work',title:'任务与协作',description:'需求、任务看板和伙伴协作'},
 {id:'automation',title:'定时与续接',description:'定时计划、长任务等待与恢复'},
 {id:'skills',title:'技能',description:'查询、加载和运行已启用 Skill'},
 {id:'management',title:'伙伴管理',description:'创建伙伴、单向授权和管理配置'},
 {id:'channels',title:'渠道与附件',description:'QQ 空间、资料修改和文件交付'},
 {id:'mcp',title:'外部 MCP',description:'已授权的外部服务工具'},
 {id:'other',title:'其他能力',description:'宿主和其他已授权扩展工具'},
]
const IMAGE_ALIASES=['生图','画图','绘图','生成图片','图片生成','图生图','改图','编辑图片','图片编辑','画一张','画张','绘制','图片','image generation','image editing']
function toolSearchMatches(tool:ToolDefinition,query:string):boolean {
 return `${tool.name} ${tool.description}`.toLocaleLowerCase().includes(query) || tool.name==='generate_image' && IMAGE_ALIASES.some(alias=>alias.includes(query)||query.includes(alias))
}
function category(name:string):string {
 if(name==='generate_image')return 'media'
 if(['partner_chat_reply','partner_chat_progress','partner_stickers','partner_qq_reply'].includes(name))return 'chat'
 if(/identity|sleep|avatar|activity/.test(name))return 'identity'
 if(/task_board|requirements|collaborate/.test(name))return 'work'
 if(/schedule/.test(name))return 'automation'
 if(/skill/.test(name))return 'skills'
 if(/companions|management|access_grants|companion_manage/.test(name))return 'management'
 if(/qq|attachment/.test(name))return 'channels'
 if(/mcp/.test(name))return 'mcp'
 return 'other'
}
const PERSONA_REFERENCE_CALL = JSON.stringify({action:'call',name:'partner_identity',argumentsJson:JSON.stringify({action:'reference'})})
export const TOOL_DISCOVERY_PROMPT='伙伴工具统一由两个固定入口提供：partner_channel_access 根据真实渠道及当前发言账号返回已授权能力，partner_tools 查询和调用能力。默认渠道沿用既有授权，QQ 由渠道适配器核验账号；不接受模型自报账号或权限。先用 list 查询（可按 category/query 缩小），describe 或 load 查看参数，再用 partner_tools action=call、name=真实工具名、argumentsJson=原工具参数的 JSON 字符串执行；不会另行向顶层工具表添加工具。用户明确要求生成或编辑图片时，先查询 media 分类或 query=image；若 generate_image 可用，describe 后通过本入口 call 实际生成，依据返回文件交付，不以口头承诺、提示词或虚构图片代替工具执行。顶层没有 generate_image 不表示没有生图能力；只有查询当前授权目录后才能说明能力是否缺失。回应和结果说明保持当前人格。私聊耗时任务先 call partner_chat_progress，argumentsJson 为 {"text":"按当前人格生成的一句自然回应"} 的 JSON 字符串；成功后再工作，此工具不结束回合。常用聊天可直接 call partner_chat_reply，参数为 {"messages":[{"text":"要说的话"}]}，表情独立使用 {"stickerId":"库内ID"}；先完成工作再提交最终回复。普通正文仍可直接最终回答。人格参考模板在 partner_identity 内置，包含基本身份、角色设定、关系设定和 qq-bridge 大肥鱼原卡；用户要参考时直接向 partner_tools 传入 '+PERSONA_REFERENCE_CALL+'，无需搜索 cosplay 配置或文件。普通修改和自主优化不要求读模板。每次调用都会再次检查实时权限，原工具审批、超时、取消与终结行为保留。'

/** Stable model-facing entries; original definitions remain registered in scope
 * so the normal DSH execution pipeline owns validation, policy and cancellation. */
export function installToolDiscovery(runtime:ToolRuntime,owner:string,store:PartnerStore,entries:DiscoverableTool[]):()=>void {
 const disposers:Array<()=>void>=[]
 let closed=false
 const guard=(exec:ToolRunContext)=>{
  const sessionId=exec.agent?.session.id,state=store.snapshot()
  if(closed||store.isCompanionRemoving(owner)||!state.companions.some(c=>c.id===owner&&c.toolDiscovery)||!sessionId||!state.sessions.some(r=>r.companionId===owner&&r.sessionId===sessionId))throw Error('当前会话不能使用此伙伴的工具入口')
  exec.signal.throwIfAborted()
 }
 const available=(exec:ToolRunContext)=>{
  const access=resolveToolAccess({agent:exec.agent!,state:store.snapshot()})
  const tools=new Map<string,ToolDefinition>()
  for(const entry of entries){const tool=runtime.get(entry.tool.name,exec.agent);if(entry.allowed()&&tool)tools.set(tool.name,tool)}
  // Include already-scoped host tools, without reviving restricted or unloaded definitions.
  for(const schema of runtime.schemas(exec.agent)) {
   if(entries.some(e=>e.tool.name===schema.name))continue
   const tool=runtime.get(schema.name,exec.agent);if(tool)tools.set(schema.name,tool)
  }
  return [...tools.values()].filter(tool=>!['partner_tools','partner_channel_access','run_code'].includes(tool.name)&&access.sendTools&&(!access.allowedTools||access.allowedTools.includes(tool.name)))
 }
 const visible=(tool:ToolDefinition)=>({name:tool.name,category:category(tool.name),summary:(tool.name==='generate_image'?'生图、画图、图生图、图片编辑。'+tool.description:tool.description).slice(0,160)})
 const render=(_args:unknown,value:unknown)=>{
  const result=value as {dispatch?:ToolExecutionResult}
  return result.dispatch?result.dispatch.content:[{type:'text' as const,text:JSON.stringify(value)}]
 }
 const invoke=async(name:string,args:unknown,exec:ToolRunContext)=>{
  guard(exec)
  if(!available(exec).some(tool=>tool.name===name))throw Error('当前账号无权使用此能力或能力已撤回')
  const subCallId=ToolCallId(`${exec.callId}:capability`),rootCallId=exec.rootCallId??exec.callId
  const log={rootCallId,parentCallId:exec.callId,subCallId,name,arguments:JSON.stringify(args)}
  exec.agent!.session.append('tool/ptc-dispatch-start',log)
  const result=await runtime.execute({name,arguments:args,agent:exec.agent!,signal:exec.signal,callId:subCallId,rootCallId,parent:exec.token})
  let content=result.content
  // Honor the host's durable-log projection (large output locators/redaction).
  try {content=await exec.agent!.ctx.waterfall(scopeTarget(runtime,exec.agent!), 'tools/ptc-dispatch-log',{exec,agent:exec.agent!,subCallId,name,isError:result.isError,content},()=>Promise.resolve(content))}catch { /* the settled result must still be recorded */ }
  exec.agent!.session.append('tool/ptc-dispatch',{...log,isError:result.isError,content,...(result.meta===undefined?{}:{meta:result.meta}),...(result.error?.info===undefined?{}:{error:result.error.info})})
  for(const context of result.additionalContexts??[])exec.deferContext(context)
  if(result.concludesTurn)exec.concludeTurn()
  return {dispatch:result}
 }
 try {
  for(const entry of entries)disposers.push(runtime.register({...entry.tool,execute:async(args,exec)=>{if(!entry.allowed())throw Error('能力已撤回');return entry.tool.execute(args,exec)}}))
  disposers.push(runtime.register({name:'partner_channel_access',description:'查询真实渠道与当前发言账号的能力权限。默认适配器沿用已有授权；QQ 普通成员只提供回复、表情、语音，归属账号与可信自主任务可使用已授权能力。不接受自报账号，不改变权限。返回的能力通过 partner_tools 调用。',
   parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object'},render},presentCall:()=>({card:'generic',title:'当前渠道能力'}),
   async execute(_raw,exec){guard(exec);const access=resolveToolAccess({agent:exec.agent!,state:store.snapshot()});return {scope:access.allowedTools?'chat-only':'authorized',tools:available(exec).map(visible),...(access.denialReason?{notice:access.denialReason}:{})}}
  }))
  disposers.push(runtime.register({name:'partner_tools',description:'统一查询、调用已授权工具。list 按 category/query 返回概要，describe（或兼容 load）返回完整参数；call 使用 name 和 argumentsJson（原工具参数的 JSON 字符串）执行，仍走原权限、审批和取消流程。切换账号不增删顶层工具。人格参考模板直接调用：'+PERSONA_REFERENCE_CALL+'。聊天调用 partner_chat_reply，原工具参数为 {"messages":[{"text":"回复内容"}]}，须序列化到 argumentsJson；表情先查询 partner_stickers。无需工具时直接最终回答。',
   parameters:{type:'object',properties:{action:{type:'string',enum:['list','describe','load','unload','call']},category:{type:'string'},query:{type:'string',maxLength:80},name:{type:'string'},offset:{type:'integer',minimum:0},argumentsJson:{type:'string',maxLength:200000}},required:['action'],additionalProperties:false},
   output:{schema:{type:'object'},render},presentCall:()=>({card:'generic',title:'伙伴能力'}),
   async execute(raw,exec){
    guard(exec)
    const args=raw as {action:string;category?:string;query?:string;name?:string;offset?:number;argumentsJson?:string}
    const all=available(exec)
    if(args.action==='list'){
     const query=(args.query??'').trim().toLocaleLowerCase(),offset=args.offset??0
     if(args.category&&!GROUPS.some(g=>g.id===args.category))throw Error('分类不存在，请先查询分类')
     if(!Number.isSafeInteger(offset)||offset<0||query.length>80)throw Error('查询参数无效')
     if(!args.category&&!query)return {categories:GROUPS.map(g=>({...g,count:all.filter(t=>category(t.name)===g.id).length})).filter(g=>g.count),next:'按 category 或 query 查询；call 通过本入口执行'}
     const found=all.filter(t=>(!args.category||category(t.name)===args.category)&&(!query||toolSearchMatches(t,query)))
     return {tools:found.slice(offset,offset+12).map(visible),total:found.length,nextOffset:offset+12<found.length?offset+12:null}
    }
    const tool=all.find(t=>t.name===args.name)
    if(!tool)throw Error('工具不存在或当前账号未获授权，请重新查询目录')
    if(args.action==='call'){
     if(typeof args.argumentsJson!=='string'||args.argumentsJson.length>200000)throw Error('请用 argumentsJson 提交工具参数 JSON')
     let parameters:unknown
     try {parameters=JSON.parse(args.argumentsJson)}catch {throw Error('argumentsJson 必须是有效 JSON')}
     return invoke(tool.name,parameters,exec)
    }
    if(args.action==='unload')return {name:tool.name,notice:'能力由统一入口调用，无需卸载；未修改权限'}
    if(!['describe','load'].includes(args.action))throw Error('操作无效')
    return {name:tool.name,description:tool.description,parameters:tool.parameters,next:'用 partner_tools action=call，name 为此名称，argumentsJson 为参数 JSON 字符串；不要直接调用原工具名。'}
   }
  }))
 }catch(error){for(const dispose of disposers.reverse())dispose();throw error}
 return ()=>{closed=true;for(const dispose of disposers.reverse())dispose()}
}
