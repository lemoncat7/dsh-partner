import type {ToolDefinition,ToolRuntime} from '@deepseek-ai/dsh-tools'
import type {PartnerStore} from '../store.js'

export interface DiscoverableTool {tool:ToolDefinition;allowed:()=>boolean}
const GROUPS=[
 {id:'identity',title:'身份与生活',description:'角色设定、睡眠和头像'},
 {id:'work',title:'任务与协作',description:'需求、任务看板和伙伴协作'},
 {id:'automation',title:'定时与续接',description:'定时计划、长任务等待与恢复'},
 {id:'skills',title:'技能',description:'查询、加载和运行已启用 Skill'},
 {id:'management',title:'伙伴管理',description:'创建伙伴、单向授权和管理配置'},
 {id:'channels',title:'渠道与附件',description:'QQ 空间、语音、资料修改和文件交付'},
 {id:'mcp',title:'外部 MCP',description:'已授权的外部服务工具'},
 {id:'other',title:'其他能力',description:'其他伙伴扩展工具'},
]
function category(name:string):string {
 if(/identity|sleep|avatar|activity/.test(name))return 'identity'
 if(/task_board|requirements|collaborate/.test(name))return 'work'
 if(/schedule/.test(name))return 'automation'
 if(/skill/.test(name))return 'skills'
 if(/companions|management|access_grants|companion_manage/.test(name))return 'management'
 if(/qq|attachment/.test(name))return 'channels'
 if(/mcp/.test(name))return 'mcp'
 return 'other'
}
export const TOOL_DISCOVERY_PROMPT='伙伴扩展工具采用按需加载：当前直接提供 partner_tools 目录与高频聊天工具。需要身份、睡眠、任务看板、协作、计划、QQ、附件、管理或 MCP 时，先 partner_tools list 看分类，再用 category/query 查工具，describe 查看单项说明，load 加载所需工具。load 本身不执行任务；加载后下一次工具调用使用返回的真实工具名及参数（若宿主采用 run_code，则通过下一次生成的 tools SDK 调用）。下文提及但暂未出现在工具清单里的伙伴工具可先 load；不要因未加载就声称不能使用。每次最多常驻 4 个工作工具，较早加载的会移出，需要时可重新加载；授权范围和原工具审批不变。'

/** Register the real definition on demand instead of bypassing its runtime pipeline.
 * Native and PTC presentations both derive their schema/SDK from this registry. */
export function installToolDiscovery(runtime:Pick<ToolRuntime,'register'>,owner:string,store:PartnerStore,entries:DiscoverableTool[]):()=>void {
 const active=new Map<string,()=>void>()
 let closed=false
 const usable=()=>entries.filter(e=>e.allowed())
 const visible=(e:DiscoverableTool)=>({name:e.tool.name,category:category(e.tool.name),summary:e.tool.description.slice(0,160),loaded:active.has(e.tool.name)})
 const guard=(sessionId?:string)=>{
  if(closed||store.isCompanionRemoving(owner)||!store.snapshot().companions.some(c=>c.id===owner&&c.toolDiscovery)||!sessionId||!store.snapshot().sessions.some(r=>r.companionId===owner&&r.sessionId===sessionId))throw Error('当前会话不能使用此伙伴的工具目录')
 }
 const dispose=runtime.register({name:'partner_tools',description:'按需发现并加载本伙伴的工作工具。list 默认仅列分类；带 category 或 query 查询工具概要；describe 返回单项完整说明及参数；load 将原工具加入当前会话但不执行。之后通过真实工具名调用，仍经过原权限与审批流程。常用聊天回复和表情直接可用。',
  parameters:{type:'object',properties:{action:{type:'string',enum:['list','describe','load','unload']},category:{type:'string'},query:{type:'string',maxLength:80},name:{type:'string'},offset:{type:'integer',minimum:0}},required:['action'],additionalProperties:false},
  output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
  presentCall:()=>({card:'generic',title:'伙伴工具目录'}),
  async execute(raw,exec){
   guard(exec.agent?.session.id);exec.signal.throwIfAborted()
   const args=raw as {action:string;category?:string;query?:string;name?:string;offset?:number}
   if(args.action==='list'){
    const all=usable(),query=(args.query??'').trim().toLocaleLowerCase(),offset=args.offset??0
    if(args.category&&!GROUPS.some(g=>g.id===args.category))throw Error('分类不存在，请先查询分类')
    if(!Number.isSafeInteger(offset)||offset<0||query.length>80)throw Error('查询参数无效')
    if(!args.category&&!query)return {categories:GROUPS.map(g=>({...g,count:all.filter(e=>category(e.tool.name)===g.id).length})).filter(g=>g.count),loaded:[...active.keys()],next:'按 category 或 query 查询所需工具'}
    const found=all.filter(e=>(!args.category||category(e.tool.name)===args.category)&&(!query||`${e.tool.name} ${e.tool.description}`.toLocaleLowerCase().includes(query)))
    return {tools:found.slice(offset,offset+12).map(visible),total:found.length,nextOffset:offset+12<found.length?offset+12:null}
   }
   if(!['describe','load','unload'].includes(args.action))throw Error('操作无效')
   const entry=usable().find(e=>e.tool.name===args.name)
   if(!entry)throw Error('工具不存在或能力已撤回，请重新查询目录')
   if(args.action==='unload'){active.get(entry.tool.name)?.();active.delete(entry.tool.name);return {unloaded:entry.tool.name}}
   if(args.action==='load'){
    if(!active.has(entry.tool.name)){
     if(active.size>=4){const oldest=active.keys().next().value!;active.get(oldest)!();active.delete(oldest)}
     // The same ToolDefinition retains validation, execution context, timeout,
     // output/presentation, conclusion and all DSH execution-policy hooks.
     const disposeTool=runtime.register(entry.tool);active.set(entry.tool.name,disposeTool)
    }else{const disposeTool=active.get(entry.tool.name)!;active.delete(entry.tool.name);active.set(entry.tool.name,disposeTool)}
   }
   return {name:entry.tool.name,description:entry.tool.description,parameters:entry.tool.parameters,loaded:active.has(entry.tool.name),next:args.action==='load'?'已加载；下一次调用此真实工具，按原工具要求执行。':'需要执行时先 load 此工具。'}
  }
 })
 return ()=>{closed=true;dispose();for(const remove of active.values())remove();active.clear()}
}
