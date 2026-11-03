import type { ReportWindowV1 } from '@superagent/contracts';
const HOUR = 3_600_000;
/** Fixed UTC+08:00 calendar, independent of host timezone/DST. */
export function nextReportEnd(value: string): string {
  const n = Date.parse(value); if (!Number.isFinite(n)) throw new Error('INVALID_REPORT_TIME');
  const day = Math.floor((n + 8 * HOUR) / (24 * HOUR)) * 24 * HOUR - 8 * HOUR;
  return new Date(n < day + 18 * HOUR ? day + 18 * HOUR : day + 24 * HOUR).toISOString();
}
export function reportWindow(projectId: string, end: string): ReportWindowV1 {
  const n = Date.parse(end); if (!Number.isFinite(n)) throw new Error('INVALID_REPORT_BOUNDARY'); const canonical = new Date(n).toISOString();
  const hour = new Date(n + 8 * HOUR).getUTCHours();
  if (!projectId || !Number.isFinite(n) || ![0,18].includes(hour) || n % HOUR !== 0) throw new Error('INVALID_REPORT_BOUNDARY');
  return { projectId, startInclusive: new Date(n - (hour === 18 ? 18 : 6) * HOUR).toISOString(), endExclusive: canonical, timezone: 'Asia/Shanghai' };
}
export function latestClosedWindow(projectId: string, now: string, graceSeconds = 180): ReportWindowV1 {
  const before = Date.parse(now) - graceSeconds * 1000;
  const next = nextReportEnd(new Date(before).toISOString());
  const prior = reportWindow(projectId, next).startInclusive;
  // At the exact grace boundary the just-closed interval is eligible.
  return reportWindow(projectId, prior);
}
