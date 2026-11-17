/** Await scoped registration before the host freezes this step's executable set. */
export function patchPrepareTools(source){
 const marker='// dsh-partner: prepare scoped tools before resolving step admission'
 if(source.includes(marker))return source
 const needle='\t\tconst toolSet = await this.loopCtx.tools.resolve({'
 if(source.split(needle).length!==2||!source.includes('async preStep(target, position) {'))throw Error('Unrecognized native tool admission boundary')
 return source.replace(needle,`\t\t${marker}
\t\tawait this.dispatch.serial("agent/prepare-tools", {messages: claimed, ...position, signal, modelSelection: selection});
\t\tsignal.throwIfAborted();
${needle}`)
}
