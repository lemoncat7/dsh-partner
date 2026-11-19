import {createHash} from 'node:crypto'
import {mkdtemp,readFile,realpath,rm,stat,writeFile} from 'node:fs/promises'
import {extname,join,sep} from 'node:path'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {ToolDefinition} from '@deepseek-ai/dsh-tools'
import type {PartnerImageReferences} from './image-references.js'

/** The original image plugin accepts paths inside the calling workspace.
 * Resolve the same trusted references and give its existing tool body temporary paths.
 */
export function legacyImageTool(tool:ToolDefinition,images:Pick<PartnerImageReferences,'resolve'>):ToolDefinition|undefined {
  if(tool.name!=='generate_image'||!tool.description.includes('Generate or edit images using the configured OpenAI-compatible image service.')
    ||tool.description.includes('partner reference authorization is verified'))return
  return {...tool,description:tool.description+' In partner chats the tool also accepts image IDs from this conversation.',
    async execute(raw,exec){
      const input=raw as {referenceImages?:string[]}
      const references=await images.resolve(exec.agent,input.referenceImages??[],exec.signal)
      if(!references)return tool.execute(raw,exec)
      const cwd=exec.agent?.session.header.cwd
      if(!cwd)throw Error('当前会话没有可用的工作目录')
      const root=await realpath(cwd)
      const temporary=references.uploads.length?await mkdtemp(join(root,'.partner-image-input-')):undefined
      try{
        const paths:string[]=[]
        if(temporary)for(const image of references.uploads){
          exec.signal.throwIfAborted()
          const suffix=extname(image.name).toLowerCase()
          const path=join(temporary,String(paths.length)+(/^\.(?:png|jpe?g|webp)$/u.test(suffix)?suffix:'.png'))
          await writeFile(path,image.data,{mode:0o600,flag:'wx',signal:exec.signal})
          paths.push(path)
        }
        const value=await tool.execute({...input,referenceImages:paths},exec)
        if(references.confirm){
          let generated:Parameters<NonNullable<typeof references.confirm>>[0]=[]
          try{
            const result=typeof value==='string'?JSON.parse(value):value
            if(Array.isArray(result?.files))for(const item of result.files.slice(0,4)){
              if(typeof item?.path!=='string')continue
              const path=await realpath(item.path),mediaType=({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'} as Record<string,string>)[extname(path).toLowerCase()]
              if(!mediaType||!path.startsWith(join(root,'generated')+sep))continue
              const info=await stat(path)
              if(!info.isFile()||info.size>20*1024*1024)continue
              const bytes=await readFile(path,{signal:exec.signal})
              generated.push({path,mediaType,bytes:bytes.length,digest:createHash('sha256').update(bytes).digest('hex')})
            }
          }catch{generated=[]}
          references.confirm(generated)
        }
        return value
      }finally{if(temporary)await rm(temporary,{recursive:true,force:true})}
    },
  }
}

export function installLegacyImageTool(agent:Agent,images:PartnerImageReferences):void {
  if(!images.managesSession(agent.session.id))return
  const tool=agent.ctx.tools.get('generate_image')
  if(!tool||agent.ctx.tools.get('generate_image',agent)!==tool)return
  const adapted=legacyImageTool(tool,images)
  if(adapted)agent.ctx.effect(()=>agent.ctx.tools.register(adapted))
}
