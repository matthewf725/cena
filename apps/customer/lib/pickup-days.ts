const dayMilliseconds = 86_400_000;

function calendarDay(date: Date, timezone?: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
}

export function dayOffset(iso: string, timezone?: string, now = new Date()) {
  return (calendarDay(new Date(iso), timezone) - calendarDay(now, timezone)) / dayMilliseconds;
}

export function dateLabel(offset: number, timezone?: string, now = new Date()) {
  const date = new Date(calendarDay(now, timezone) + offset * dayMilliseconds);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric',
  }).format(date);
}
