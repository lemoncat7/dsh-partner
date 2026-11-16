/** Expected supersession, not a transport failure or a retryable notification. */
export class ReplySupersededError extends Error {
  constructor() { super('新输入已接管，停止发送旧回复的剩余分条') }
}

export class ReplyTurn {
  private revision = 0
  private valid = true
  private readonly pending = new Set<Promise<void>>()
  constructor(private readonly release: () => void) {}
  capture(): () => void {
    const revision = this.revision
    const check = () => { if (!this.valid || this.pending.size || this.revision !== revision) throw new ReplySupersededError() }
    check(); return check
  }
  hold(): (continued: boolean) => void {
    this.revision++
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    this.pending.add(promise)
    return continued => { if (!continued) this.valid = false; this.pending.delete(promise); resolve() }
  }
  async ready(): Promise<void> { while (this.pending.size) await Promise.all(this.pending); this.capture() }
  finish(): void { this.valid = false; this.release() }
}

/** A shared transcript does not grant permission to interrupt another sender. */
export class ReplyTurns {
  private readonly active = new Map<string, Set<ReplyTurn>>()
  private key(channel: string, user: string): string { return JSON.stringify([channel, user]) }
  begin(channel: string, user: string): ReplyTurn {
    const key = this.key(channel, user), turns = this.active.get(key) ?? new Set<ReplyTurn>()
    const turn = new ReplyTurn(() => { turns.delete(turn); if (!turns.size && this.active.get(key) === turns) this.active.delete(key) })
    turns.add(turn); this.active.set(key, turns); return turn
  }
  interrupt(channel: string, user: string): (continued: boolean) => void {
    const settle = [...(this.active.get(this.key(channel, user)) ?? [])].map(turn => turn.hold())
    return continued => { for (const finish of settle) finish(continued) }
  }
}
