// What a checked sheet means for a teacher: is it fine, does it need a look, which questions, and why.
import { Sheet } from './api';
import { capitalise, titleCase } from './format';

export type SheetKind = 'fine' | 'check' | 'error';
export type AnswerKind = 'right' | 'wrong' | 'blank' | 'multi';

/** Field labels the sheet template produces. */
export const FIELD = { name: 'Name', roll: 'Roll Number', mobile: 'Mobile Number', gender: 'gender' } as const;

export const sheetKind = (s: Sheet): SheetKind => (s.status === 'error' ? 'error' : s.needs_review ? 'check' : 'fine');

export const qNumber = (label: string) => Number(label.replace(/^q/, ''));

/** Student name in normal capitals, or '' when no name was read. */
export const studentName = (s: Sheet) => titleCase(s.fields?.[FIELD.name] || '');
export const rollNumber = (s: Sheet) => (s.fields?.[FIELD.roll] || '').trim();
export const mobileNumber = (s: Sheet) => (s.fields?.[FIELD.mobile] || '').trim();
export const gender = (s: Sheet) => (s.fields?.[FIELD.gender] || '').trim();

/** Where the sheet came from: "class7.pdf, page 3" or "IMG_4471.jpg". */
export function sourceLabel(s: Sheet): string {
  const isPdf = s.source_name.toLowerCase().endsWith('.pdf');
  return isPdf || s.page_no > 1 ? `${s.source_name}, page ${s.page_no}` : s.source_name;
}

/** The name to show in lists: the student's name, else "Roll 2302", else where the sheet came from. */
export function sheetTitle(s: Sheet): string {
  const roll = rollNumber(s);
  return studentName(s) || (roll ? `Roll ${roll}` : sourceLabel(s));
}

// A key's answer for one question is written in one of three ways (the server's rule, omr/engine.py):
//   "B"    one right answer
//   "BC"   B and C must both be filled, and nothing else
//   "B/C"  B or C: either one alone is right
export const ANY_ONE = '/';

/** The letters of a key's answer, without the mark that says "any one of them". */
export const keyLetters = (correct: string | undefined) => (correct || '').split(ANY_ONE).join('');
/** True when any one of the key's letters is right ("B/C"). */
export const anyOneIsRight = (correct: string | undefined) => (correct || '').includes(ANY_ONE);
/** True when the key asks for several bubbles to be filled ("BC"). */
export const needsAll = (correct: string | undefined) => !anyOneIsRight(correct) && keyLetters(correct).length > 1;

/** Whether what a student filled for one question earns its marks. */
export function isRight(marked: string | undefined, correct: string | undefined): boolean {
  const m = (marked || '').trim();
  const letters = keyLetters(correct);
  if (!m || !letters) return false;
  if (anyOneIsRight(correct)) return m.length === 1 && letters.includes(m);
  return m.split('').sort().join('') === letters.split('').sort().join('');
}

/** The key's answer in a sentence: "B", "B or C", "B and C together". */
export function keyText(correct: string | undefined): string {
  const letters = keyLetters(correct).split('');
  if (letters.length <= 1) return letters[0] || '';
  const start = `${letters.slice(0, -1).join(', ')}`;
  const last = letters[letters.length - 1];
  return anyOneIsRight(correct) ? `${start} or ${last}` : `${start} and ${last} together`;
}

export function answerKind(marked: string | undefined, correct: string | undefined): AnswerKind {
  const m = (marked || '').trim();
  if (!m) return 'blank';
  if (isRight(m, correct)) return 'right';
  // More than one mark where the key wants one answer: it counts as wrong and is worth a look.
  if (m.length > 1 && !needsAll(correct)) return 'multi';
  return 'wrong';
}

/** "CD" -> "C and D", "ACD" -> "A, C and D". */
export function lettersText(v: string): string {
  const parts = v.split('');
  return parts.length <= 1 ? v : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export interface Problem {
  /** One plain sentence for the yellow notice. */
  text: string;
  /** Layout labels to box on the picture (q15, Name, Roll Number ...). */
  boxes: string[];
  /** A word or two for the list: "q15", "name", "roll no." */
  short: string;
}

/** Everything a teacher should look at on a sheet that was read but flagged. */
export function problemsOf(s: Sheet, questionCount: number, answerKey?: Record<string, string>): Problem[] {
  if (s.status !== 'ok') return [];
  const out: Problem[] = [];
  // Two marks are no problem where the key asks for several bubbles: there they are the answer.
  const doubles = Object.entries(s.answers || {})
    .filter(([q, v]) => /^q\d+$/.test(q) && (v || '').trim().length > 1 && !needsAll(answerKey?.[q]))
    .sort((a, b) => qNumber(a[0]) - qNumber(b[0]));
  for (const [q, v] of doubles) {
    const n = qNumber(q);
    out.push(n <= questionCount
      ? { text: `Question ${n}: ${lettersText(v.trim())} are both filled, so it counts as wrong.`, boxes: [q], short: `q${n}` }
      : { text: `Question ${n}: ${lettersText(v.trim())} are both filled. This question is not part of this test.`, boxes: [q], short: `q${n}` });
  }
  for (const reason of (s.review_reason || '').split(';').map(r => r.trim()).filter(Boolean)) {
    if (reason.startsWith('two bubbles filled for')) continue; // listed question by question above
    const column = /^two bubbles filled in a column of the (name|roll number|mobile number)$/.exec(reason);
    const digits = /^mobile number has (\d+) digits?, not 10$/.exec(reason);
    if (column) {
      const field = column[1] === 'name' ? FIELD.name : column[1] === 'roll number' ? FIELD.roll : FIELD.mobile;
      const short = column[1] === 'name' ? 'name' : column[1] === 'roll number' ? 'roll no.' : 'mobile no.';
      const what = column[1] === 'name' ? 'a letter' : 'a digit';
      out.push({ text: `Two bubbles are filled in one column of the ${column[1]}, so ${what} may be wrong.`, boxes: [field], short });
    } else if (reason === 'both gender bubbles filled') {
      out.push({ text: 'Both gender bubbles are filled.', boxes: [FIELD.gender], short: 'gender' });
    } else if (digits) {
      const n = digits[1];
      out.push({
        text: `The mobile number has ${n} digit${n === '1' ? '' : 's'}, not 10. A column may have been skipped, or a mark may be stray.`,
        boxes: [FIELD.mobile], short: 'mobile no.',
      });
    } else if (reason === 'two bubbles filled in a name or number field') {
      // Sheets checked by an older version, which did not say which field.
      out.push({ text: 'Two bubbles are filled in one column of the name, roll number or mobile number.', boxes: [FIELD.name, FIELD.roll, FIELD.mobile], short: 'name or number' });
    } else if (reason === 'name is blank') {
      out.push({ text: 'No name was read. Look at the name boxes on the sheet.', boxes: [FIELD.name], short: 'name' });
    } else if (reason === 'name does not start in the first column') {
      out.push({ text: 'The name does not start in the first box, so a letter may be lost at the edge of the scan.', boxes: [FIELD.name], short: 'name' });
    } else if (reason === 'roll number is blank') {
      out.push({ text: 'No roll number was read.', boxes: [FIELD.roll], short: 'roll no.' });
    } else {
      out.push({ text: `${capitalise(reason)}.`, boxes: [], short: 'sheet' });
    }
  }
  if (out.length === 0 && s.needs_review) out.push({ text: 'This sheet was marked for a closer look.', boxes: [], short: 'sheet' });
  return out;
}

/** "Check q15", "Check name, roll no.", "Check q3, q15 and 2 more". */
export function checkSummary(problems: Problem[]): string {
  const words = Array.from(new Set(problems.map(p => p.short)));
  if (words.length === 0) return 'Check this sheet';
  const shown = words.slice(0, 2).join(', ');
  return words.length > 2 ? `Check ${shown} and ${words.length - 2} more` : `Check ${shown}`;
}

/** Why a sheet could not be read, in words a teacher can act on. */
export function errorText(reason: string): string {
  const r = (reason || '').toLowerCase();
  if (r.includes('corner targets not found')) {
    return 'The four corner circles were not all found. Scan the sheet again, flat, with all four corners in the picture.';
  }
  if (r.includes('could not process image') || r.includes('could not read bubbles')) {
    return 'The sheet could not be read. Scan it again, flat and in good light.';
  }
  return reason ? `${capitalise(reason)}.` : 'The sheet could not be read.';
}

/** Counts for the filter chips and progress tiles. */
export function countKinds(sheets: Sheet[]) {
  let fine = 0;
  let check = 0;
  let error = 0;
  for (const s of sheets) {
    const k = sheetKind(s);
    if (k === 'fine') fine++;
    else if (k === 'check') check++;
    else error++;
  }
  return { fine, check, error, total: sheets.length };
}
