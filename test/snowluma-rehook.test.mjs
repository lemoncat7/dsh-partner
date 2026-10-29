import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
test('Supervisor recovery listener acknowledges successive events using its framed protocol',()=>{
 const body='processname:other groupname:other pid:123'
 const event=`ver:3.0 server:supervisor serial:1 pool:qq poolserial:1 eventname:PROCESS_STATE_RUNNING len:${Buffer.byteLength(body)}\n${body}`
 const result=spawnSync('python3',[fileURLToPath(new URL('../ops/snowluma-qq-rehook.py',import.meta.url))],{input:event+event,encoding:'utf8',timeout:5000})
 assert.equal(result.status,0,result.stderr)
 assert.equal(result.stdout,'READY\nRESULT 2\nOKREADY\nRESULT 2\nOKREADY\n')
})
test('reattach only restarts the bridge for the current replacement QQ PID',()=>{
 const path=fileURLToPath(new URL('../ops/snowluma-qq-rehook.py',import.meta.url))
 const script=`import importlib.util,sys\nfrom unittest.mock import patch,Mock\nspec=importlib.util.spec_from_file_location('rehook',sys.argv[1])\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nwith patch.object(m.subprocess,'check_output',return_value='123\\n'),patch.object(m.subprocess,'run',return_value=Mock(returncode=0)) as run:\n m.reattach('old');run.assert_not_called()\n m.reattach('123');assert run.call_args.args[0]==['supervisorctl','restart','snowluma'];assert run.call_count==1\n`
 const r=spawnSync('python3',['-c',script,path],{encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr)
})
