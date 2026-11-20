import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {join} from 'node:path'
import {once} from 'node:events'

process.on('disconnect',()=>process.exit(0))
const [workerData]=await once(process,'message')
const send=value=>process.send(value)

const {modelDir, packages, assets, training, custom, groupModels, groupTraining} = workerData
const require = createRequire(join(packages, 'package.json'))
const ort = require('onnxruntime-node')
const tokenizerModule = await import(require.resolve('@huggingface/tokenizers'))
const Tokenizer = tokenizerModule.Tokenizer ?? tokenizerModule.default?.Tokenizer
const json = async (directory, file) => JSON.parse(await readFile(join(directory, file), 'utf8'))
const tokenizer = new Tokenizer(await json(modelDir, 'tokenizer.json'), {})
const session = await ort.InferenceSession.create(join(modelDir, 'model.onnx'), {
  executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1,
})
const dot = (a,b) => a.reduce((sum,x,i) => sum+x*b[i],0)
const cache = new Map()

async function encode(texts) {
  const rows = texts.map(text => {
    const tokens = tokenizer.encode(text.slice(0,1200), {add_special_tokens:true})
    const truncate = values => values.length <= 128 ? values : [...values.slice(0,127),values.at(-1)]
    return {ids:truncate(tokens.ids), types:truncate(tokens.token_type_ids ?? tokens.ids.map(() => 0))}
  })
  const width = Math.max(...rows.map(r => r.ids.length))
  const tensor = get => new ort.Tensor('int64',
    BigInt64Array.from(rows.flatMap(r => Array.from({length:width},(_,j) => get(r,j))),BigInt),
    [rows.length,width])
  const inputs = {input_ids:tensor((r,j)=>r.ids[j]??0), attention_mask:tensor((r,j)=>+(j<r.ids.length)),
    token_type_ids:tensor((r,j)=>r.types[j]??0)}
  const output = Object.values(await session.run(Object.fromEntries(session.inputNames.map(name=>[name,inputs[name]]))))[0]
  const dim = output.dims.at(-1)
  return rows.map((row,index) => {
    const vector = new Float32Array(dim)
    const length = output.dims.length===3 ? row.ids.length : 1
    for(let j=0;j<length;j++) for(let k=0;k<dim;k++)
      vector[k]+=output.data[(index*(output.dims.length===3?width:1)+j)*dim+k]/length
    const norm=Math.hypot(...vector)||1
    return vector.map(v=>v/norm)
  })
}

async function vectorsFor(texts) {
  const now=Date.now()
  for (const [hash,value] of cache) if(now-value.at>120_000)cache.delete(hash)
  const keys=texts.map(text=>createHash('sha256').update(text).digest('hex'))
  const missing=new Map(keys.map((key,i)=>[key,texts[i]]).filter(([key])=>!cache.has(key)))
  if(missing.has(keys[0])){
    cache.set(keys[0],{vector:(await encode([missing.get(keys[0])]))[0],at:now})
    missing.delete(keys[0])
  }
  if(missing.size){
    const vectors=await encode([...missing.values()])
    Array.from(missing.keys(),(key,i)=>cache.set(key,{vector:vectors[i],at:now}))
  }
  const vectors=keys.map(key=>{
    const entry=cache.get(key);cache.delete(key);cache.set(key,entry);return entry.vector
  })
  while(cache.size>128)cache.delete(cache.keys().next().value)
  return vectors
}

function ranking(logits) {
  const max = Math.max(...logits)
  const exp = logits.map(v=>Math.exp(v-max))
  const total = exp.reduce((sum,v)=>sum+v,0)
  const scores = exp.map(v=>v/total)
  const order = scores.map((_,i)=>i).sort((a,b)=>scores[b]-scores[a]||b-a)
  return {index:order[0],confidence:scores[order[0]],margin:scores[order[0]]-scores[order[1]],scores}
}

function logits(head,vector) {
  const scores = head.bias.slice()
  for(let i=0;i<vector.length;i++) for(let j=0;j<scores.length;j++) scores[j]+=vector[i]*head.weights[i][j]
  return scores
}

function predict(head,vector) {
  const {index,confidence,margin}=ranking(logits(head,vector))
  return {label:head.labels[index],confidence,margin}
}

const bigrams = text => {
  const chars=Array.from(text.toLowerCase().replace(/[^\p{L}\p{N}]/gu,''))
  return new Set(chars.slice(1).map((v,i)=>chars[i]+v))
}
const overlap = (a,b) => a.size&&b.size ? [...a].filter(v=>b.has(v)).length/Math.sqrt(a.size*b.size) : 0
function dialogueLink(head,query,turns,vectors,text) {
  const terms=bigrams(text), words=turns.map(turn=>bigrams(turn.text))
  const scores=Array(7).fill(-Infinity)
  scores[6]=0
  for(const [index,turn] of turns.entries()){
    if(turn.speaker===1)continue
    const vector=vectors[index],similarity=dot(query,vector),previous=turn.replyTo
    const hasParent=Number.isInteger(previous)&&previous>=0&&previous<index
    const separation=turns.length-1-index
    const features=[1,similarity,similarity**2,hasParent?dot(query,vectors[previous]):0,
      separation/6,+(turn.recipient===1),+(separation===0),similarity/(1+separation),
      +(turn.recipient!==undefined&&turn.recipient!==1),+turns.slice(index+1).some(t=>t.replyTo===index),
      overlap(terms,words[index]),hasParent?overlap(terms,words[previous]):0]
    scores[index]=dot(query,head.weights)+dot(vector,head.weights.slice(query.length))/2+
      dot(features,head.weights.slice(query.length*2))
  }
  const {index,confidence,margin}=ranking(scores)
  return {index:index===6?null:index,confidence,margin}
}

const defaults = { intent:await json(assets,'head.json'), scene:await json(assets,'scene-head.json'),
  dialogue:await json(assets,'dialogue-head.json').catch(error=>{if(error.code!=='ENOENT')throw error}) }
const baseHeads = {...defaults,...custom}
async function classify({text,context=[],profile=[],partnerText,dialogue=[],groupScope,boundRelationship}) {
  const scoped=groupScope?groupModels?.[groupScope]:undefined
  const heads=scoped?.builtin?defaults:{...baseHeads,...scoped?.heads}
  if(boundRelationship&&scoped?.relationshipAliases?.length){
    const original=text.normalize('NFKC')
    const prefix=/^[@＠]?\s*/u.exec(original)?.[0]??''
    for(const alias of [...scoped.relationshipAliases].sort((a,b)=>b.length-a.length)){
      if(!boundRelationship.normalize('NFKC').includes(alias)||!original.slice(prefix.length).startsWith(alias))continue
      const tail=original.slice(prefix.length+alias.length)
      if(!tail||/^[\s\p{P}]/u.test(tail)||/^你/u.test(tail)){text=prefix+'伙伴'+tail;break}
    }
  }
  const legacy=[text,...context,...profile,...(partnerText?[partnerText]:[])]
  const vectors=await vectorsFor([...legacy,...dialogue.map(t=>t.text)])
  const query=vectors[0]
  const similarity = others => Math.max(0,Math.min(1,Math.max(...others.map(vector=>dot(query,vector)))))
  return {
    ...predict(heads.intent,query),scene:predict(heads.scene,query),
    ...(context.length?{contextSimilarity:similarity(vectors.slice(1,context.length+1))}:{}),
    ...(profile.length?{profileSimilarity:similarity(vectors.slice(context.length+1,1+context.length+profile.length))}:{}),
    ...(partnerText?{replySimilarity:similarity([vectors[legacy.length-1]])}:{}),
    ...(heads.dialogue&&dialogue.length?{link:dialogueLink(heads.dialogue,query,dialogue,vectors.slice(legacy.length),text)}:{}),
  }
}

async function dataset(rows) {
  const vectors=[]
  for(let i=0;i<rows.length;i+=8)vectors.push(...await encode(rows.slice(i,i+8).map(row=>row.text)))
  return rows.map((row,i)=>({vector:vectors[i],label:row.label,persona:row.persona===true,personaScene:row.personaScene===true}))
}

async function train(name, samples, evaluation) {
  const baseline=defaults[name]
  const additions=groupTraining?.samples.train[name]??[]
  const bundled=await json(assets,samples)
  const rows=await dataset(groupTraining?additions:bundled)
  const scoped=groupTraining?groupModels?.[groupTraining.scope]:undefined
  const incumbent=groupTraining&&!scoped?.builtin?(scoped?.heads?.[name]??baseHeads[name]):baseline
  const width=rows[0].vector.length
  const count=baseline.labels.length
  const weights=groupTraining?baseline.weights.map(row=>row.slice()):Array.from({length:width},()=>Array(count).fill(0))
  const bias=groupTraining?baseline.bias.slice():Array(count).fill(0)
  let head={...baseline,weights,bias,trainingCount:rows.length}
  const targets=rows.map(row=>baseline.labels.indexOf(row.label))
  if(targets.includes(-1))throw Error('训练样本包含未知分类')
  const weightsByRow=rows.map(row=>row.persona||row.personaScene?2:1)
  const totalWeight=weightsByRow.reduce((sum,value)=>sum+value,0)
  const gradient=weights.map(row=>row.slice())
  const biasGradient=bias.slice()
  for(let step=0;step<1800;step++){
    for(const row of gradient)row.fill(0)
    biasGradient.fill(0)
    for(let row=0;row<rows.length;row++){
      const {vector}=rows[row]
      const raw=logits(head,vector), max=Math.max(...raw)
      const exp=raw.map(v=>Math.exp(v-max)),total=exp.reduce((a,b)=>a+b,0)
      const errors=exp.map((v,j)=>(v/total-+(j===targets[row]))*weightsByRow[row]/totalWeight)
      for(let j=0;j<count;j++)biasGradient[j]+=errors[j]
      for(let i=0;i<width;i++)for(let j=0;j<count;j++)gradient[i][j]+=vector[i]*errors[j]
    }
    for(let i=0;i<width;i++)for(let j=0;j<count;j++)weights[i][j]-=1.5*(gradient[i][j]+(groupTraining?.samples ? .07*(weights[i][j]-baseline.weights[i][j]) : .001*weights[i][j]))
    for(let j=0;j<count;j++)bias[j]-=1.5*(biasGradient[j]+(groupTraining?.samples ? .07*(bias[j]-baseline.bias[j]) : 0))
  }
  const accuracy=(checks,model)=>checks.filter(row=>predict(model,row.vector).label===row.label).length
  const generic=await dataset(await json(assets,evaluation))
  const previousAccuracy=accuracy(generic,incumbent)
  if(groupTraining&&accuracy(generic,head)<previousAccuracy-2){
    const learned=head
    for(const strength of [.5,.25,.125,.0625]){
      const blend=(trained,original)=>original+strength*(trained-original)
      head={...learned,weights:learned.weights.map((row,i)=>row.map((value,j)=>blend(value,incumbent.weights[i][j]))),
        bias:learned.bias.map((value,j)=>blend(value,incumbent.bias[j]))}
      if(accuracy(generic,head)>=previousAccuracy-2)break
    }
  }
  const check=checks=>({total:checks.length,correct:accuracy(checks,head),baseline:accuracy(checks,incumbent),training:rows.length})
  const result=check(generic)
  const signature=text=>text.normalize('NFKC').toLowerCase().replace(/[\p{Z}\p{P}\p{S}]/gu,'')
  const builtIns=new Set(bundled.map(row=>signature(row.text)))
  const holdout=groupTraining?.samples.holdout[name].filter(row=>!builtIns.has(signature(row.text)))
  if(holdout&&(holdout.length<10||new Set(holdout.map(row=>row.label)).size<2)){
    return {head,result,held:undefined}
  }
  const checks=holdout?await dataset(holdout):undefined
  const held=checks?check(checks):undefined
  const personaCheck=labelMatches=>{
    const selected=checks.filter(row=>row.persona&&labelMatches(row.label))
    const correct=model=>selected.filter(row=>labelMatches(predict(model,row.vector).label)).length
    return {total:selected.length,correct:correct(head),baseline:correct(incumbent),
      training:rows.filter(row=>row.persona&&labelMatches(row.label)).length}
  }
  const persona=checks&&(name==='intent'?{
    personaCalls:personaCheck(label=>label==='address'),
    personaNonCalls:personaCheck(label=>label!=='address'),
  }:{
    personaScenes:{...check(checks.filter(row=>row.personaScene)),training:rows.filter(row=>row.personaScene).length},
  })
  return {head,result,held,persona}
}

if(training){
  const intent=await train('intent','training.json','evaluation.json')
  const scene=await train('scene','scene-training.json','scene-evaluation.json')
  send({trained:{intent:intent.head,scene:scene.head},results:{intent:intent.result,scene:scene.result,...(groupTraining?{groupIntent:intent.held,groupScene:scene.held,...intent.persona,...scene.persona}:{})}})
}else{
  await classify({text:'你好'})
  send({ready:true})
  let queue=Promise.resolve()
  process.on('message',({id,input,expiresAt})=>{
    queue=queue.then(async()=>{
      if(Date.now()>=expiresAt)return
      try{send({id,result:await classify(input)})}
      catch{send({id,error:true})}
    })
  })
}
