import {PtcExecutor} from '@deepseek-ai/dsh-tool-executor-ptc'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {NativeToolExecutor} from '@deepseek-ai/dsh-tool-executor-native'
export const native=ctx=>ctx.tools.setExecutor(new NativeToolExecutor(ctx))
export const defineContentToolFixture=options=>defineTool({...options,output:{schema:{type:'array',items:{type:'json'}},render:(_args,value)=>value}})

export const ptc=ctx=>ctx.tools.setExecutor(new PtcExecutor(ctx))
export const modeFor=(tools,agent)=>tools.selectExecutor(agent).describe(tools.definitions(agent)).schemas.some(t=>t.name==='run_code')?'ptc':'native'
