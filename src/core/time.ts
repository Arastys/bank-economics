/**
 * Simulation time.
 *
 * A tick is one day. Time is a plain integer day index so that state stays
 * trivially serialisable and comparable; calendar dates are derived on demand.
 */
export type Day = number;

export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

/** Day 0 of the simulation clock. */
export const EPOCH: CalendarDate = { year: 2025, month: 1, day: 1 };

/** Days from 1970-01-01 for a civil date (Howard Hinnant's algorithm). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yAdj = y - (m <= 2 ? 1 : 0);
  const era = Math.floor((yAdj >= 0 ? yAdj : yAdj - 399) / 400);
  const yoe = yAdj - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): CalendarDate {
  let days = z + 719468;
  const era = Math.floor((days >= 0 ? days : days - 146096) / 146097);
  const doe = days - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { year: y + (m <= 2 ? 1 : 0), month: m, day: d };
}

const EPOCH_ABSOLUTE = daysFromCivil(EPOCH.year, EPOCH.month, EPOCH.day);

export function toDate(day: Day): CalendarDate {
  return civilFromDays(EPOCH_ABSOLUTE + day);
}

export function fromDate(date: CalendarDate): Day {
  return daysFromCivil(date.year, date.month, date.day) - EPOCH_ABSOLUTE;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDay(day: Day): string {
  const d = toDate(day);
  return `${String(d.day).padStart(2, '0')} ${MONTHS[d.month - 1]} ${d.year}`;
}

/** 0 = Sunday. */
export function dayOfWeek(day: Day): number {
  const abs = EPOCH_ABSOLUTE + day;
  return ((abs % 7) + 11) % 7;
}

export function isWeekend(day: Day): boolean {
  const dow = dayOfWeek(day);
  return dow === 0 || dow === 6;
}

/**
 * Business days ignore weekends. UK bank holidays are a later refinement --
 * the seam is here so adding a holiday calendar does not touch call sites.
 */
export function isBusinessDay(day: Day): boolean {
  return !isWeekend(day);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isMonthEnd(day: Day): boolean {
  const d = toDate(day);
  return d.day === daysInMonth(d.year, d.month);
}

export function isQuarterEnd(day: Day): boolean {
  const d = toDate(day);
  return isMonthEnd(day) && d.month % 3 === 0;
}

export function isYearEnd(day: Day): boolean {
  const d = toDate(day);
  return d.month === 12 && d.day === 31;
}

export function addMonths(day: Day, months: number): Day {
  const d = toDate(day);
  const totalMonths = (d.year * 12 + (d.month - 1)) + months;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  const dayOfMonth = Math.min(d.day, daysInMonth(year, month));
  return fromDate({ year, month, day: dayOfMonth });
}

export function addYears(day: Day, years: number): Day {
  return addMonths(day, years * 12);
}

/** Sterling markets use ACT/365 fixed. */
export const DAY_COUNT_BASIS = 365;

/** Year fraction between two days under ACT/365F. */
export function yearFraction(from: Day, to: Day): number {
  return (to - from) / DAY_COUNT_BASIS;
}

/** The daily accrual factor for an annual nominal rate under ACT/365F. */
export function dailyRate(annualRate: number): number {
  return annualRate / DAY_COUNT_BASIS;
}
