import { createHash } from 'node:crypto'
import type { PartnerStore } from '../store.js'
import { httpError } from '../api/http.js'
import { parsePushChannel } from './push-config.js'
import { barkAdapter, PushSendError } from './bark-adapter.js'
import type { PushCredentials } from './push-credentials.js'
import { pushSummary, type PushAdapter, type PushChannel, type PushChannelView, type PushDelivery, type PushEvent } from './push-domain.js'

/** Durable outbox independent of chat routing, pairing and conversation speed. */
export class PushService {
  private readonly shutdown = new AbortController()
  private timer?: ReturnType<typeof setInterval>
  private running?: Promise<void>
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private readonly store: PartnerStore, private readonly vault: PushCredentials,
    private readonly report: (message: string) => void,
    private readonly adapters: Readonly<Record<string, PushAdapter>> = { bark: barkAdapter }) {}

  views(companionId?: string): PushChannelView[] {
    const state = this.store.snapshot()
    return (state.pushChannels ?? []).filter(c => !companionId || c.companionId === companionId).map(c => {
      const rows = (state.pushDeliveries ?? []).filter(r => r.channelId === c.id).sort((a,b) => b.updatedAt - a.updatedAt)
      const last = rows[0]
      return { ...c, targets: c.targets.map(({ id, name, enabled }) => ({ id, name, enabled, configured: true })),
        pending: rows.filter(r => ['pending', 'sending'].includes(r.status)).length, failed: rows.filter(r => r.status === 'failed').length,
        ...(last ? { lastDelivery: { status: last.status, updatedAt: last.updatedAt, ...(last.lastError ? { lastError: last.lastError } : {}) } } : {}) }
    })
  }
  require(id: string): PushChannel {
    const channel = this.store.snapshot().pushChannels?.find(c => c.id === id)
    if (!channel) throw httpError(404, '推送渠道不存在')
    return channel
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writes.then(fn)
    this.writes = result.catch(() => {})
    return result
  }
  save(companionId: string, raw: Record<string, unknown>, id?: string): Promise<PushChannelView> {
    return this.serial(async () => {
      const state = this.store.snapshot(), previous = id ? this.require(id) : undefined
      if (!state.companions.some(c => c.id === companionId) || this.store.isCompanionRemoving(companionId)) throw httpError(404, '伙伴不存在或正在删除')
      if (previous && previous.companionId !== companionId) throw httpError(400, '渠道不属于该伙伴')
      if (previous && raw.revision !== previous.revision) throw httpError(409, '渠道已更新，请重新打开配置')
      if (!previous && (state.pushChannels ?? []).filter(c => c.companionId === companionId).length >= 20) throw httpError(400, '每位伙伴最多配置 20 个推送服务器')
      const { channel, secrets } = parsePushChannel(raw, companionId, previous)
      try {
        for (const secret of secrets) await this.vault.write(secret.id, secret.key)
        await this.store.update(draft => {
          if (!draft.companions.some(c => c.id === companionId) || this.store.isCompanionRemoving(companionId)) throw httpError(409, '伙伴正在删除')
          if (previous && draft.pushChannels?.find(c => c.id === id)?.revision !== previous.revision) throw httpError(409, '渠道已更新，请重新打开配置')
          draft.pushChannels = [...(draft.pushChannels ?? []).filter(c => c.id !== channel.id), channel]
          for (const row of draft.pushDeliveries ?? []) if (row.channelId === channel.id && ['pending','sending','failed'].includes(row.status)) {
            row.status = 'canceled'; row.updatedAt = Date.now(); row.lastError = '渠道配置已修改，旧通知已取消，避免发给新目标'
          }
        })
      } catch (error) { await Promise.all(secrets.map(s => this.vault.delete(s.id).catch(() => {}))); throw error }
      for (const target of previous?.targets ?? []) if (!channel.targets.some(t => t.credentialId === target.credentialId)) await this.vault.delete(target.credentialId).catch(() => this.report('旧推送凭据清理失败'))
      return this.views(companionId).find(c => c.id === channel.id)!
    })
  }
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const channel = this.require(id)
      await this.store.update(state => {
        state.pushChannels = (state.pushChannels ?? []).filter(c => c.id !== id)
        state.pushDeliveries = (state.pushDeliveries ?? []).filter(r => r.channelId !== id)
      })
      await Promise.all(channel.targets.map(t => this.vault.delete(t.credentialId).catch(() => this.report('推送凭据清理失败'))))
    })
  }
  async removeOwner(id: string): Promise<void> {
    for (const channel of this.store.snapshot().pushChannels ?? []) if (channel.companionId === id) await this.remove(channel.id)
  }
  deliveries(id: string): PushDelivery[] { this.require(id); return (this.store.snapshot().pushDeliveries ?? []).filter(r => r.channelId === id).sort((a,b) => b.createdAt - a.createdAt).slice(0, 100) }
  async clearHistory(id: string): Promise<void> {
    this.require(id)
    await this.store.update(state => { state.pushDeliveries = (state.pushDeliveries ?? []).filter(r => r.channelId !== id || !['accepted','canceled'].includes(r.status)) })
  }
  async retry(id: string, rowId: string): Promise<void> {
    await this.store.update(state => {
      const channel = state.pushChannels?.find(c => c.id === id)
      const row = state.pushDeliveries?.find(r => r.id === rowId && r.channelId === id)
      if (!row || row.status !== 'failed') throw httpError(400, '仅可重试失败的通知')
      if (!channel?.enabled || channel.revision !== row.revision || !channel.targets.some(t => t.id === row.targetId && t.enabled)) throw httpError(400, '原接收目标已失效，不能重试')
      row.status = 'pending'; row.attempts = 0; row.nextAttemptAt = Date.now(); row.updatedAt = Date.now(); row.expiresAt = Date.now() + 86400_000; delete row.lastError
    })
    this.kick()
  }
  async test(id: string, targetId: string): Promise<void> {
    const channel = this.require(id), target = channel.targets.find(t => t.id === targetId)
    if (!target) throw httpError(404, '发送目标不存在')
    await this.adapters[channel.platform]!.send(channel, await this.vault.read(target.credentialId), {
      title: 'DSH 伙伴 · Bark 测试', body: `这是一条测试通知，来自“${channel.name}”。能看到此消息说明手机推送可达。`,
    }, this.shutdown.signal)
  }
  async enqueue(event: PushEvent): Promise<void> {
    if (this.shutdown.signal.aborted) return
    const eligible = (this.store.snapshot().pushChannels ?? []).some(c => c.companionId === event.companionId && c.enabled)
    if (!eligible) return
    await this.store.update(state => {
      const rows = state.pushDeliveries ??= [], seen = new Set<string>()
      for (const c of state.pushChannels ?? []) {
        if (!c.enabled || c.companionId !== event.companionId || event.createdAt < c.createdAt || (event.outcome === 'problem' && !c.notifyProblems)) continue
        for (const t of c.targets.filter(t => t.enabled)) {
          const recipient = `${c.baseUrl}:${t.fingerprint}`
          if (seen.has(recipient)) continue; seen.add(recipient)
          const id = createHash('sha256').update(JSON.stringify([event.id, event.companionId, recipient])).digest('hex')
          if (rows.some(r => r.id === id)) continue
          while (rows.length >= 1000) {
            const index = rows.findIndex(r => ['accepted','canceled'].includes(r.status) && r.createdAt < Date.now() - 7 * 86400_000)
            if (index < 0) throw Error('Bark 通知记录已满，请清理发送记录')
            rows.splice(index, 1)
          }
          rows.push({ id, companionId: event.companionId, eventId: event.id, channelId: c.id, targetId: t.id, revision: c.revision,
            title: event.title.slice(0, 120), body: c.content === 'title' ? '请返回 DSH 查看伙伴会话。' : pushSummary(event.text) || '本轮已完成，请查看会话。',
            createdAt: event.createdAt, updatedAt: Date.now(), nextAttemptAt: Date.now(), status: 'pending', attempts: 0 })
        }
      }
    })
    this.kick()
  }
  async start(): Promise<void> {
    if (this.store.snapshot().pushDeliveries?.some(r => r.status === 'sending')) await this.store.update(state => { for (const row of state.pushDeliveries ?? []) if (row.status === 'sending') { row.status = 'pending'; row.nextAttemptAt = Date.now() } })
    this.timer = setInterval(() => this.kick(), 15_000); this.timer.unref(); this.kick()
  }
  private kick(): void { if (!this.running && !this.shutdown.signal.aborted) { this.running = this.flush().catch(() => this.report('推送队列处理失败，将自动重试')).finally(() => { delete this.running }) } }
  async flush(): Promise<void> {
    const rows = (this.store.snapshot().pushDeliveries ?? []).filter(r => r.status === 'pending' && r.nextAttemptAt <= Date.now()).slice(0, 30)
    let cursor = 0
    await Promise.all(Array.from({length: Math.min(3, rows.length)}, async () => {
      while (!this.shutdown.signal.aborted && cursor < rows.length) await this.send(rows[cursor++]!)
    }))
  }
  private async send(row: PushDelivery): Promise<void> {
    if (Date.now() > (row.expiresAt ?? row.createdAt + 86400_000)) {
      await this.patch(row.id, r => { if (r.status === 'pending') { r.status = 'failed'; r.lastError = '通知已超过 24 小时，停止自动补发' } }); return
    }
    const state = this.store.snapshot(), channel = state.pushChannels?.find(c => c.id === row.channelId), target = channel?.targets.find(t => t.id === row.targetId)
    if (!channel?.enabled || !target?.enabled || channel.revision !== row.revision || !state.companions.some(c => c.id === row.companionId) || this.store.isCompanionRemoving(row.companionId)) {
      await this.patch(row.id, r => { r.status = 'canceled'; r.lastError = '原渠道或接收目标已停用' }); return
    }
    let claimed = false
    await this.patch(row.id, r => { if (r.status === 'pending' && r.revision === channel.revision) { r.status = 'sending'; r.attempts++; claimed = true } })
    if (!claimed) return
    try {
      const key = await this.vault.read(target.credentialId)
      await this.adapters[channel.platform]!.send(channel, key, row, this.shutdown.signal)
      await this.patch(row.id, r => { if (r.status === 'sending') { r.status = 'accepted'; delete r.lastError } })
    } catch (error) {
      await this.patch(row.id, r => {
        if (r.status !== 'sending') return
        const retry = this.shutdown.signal.aborted || (error instanceof PushSendError && error.retryable && r.attempts < 5)
        r.status = retry ? 'pending' : 'failed'; r.nextAttemptAt = Date.now() + Math.min(300_000, 15_000 * 2 ** (r.attempts - 1))
        r.lastError = error instanceof PushSendError ? error.message : '推送凭据或配置不可用，请检查后重试'
      })
    }
  }
  private async patch(id: string, change: (row: PushDelivery) => void): Promise<void> { await this.store.update(state => { const row = state.pushDeliveries?.find(r => r.id === id); if (row) { change(row); row.updatedAt = Date.now() } }) }
  async close(): Promise<void> { this.shutdown.abort(); clearInterval(this.timer); await this.running; await this.writes }
}
