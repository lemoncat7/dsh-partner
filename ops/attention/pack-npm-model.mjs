/** Build the optional, data-only npm package from the pinned model files. */
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const [source,out]=process.argv.slice(2)
if(!source||!out)throw Error('Usage: node ops/attention/pack-npm-model.mjs MODEL_DIR OUTPUT_DIR')
const assets=fileURLToPath(new URL('./',import.meta.url))
const manifest=JSON.parse(await readFile(join(assets,'model-manifest.json'),'utf8'))
const {name,version}=manifest.npm
const outDir=resolve(out)
await mkdir(outDir,{recursive:true})
const stage=await mkdtemp(join(tmpdir(),'dsh-attention-model-package-'))
try{
 for(const entry of manifest.files){
  const file=join(resolve(source),entry.path)
  const hash=createHash('sha256')
  for await(const chunk of createReadStream(file))hash.update(chunk)
  if((await stat(file)).size!==entry.bytes||hash.digest('hex')!==entry.sha256)throw Error('Model checksum mismatch: '+entry.path)
  await copyFile(file,join(stage,entry.path))
 }
 await copyFile(join(assets,'MODEL-LICENSE'),join(stage,'LICENSE'))
 await writeFile(join(stage,'package.json'),JSON.stringify({
  name,version,description:'Pinned MiniLM INT8 ONNX model files for DSH Partner local QQ attention',
  license:'Apache-2.0',repository:{type:'git',url:'git+https://github.com/lemoncat7/dsh-partner.git',directory:'ops/attention'},
  files:[...manifest.files.map(entry=>entry.path),'model-manifest.json','LICENSE','NOTICE','README.md'],
  publishConfig:{access:'public',registry:'https://registry.npmjs.org'},
 },null,2)+'\n')
 await writeFile(join(stage,'model-manifest.json'),JSON.stringify(manifest,null,2)+'\n')
 const sourceLink='https://huggingface.co/'+manifest.repository+'/tree/'+manifest.revision
 await writeFile(join(stage,'NOTICE'),[
  'Sentence encoder: sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2.',
  'Upstream model: https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
  'INT8 ONNX conversion and tokenizer distributed by Xenova.',
  'Exact source revision: '+sourceLink,
  'The model.onnx file is the upstream onnx/model_quantized.onnx with its local filename changed. Model bytes and tokenizer are unmodified.',
  'This package does not contain DSH Partner classification heads, training samples, or executable JavaScript.',
 ].join('\n')+'\n')
 await writeFile(join(stage,'README.md'),[
  '# DSH Partner optional MiniLM files','',
  'MiniLM INT8 ONNX encoder and tokenizer for local QQ attention. DSH Partner downloads this optional data package on demand.',
  'See NOTICE for upstream attribution and model-manifest.json for the pinned revision and SHA-256 checksums.',
  '','License: Apache-2.0.','',sourceLink,'',
 ].join('\n'))
 const result=execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',outDir],{cwd:stage,encoding:'utf8'})
 const [packed]=JSON.parse(result)
 console.log(JSON.stringify({file:join(outDir,packed.filename),size:packed.size,unpackedSize:packed.unpackedSize,integrity:packed.integrity}))
}finally{await rm(stage,{recursive:true,force:true})}
