/** Read-only compatibility for existing, repaired history. No producer remains. */
export interface DecisionEvent {
  id: string; requestId: number; status: 'running' | 'settled'; reason: string; durationMs: number; suggestions: string[]
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'partner/decision': DecisionEvent }
}

export function decisionReason(reason: string): string {
  return ({ running: '决策中', recommended: '已推荐（未执行）', timeout: '超时，已回退原有流程',
    'no-confident-match': '无明确匹配，继续原有流程', 'no-candidates': '没有可推荐项',
    'input-limit': '目录或请求过大，已回退', busy: '决策服务繁忙，已回退', cooldown: '服务冷却中，已回退',
    cancelled: '已取消', interrupted: '决策已中断', 'settings-changed': '配置已变更，忽略旧结果',
    'invalid-response': '响应无效，已回退', unavailable: '服务不可用，已回退',
  } as Record<string, string>)[reason] ?? (reason.startsWith('http-') ? `上游 HTTP ${reason.slice(5)}，已回退` : '继续原有流程')
}
