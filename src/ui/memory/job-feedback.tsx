export function MemoryJobFeedback({status, error}: {status: string; error?: string}) {
  if(!error)return null
  return <small className="dsh-partner-memory-job-error">上次失败：{error}{status==='processing'?'（当前正在重试，本轮尚未结束）':''}</small>
}
