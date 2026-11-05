import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { scopeOf, scopeChainOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRuntime, ToolDefinition, ToolExecutor } from '@deepseek-ai/dsh-tools'

// DSH 0.2.2-rc.1 has no public read accessor for the selected executor. Keep
// this version-pinned adapter in one place; never mutate host registry records.
// Restoration resolves the inherited provider again, so unloading it fails closed.
type ExecutorRegistry = {selectExecutor(scope?: ScopeKey): ToolExecutor}
const presentations = new WeakMap<object, {active?: ToolExecutor}>()
export function nativePresentation(ctx: Context, filter: (tools: readonly ToolDefinition[]) => readonly ToolDefinition[] = tools => tools): () => void {
  const tools = ctx.tools as ToolRuntime & {presentAs?: (mode: 'native') => () => void}
  if (typeof tools.presentAs === 'function') return tools.presentAs('native')
  const scope=scopeOf(ctx)
  if (!scope) throw new Error('伙伴工具展示需要独立 Agent 作用域')
  let state=presentations.get(scope)
  if(!state){
    const registry=tools as unknown as ExecutorRegistry
    if(typeof registry.selectExecutor!=='function')throw new Error('当前宿主缺少已验证的执行器选择接口')
    state={};const selected=state
    const inherited=()=>registry.selectExecutor(scopeChainOf(scope)[1])
    let inheritedSections: ToolExecutor['sections']=[]
    try {inheritedSections=inherited().sections??[]}catch { /* A native-only child may provide the first executor. */ }
    const sections=inheritedSections.map(section=>({...section,text:(definitions:readonly ToolDefinition[])=>{
      if(selected.active)return ''
      const current=inherited().sections?.find(item=>item.name===section.name)
      return typeof current?.text==='function'?current.text(definitions):current?.text??''
    }}))
    tools.setExecutor({sections,describe: definitions=>(selected.active??inherited()).describe(definitions),execute: input=>(selected.active??inherited()).execute(input)})
    presentations.set(scope,state)
    ctx.effect(()=>()=>{presentations.delete(scope)})
  }
  const native=new NativeToolExecutor(ctx)
  const executor:ToolExecutor={describe: definitions=>native.describe(filter(definitions)),execute: input=>native.execute(input)}
  state.active=executor
  return ()=>{if(state.active===executor)delete state.active}
}
