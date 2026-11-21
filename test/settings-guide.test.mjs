import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { registerPartnerApi } from '../lib/api.js'
import { findSettings, settingsCatalog } from '../lib/settings/catalog.js'
import { explainSettings, parseSettingsGuideReply } from '../lib/settings/guide.js'

test('setting search matches everyday questions without asking a model', () => {
  for (const wording of ['不 @ 也回', '群里不用艾特也能回吗', '为什么只有＠才回？']) {
    assert.equal(findSettings(wording)[0]?.id, 'qq-autonomy', wording)
  }
  assert.deepEqual(findSettings('怎么发语音？').slice(0, 2).map(item => item.id), ['qq-voice', 'tts'])
  assert.equal(findSettings('上下文')[0]?.id, 'memory-window')
  assert.equal(findSettings('分段')[0]?.id, 'chat-style')
  assert.deepEqual(findSettings(' ！ '), [])
  assert.equal(new Set(settingsCatalog.map(item => item.id)).size, settingsCatalog.length)
})

test('guide suggestions accept only known settings, capped in their original order', () => {
  const ids = ['tts', '/somewhere', 'tts', 42, 'qq-voice', 'qq-autonomy', 'identity', 'memory', 'browser']
  const json = JSON.stringify({ answer: '  先确认语音服务。 ', settingIds: ids, operation: 'write' })
  assert.deepEqual(parseSettingsGuideReply('\x60\x60\x60json\n' + json + '\n\x60\x60\x60'), {
    answer: '先确认语音服务。',
    settingIds: ['tts', 'qq-voice', 'qq-autonomy', 'identity', 'memory'],
  })
  assert.throws(() => parseSettingsGuideReply('{"answer":" ","settingIds":[]}'), /格式无效/)
})

test('settings guide API passes only current partner configuration facts and keeps changes in the original forms', async () => {
  const companion = {
    id: 'partner-a', provider: 'selected-provider', model: 'selected-model',
    instructions: 'PRIVATE_INSTRUCTIONS', relationshipText: 'PRIVATE_RELATIONSHIP',
    capabilities: ['chat'], browser: { enabled: true, endpoint: 'PRIVATE_ENDPOINT' },
    automation: { memory: { enabled: true, dailyReviewEnabled: false, rollingContextEnabled: true } },
    ttsProfiles: [{ id: 'profile-one', credential: 'PRIVATE_CREDENTIAL' }],
  }
  const state = {
    companions: [companion],
    channels: [
      { id: 'qq-a', companionId: 'partner-a', enabled: true, platform: 'qq', accountId: 'PRIVATE_ACCOUNT',
        qq: { groupReplies: true, groupIds: ['12345678'], autonomousGroupIds: ['12345678', '12345679'],
          replyVoiceEnabled: true, replyVoiceGroupId: '12345678', identityBinding: { enabled: true, qqIds: ['12345670'] } },
        tts: { enabled: true, profileId: 'profile-one' } },
      { id: 'qq-b', companionId: 'partner-b', enabled: true, platform: 'qq' },
    ],
    pairings: [{ channelId: 'qq-a', status: 'pending', userId: 'PRIVATE_CONTACT' }],
    sessions: [{kind:'local',companionId:companion.id,sessionId:'main-session'}],
  }
  const before = structuredClone(state)
  const defaultSelection = Object.freeze({ provider: 'default-provider', model: 'default-model', reasoningEffort: 'high' })
  const modelCalls = []
  let successful = true
  let handler
  registerPartnerApi({ register(route) { handler = route.handler; return () => {} } }, '/api', {
    store: {
      isCompanionRemoving: () => false,
      snapshot(keys) {
        assert.deepEqual(keys, ['companions', 'channels', 'pairings', 'sessions'])
        return state
      },
    },
    channels: {
      channelRuntimeStatus(id) { assert.equal(id, 'qq-a'); return 'running' },
    },
    ctx: {
      get: () => ({ currentSelection: () => defaultSelection }),
      agents: {get(id) {
        assert.equal(id,'main-session')
        return {model:{current:()=>({provider:'session-provider',model:'session-model',reasoningEffort:'high'})}}
      }},
      llm: {
        async *stream(options) {
          modelCalls.push(options)
          if (!successful) throw Error('PRIVATE_PROVIDER_ERROR')
          yield { type: 'text-delta', text: '{"answer":"可以先检查通用 TTS。","settingIds":["tts","unknown"]}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    },
  })
  const call = async (question, id = companion.id, headers = { 'x-dsh-partner-request': '1' }) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ question }))]), {
      method: 'POST', url: '/api/companions/' + id + '/settings-guide', headers,
    })
    const res = Object.assign(new EventEmitter(), {
      statusCode: 0, setHeader() {}, end(body) { this.body = JSON.parse(body) },
    })
    await handler(req, res)
    return res
  }
  assert.equal((await call('语音', undefined, {})).statusCode, 403)
  assert.equal((await call('语音', undefined, { 'x-dsh-partner-request': '1', origin: 'https://other.example', host: 'partner.local' })).statusCode, 403)
  assert.equal((await call(' ')).statusCode, 400)
  assert.equal((await call('长'.repeat(501))).statusCode, 400)
  assert.equal((await call('语音', 'missing')).statusCode, 404)
  assert.equal(modelCalls.length, 0)

  const result = await call('  为什么 QQ 发不了语音？  ')
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.body, { answer: '可以先检查通用 TTS。', settingIds: ['tts'] })
  const [request] = modelCalls
  assert.equal(request.provider, 'session-provider')
  assert.equal(request.model, 'session-model')
  assert.equal(request.reasoningEffort, 'high')
  assert.equal(request.maxTokens, undefined)
  assert.equal(request.tools, undefined)
  assert.equal(request.messages.length, 1)
  const input = request.messages[0].content[0].text
  assert.doesNotMatch(input, /PRIVATE_|1234567|qq-b|partner-b|profile-one/)
  const { question, facts } = JSON.parse(input)
  assert.equal(question, '为什么 QQ 发不了语音？')
  assert.equal(facts.memory.rolling, true)
  assert.deepEqual(facts.channels, [{
    platform: 'qq', enabled: true, status: 'running', pendingContacts: 1,
    tts: { enabled: true, profileExists: true },
    qq: { privateReplies: true, groupReplies: true, selectedGroups: 1, otherGroupTrigger: 'mention', autonomousGroups: 1, nativeVoice: true, nativePrivateVoiceHasSource: true, ownerBound: true },
  }])
  assert.deepEqual(state, before)

  successful = false
  const error = await call('语音')
  assert.equal(error.statusCode, 503)
  assert.match(error.body.error, /设置搜索/)
  assert.doesNotMatch(error.body.error, /PRIVATE_PROVIDER_ERROR/)
})

test('settings guide uses a cold session selection before falling back to companion defaults', async () => {
  const signal=AbortSignal.timeout(1000)
  const defaultSelection = { provider: 'p', model: 'm', reasoningEffort: 'high' }
  const selected = { provider: 'saved-provider', model: 'saved-model', reasoningEffort: 'max' }
  const models=[]
  let closed=false
  const ctx = {
    get: name=>name==='agentDefaultModel'?{currentSelection:()=>defaultSelection}:name==='sessionQuery'?{
      async observeSession(id,options){
        assert.equal(options.signal,signal)
        if(id==='missing')throw Object.assign(Error('not found'),{code:'SESSION_QUERY_SESSION_NOT_FOUND'})
        return {events:[{type:'model/selection',data:selected}],[Symbol.dispose](){closed=true}}
      }
    }:undefined,
    llm: {
      async *stream(options) {
        assert.equal(options.maxTokens,undefined)
        assert.equal(options.signal,signal)
        models.push([options.provider,options.model,options.reasoningEffort])
        yield { type: 'text-delta', text: '{"answer":"去渠道设置。","settingIds":[]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  for (const [sessionId,companion] of [['cold',{}],['missing',{model:'companion-model'}],[undefined,{}]]) {
    const result = await explainSettings(ctx, { id: 'guide', ...companion }, '从哪设置？', {}, signal, sessionId)
    assert.equal(result.answer, '去渠道设置。')
  }
  assert.ok(closed)
  assert.deepEqual(models,[['saved-provider','saved-model','max'],['p','companion-model',undefined],['p','m','high']])
})
