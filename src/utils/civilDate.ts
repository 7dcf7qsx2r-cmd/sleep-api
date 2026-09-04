const SHANGHAI = 'Asia/Shanghai';

/** 上海日历日 YYYY-MM-DD，避免用 UTC 把凌晨 8 点前算成昨天。 */
export function shanghaiToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SHANGHAI }).format(now);
}

export function shanghaiYesterday(now = new Date()): string {
  return addCivilDays(shanghaiToday(now), -1);
}

export function addCivilDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const utc = Date.UTC(year!, (month ?? 1) - 1, (day ?? 1) + days);
  const shifted = new Date(utc);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

export function toDateOnly(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 10) : null;
  }
  if (value.getUTCHours() === 0 && value.getUTCMinutes() === 0) {
    return value.toISOString().slice(0, 10);
  }
  return shanghaiToday(value);
}

export const SHANGHAI_TODAY_SQL = `((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date)`;

export function shanghaiHour(now = new Date()): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: SHANGHAI,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return Number.parseInt(hour, 10);
}

/** 睡眠归属日：上海时间 12:00 前算当天早晨那一夜，12:00 起算下一夜。 */
export function sleepNightDate(at = new Date()): string {
  const date = shanghaiToday(at);
  return shanghaiHour(at) < 12 ? date : addCivilDays(date, 1);
}
