import {redactObservationError} from './observation-errors.js'

/** Keep only safe diagnostic fields, never a request, response or generated body. */
export function memoryFinishError(reason: {kind: string; failure?: unknown}): string {
  if(reason.kind==='max-tokens') return '模型输出达到长度上限，结果不完整'
  const failure=reason.failure && typeof reason.failure==='object' ? reason.failure as Record<string,unknown> : {}
  const code=typeof failure.code==='string' && /^[A-Z0-9_:-]{1,64}$/.test(failure.code) ? failure.code : undefined
  const status=typeof failure.status==='number' && Number.isInteger(failure.status) && failure.status>=100 && failure.status<=599 ? `HTTP ${failure.status}` : undefined
  const detail=typeof failure.message==='string' ? redactObservationError(failure.message) : '服务未提供详细原因'
  return [reason.kind==='aborted'?'模型调用取消':'模型响应失败',code,status,detail].filter(Boolean).join(' · ')
}
