export function futureTime(value: number, now = Date.now()): string {
  const minutes = Math.ceil((value - now) / 60_000)
  if (minutes <= 0) return '即将检查'
  if (minutes < 60) return `${minutes} 分钟后`
  const hours = Math.ceil(minutes / 60)
  if (hours < 24) return `${hours} 小时后`
  const days = Math.ceil(hours / 24)
  if (days <= 7) return `${days} 天后`
  const date = new Date(value)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${month}/${day} ${hour}:${minute}`
}
