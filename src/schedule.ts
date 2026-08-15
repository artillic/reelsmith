import { UserError } from './log.ts';

/**
 * Schedule planning. Pure, and deliberately timezone-free: every timestamp here
 * is a *civil* (wall-clock) time. Metricool takes `dateTime` plus a separate
 * `timezone` field, so converting to UTC would be wrong as well as harder.
 *
 * A UTC-based Date is used only as a carrier for wall-clock arithmetic — the
 * value is never interpreted as an instant.
 */

/** Instagram's publishing API allows at most 50 posts per rolling 24h. */
export const IG_DAILY_POST_LIMIT = 50;

export interface SchedulePlanInput {
  count: number;
  /** Civil time, `YYYY-MM-DDTHH:mm`. */
  start: string;
  gapMinutes: number;
  dailyCap: number;
  /** Inclusive hour, 0-23. Posts are never planned before this. */
  windowStartHour: number;
  /** Exclusive hour, 1-24. Posts are never planned at or after this. */
  windowEndHour: number;
}

const CIVIL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

export function parseCivil(value: string): Date {
  const m = CIVIL_RE.exec(value.trim());
  if (m === null) {
    throw new UserError(`Invalid date "${value}". Expected YYYY-MM-DDTHH:mm (local wall-clock time).`);
  }
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? '0')),
  );
  if (Number.isNaN(date.getTime())) {
    throw new UserError(`Invalid date "${value}".`);
  }
  return date;
}

export function formatCivil(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

function dayKey(date: Date): string {
  return formatCivil(date).slice(0, 10);
}

function atHour(date: Date, hour: number): Date {
  const next = new Date(date.getTime());
  next.setUTCHours(hour, 0, 0, 0);
  return next;
}

function nextDayAt(date: Date, hour: number): Date {
  const next = atHour(date, hour);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/**
 * Spreads `count` posts forward from `start`, honouring a minimum gap, a daily
 * cap, and a posting window. Returns civil timestamps in ascending order.
 */
export function planSchedule(input: SchedulePlanInput): string[] {
  const { count, gapMinutes, dailyCap, windowStartHour, windowEndHour } = input;

  if (count < 0 || !Number.isInteger(count)) {
    throw new UserError(`count must be a non-negative integer, got ${count}.`);
  }
  if (gapMinutes < 1) {
    throw new UserError(`--gap must be at least 1 minute, got ${gapMinutes}.`);
  }
  if (dailyCap < 1) {
    throw new UserError(`--daily-cap must be at least 1, got ${dailyCap}.`);
  }
  if (dailyCap > IG_DAILY_POST_LIMIT) {
    throw new UserError(
      `--daily-cap of ${dailyCap} exceeds Instagram's ${IG_DAILY_POST_LIMIT} posts per 24h API limit.`,
    );
  }
  if (
    !Number.isInteger(windowStartHour) ||
    !Number.isInteger(windowEndHour) ||
    windowStartHour < 0 ||
    windowEndHour > 24 ||
    windowStartHour >= windowEndHour
  ) {
    throw new UserError(
      `Invalid posting window ${windowStartHour}-${windowEndHour}. Expected 0 <= start < end <= 24.`,
    );
  }
  const windowMinutes = (windowEndHour - windowStartHour) * 60;
  if (gapMinutes > windowMinutes && dailyCap > 1) {
    throw new UserError(
      `A ${gapMinutes}-minute gap does not fit twice inside a ${windowStartHour}:00-${windowEndHour}:00 ` +
        `window. Widen the window, shorten the gap, or set --daily-cap 1.`,
    );
  }

  const out: string[] = [];
  let cursor = parseCivil(input.start);
  let currentDay = dayKey(cursor);
  let postsToday = 0;

  for (let i = 0; i < count; i += 1) {
    if (dayKey(cursor) !== currentDay) {
      currentDay = dayKey(cursor);
      postsToday = 0;
    }
    if (cursor.getUTCHours() < windowStartHour) {
      cursor = atHour(cursor, windowStartHour);
    }
    if (cursor.getUTCHours() >= windowEndHour || postsToday >= dailyCap) {
      cursor = nextDayAt(cursor, windowStartHour);
      currentDay = dayKey(cursor);
      postsToday = 0;
    }

    out.push(formatCivil(cursor));
    postsToday += 1;
    cursor = new Date(cursor.getTime() + gapMinutes * 60_000);
  }

  return out;
}
