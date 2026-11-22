export function validCalendarDay(day:string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day))&&new Date(day).toISOString().slice(0,10)===day
}

export function shiftCalendarDay(day:string,amount:number):string {
  return new Date(Date.parse(day)+amount*86_400_000).toISOString().slice(0,10)
}
