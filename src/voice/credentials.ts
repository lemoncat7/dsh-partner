import {credentialKey,type CredentialProvider} from '@deepseek-ai/dsh-credentials'
export class TtsCredentials {
 constructor(private provider:CredentialProvider){}
 async read(id:string):Promise<string>{const r=await this.provider.readRecord(credentialKey('dsh-partner-tts',id));if(!r||r.kind!=='grant'||typeof (r.payload as any).key!=='string')throw Error('TTS 密钥未配置，请在语音 TTS 中保存');return (r.payload as {key:string}).key}
 async write(id:string,key:string):Promise<void>{await this.provider.modifyRecord(credentialKey('dsh-partner-tts',id),async()=>({kind:'grant',payload:{key}}))}
 async delete(id:string):Promise<void>{await this.provider.deleteRecord(credentialKey('dsh-partner-tts',id))}
}
