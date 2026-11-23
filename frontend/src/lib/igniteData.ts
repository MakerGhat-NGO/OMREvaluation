// IGNITE: what the admin's "IGNITE data" screen gets from the server, and the small helpers that
// show and read a figure. A share (average score, girls) is kept from 0 to 1 and shown as a percent.
import { ApiError } from './api';
import { capitalise } from './format';

export type FigureKey = 'schools_reached' | 'students_reached' | 'assessed' | 'avg' | 'girls'
  | 'above70' | 'above50' | 'below50' | 'hands_count' | 'hands_avg';
export type FigureKind = 'count' | 'share' | 'average';
export type Figures = Record<FigureKey, number | null>;

/** A figure an admin typed over the worked-out one. */
export interface OwnFigure { value: number; note: string; by: string; at: string; }

export interface IgniteBatch {
  id: string; name: string; test_name: string; state_name: string; district: string; block: string;
  school: string; grade: string; assessed_on: string | null; submitted_at: string | null; submitted_by: string;
  /** The schools at the session, and those of them the team had already counted (they add no school). */
  schools?: string[]; schools_counted_before?: string[];
  /** Sheets that count, and their average score from 0 to 1. */
  sheets: number; average: number | null;
  students_reached: number; hands_on_count: number;
  /** An admin keeps this batch out of the dashboard's numbers. */
  left_out: boolean;
  /** Filed under a block an admin marked Completed: no more papers were expected for it. */
  block_completed?: boolean;
}

export interface IgniteBlock {
  id: string; district_id: string; name: string; position: number;
  total_schools: number | null; selected_schools: number | null; student_target: number | null;
  /** The status an admin chose ('' when the app works it out) and the one shown. */
  status: string; status_shown: string;
  /** Before the app fed the dashboard; what the submitted batches add; the two together; an admin's
   *  own figures; what the dashboard will show (an own figure wins); and what it shows now (null:
   *  this block is not published yet). */
  opening: Figures; added: Figures; worked_out: Figures;
  overrides: Partial<Record<FigureKey, OwnFigure>>; shown: Figures;
  published: (Figures & { status: string | null }) | null;
  /** The schools the team's sheet had already counted in this block. */
  schools_counted?: string[];
  batches: IgniteBatch[];
}

export interface IgniteDistrict {
  id: string; state: string; name: string; position: number;
  blocks_count: number | null; total_schools: number | null; grade: string; total_students: number | null;
  target_date: string | null;
  /** Top students taken from the team's sheet, and scanned students an admin marked. */
  top_imported: number; top_marked: number;
  blocks: IgniteBlock[];
}

export interface Publish { id: string; published_at: string; published_by: string; note: string; restored_from: string; }

export interface WorkingBatch { id: string; name: string; district: string; block: string; school: string; created_by: string; sheets: number; }

export interface IgniteOverview {
  settings: { hands_on_max: number | null };
  statuses: string[];
  districts: IgniteDistrict[];
  /** Submitted batches whose district and block match no block: they are in no number. */
  unmatched: IgniteBatch[];
  /** Batches teachers have not submitted yet. */
  working: WorkingBatch[];
  last_publish: Publish | null;
  publishes: number;
  /** The numbers differ from what the dashboard shows now. */
  changed: boolean;
}

export interface TopStudent {
  id: string; batch_id: string; batch_name: string; name: string; school: string; block: string; gender: string;
  score: number; max_score: number; percent: number; skills: Record<string, number>; top5: boolean; top1: boolean;
  /** The activity score and its most; percent is test and activity together when both are there. */
  hands_on_score?: number | null; hands_on_max?: number | null;
}

/** "18 of 25 + activity 4 of 5 (73%)": a student's marks and the percent they make. */
export function marksText(s: Pick<TopStudent, 'score' | 'max_score' | 'percent' | 'hands_on_score' | 'hands_on_max'>,
  fmt: (n: number) => string): string {
  const activity = s.hands_on_max != null && s.hands_on_score != null
    ? ` + activity ${fmt(s.hands_on_score)} of ${fmt(s.hands_on_max)}` : '';
  return `${fmt(s.score)} of ${fmt(s.max_score)}${activity} (${figureText('share', s.percent)})`;
}
export interface TopList { students: TopStudent[]; imported: number; imported_top1: number; }

/** The figures of a block, in the order the screen shows them. */
export const FIGURES: { key: FigureKey; label: string; kind: FigureKind }[] = [
  { key: 'schools_reached', label: 'Schools reached', kind: 'count' },
  { key: 'students_reached', label: 'Students reached', kind: 'count' },
  { key: 'assessed', label: 'Students assessed', kind: 'count' },
  { key: 'avg', label: 'Average score', kind: 'share' },
  { key: 'girls', label: 'Girls among them', kind: 'share' },
  { key: 'above70', label: 'Scored 70% or more', kind: 'count' },
  { key: 'above50', label: 'Scored 50% to 70%', kind: 'count' },
  { key: 'below50', label: 'Scored below 50%', kind: 'count' },
  { key: 'hands_count', label: 'Did the hands-on activity', kind: 'count' },
  { key: 'hands_avg', label: 'Hands-on average score', kind: 'average' },
];

/** 0.523 as "52.3%", 1203 as "1,203", nothing as "–". */
export function figureText(kind: FigureKind, value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  if (kind === 'share') return `${+(value * 100).toFixed(1)}%`;
  if (kind === 'average') return String(+value.toFixed(2));
  return value.toLocaleString('en-IN');
}

/** A figure as it stands in a box for typing: a share as its percent number. */
export function boxText(kind: FigureKind, value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return kind === 'share' ? String(+(value * 100).toFixed(2)) : String(value);
}

/** What was typed in a box, as the figure to save: null for an empty box, or why it cannot be saved. */
export function typedFigure(kind: FigureKind, text: string): { value: number | null } | { error: string } {
  const typed = text.trim().replace(/%$/, '').replace(/,/g, '').trim();
  if (typed === '') return { value: null };
  const n = Number(typed);
  if (!Number.isFinite(n) || n < 0) return { error: 'must be a number, 0 or more' };
  if (kind === 'count') return Number.isInteger(n) ? { value: n } : { error: 'must be a whole number' };
  if (kind === 'share') return n <= 100 ? { value: n / 100 } : { error: 'must be between 0 and 100' };
  return { value: n };
}

const same = (a: number | null | undefined, b: number | null | undefined) =>
  (a ?? null) === null || (b ?? null) === null ? (a ?? null) === (b ?? null) : Math.abs((a as number) - (b as number)) < 1e-9;

/** The figures of a block that differ from what the dashboard shows now. */
export function changedFigures(block: IgniteBlock): FigureKey[] {
  if (!block.published) return [];
  return FIGURES.map(f => f.key).filter(k => !same(block.shown[k], block.published?.[k]));
}

/** True when a block is not on the dashboard as it stands here: new, or with another figure or status. */
export function blockDiffers(block: IgniteBlock): boolean {
  if (!block.published) return true;
  return changedFigures(block).length > 0 || (block.published.status || '') !== block.status_shown;
}

/** One figure summed over the blocks of a district; null when no block has it. */
export function districtSum(d: IgniteDistrict, k: FigureKey): number | null {
  const values = d.blocks.map(b => b.shown[k]).filter((v): v is number => v !== null && v !== undefined);
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

/** How many students make up a share of all of them, at least one: 5% of 128 is 6. */
export const shareCount = (all: number, share: number) => (all > 0 ? Math.max(1, Math.round(all * share)) : 0);

/** What went wrong, in plain words, from the server's message or a lost connection. */
export function problemText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Check your internet connection and try again.';
  if (e.status === 401) return 'You have been signed out. Reload the page to sign in again.';
  if (e.status === 413) return 'That file is too big.';
  if (e.status >= 500) return 'The server had a problem. Try again in a minute.';
  const said = capitalise(e.message || 'that did not work');
  return /[.!?]$/.test(said) ? said : `${said}.`;
}
