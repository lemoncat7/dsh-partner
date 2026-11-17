/** Preserve the native continuation path while restoring per-activation delivery/schema. */
export function patchBackgroundContinuation(source){
 const marker='// dsh-partner: resume the same task with caller-owned delivery and structured output'
 if(source.includes(marker))return source
 const runtimeNeedle='\t\tasync sendMessage(sender, targetId, content, options) {'
 if(source.split(runtimeNeedle).length!==2)throw Error('Unrecognized native sendMessage entry')
 let next=source.replace(runtimeNeedle,`\t\t${marker}
\t\tasync resumeActivation(spec) {
\t\t\tconst provider = this.expectProvider(spec.provider);
\t\t\tif (provider.prepareContinuable === void 0 || spec.delivery !== "caller" || typeof spec.childId !== "string") throw new SubagentError("task resume requires a continuable caller-delivered target", "UNSUPPORTED_CAPABILITY");
\t\t\tthis.assertCapabilities(provider, spec);
\t\t\tif (this.ctx.get("agents")?.get(spec.parent.id) !== spec.parent) throw new SubagentError("task resume requires the exact live parent", "UNAUTHORIZED");
\t\t\tif (spec.outputSchema !== void 0) assertObjectJsonSchema(spec.outputSchema);
\t\t\treturn this.requireManager().resumeLocalActivation({...spec, authorizeProvider: () => this.assertProviderCurrent(provider)});
\t\t}
${runtimeNeedle}`)
 const managerNeedle='\t/** Capture creation ancestry separately from the root that owns the new instance. */'
 if(next.split(managerNeedle).length!==2)throw Error('Unrecognized native continuation manager')
 next=next.replace(managerNeedle,`\tasync resumeLocalActivation(spec) {
\t\tconst root = this.rootOf(spec.parent);
\t\tif (spec.childId === root.id) throw new SubagentError("cannot resume the root as a task", "UNAUTHORIZED");
\t\twhile (true) {
\t\t\tthis.assertAdmitting(spec.parent);
\t\t\tspec.signal.throwIfAborted();
\t\t\tconst outcome = await this.locks.run(spec.childId, async () => {
\t\t\t\tconst live = this.resident.get(spec.childId);
\t\t\t\tif (live?.closing !== void 0) return { closing: live.closing };
\t\t\t\tif (live !== void 0) throw new SubagentError("task is already active", "ACTIVATION_ACTIVE");
\t\t\t\tconst restored = await this.restoreTarget(root, spec.childId, spec.signal, {provider: spec.provider, delivery: "caller", outputSchema: spec.outputSchema});
\t\t\t\tconst messageId = await this.submitMaterialized(restored, spec.prompt, {source: {kind: "user"}, signal: spec.signal, delivery: "queue", authorize: () => {this.assertAdmitting(spec.parent); spec.authorizeProvider();}}, root);
\t\t\t\treturn { receipt: {...this.receipt(restored), messageId} };
\t\t\t});
\t\t\tif ("receipt" in outcome) return outcome.receipt;
\t\t\tawait Promise.allSettled([outcome.closing]);
\t\t}
\t}
${managerNeedle}`)
 const start=next.indexOf('\tasync restoreTarget(root, childId, signal) {'),end=next.indexOf('\n\t/** Admit a materialized child',start)
 if(start<0||end<0)throw Error('Unrecognized native cold restoration')
 let restore=next.slice(start,end).replace('restoreTarget(root, childId, signal)', 'restoreTarget(root, childId, signal, taskOptions)')
 const descriptorNeedle='\t\t\t\tconst descriptor = foldSubagentDescriptor(source.events.slice(source.inheritedEventCount));'
 const materializeNeedle='\t\t\t\t\t\tsignal\n\t\t\t\t\t});'
 if(restore.split(descriptorNeedle).length!==2||restore.split(materializeNeedle).length!==2)throw Error('Unrecognized native restoration setup')
 restore=restore.replace(descriptorNeedle,descriptorNeedle+'\n\t\t\t\tif (taskOptions?.provider !== void 0 && descriptor?.provider !== taskOptions.provider) throw new SubagentError("task provider changed", "PROVIDER_CHANGED");')
 restore=restore.replace(materializeNeedle,'\t\t\t\t\t\t...taskOptions === void 0 ? {} : {delivery: taskOptions.delivery, outputSchema: taskOptions.outputSchema},\n'+materializeNeedle)
 return next.slice(0,start)+restore+next.slice(end)
}
