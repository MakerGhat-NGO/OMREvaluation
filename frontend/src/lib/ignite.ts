// IGNITE: small helpers shared by the screens that take school details, correct a sheet and submit
// a batch. All of those screens show only when the server says the feature is on (me.features.ignite).
import { Batch, Me, Places, Sheet, Test } from './api';
import { isRight } from './sheets';

export const igniteOn = (me: Me | undefined | null) => !!me?.features?.ignite;

/** The school details of a batch, as typed. schools: the schools at this session, each once. */
export interface BatchDetails { district: string; block: string; schools: string[]; grade: string; assessed_on: string; }

export const NO_DETAILS: BatchDetails = { district: '', block: '', schools: [], grade: '', assessed_on: '' };

export const detailsOf = (b: Pick<Batch, 'district' | 'block' | 'school' | 'schools' | 'grade' | 'assessed_on'>): BatchDetails => ({
  district: b.district || '', block: b.block || '', schools: b.schools ?? (b.school ? [b.school] : []),
  grade: b.grade || '', assessed_on: b.assessed_on || '',
});

/** A school's name for comparing, as the server compares them: "Z.P.P.S. Sunderpur" and "zpps sunderpur"
 *  are one school. Letters (with their vowel signs) of any script count, so Marathi names compare too. */
const LETTER = new RegExp('[\\p{L}\\p{M}\\p{N}]', 'u');
export const schoolKey = (name: string) => Array.from(name.toLowerCase()).filter(ch => LETTER.test(ch)).join('');

/** "ZPPS Sunderpur" / "ZPPS Sunderpur and Hidden High" / "5 schools": a list of schools, short. */
export function schoolsText(schools: string[] | undefined): string {
  const list = schools || [];
  return list.length > 2 ? `${list.length} schools` : list.join(' and ');
}

/** The list with this school added, unless it is in it already (spelt any way). */
export function addSchool(schools: string[], name: string): string[] {
  const clean = name.replace(/\s+/g, ' ').trim();
  const k = schoolKey(clean);
  return !k || schools.some(s => schoolKey(s) === k) ? schools : [...schools, clean];
}

/** Today in India as 2026-11-10: the latest day a test can have been taken. */
export function todayInIndia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
}

/** "2026-11-02" as "2 Nov 2026". */
export function dayText(day: string | null | undefined): string {
  if (!day) return '';
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The marks a set of answers gets with this answer key: what the server works out when it saves. */
export function scoreOf(answers: Record<string, string>, test: Pick<Test, 'answer_key' | 'marks_correct' | 'marks_incorrect' | 'marks_unmarked'>): number {
  let total = 0;
  Object.keys(test.answer_key || {}).forEach(q => {
    const marked = (answers[q] || '').trim();
    if (marked === '') total += test.marks_unmarked;
    else if (isRight(marked, test.answer_key[q])) total += test.marks_correct;
    else total += test.marks_incorrect;
  });
  return total;
}

/** What the name of a scan says about its school: the team names scans "Name_Grade_School_Block.pdf".
 *  Null when the name is not in that shape. */
export function detailsFromFileName(fileName: string): { grade: string; school: string; block: string } | null {
  const parts = fileName.replace(/\.[A-Za-z0-9]+$/, '').split('_').map(p => p.replace(/\s+/g, ' ').trim());
  if (parts.length !== 4 || parts.some(p => !p)) return null;
  const [, grade, school, block] = parts;
  // "G7", "Grade 7" and "Class 7" are all grade 7.
  return { grade: grade.replace(/^(grade|class|std\.?|g)\s*(?=\d)/i, ''), school, block };
}

/** What the file names say: the grade and the block most of them agree on, and every school they
 *  name, each once, the most named first (one session can be for many schools). */
export function guessDetails(fileNames: string[]): Partial<BatchDetails> {
  const guess: Partial<BatchDetails> = {};
  const named = new Map<string, { name: string; count: number }>();
  fileNames.forEach(file => {
    const school = detailsFromFileName(file)?.school;
    if (!school) return;
    const seen = named.get(schoolKey(school));
    named.set(schoolKey(school), { name: seen?.name || school, count: (seen?.count || 0) + 1 });
  });
  if (named.size) guess.schools = Array.from(named.values()).sort((a, b) => b.count - a.count).map(s => s.name);
  (['grade', 'block'] as const).forEach(key => {
    const seen = new Map<string, number>();
    fileNames.forEach(name => {
      const value = detailsFromFileName(name)?.[key];
      if (value) seen.set(value, (seen.get(value) || 0) + 1);
    });
    const best = Array.from(seen.entries()).sort((a, b) => b[1] - a[1])[0];
    // Only when more than half of the files say the same.
    if (best && best[1] * 2 > fileNames.length) guess[key] = best[0];
  });
  return guess;
}

const unique = (values: string[]) => Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Names to suggest for each detail, narrowed by what is typed so far: the blocks of the typed
 *  district, the schools of the typed block. */
export function suggestionsFor(places: Places | null, stateId: string, typed: BatchDetails) {
  const all = (places?.places || []).filter(p => !stateId || !p.state_id || p.state_id === stateId);
  const inDistrict = all.filter(p => !typed.district || same(p.district, typed.district));
  const inBlock = inDistrict.filter(p => !typed.block || same(p.block, typed.block));
  return {
    districts: unique(all.map(p => p.district)),
    blocks: unique(inDistrict.map(p => p.block)),
    schools: unique(inBlock.map(p => p.school)),
    grades: places?.grades || [],
  };
}

/** Sheets that count: the ones not left out. */
export const keptSheets = (sheets: Sheet[]) => sheets.filter(s => !s.left_out);

/** What stands between a batch and Submit: the steps its page lists for the teacher. */
export interface BatchSteps {
  /** Sheets that count (not left out). */
  kept: number;
  /** Read, but still to be looked at. */
  check: number;
  /** Could not be read. */
  unread: number;
  /** Of 'state', 'district', 'block' and 'school': the ones nobody has filled in. */
  missing: string[];
  /** Papers with no activity score yet; always 0 when the answer key takes none. */
  noActivity: number;
  /** Papers whose activity score is below the pass mark: only students who reach it write the test,
   *  so each is a mark to check. A warning, never a reason to hold back Submit. 0 with no pass mark. */
  belowPass: number;
  /** The students in the hands-on challenge: 'missing' (not typed), 'fewer' (fewer than the papers)
   *  or '' (fine, or not asked for: the answer key takes no activity score). */
  reached: '' | 'missing' | 'fewer';
}

/** handsOnMax: the most an activity score can be on this answer key, or null when it takes none.
 *  With one, every paper needs its activity score and the number of students in the hands-on
 *  challenge is needed too (the team's answers 1 and 10), the same rules as the server's.
 *  handsOnPass: the pass mark of the hands-on challenge (3 of 5), or null for none. */
export function batchSteps(batch: Batch, sheets: Sheet[], handsOnMax: number | null = null,
  handsOnPass: number | null = null): BatchSteps {
  const kept = keptSheets(sheets);
  const asked = handsOnMax != null;
  const reached = batch.students_reached;
  const schools = batch.schools ?? (batch.school ? [batch.school] : []);
  return {
    kept: kept.length,
    check: kept.filter(s => s.status === 'ok' && s.needs_review).length,
    unread: kept.filter(s => s.status === 'error').length,
    missing: [!batch.state_id && 'state', !batch.district && 'district', !batch.block && 'block',
      !schools.length && 'school'].filter(Boolean) as string[],
    noActivity: asked ? kept.filter(s => s.hands_on_score == null).length : 0,
    belowPass: asked && handsOnPass != null ? kept.filter(s => s.hands_on_score != null && s.hands_on_score < handsOnPass).length : 0,
    reached: !asked ? '' : reached == null ? 'missing' : reached < kept.length ? 'fewer' : '',
  };
}

/** "1 paper has no activity score" / "3 papers have no activity score". */
export const noActivityText = (n: number) => (n === 1 ? '1 paper has no activity score' : `${n} papers have no activity score`);

/** "1 paper has an activity score below the pass mark" / "2 papers have ...". */
export const belowPassText = (n: number) =>
  `${n === 1 ? '1 paper has' : `${n} papers have`} an activity score below the pass mark`;

/** Is a block of the programme marked Completed? The names are compared without case or spaces. */
export function blockCompleted(places: Places | null, district: string, block: string): boolean {
  if (!district.trim() || !block.trim()) return false;
  return (places?.places || []).some(p => same(p.district, district) && same(p.block, block)
    && (p.status || '').trim().toLowerCase() === 'completed');
}

/** "1 sheet still needs a check and 2 sheets could not be read"; '' when every sheet is settled. */
export function flaggedText({ check, unread }: Pick<BatchSteps, 'check' | 'unread'>): string {
  const parts: string[] = [];
  if (check) parts.push(check === 1 ? '1 sheet still needs a check' : `${check} sheets still need a check`);
  if (unread) parts.push(unread === 1 ? '1 sheet could not be read' : `${unread} sheets could not be read`);
  return parts.join(' and ');
}

/** "the district", "the district and the block", "the state, the district and the block". */
export function missingText(missing: string[]): string {
  const named = missing.map(m => `the ${m}`);
  return named.length <= 1 ? named.join('') : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}

/** Why a batch cannot be submitted yet, as a sentence; '' when it can. In the order the server checks. */
export function submitBlocker(batch: Batch, sheets: Sheet[], handsOnMax: number | null = null): string {
  const steps = batchSteps(batch, sheets, handsOnMax);
  if (steps.kept === 0) return 'There are no sheets in this batch yet.';
  if (steps.check || steps.unread) return `${flaggedText(steps)}. Correct them, type them in or leave them out first.`;
  if (steps.noActivity) return `${noActivityText(steps.noActivity)} yet. Type ${steps.noActivity === 1 ? 'it' : 'them'} first.`;
  if (steps.missing.length) return `Add ${steps.missing.map(m => `the ${m}`).join(' and ')} of this batch first.`;
  if (steps.reached === 'missing') return 'Type how many students did the hands-on challenge first.';
  if (steps.reached === 'fewer') {
    return `The students in the hands-on challenge (${batch.students_reached}) cannot be fewer than the papers (${steps.kept}).`;
  }
  return '';
}
