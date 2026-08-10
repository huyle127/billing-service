function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function nextCreditAt(after: Date, paidThrough: Date | null): Date {
  const anchorDay = (paidThrough ?? after).getUTCDate();
  const next = new Date(after.getTime());

  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  next.setUTCDate(Math.min(anchorDay, daysInMonth(next.getUTCFullYear(), next.getUTCMonth())));

  return next;
}
