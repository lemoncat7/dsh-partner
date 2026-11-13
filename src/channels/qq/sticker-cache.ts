import type {QqFace} from './catalog.js'
export class QqStickerCache {
 private readonly entries=new Map<string,{at:number;faces:Promise<QqFace[]>}>()
 constructor(private readonly load:(id:string,kind:'image'|'all')=>Promise<QqFace[]>,private readonly now=Date.now){}
 get(id:string,revision:number,kind:'image'|'all'):Promise<QqFace[]> {
  const key=JSON.stringify([id,revision,kind]),cached=this.entries.get(key)
  if(cached&&this.now()-cached.at<300000)return cached.faces
  const faces=Promise.resolve().then(()=>this.load(id,kind))
  this.entries.set(key,{at:this.now(),faces})
  if(this.entries.size>100)this.entries.delete(this.entries.keys().next().value!)
  void faces.catch(()=>{if(this.entries.get(key)?.faces===faces)this.entries.delete(key)})
  return faces
 }
 invalidate(id:string):void {for(const key of this.entries.keys())if(JSON.parse(key)[0]===id)this.entries.delete(key)}
}
