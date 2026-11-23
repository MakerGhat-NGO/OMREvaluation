// A date box with its own calendar, drawn in the app's look (the browser's own date picker cannot
// be styled). The day is kept as "2026-11-02"; the box shows "2 Nov 2026". Arrow keys move through
// the days, Page Up and Page Down change the month, Enter takes a day, Escape closes the calendar.
import classNames from 'classnames';
import { KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { dayText, todayInIndia } from '../lib/ignite';
import { IconCalendar, IconChevronLeft, IconChevronRight } from './Icons';

const pad = (n: number) => String(n).padStart(2, '0');
/** "2026-11-02" from a year, a month (0 = January) and a day. */
export const isoDay = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** The year and month (0 = January) of a day like "2026-11-02". */
function monthOf(day: string): { y: number; m: number } {
  const [y, m] = day.split('-').map(Number);
  return { y, m: m - 1 };
}

/** The day `by` days after (or before) a day, as "2026-11-02". Worked out in UTC, so no time zone
 *  or summer time can shift it. */
export function addDays(day: string, by: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const moved = new Date(Date.UTC(y, m - 1, d + by));
  return isoDay(moved.getUTCFullYear(), moved.getUTCMonth(), moved.getUTCDate());
}

/** One month as rows of seven, Monday first: a day of the month, or null for an empty square. */
export function monthGrid(y: number, m: number): (number | null)[][] {
  const blanks = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells: (number | null)[] = Array(blanks).fill(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const rows: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

const WEEKDAYS: [string, string][] = [
  ['Mo', 'Monday'], ['Tu', 'Tuesday'], ['We', 'Wednesday'], ['Th', 'Thursday'], ['Fr', 'Friday'], ['Sa', 'Saturday'],
  ['Su', 'Sunday'],
];
const monthName = (y: number, m: number) =>
  new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const ROUND = 'inline-flex h-10 w-10 items-center justify-center rounded-full';

export default function DayPicker({ label, value, max, disabled, onChange, boxClassName = 'input', alignRight }: {
  label: string;
  /** "2026-11-02", or '' for no day. */
  value: string;
  /** The last day that can be picked, e.g. today for the day a test was taken. */
  max?: string;
  disabled?: boolean;
  onChange: (day: string) => void;
  /** The look of the box, when it is not the usual tall one. */
  boxClassName?: string;
  /** The calendar opens to the left of the box's right edge: for a box near the right of its card. */
  alignRight?: boolean;
}) {
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLButtonElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const today = todayInIndia();
  const [open, setOpen] = useState(false);
  /** The day the arrow keys are on. The calendar shows its month. */
  const [focusDay, setFocusDay] = useState(today);
  const { y, m } = monthOf(focusDay);
  const allowed = (day: string) => !max || day <= max;

  const openCalendar = () => {
    const start = value || (max && max < today ? max : today);
    setFocusDay(start);
    setOpen(true);
  };
  const close = (backToBox = true) => {
    setOpen(false);
    if (backToBox) box.current?.focus();
  };
  const pick = (day: string) => {
    onChange(day);
    close();
  };
  /** Moves to another day, never past the last day that can be picked. */
  const moveTo = (day: string) => setFocusDay(allowed(day) ? day : max || day);
  const otherMonth = (by: number) => {
    const first = new Date(Date.UTC(y, m + by, 1));
    const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const day = Math.min(Number(focusDay.slice(8)), days);
    moveTo(isoDay(first.getUTCFullYear(), first.getUTCMonth(), day));
  };
  // The month after can be opened only when its first day can still be picked.
  const nextFirst = new Date(Date.UTC(y, m + 1, 1));
  const nextMonthOpen = allowed(isoDay(nextFirst.getUTCFullYear(), nextFirst.getUTCMonth(), 1));

  // The keyboard follows the day the arrow keys are on.
  useEffect(() => {
    if (open) grid.current?.querySelector<HTMLButtonElement>(`button[data-day="${focusDay}"]`)?.focus();
  }, [open, focusDay]);

  // A click anywhere else closes the calendar.
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key === 'Escape') {
      // Only the calendar closes: not the screen it is on.
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key in steps && (e.target as HTMLElement).dataset.day) {
      e.preventDefault();
      moveTo(addDays(focusDay, steps[e.key]));
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      otherMonth(e.key === 'PageUp' ? -1 : 1);
    }
  };

  return (
    <div className="field min-w-0">
      <label htmlFor={id}>{label}</label>
      <div ref={wrap} className="relative">
        <button ref={box} id={id} type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
          onClick={() => (open ? close() : openCalendar())}
          className={classNames(boxClassName, 'flex items-center justify-between gap-2 text-left', open && 'border-coral-dark')}>
          <span className={classNames('min-w-0 truncate', !value && 'text-muted')}>{value ? dayText(value) : 'Pick a day'}</span>
          <IconCalendar size={22} className={classNames('shrink-0', disabled ? 'text-muted' : 'text-brand')} />
        </button>

        {open && (
          // data-own-arrows: the arrow keys belong to the calendar, not to the sheet beside it.
          <div role="dialog" aria-label={`${label}: pick a day`} data-own-arrows onKeyDown={onKeyDown}
            className={classNames(
              'absolute top-[calc(100%+6px)] z-30 w-[324px] max-w-[calc(100vw-2rem)] rounded-[18px] border-2 border-line bg-white p-3 font-normal',
              'shadow-[0_12px_28px_-8px_rgba(63,43,18,0.28)]', alignRight ? 'right-0' : 'left-0',
            )}>
            <div className="flex items-center justify-between gap-2 pb-2">
              <button type="button" aria-label="Month before" onClick={() => otherMonth(-1)}
                className={classNames(ROUND, 'text-brand hover:bg-coral-wash')}>
                <IconChevronLeft size={22} />
              </button>
              <p aria-live="polite" className="m-0 font-display text-[17px] font-semibold text-heading">{monthName(y, m)}</p>
              <button type="button" aria-label="Month after" disabled={!nextMonthOpen} onClick={() => otherMonth(1)}
                className={classNames(ROUND, 'text-brand hover:bg-coral-wash disabled:text-line disabled:hover:bg-transparent')}>
                <IconChevronRight size={22} />
              </button>
            </div>

            <div ref={grid} role="grid" aria-label={monthName(y, m)} className="flex flex-col gap-0.5">
              <div role="row" className="grid grid-cols-7 justify-items-center">
                {WEEKDAYS.map(([short, long]) => (
                  <span key={short} role="columnheader" aria-label={long} className="py-1 text-[13px] font-semibold text-muted">{short}</span>
                ))}
              </div>
              {monthGrid(y, m).map((row, r) => (
                <div key={r} role="row" className="grid grid-cols-7 justify-items-center">
                  {row.map((d, c) => {
                    if (d === null) return <span key={c} role="gridcell" className="h-10 w-10" />;
                    const day = isoDay(y, m, d);
                    const chosen = day === value;
                    return (
                      <span key={c} role="gridcell" aria-selected={chosen}>
                        <button type="button" data-day={day} disabled={!allowed(day)} tabIndex={day === focusDay ? 0 : -1}
                          aria-label={dayText(day)} aria-current={day === today ? 'date' : undefined}
                          onClick={() => pick(day)}
                          className={classNames(ROUND, 'text-[16px] disabled:cursor-not-allowed disabled:text-line',
                            chosen ? 'bg-coral font-bold text-heading' : 'text-ink enabled:hover:bg-coral-wash',
                            !chosen && day === today && 'border-2 border-coral-dark font-semibold')}>
                          {d}
                        </button>
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="mt-2 flex items-center justify-between gap-2 border-t border-line pt-2">
              <button type="button" className="btn btn-quiet btn-small" disabled={!allowed(today)} onClick={() => pick(today)}>
                Today
              </button>
              {value && (
                <button type="button" className="btn btn-quiet btn-small" onClick={() => pick('')}>Clear</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
