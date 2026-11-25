// IGNITE: correcting what was read from a sheet, inside the sheet viewer. A teacher marks a flagged
// sheet as checked, corrects the name or an answer, types in a sheet that could not be read, or
// leaves a sheet out. The server keeps the first reading and who changed what.
import { ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, ApiError, Me, Sheet, SheetChange, Test } from '../../lib/api';
import { capitalise, fmtScore, friendlyDate, whoDid } from '../../lib/format';
import { scoreOf } from '../../lib/ignite';
import { FIELD, keyText, needsAll, qNumber, sheetKind } from '../../lib/sheets';
import { IconCheck, IconPencil } from '../Icons';
import SelectBox from '../SelectBox';
import { AnswerCell, answerCells } from '../sheet/AnswerGrid';
import { Chip } from '../ui';

export interface FixContext {
  test: Test;
  me?: Me;
  /** Why this person cannot change the sheet now, as a sentence: the batch was submitted. '' when they can. */
  locked: string;
  /** The sheet as the server saved it. */
  onSaved: (sheet: Sheet) => void;
  /** Told when the form opens and closes, so the page can ask before unsaved changes are dropped. */
  onEditing?: (editing: boolean) => void;
}

interface Draft { fields: Record<string, string>; answers: Record<string, string>; handsOn: string; }

const FIELDS: string[] = [FIELD.name, FIELD.roll, FIELD.mobile, FIELD.gender];
export const LEAVE_SHEET = 'Leave this sheet without saving your changes?';

function draftOf(sheet: Sheet, test: Test): Draft {
  const fields: Record<string, string> = {};
  FIELDS.forEach(k => { fields[k] = (sheet.fields?.[k] || '').trim(); });
  const answers: Record<string, string> = {};
  for (let n = 1; n <= test.question_count; n++) answers[`q${n}`] = (sheet.answers?.[`q${n}`] || '').trim();
  return { fields, answers, handsOn: sheet.hands_on_score == null ? '' : String(sheet.hands_on_score) };
}

/** Why a save did not work, as a sentence. */
function problemText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Check your internet connection and try again.';
  if (e.status === 401) return 'You have been signed out. Reload the page to sign in again.';
  if (e.status >= 500) return 'The server had a problem. Try again in a minute.';
  const said = capitalise(e.message || 'the change could not be saved');
  return /[.!?]$/.test(said) ? said : `${said}.`;
}

const shown = (value: string | number | boolean | null) => (value === '' || value === null ? 'empty' : String(value));

/** One line of the history: "question 15: CD to C", "marked as checked". */
function changeText(c: SheetChange['changes'][number]): string {
  if (/^q\d+$/.test(c.what)) return `question ${qNumber(c.what)}: ${shown(c.from)} to ${shown(c.to)}`;
  if (c.what === 'Checked') return 'marked as checked';
  if (c.what === 'Typed in by hand') return 'typed in by hand';
  if (c.what === 'Left out') return c.to ? 'left out of the results' : 'put back in the results';
  if (c.what === 'First reading put back') return 'first reading put back';
  return `${c.what.toLowerCase()}: ${shown(c.from)} to ${shown(c.to)}`;
}

/** The parts the viewer puts around the picture and the answers. cells is the grid to show while
 *  the form is open (the answers as typed so far), else null. */
export interface SheetFixParts { editing: boolean; cells: AnswerCell[] | null; top: ReactNode; afterAnswers: ReactNode; }

export function useSheetFix(
  sheet: Sheet, fix: FixContext | undefined, selected: string | null, select: (label: string | null) => void,
): SheetFixParts {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const editing = draft !== null;
  const onEditing = fix?.onEditing;
  const genderId = useId();

  useEffect(() => {
    onEditing?.(editing);
  }, [editing, onEditing]);
  useEffect(() => () => onEditing?.(false), [onEditing]);

  const test = fix?.test;
  const options = test ? test.options.split('') : [];
  const byHand = sheet.status === 'error';

  const setAnswer = useCallback((label: string, letter: string) => {
    // Where the key asks for several bubbles, a letter is added to what is filled, or taken away.
    const several = !!test && !!letter && needsAll(test.answer_key?.[label]);
    setDraft(d => {
      if (!d) return d;
      let value = letter;
      if (several && test) {
        const filled = d.answers[label] || '';
        const next = filled.includes(letter) ? filled.replace(letter, '') : filled + letter;
        value = test.options.split('').filter(o => next.includes(o)).join('');
      }
      return { ...d, answers: { ...d.answers, [label]: value } };
    });
    // Typing a whole sheet in: go on to the next question by itself (not where more letters may follow).
    if (byHand && !several && test && qNumber(label) < test.question_count) select(`q${qNumber(label) + 1}`);
  }, [byHand, test, select]);

  // With a question picked, its letter on the keyboard sets the answer; Backspace or Delete empties it.
  useEffect(() => {
    if (!editing || !selected || !test) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('input, textarea, select')) return;
      const letter = e.key.length === 1 ? e.key.toUpperCase() : '';
      if (letter && test.options.includes(letter)) {
        e.preventDefault();
        setAnswer(selected, letter);
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        setAnswer(selected, '');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing, selected, test, setAnswer]);

  const cells = useMemo(
    () => (draft && test ? answerCells({ answers: draft.answers } as Sheet, test) : null),
    [draft, test],
  );

  // The answer buttons sit under the grid: bring them into view when a question is picked, clear of
  // the Save bar that stays at the bottom.
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editing && selected) pickerRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [editing, selected]);

  if (!fix || !test) return { editing: false, cells: null, top: null, afterAnswers: null };

  const send = async (what: string, body: Record<string, unknown>): Promise<boolean> => {
    setBusy(what);
    setError('');
    try {
      fix.onSaved(await api.patch<Sheet>(`/api/sheets/${sheet.id}`, body));
      return true;
    } catch (e) {
      setError(problemText(e));
      return false;
    } finally {
      setBusy('');
    }
  };

  const open = () => {
    setError('');
    setDraft(draftOf(sheet, test));
    // No question is picked yet: the form starts at the name, not down at the answers.
    select(null);
  };
  const cancel = () => {
    setError('');
    setDraft(null);
  };

  const save = async () => {
    if (!draft) return;
    const body: Record<string, unknown> = {};
    const fields: Record<string, string> = {};
    FIELDS.forEach(k => {
      if (byHand || draft.fields[k].trim() !== (sheet.fields?.[k] || '').trim()) fields[k] = draft.fields[k].trim();
    });
    const answers: Record<string, string> = {};
    Object.keys(draft.answers).forEach(q => {
      if (byHand || draft.answers[q] !== (sheet.answers?.[q] || '').trim()) answers[q] = draft.answers[q];
    });
    if (byHand || Object.keys(fields).length) body.fields = fields;
    if (byHand || Object.keys(answers).length) body.answers = answers;
    const typed = draft.handsOn.trim();
    if (typed !== (sheet.hands_on_score == null ? '' : String(sheet.hands_on_score))) {
      const marks = Number(typed);
      if (typed !== '' && (Number.isNaN(marks) || marks < 0 || marks > (test.hands_on_max ?? 0))) {
        setError(`The hands-on score must be a number from 0 to ${fmtScore(test.hands_on_max)}.`);
        return;
      }
      body.hands_on_score = typed === '' ? null : marks;
    }
    if (sheetKind(sheet) === 'check') body.confirm = true;
    if (Object.keys(body).length === 0 || await send('save', body)) setDraft(null);
  };

  const restore = () => {
    if (window.confirm('Put back what the scan first read? Every correction to this sheet is dropped.')) {
      send('restore', { restore: true });
    }
  };

  const kind = sheetKind(sheet);
  const errorLine = error && <p role="alert" className="m-0 basis-full text-[15px] leading-[22px] text-danger">{error}</p>;

  let top: ReactNode;
  if (draft) {
    const setField = (k: string, v: string) => setDraft(d => (d ? { ...d, fields: { ...d.fields, [k]: v } } : d));
    top = (
      <div className="flex flex-col gap-3.5 border-b border-line bg-ivory px-5 py-4">
        <p className="m-0 font-display text-[19px] font-semibold leading-7 text-heading">
          {byHand ? 'Type in what is on the paper' : 'Correct what was read'}
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="field min-w-0">
            Name
            <input className="input" type="text" maxLength={60} autoComplete="off" value={draft.fields[FIELD.name]}
              onChange={e => setField(FIELD.name, e.target.value)} />
          </label>
          <label className="field min-w-0">
            Roll number
            <input className="input" type="text" maxLength={20} autoComplete="off" value={draft.fields[FIELD.roll]}
              onChange={e => setField(FIELD.roll, e.target.value)} />
          </label>
          <label className="field min-w-0">
            Mobile number
            <input className="input" type="text" inputMode="numeric" maxLength={15} autoComplete="off"
              value={draft.fields[FIELD.mobile]} onChange={e => setField(FIELD.mobile, e.target.value.replace(/[^\d ]/g, ''))} />
          </label>
          <div className="field min-w-0">
            <label htmlFor={genderId}>Gender</label>
            <SelectBox id={genderId} value={draft.fields[FIELD.gender]} onChange={v => setField(FIELD.gender, v)}
              options={[{ value: '', label: 'Not marked' }, { value: 'Male', label: 'Male' }, { value: 'Female', label: 'Female' }]} />
          </div>
          {test.hands_on_max != null && (
            <label className="field min-w-0">
              <span>Activity score <span className="field-note">(hands-on activity, out of {fmtScore(test.hands_on_max)}
                {test.hands_on_pass != null && `; pass mark ${fmtScore(test.hands_on_pass)}`})</span></span>
              <input className="input" type="text" inputMode="decimal" maxLength={6} autoComplete="off" value={draft.handsOn}
                onChange={e => setDraft(d => (d ? { ...d, handsOn: e.target.value } : d))} />
            </label>
          )}
        </div>
        <p className="hint">
          To {byHand ? 'type' : 'change'} an answer, pick its question in the grid under the picture, then choose the answer.
        </p>
      </div>
    );
  } else {
    const working = busy !== '';
    top = (
      <div className="flex flex-col gap-2.5 border-b border-line px-5 py-3.5">
        {sheet.left_out && <p className="m-0 font-semibold text-heading">This sheet is left out of the results.</p>}
        {fix.locked ? <p className="hint">{fix.locked}</p> : (
          <div className="flex flex-wrap gap-2">
            {sheet.left_out ? (
              <button type="button" className="btn btn-secondary btn-small" disabled={working}
                onClick={() => send('back', { left_out: false })}>
                Put it back in the results
              </button>
            ) : (
              <>
                {kind === 'check' && (
                  <button type="button" className="btn btn-primary btn-small" disabled={working}
                    onClick={() => send('confirm', { confirm: true })}>
                    <IconCheck size={20} />
                    {busy === 'confirm' ? 'Saving…' : 'It is right: mark as checked'}
                  </button>
                )}
                <button type="button" className={kind === 'error' ? 'btn btn-primary btn-small' : 'btn btn-secondary btn-small'}
                  disabled={working} onClick={open}>
                  <IconPencil size={20} />
                  {kind === 'error' ? 'Type it in by hand' : 'Correct this sheet'}
                </button>
                <button type="button" className="btn btn-quiet btn-small" disabled={working}
                  onClick={() => send('out', { left_out: true })}>
                  Leave it out
                </button>
              </>
            )}
          </div>
        )}
        {errorLine}
      </div>
    );
  }

  let afterAnswers: ReactNode;
  if (draft) {
    const picked = selected && selected in draft.answers ? selected : null;
    // The key asks for more than one bubble on the picked question: several letters can be chosen.
    const pickedSeveral = !!picked && needsAll(test.answer_key?.[picked]);
    const maxScore = Object.keys(test.answer_key || {}).length * test.marks_correct;
    let saveText = kind === 'fine' ? 'Save' : 'Save and mark as checked';
    if (busy === 'save') saveText = 'Saving…';
    afterAnswers = (
      <>
        <div ref={pickerRef} className="flex scroll-mb-24 flex-col gap-2 px-5 pb-5">
          {picked ? (
            <div role="group" aria-label={`Answer for question ${qNumber(picked)}`} className="flex flex-wrap items-center gap-2">
              <span className="mr-1 font-semibold text-heading">Question {qNumber(picked)}:</span>
              {options.map(letter => (
                <Chip key={letter} onClick={() => setAnswer(picked, letter)}
                  pressed={pickedSeveral ? draft.answers[picked].includes(letter) : draft.answers[picked] === letter}>
                  {letter}
                </Chip>
              ))}
              <Chip pressed={draft.answers[picked] === ''} onClick={() => setAnswer(picked, '')}>No answer</Chip>
              {pickedSeveral && (
                <p className="hint basis-full">
                  The answer key asks for {keyText(test.answer_key[picked])}: pick every letter that is filled.
                </p>
              )}
            </div>
          ) : (
            <p className="hint">Pick a question above to {byHand ? 'type' : 'change'} its answer.</p>
          )}
        </div>
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2.5 border-t border-line bg-white px-5 py-3">
          <p className="m-0 mr-auto font-semibold text-heading">
            Score with these answers: {fmtScore(scoreOf(draft.answers, test))}{maxScore > 0 ? ` of ${fmtScore(maxScore)}` : ''}
          </p>
          <button type="button" className="btn btn-quiet btn-small" disabled={busy !== ''} onClick={cancel}>Cancel</button>
          <button type="button" className="btn btn-primary btn-small" disabled={busy !== ''} onClick={save}>{saveText}</button>
          {errorLine}
        </div>
      </>
    );
  } else {
    const changes = sheet.changes || [];
    const first = sheet.original;
    afterAnswers = (
      <>
        {sheet.skills && sheet.skills.length > 0 && (
          <section aria-label="Skills" className="flex flex-col gap-2 px-5 pb-5">
            <h3 className="m-0 font-sans text-[17px] font-semibold leading-6 text-ink">Skills</h3>
            <ul className="m-0 grid list-none grid-cols-1 gap-x-6 gap-y-1 p-0 text-[15px] leading-[22px] sm:grid-cols-2">
              {sheet.skills.map(s => (
                <li key={s.skill} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 break-words">{s.skill}</span>
                  <span className="shrink-0 whitespace-nowrap font-semibold text-heading">{s.correct} of {s.total}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {changes.length > 0 && (
          <details className="border-t border-line px-5 py-3.5 text-[15px] leading-[22px]">
            <summary className="cursor-pointer font-semibold text-brand">
              Changes to this sheet ({changes.length})
            </summary>
            <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
              {changes.map((entry, i) => (
                <li key={i} className="break-words">
                  <b className="font-semibold">
                    {capitalise(fix.me ? whoDid(entry.by, fix.me.user) : entry.by.split('@')[0])}, {friendlyDate(entry.at)}:
                  </b>{' '}
                  {entry.changes.map(changeText).join('; ')}
                </li>
              ))}
            </ul>
            {first && (
              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                <p className="m-0 min-w-0">
                  First reading: {first.status === 'error' ? 'could not be read' : `score ${fmtScore(first.score)}`}
                  {first.needs_review ? ', needed a check' : ''}.
                </p>
                {!fix.locked && (
                  <button type="button" className="btn btn-quiet btn-small" disabled={busy !== ''} onClick={restore}>
                    Put the first reading back
                  </button>
                )}
              </div>
            )}
          </details>
        )}
      </>
    );
  }

  return { editing, cells, top, afterAnswers };
}
