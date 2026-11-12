import test from 'node:test'
import assert from 'node:assert/strict'
import {withSpeechTail} from '../lib/voice/audio-tail.js'
import {audioType,MAX_AUDIO_BYTES,synthesize} from '../lib/voice/synthesize.js'
function wav({rate=24000,channels=1,bits=16,frames=2400,quiet=0,metadata=false}={}){
 const width=bits/8,align=width*channels,size=frames*align,pad=size%2
 const b=Buffer.alloc(44+size+pad+(metadata?12:0));b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(channels,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*align,28);b.writeUInt16LE(align,32);b.writeUInt16LE(bits,34);b.write('data',36);b.writeUInt32LE(size,40)
 for(let i=0;i<frames;i++)for(let c=0;c<channels;c++){const offset=44+(i*channels+c)*width,value=i<frames-quiet?Math.round(2**(bits-1)*.25):0;if(bits===8)b[offset]=value+128;else b.writeIntLE(value,offset,width)}
 if(metadata){b.write('LIST',44+size+pad);b.writeUInt32LE(4,48+size+pad);b.write('INFO',52+size+pad)}
 return b
}
for(const bits of [8,16,24,32])for(const channels of [1,2])test(`PCM ${bits}-bit ${channels} channels preserves samples, metadata and legal chunk padding`,()=>{
 const b=wav({bits,channels,frames:2401,quiet:101,metadata:true}),size=b.readUInt32LE(40),out=withSpeechTail(b,MAX_AUDIO_BYTES),align=bits/8*channels
 assert.equal(audioType(out),'audio/wav');assert.equal(out.readUInt32LE(4)+8,out.length)
 assert.deepEqual(out.subarray(44,44+size),b.subarray(44,44+size))
 assert.equal((out.readUInt32LE(40)-size)/align,12000-101)
 assert.ok(out.subarray(44+size,44+out.readUInt32LE(40)).every(x=>x===(bits===8?128:0)))
 assert.equal(out.subarray(-12).toString('ascii'),b.subarray(-12).toString('ascii'))
 assert.deepEqual(withSpeechTail(out,MAX_AUDIO_BYTES),out,'already padded samples are not padded again')
})
test('existing release is kept; unsupported layouts and oversize audio remain unchanged',()=>{
 const b=wav({frames:24000,quiet:14000});assert.equal(withSpeechTail(b,MAX_AUDIO_BYTES),b)
 for(const mutate of [b=>b.writeUInt16LE(3,20),b=>b.writeUInt32LE(5,4),b=>b.writeUInt16LE(3,32),b=>b.writeUInt32LE(3,28),b=>b.writeUInt32LE(999999,40)]){const b=wav();mutate(b);assert.equal(withSpeechTail(b,MAX_AUDIO_BYTES),b)}
 const original=wav();assert.equal(withSpeechTail(original,original.length),original)
 const mp3=Buffer.from('ID3'+'x'.repeat(80));assert.equal(withSpeechTail(mp3,MAX_AUDIO_BYTES),mp3)
})
test('half-second release keeps rounded QQ duration beyond original sound at every fractional second',()=>{
 for(let ms=0;ms<1000;ms+=10){const frames=(1+ms/1000)*24000,b=wav({frames:Math.round(frames),quiet:0}),out=withSpeechTail(b,MAX_AUDIO_BYTES),duration=out.readUInt32LE(40)/48000;assert.ok(Math.round(duration)>=frames/24000+0.25)}
})
test('TTS response receives a release without changing the spoken text or generation settings',async()=>{
 const input=wav(),p={provider:'breezeblue',endpoint:'https://example.test',voice:'v',format:'wav',model:'model',language:'zh',speed:1,authHeader:'key',authPrefix:'',responseMode:'binary'};let sent
 const result=await synthesize(p,'secret','最后一个字','v',new AbortController().signal,async(_url,init)=>{sent=JSON.parse(init.body);return new Response(input,{headers:{'content-type':'audio/wav'}})})
 assert.equal(sent.text,'最后一个字');assert.equal(sent.voice_settings.speed,1);assert.ok(result.data.length>input.length);assert.deepEqual(result.data.subarray(44,input.length),input.subarray(44))
})
