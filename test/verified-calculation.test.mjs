import test from 'node:test'
import assert from 'node:assert/strict'
import {verifyCalculations} from '../lib/chat/verified-calculation.js'
const source={runId:'r',facts:['展览当天17:00停止入场。','按当前路线预计18:10到达。'],unknowns:[],evidence:[],artifacts:[]}
const proof={kind:'same-day-clock-difference',runId:'r',from:'17:00',to:'18:10'}
test('same-day time difference is computed by code from selected facts',()=>{
 assert.deepEqual(verifyCalculations([proof],[source]),[{...proof,totalMinutes:70,hours:1,minutes:10}])
 assert.deepEqual(verifyCalculations(undefined,[source]),[])
})
for(const [name,ref,record] of [
 ['invented time',{...proof,to:'19:10'},source],
 ['wrong run',{...proof,runId:'other'},source],
 ['claimed result',{...proof,result:99},source],
 ['overnight',{...proof,from:'18:10',to:'17:00'},source],
 ['invalid clock',{...proof,to:'28:10'},source],
 ['unknown day',proof,{...source,facts:['17:00停止入场，18:10到达。']}],
 ['different dates',proof,{...source,facts:['当天11月1日17:00关闭；11月2日18:10到达。']}],
 ['time zone',proof,{...source,facts:['当天UTC17:00关闭，18:10到达。']}],
 ['uncertain zone',proof,{...source,unknowns:['两个时间的时区尚未确认。']}],
 ['next day',proof,{...source,facts:['当天17:00关闭，次日18:10到达。']}],
 ['artifact is not a clock',proof,{...source,facts:['当天安排尚不明确。'],artifacts:['/17:00/18:10']}],
 ['evidence is not an appointment',proof,{...source,facts:['当天安排尚不明确。'],evidence:['17:00 日志 18:10 日志']}],
])test('rejects unsupported arithmetic: '+name,()=>assert.throws(()=>verifyCalculations([ref],[record])))
test('does not mix independent runs to manufacture an interval',()=>{
 assert.throws(()=>verifyCalculations([proof],[{...source,facts:['当天17:00关闭。']},{...source,runId:'other',facts:['当天18:10到达。']}]))
})
