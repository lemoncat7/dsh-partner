export type AttentionLabel = 'address' | 'engage' | 'other' | 'close' | 'background'
export type AttentionScene = 'address'|'question'|'banter'|'share'|'topic'|'close'|'other'|'background'
export interface ScenePrediction {label:AttentionScene;confidence:number;margin:number}
export function isClearScene(scene:ScenePrediction|undefined):boolean {return !!scene&&(scene.confidence>=.6&&scene.margin>=.2||scene.confidence>=.5&&scene.margin>=.25)}
export interface AttentionTurn {speaker:number;text:string;recipient?:number;replyTo?:number}
export interface AttentionFrame {groupScope?:string;boundRelationship?:string;profile?:readonly string[];partnerText?:string;dialogue?:readonly AttentionTurn[]}
export interface AttentionLink {index:number|null;confidence:number;margin:number}
export function recognizedLink(link:AttentionLink|undefined):boolean {
 return !!link&&link.index!==null&&link.confidence>=.65&&link.margin>=.2
}
export interface RecipientPrediction {label:'partner'|'member'|'open';confidence:number;margin:number}
export function recognizedRecipient(prediction:RecipientPrediction|undefined):'partner'|'member'|undefined {
 if(prediction&&prediction.label!=='open'&&prediction.confidence>=.65&&prediction.margin>=.2)return prediction.label
}
export interface AttentionPrediction { label:AttentionLabel; confidence:number; margin:number; contextSimilarity?:number;replySimilarity?:number;profileSimilarity?:number;scene?:ScenePrediction;link?:AttentionLink;recipient?:RecipientPrediction }
/** Use the same call evidence for admission, busy queues and interjection limits. */
export function isAttentionCall(prediction:AttentionPrediction|undefined):boolean {
 if(!prediction)return false
 // These heads are uncalibrated rankings, not probabilities of a correct answer.
 // Correlated heads agreeing is insufficient alone: require support from the
 // current persona or delivered conversation when relaxing the score cutoff.
 const relevant=(prediction.profileSimilarity??0)>=.45||(prediction.replySimilarity??0)>=.4||(prediction.contextSimilarity??0)>=.4
 if(prediction.label==='address'&&prediction.scene?.label==='address'&&relevant)return true
 const addressed=prediction.label==='address'&&(prediction.confidence>=.65&&prediction.margin>=.15||prediction.confidence>=.58&&prediction.margin>=.2||prediction.confidence>=.45&&prediction.margin>=.25||prediction.confidence>=.48&&prediction.margin>=.12&&(prediction.contextSimilarity??0)>=.4)
 const strongOther=prediction.scene?.label==='other'&&prediction.scene.confidence>=.8&&prediction.scene.margin>=.5
 const supported=prediction.confidence>=.65&&prediction.margin>=.15||prediction.confidence>=.48&&prediction.margin>=.12&&(prediction.contextSimilarity??0)>=.4
 // Scene and address heads score the same text independently. A negative scene
 // cannot erase contextual evidence that the speaker is addressing the partner.
 return addressed&&(!strongOther||supported)||isClearScene(prediction.scene)&&prediction.scene!.label==='address'
}
export interface AttentionDiagnostic {status:'ok'|'empty'|'busy'|'backoff'|'timeout'|'transport'|'http'|'invalid'|'unconfigured';attempts:number;retryAfterMs?:number}
export type AttentionClassifier = (text:string,signal:AbortSignal,context?:readonly string[],report?:(diagnostic:AttentionDiagnostic)=>void,frame?:AttentionFrame)=>Promise<AttentionPrediction|undefined>
