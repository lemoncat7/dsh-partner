/** Expected workflow conflicts are actionable tool results, not retryable failures. */
export class TaskWorkflowError extends Error {
  constructor(readonly code: string, message: string, readonly current: Record<string, unknown>, readonly recovery: string) { super(message) }
  result() { return { ok: false, retryable: false, code: this.code, message: this.message, current: this.current, recovery: this.recovery } }
}
