import { randomUUID } from 'node:crypto'
import { WeixinApi, WEIXIN_DEFAULT_BASE_URL } from './api.js'
import { weixinTransientFailure } from './errors.js'

export interface LoginView {
  id: string
  companionId: string
  phase: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error'
  qrContent?: string
  accountId?: string
  baseUrl?: string
  error?: string
  expiresAt: number
}

export interface ConfirmedLogin extends LoginView {
  phase: 'confirmed'
  accountId: string
  botToken: string
  baseUrl: string
}

type InternalLogin = LoginView & { qrcode: string; nextPollAt: number; botToken?: string }

export class WeixinLoginManager {
  private readonly sessions = new Map<string, InternalLogin>()
  private readonly polls = new Map<string, Promise<LoginView>>()
  private readonly completions = new Map<string, Promise<unknown>>()

  async begin(companionId: string): Promise<LoginView> {
    this.prune()
    const result = await new WeixinApi().getQrCode(AbortSignal.timeout(30_000))
    if (!result.qrcode || !result.qrcode_img_content) throw new Error('微信登录接口没有返回有效二维码')
    const now = Date.now()
    const session: InternalLogin = {
      id: `login-${randomUUID()}`,
      companionId,
      phase: 'waiting',
      qrContent: result.qrcode_img_content,
      qrcode: result.qrcode,
      nextPollAt: now + 1_500,
      expiresAt: now + 5 * 60_000,
    }
    this.sessions.set(session.id, session)
    return publicView(session)
  }

  async poll(id: string): Promise<LoginView> {
    const pending = this.polls.get(id)
    if (pending) return pending
    const task = this.pollOnce(id)
    this.polls.set(id, task)
    try { return await task } finally { this.polls.delete(id) }
  }

  private async pollOnce(id: string): Promise<LoginView> {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error('微信扫码会话不存在或已过期')
    if (Date.now() >= session.expiresAt && session.phase !== 'confirmed') session.phase = 'expired'
    if ((session.phase === 'waiting' || session.phase === 'scanned') && Date.now() >= session.nextPollAt) {
      session.nextPollAt = Date.now() + 2_000
      try {
        const status = await new WeixinApi().getQrCodeStatus(session.qrcode, AbortSignal.timeout(30_000))
        delete session.error
        if (status.status === 'scaned' || status.status === 'scanned') session.phase = 'scanned'
        else if (status.status === 'confirmed') {
          if (!status.ilink_bot_id || !status.bot_token) throw new Error('微信确认响应缺少机器人凭据')
          session.phase = 'confirmed'
          session.accountId = status.ilink_bot_id
          session.botToken = status.bot_token
          session.baseUrl = status.baseurl || WEIXIN_DEFAULT_BASE_URL
        } else if (status.status === 'expired') session.phase = 'expired'
      } catch (error) {
        if (weixinTransientFailure(error)) {
          session.error = '查询扫码状态暂时失败，正在重试；无需重新扫码。'
          session.nextPollAt = Date.now() + 3_000
        } else {
          session.phase = 'error'
          session.error = error instanceof Error ? error.message : String(error)
        }
      }
    }
    return publicView(session)
  }

  consume(id: string): ConfirmedLogin {
    const session = this.sessions.get(id)
    if (session === undefined || session.phase !== 'confirmed' || !session.accountId || !session.botToken || !session.baseUrl) throw new Error('微信扫码尚未确认')
    return { ...publicView(session), phase: 'confirmed', accountId: session.accountId, botToken: session.botToken, baseUrl: session.baseUrl }
  }

  // Keep a successful result briefly: overlapping polls and a lost HTTP response
  // must not create another channel or report that a confirmed QR has expired.
  async complete<T>(id: string, save: (login: ConfirmedLogin) => Promise<T>): Promise<T> {
    const existing = this.completions.get(id)
    if (existing) return existing as Promise<T>
    const confirmed = this.consume(id)
    const task = Promise.resolve().then(() => save(confirmed))
    this.completions.set(id, task)
    try { return await task }
    catch (error) { this.completions.delete(id); throw error }
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, session] of this.sessions) if (now > session.expiresAt + 60_000 && !this.polls.has(id)) {
      this.sessions.delete(id)
      this.completions.delete(id)
    }
  }
}

function publicView(session: InternalLogin): LoginView {
  const { botToken: _secret, qrcode: _qrcode, nextPollAt: _nextPollAt, ...safe } = session
  return safe
}
