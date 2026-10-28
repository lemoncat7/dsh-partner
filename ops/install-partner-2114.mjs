// Runs offline in a helper container against the stopped production volume.
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, mkdirSync, mkdtempSync, renameSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const profile='/data/profiles/web', scope=profile+'/node_modules/@lemoncat7', target=scope+'/dsh-partner'
const saved='/backup/install-state.json'
// The deployment script has stopped the sole container using this data volume.
// Container PID reuse otherwise makes an abandoned credentials lock look live.
function releaseStoppedWriterLock(){
  const path='/data/.credentials.yaml.lock'
  if(!existsSync(path))return
  // A stop can occur after creating the lock but before writing the PID.
  // The deployment guard has stopped the sole writer; retain even empty locks
  // in the backup before releasing them. Reject any other unexpected contents.
  assert.match(readFileSync(path,'utf8').trim(), /^(?:\d+)?$/)
  copyFileSync(path,'/backup/credentials-stale-'+Date.now()+'.lock')
  unlinkSync(path)
}
function restore(){
  releaseStoppedWriterLock()
  const state=JSON.parse(readFileSync(saved))
  assert.ok(state.old.startsWith('/data/plugin-package-backups/partner-2114-'))
  if(existsSync(state.old)){
    if(existsSync(target))renameSync(target,state.old+'-failed')
    renameSync(state.old,target)
  }
  for(const file of ['package.json','package-lock.json'])copyFileSync('/backup/'+file,profile+'/'+file)
  execFileSync('chown',['1000:1000',profile+'/package.json',profile+'/package-lock.json'])
}
if(process.argv[2]==='restore'){restore();console.log('Previous partner package and install metadata restored');process.exit(0)}
const next=JSON.parse(execFileSync('tar',['-xOzf','/package.tgz','package/package.json']))
const prev=JSON.parse(readFileSync(target+'/package.json'))
assert.equal(next.name,'@lemoncat7/dsh-partner');assert.equal(next.version,'2.11.4')
assert.equal(next.engines.dsh,'^0.2.1-rc.2');assert.deepEqual(next.dependencies,prev.dependencies)
assert.equal(existsSync(target+'/node_modules'),false,'Review nested dependencies before replacing package')
for(const file of ['package.json','package-lock.json'])copyFileSync(profile+'/'+file,'/backup/'+file)
execFileSync('tar',['-cf','/backup/partner-package.tar','-C',scope,'dsh-partner'])
execFileSync('tar',['-cf','/backup/partner-data.tar','-C','/data','partner'])
// Private state and memory live outside /data; capture them while the sole writer is stopped.
const privateDirs=readdirSync('/partner-workspaces',{withFileTypes:true})
  .filter(entry=>entry.isDirectory() && existsSync('/partner-workspaces/'+entry.name+'/.partner'))
  .map(entry=>entry.name+'/.partner')
execFileSync('tar',['-cf','/backup/partner-private-state.tar','-C','/partner-workspaces','--null','-T','-'],{input:privateDirs.map(path=>path+'\0').join('')})
releaseStoppedWriterLock()
const stage=mkdtempSync(scope+'/.partner-2114-stage-')
execFileSync('tar',['-xzf','/package.tgz','--strip-components=1','-C',stage])
execFileSync('chown',['-R','1000:1000',stage])
mkdirSync('/data/plugin-package-backups',{recursive:true})
const old=mkdtempSync('/data/plugin-package-backups/partner-2114-')+'/package'
writeFileSync(saved,JSON.stringify({old,previousVersion:prev.version}),{mode:0o600})
try{
  renameSync(target,old);renameSync(stage,target)
  const archiveDir='/data/local-plugins/partner-2.11.4'
  mkdirSync(archiveDir,{recursive:true});copyFileSync('/package.tgz',archiveDir+'/lemoncat7-dsh-partner-2.11.4.tgz')
  execFileSync('chown',['-R','1000:1000',archiveDir])
  const spec='file:../../local-plugins/partner-2.11.4/lemoncat7-dsh-partner-2.11.4.tgz'
  const pkg=JSON.parse(readFileSync(profile+'/package.json')),lock=JSON.parse(readFileSync(profile+'/package-lock.json'))
  assert.ok(pkg.dependencies[next.name]);assert.ok(lock.packages[''].dependencies[next.name])
  const record=lock.packages['node_modules/'+next.name];assert.ok(record)
  pkg.dependencies[next.name]=spec;lock.packages[''].dependencies[next.name]=spec
  record.version=next.version;record.resolved=spec.slice(5)
  record.integrity='sha512-'+createHash('sha512').update(readFileSync('/package.tgz')).digest('base64')
  for(const [file,data] of [['package.json',pkg],['package-lock.json',lock]])writeFileSync(profile+'/'+file,JSON.stringify(data,null,2)+'\n')
  console.log('Installed partner 2.11.4; previous package and metadata retained for rollback')
}catch(error){restore();throw error}
