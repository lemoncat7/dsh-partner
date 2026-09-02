export function appendBounded<T>(items: T[], item: T, limit: number): void {
  items.push(item)
  if (items.length > limit) items.splice(0, items.length - limit)
}
