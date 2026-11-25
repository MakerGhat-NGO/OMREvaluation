// IGNITE: on a batch's results, what is left to do before the batch goes to the admin, as steps in
// the order a teacher does them: settle the flagged sheets, type the activity scores, say where the
// test was taken, submit. A batch is submitted only when every sheet is settled: read fine, marked
// as checked, typed in by hand or left out. When the answer key takes an activity score, every paper
// needs one and the teacher types how many students did the hands-on challenge (the team's answers
// 1 and 10). Once it is submitted the card shows where the test was taken and who submitted it.
import classNames from 'classnames';
import { ReactNode, useEffect, useState } from 'react';
import { api, ApiError, Batch, Me, Places, Sheet, Test } from '../../lib/api';
import { capitalise, fmtScore, friendlyDate, whoDid } from '../../lib/format';
import { BatchDetails, batchSteps, belowPassText, dayText, detailsOf, flaggedText, keptSheets, noActivityText, schoolsText } from '../../lib/ignite';
import { IconCheck, IconPencil } from '../Icons';
import { Notice } from '../ui';
import DetailFields from './DetailFields';

function problemText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Check your internet connection and try again.';
  if (e.status === 401) return 'You have been signed out. Reload the page to sign in again.';
  if (e.status >= 500) return 'The server had a problem. Try again in a minute.';
  const said = capitalise(e.message || 'that did not work');
  return /[.!?]$/.test(said) ? said : `${said}.`;
}

/** done: a tick. todo: still to do. last: the step that ends the list (Submit). */
type StepState = 'done' | 'todo' | 'last';
const MARK: Record<StepState, string> = {
  done: 'bg-leaf-wash text-leaf-ink', todo: 'bg-sun-wash text-sun-ink', last: 'bg-ivory text-muted',
};

/** One step: its number (a tick once it is done), what to do, how far it is, and what belongs to it. */
function Step({ n, state, title, pill, action, children }: {
  n: number;
  state: StepState;
  title: string;
  /** How far the step is: "3 left", "2 of 5". */
  pill?: string;
  /** A button on the right of the title. */
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="flex gap-3 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
      <span aria-hidden="true"
        className={classNames('flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-display text-[15px] font-bold', MARK[state])}>
        {state === 'done' ? <IconCheck size={18} /> : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-h-[32px] flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h3 className="m-0 text-base font-semibold leading-6 text-heading">
            <span className="sr-only">{state === 'done' ? 'Done: ' : `Step ${n}: `}</span>
            {title}
          </h3>
          {pill && (
            <span className={classNames('pill whitespace-nowrap py-0.5 text-[14px]', state === 'done' ? 'tone-fine' : 'tone-check')}>
              {pill}
            </span>
          )}
          {action}
        </div>
        {children}
      </div>
    </li>
  );
}

export default function BatchIgniteCard({ batch, test, sheets, me, onBatch }: {
  batch: Batch;
  test: Test;
  sheets: Sheet[];
  me: Me;
  /** The batch as the server saved it. */
  onBatch: (batch: Batch) => void;
}) {
  const admin = me.user.role === 'admin';
  // With an activity score on the answer key, the teacher types the students in the hands-on
  // challenge; without one, "students reached" is an admin's own figure.
  const handsOn = test.hands_on_max != null;
  const submitted = !!batch.submitted_at;
  const locked = submitted && !admin;
  const [form, setForm] = useState<BatchDetails | null>(null);
  const [reached, setReached] = useState('');
  const [places, setPlaces] = useState<Places | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const editing = form !== null;

  // The names typed on earlier batches, to suggest while this one's details are typed.
  useEffect(() => {
    if (!editing || places) return undefined;
    let cancelled = false;
    api.get<Places>('/api/places')
      .then(found => {
        if (!cancelled) setPlaces(found);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [editing, places]);

  const run = async (what: string, request: () => Promise<Batch>): Promise<boolean> => {
    setBusy(what);
    setError('');
    try {
      onBatch(await request());
      return true;
    } catch (e) {
      setError(problemText(e));
      return false;
    } finally {
      setBusy('');
    }
  };

  const openForm = () => {
    setError('');
    setForm(detailsOf(batch));
    setReached(batch.students_reached == null ? '' : String(batch.students_reached));
  };
  const saveForm = async () => {
    if (!form) return;
    const body: Record<string, unknown> = { ...form };
    if (admin || handsOn) {
      const typed = reached.trim();
      if (typed !== '' && !/^\d+$/.test(typed)) {
        setError(handsOn ? 'The number of students must be a whole number.' : 'Students reached must be a whole number.');
        return;
      }
      body.students_reached = typed === '' ? null : Number(typed);
    }
    if (await run('save', () => api.patch<Batch>(`/api/batches/${batch.id}`, body))) setForm(null);
  };

  const kept = keptSheets(sheets);
  const place = [batch.district, batch.block, schoolsText(detailsOf(batch).schools), batch.grade && `Grade ${batch.grade}`,
    dayText(batch.assessed_on)]
    .filter(Boolean).join(' · ');
  let reachedLine = '';
  if (handsOn) {
    reachedLine = `Students in the hands-on challenge: ${batch.students_reached == null ? 'not typed yet' : batch.students_reached}`;
  } else if (admin) {
    reachedLine = `Students reached: ${batch.students_reached == null ? `${kept.length} (the number of sheets)` : batch.students_reached}`;
  }
  // The hands-on scores: asked for only when the answer key takes one.
  const handsOnMax = kept.length > 0 ? test.hands_on_max ?? null : null;
  const handsOnPass = handsOnMax != null ? test.hands_on_pass ?? null : null;
  const handsOnTyped = batch.hands_on_count ?? kept.filter(s => s.hands_on_score != null).length;

  const editButton = (label: string, quiet: boolean) => (
    <button type="button" className={classNames('btn btn-small -my-1.5 shrink-0', quiet ? 'btn-quiet' : 'btn-secondary')}
      onClick={openForm}>
      <IconPencil size={20} />
      {label}
    </button>
  );
  const placeForm = form && (
    <>
      <DetailFields value={form} onChange={patch => setForm(f => (f ? { ...f, ...patch } : f))} places={places}
        stateId={batch.state_id || ''} disabled={busy !== ''} oneColumn />
      {(admin || handsOn) && (
        <label className="field min-w-0">
          {handsOn ? (
            <span>
              Students in the hands-on challenge{' '}
              <span className="field-note">(from the attendance: at least the {kept.length} papers)</span>
            </span>
          ) : (
            <span>Students reached <span className="field-note">(leave empty to use the number of sheets)</span></span>
          )}
          <input className="input" type="text" inputMode="numeric" maxLength={6} autoComplete="off" value={reached}
            placeholder={handsOn ? 'e.g. 60' : String(kept.length)} disabled={busy !== ''}
            onChange={e => setReached(e.target.value)} />
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary btn-small" disabled={busy !== ''} onClick={saveForm}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-quiet btn-small" disabled={busy !== ''}
          onClick={() => {
            setError('');
            setForm(null);
          }}>
          Cancel
        </button>
      </div>
    </>
  );

  if (submitted) {
    return (
      <section aria-labelledby="ignite-title" className="card flex flex-col gap-3.5">
        <div className="flex items-start justify-between gap-3">
          <h2 id="ignite-title" className="section-title">Where the test was taken</h2>
          {!editing && !locked && editButton('Edit', true)}
        </div>
        {placeForm || (
          <div className="flex flex-col gap-1 text-base leading-6">
            <p className="m-0 break-words font-semibold text-heading">{place || 'Not typed.'}</p>
            {reachedLine && <p className="hint">{reachedLine}</p>}
            {handsOnMax != null && (
              <p className="hint">
                Activity scores typed for {handsOnTyped} of {kept.length} sheets (out of {fmtScore(handsOnMax)} each).
              </p>
            )}
          </div>
        )}
        {!editing && (
          <Notice tone="success" title={`Submitted by ${whoDid(batch.submitted_by || '', me.user)}, ${friendlyDate(batch.submitted_at)}`}>
            <p className="m-0">
              {admin ? 'Open it again to send it back to the teacher for changes.' : 'An admin can open it again if something needs to change.'}
            </p>
            {admin && (
              <button type="button" className="btn btn-secondary btn-small mt-3" disabled={busy !== ''}
                onClick={() => run('reopen', () => api.post<Batch>(`/api/batches/${batch.id}/reopen`))}>
                {busy === 'reopen' ? 'Opening…' : 'Open it again'}
              </button>
            )}
          </Notice>
        )}
        {error && <Notice tone="error" onClose={() => setError('')}>{error}</Notice>}
      </section>
    );
  }

  const steps = batchSteps(batch, sheets, handsOnMax, handsOnPass);
  const flagged = steps.check + steps.unread;
  // The steps are numbered as they show: the activity step is there only when the key takes a score.
  const handsOnStep = handsOnMax != null ? 2 : 0;
  const placeStep = handsOnStep ? 3 : 2;
  const submitStep = placeStep + 1;
  // What the place step still asks for: the district and block, and the students in the challenge.
  const placeAsks = [...steps.missing.map(m => `the ${m}`),
    ...(steps.reached === 'missing' ? ['the students in the hands-on challenge'] : [])];
  const placeAsksText = placeAsks.length <= 1 ? placeAsks.join('')
    : `${placeAsks.slice(0, -1).join(', ')} and ${placeAsks[placeAsks.length - 1]}`;
  const placeTodo = placeAsks.length > 0 || steps.reached !== '';
  // Submit waits for the sheets, every activity score (only students who passed the challenge
  // write the test, so each paper has one) and the place, the same rules as the server's.
  const waitsFor = [flagged > 0 && 1, steps.noActivity > 0 && handsOnStep, placeTodo && placeStep]
    .filter(Boolean) as number[];
  const blocked = steps.kept === 0 || waitsFor.length > 0;
  let submitHint = 'Everything is ready. After you submit, only an admin can change this batch.';
  if (steps.kept === 0) submitHint = 'There are no sheets in this batch yet.';
  else if (waitsFor.length) {
    const list = waitsFor.length > 1 ? `${waitsFor.slice(0, -1).join(', ')} and ${waitsFor[waitsFor.length - 1]}` : `${waitsFor[0]}`;
    submitHint = `Finish ${waitsFor.length > 1 ? 'steps' : 'step'} ${list} first.`;
  }

  return (
    <section aria-labelledby="ignite-title" className="card flex flex-col gap-3.5">
      <h2 id="ignite-title" className="section-title">What is left to do</h2>
      <ol className="m-0 flex list-none flex-col p-0">
        <Step n={1} state={flagged ? 'todo' : 'done'} title="Check the flagged sheets" pill={flagged ? `${flagged} left` : undefined}>
          <p className="hint">
            {flagged
              ? `${capitalise(flaggedText(steps))}. Open ${flagged === 1 ? 'it' : 'each one'} in the list below.`
              : steps.kept === 0 ? 'There are no sheets in this batch yet.' : 'Every sheet is settled.'}
          </p>
        </Step>

        {handsOnMax != null && (
          <Step n={handsOnStep} state={steps.noActivity ? 'todo' : 'done'} title="Type the activity scores"
            pill={`${steps.kept - steps.noActivity} of ${steps.kept}`}>
            {steps.noActivity > 0 && (
              <p className="hint">
                {noActivityText(steps.noActivity)} yet. Type the mark each student got for the hands-on activity, out
                of {fmtScore(handsOnMax)}, in the box beside the student. Submit waits for every one.
              </p>
            )}
            {steps.belowPass > 0 && handsOnPass != null && (
              <Notice tone="warn" className="mt-1">
                {belowPassText(steps.belowPass)} ({fmtScore(handsOnPass)} of {fmtScore(handsOnMax)}). Only students who
                score {fmtScore(handsOnPass)} or more write the test. Check {steps.belowPass === 1 ? 'that mark' : 'those marks'}.
                If a student did not pass, leave the paper out.
              </Notice>
            )}
          </Step>
        )}

        <Step n={placeStep} state={placeTodo ? 'todo' : 'done'}
          title={placeAsks.length ? `Add ${placeAsksText}` : 'Where the test was taken'}
          action={!editing && editButton(placeAsks.length ? 'Add' : 'Edit', !placeTodo)}>
          {placeForm || (
            <>
              <p className="hint">
                {place && <span className="font-semibold text-heading">{place}</span>}
                {place && placeAsks.length > 0 && '. '}
                {placeAsks.length > 0 && 'Needed before you submit.'}
              </p>
              {reachedLine && <p className="hint">{reachedLine}</p>}
              {steps.reached === 'fewer' && (
                <p className="hint text-sun-ink">
                  That is fewer than the {steps.kept} papers. Everyone who wrote the test did the challenge first, so
                  correct the number.
                </p>
              )}
            </>
          )}
        </Step>

        <Step n={submitStep} state="last" title="Submit to the admin">
          <button type="button" className="btn btn-primary w-full" disabled={blocked || busy !== ''}
            onClick={() => run('submit', () => api.post<Batch>(`/api/batches/${batch.id}/submit`))}>
            <IconCheck />
            {busy === 'submit' ? 'Submitting…' : 'Submit this batch'}
          </button>
          <p className="hint">{submitHint}</p>
        </Step>
      </ol>

      {error && <Notice tone="error" onClose={() => setError('')}>{error}</Notice>}
    </section>
  );
}
