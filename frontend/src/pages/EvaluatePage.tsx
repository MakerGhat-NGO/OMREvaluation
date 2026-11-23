// "Check sheets" (/evaluate): choose the answer key, the state and the batch, add the scans, check them,
// and follow the progress. The choices, the files and the checking itself live in
// components/evaluate/session.ts, so they carry on when the teacher looks at another tab of the app and
// are still here when they come back.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { reasonText, startChecking, withFullStop } from '../components/evaluate/checking';
import ProgressCard from '../components/evaluate/ProgressCard';
import ScansCard from '../components/evaluate/ScansCard';
import {
  batchChosen, getSession, NEW_BATCH, setBatchId, setDetails, setNewBatch, setStateId, setTestId, sheetTotals, startOver,
  updateSession, useSession,
} from '../components/evaluate/session';
import DetailFields from '../components/ignite/DetailFields';
import SelectBox from '../components/SelectBox';
import EvaluateSkeleton from '../components/skeletons/EvaluateSkeleton';
import { EmptyState, Notice } from '../components/ui';
import { api, Batch, Me, Places, State, Test } from '../lib/api';
import { capitalise, plural } from '../lib/format';
import { addSchool, BatchDetails, detailsOf, guessDetails, igniteOn } from '../lib/ignite';

const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

const byName = (a: State, b: State) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** A name typed for a new state or batch, with its spaces tidied (as the server keeps it). */
const tidy = (name: string) => name.replace(/\s+/g, ' ').trim();

/** The box that takes the name of a new state or batch, in the place of the dropdown. */
function NewNameForm({ id, label, placeholder, addText, saving, error, onAdd, onCancel }: {
  id: string;
  label: string;
  placeholder: string;
  addText: string;
  saving: boolean;
  error: string;
  onAdd: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  const canAdd = tidy(name) !== '' && !saving;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <input ref={box} id={id} aria-label={label} className="input min-w-0 flex-1 basis-40" type="text" value={name}
          maxLength={200} autoComplete="off" placeholder={placeholder} disabled={saving}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && canAdd) {
              e.preventDefault();
              onAdd(tidy(name));
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }} />
        <button type="button" className="btn btn-primary shrink-0" disabled={!canAdd} onClick={() => onAdd(tidy(name))}>
          {saving ? 'Adding…' : addText}
        </button>
        <button type="button" className="btn btn-quiet shrink-0" disabled={saving} onClick={onCancel}>Cancel</button>
      </div>
      {error && <p className="m-0 text-[15px] leading-[22px] text-danger">{error}</p>}
    </div>
  );
}

export default function EvaluatePage({ me }: { me: Me }) {
  const session = useSession();
  const { testId, stateId, batchId, newBatchName, files, run, startError, details } = session;
  // IGNITE: the batch also says where and when the test was taken.
  const ignite = igniteOn(me);
  const [places, setPlaces] = useState<Places | null>(null);
  const [tests, setTests] = useState<Test[] | null>(null);
  const [states, setStates] = useState<State[] | null>(null);
  // The batches of the chosen test and state; null while they load.
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Which name box is open, if any.
  const [adding, setAdding] = useState<'state' | 'batch' | null>(null);
  const [savingState, setSavingState] = useState(false);
  const [addError, setAddError] = useState('');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const progressTitleRef = useRef<HTMLHeadingElement>(null);
  const phase = run ? run.phase : null;
  // The phase the screen last saw, to notice the moment checking finishes while it is open.
  const lastPhase = useRef(phase);
  const runBatchId = run ? run.batchId : '';

  // The answer keys, newest first, and the states. "cancelled" drops a reply that arrives after the
  // screen has closed.
  useEffect(() => {
    let cancelled = false;
    setLoadError('');
    Promise.all([api.get<Test[]>('/api/tests'), api.get<State[]>('/api/states')])
      .then(([keys, stateList]) => {
        if (cancelled) return;
        setTests(keys);
        setStates((stateList || []).slice().sort(byName));
        // Keep the key that is shown as the chosen one, so a key made later (by anyone) does not
        // take its place when the teacher comes back to this screen.
        const chosen = getSession().testId;
        if (keys.length > 0 && !keys.some(t => t.id === chosen)) setTestId(keys[0].id);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(reasonText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  // The batches to choose from: those of the chosen test and state. Loaded again when checking
  // has made a new batch, so it is in the list with its sheets counted.
  useEffect(() => {
    if (!testId || !stateId) {
      setBatches(null);
      return undefined;
    }
    let cancelled = false;
    setBatches(null);
    api.get<Batch[]>(`/api/batches?test_id=${encodeURIComponent(testId)}&state_id=${encodeURIComponent(stateId)}`)
      .then(list => {
        if (cancelled) return;
        setBatches(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setBatches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [testId, stateId, runBatchId]);

  // A chosen batch that is not in the list (deleted meanwhile, say) is not a place to put sheets.
  useEffect(() => {
    if (batches && batchId && batchId !== NEW_BATCH && !batches.some(b => b.id === batchId) && !getSession().run) setBatchId('');
  }, [batches, batchId]);

  // IGNITE: the school details go with the batch only while the feature is on. The names typed on
  // earlier batches are suggested; they are loaded again when checking has made a new batch.
  useEffect(() => {
    updateSession({ sendDetails: ignite });
  }, [ignite]);
  useEffect(() => {
    if (!ignite) return undefined;
    let cancelled = false;
    api.get<Places>('/api/places')
      .then(found => {
        if (!cancelled) setPlaces(found);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ignite, runBatchId]);
  // A batch chosen from the list shows the details it already has, to add to or correct.
  const listedBatch = (batches || []).find(b => b.id === batchId) || null;
  const listedBatchId = listedBatch ? listedBatch.id : '';
  useEffect(() => {
    if (ignite && listedBatch && !getSession().run) updateSession({ details: detailsOf(listedBatch) });
    // Only when another batch is chosen: what the teacher types afterwards stays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ignite, listedBatchId]);

  // A file dropped outside the Scans card would make the browser open it and leave the tool.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer || Array.from(e.dataTransfer.types).indexOf('Files') === -1) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);

  // When checking finishes on this screen, its card moves to the top (see below). Take the teacher
  // there, and give the card's title keyboard focus when the pressed button took focus away with it.
  // Not when the screen opens on a finished check: coming back to this tab never moves focus.
  useEffect(() => {
    const before = lastPhase.current;
    lastPhase.current = phase;
    if (phase !== 'finished' || before === null || before === 'finished') return;
    const active = document.activeElement;
    if (!active || active === document.body) progressTitleRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  }, [phase]);

  const test = tests ? tests.find(t => t.id === testId) || tests[0] || null : null;
  const locked = run !== null; // the form belongs to the run until "Check more sheets"
  const checking = phase === 'starting' || phase === 'checking';
  const finished = phase === 'finished';
  const { counting, sheets } = sheetTotals(files);
  const noAnswers = test !== null && Object.keys(test.answer_key || {}).length === 0;
  const placed = stateId !== '' && batchChosen(session);
  // IGNITE: every batch says which district and block it is from.
  const detailsMissing = ignite && (details.district.trim() === '' || details.block.trim() === '');
  // While pages are being counted the button works (checking waits for the count). Once counted, at
  // least one sheet must open: a list of files that cannot be opened has nothing to check.
  const canStart = test !== null && !noAnswers && placed && !detailsMissing && files.length > 0 && !locked
    && (counting || sheets > 0);
  // What the names of the scans say about the schools ("Name_G7_ZPPS Sunderpur_Malegaon.pdf"): the
  // grade and block for the boxes still empty, and the schools not added yet.
  const fromNames: Partial<BatchDetails> = {};
  let newSchools: string[] = [];
  if (ignite && !locked) {
    const guess = guessDetails(files.map(f => f.file.name));
    (['grade', 'block'] as const).forEach(key => {
      if (guess[key] && details[key].trim() === '') fromNames[key] = guess[key];
    });
    const all = (guess.schools || []).reduce(addSchool, details.schools);
    newSchools = all.slice(details.schools.length);
    if (newSchools.length) fromNames.schools = all;
  }
  const fromNamesText = [
    newSchools.length > 3 ? `${newSchools.slice(0, 3).join(', ')} and ${newSchools.length - 3} more schools` : newSchools.join(', '),
    fromNames.block && `block ${fromNames.block}`, fromNames.grade && `grade ${fromNames.grade}`,
  ].filter(Boolean).join(', ');

  let buttonLabel = 'Check sheets';
  if (checking) buttonLabel = 'Checking…';
  else if (files.length > 0 && !counting && sheets > 0) buttonLabel = sheets === 1 ? 'Check 1 sheet' : `Check ${sheets} sheets`;

  const start = () => {
    if (!test || !canStart) return;
    startChecking(test.id);
    // On a phone the progress card starts below the screen: bring it into view.
    window.requestAnimationFrame(() => progressRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' }));
  };

  const checkMore = () => {
    startOver();
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
    titleRef.current?.focus({ preventScroll: true });
  };

  const openNameBox = (which: 'state' | 'batch') => {
    setAddError('');
    setAdding(which);
  };
  const closeNameBox = () => {
    setAddError('');
    setAdding(null);
  };

  // A new state is saved at once, so every teacher sees it. The same name again (in any capitals)
  // gives the state that exists.
  const addState = async (name: string) => {
    setSavingState(true);
    setAddError('');
    try {
      const made = await api.post<State>('/api/states', { name });
      setStates(list => (list && !list.some(s => s.id === made.id) ? list.concat(made).sort(byName) : list));
      setStateId(made.id);
      setAdding(null);
    } catch (e) {
      setAddError(`Could not add the state: ${capitalise(withFullStop(reasonText(e)))}`.replace(': C', ': c'));
    } finally {
      setSavingState(false);
    }
  };

  // A new batch is made when checking starts, so an empty batch is never left behind. Until then its
  // name is shown as the chosen one.
  const addBatch = (name: string) => {
    const existing = (batches || []).find(b => b.name.toLowerCase() === name.toLowerCase());
    if (existing) setBatchId(existing.id);
    else setNewBatch(name);
    setAdding(null);
  };

  let announcement = '';
  if (run && run.phase === 'finished') {
    announcement = `Finished. ${plural(run.done, 'sheet')} checked: ${run.fine} read fine, ${run.check} to check, ${run.bad} could not read.`;
  } else if (run && run.problems.length > 0) {
    // The first problem is said once, when it happens. The list in the card then grows quietly: read
    // out again at every new problem, it would interrupt the teacher every few seconds.
    announcement = `${run.problems[0]} Checking goes on.`;
  }

  // While checking, the card follows the big button, as on the design. Once finished it moves to the
  // top, so a teacher coming back to this tab sees "See results" and "Check more sheets" first.
  const progress = run && (
    <div ref={progressRef} className="scroll-mb-28 md:scroll-mb-8">
      <ProgressCard run={run} onCheckMore={checkMore} titleRef={progressTitleRef} />
    </div>
  );

  const stateList = states || [];
  const batchList = batches || [];
  const chosenBatch = batchList.find(b => b.id === batchId) || null;
  let batchHint = 'The sheets go into this batch. More can be added to it at any time.';
  if (!stateId) batchHint = 'Choose a state first.';
  else if (batches === null) batchHint = 'Loading batches…';
  else if (batchId === NEW_BATCH) batchHint = 'This batch is made when checking starts.';
  else if (chosenBatch && chosenBatch.sheet_count > 0) {
    batchHint = `${plural(chosenBatch.sheet_count, 'sheet')} in this batch so far. These sheets are added to it.`;
  }

  return (
    <div className="page flex flex-col gap-5">
      <h1 ref={titleRef} tabIndex={-1} className="page-title">Check sheets</h1>

      {finished && progress}

      {!tests && loadError && (
        <Notice tone="error" title="The answer keys could not be loaded">
          <p className="m-0">{capitalise(withFullStop(loadError))}</p>
          <button type="button" className="btn btn-secondary btn-small mt-3" onClick={() => setLoadAttempt(n => n + 1)}>
            Try again
          </button>
        </Notice>
      )}
      {!tests && !loadError && <EvaluateSkeleton />}
      {tests && tests.length === 0 && (
        <EmptyState title="First, make an answer key"
          action={<Link to="/tests?new=1" className="btn btn-primary">Make an answer key</Link>}>
          The tool needs the right answers before it can check sheets.
        </EmptyState>
      )}

      {tests && test && (
        <>
          <div className="card grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="field min-w-0 md:col-span-2">
              <label htmlFor="test-choice">Which test?</label>
              <SelectBox id="test-choice" plain={!ignite} value={test.id} disabled={locked} onChange={setTestId}
                options={tests.map(t => ({ value: t.id, label: `${t.name} (${plural(t.question_count, 'question')})` }))} />
            </div>
            {noAnswers && !locked && (
              <Notice tone="warn" className="md:col-span-2">
                This answer key has no answers yet. <Link to="/tests" className="link">Add the right answers</Link> before
                checking sheets with it.
              </Notice>
            )}

            <div className="field min-w-0">
              <label htmlFor="state-choice">State</label>
              {adding === 'state' ? (
                <NewNameForm id="new-state-name" label="New state" placeholder="e.g. Maharashtra" addText="Add state"
                  saving={savingState} error={addError} onAdd={addState} onCancel={closeNameBox} />
              ) : (
                <div className="flex gap-2">
                  <SelectBox id="state-choice" plain={!ignite} wrapClassName="min-w-0 flex-1" value={stateId} disabled={locked}
                    onChange={setStateId} placeholder={stateList.length === 0 ? 'No states yet' : 'Choose a state'}
                    options={stateList.map(s => ({ value: s.id, label: s.name }))} />
                  <button type="button" className="btn btn-secondary shrink-0" disabled={locked} onClick={() => openNameBox('state')}>
                    New state
                  </button>
                </div>
              )}
              {stateList.length === 0 && adding !== 'state' && (
                <p className="hint font-normal">No states yet: add the state the sheets are from.</p>
              )}
            </div>

            <div className="field min-w-0">
              <label htmlFor="batch-choice">Batch</label>
              {adding === 'batch' ? (
                <NewNameForm id="new-batch-name" label="New batch" placeholder="e.g. ZP Mahalpatane, Grade 7"
                  addText="Use this name" saving={false} error="" onAdd={addBatch} onCancel={closeNameBox} />
              ) : (
                <div className="flex gap-2">
                  <SelectBox id="batch-choice" plain={!ignite} wrapClassName="min-w-0 flex-1" value={batchId}
                    disabled={locked || !stateId} onChange={setBatchId}
                    placeholder={!stateId ? 'Choose a state first'
                      : batchList.length === 0 && batches !== null ? 'No batches yet' : 'Choose a batch'}
                    options={[
                      ...(batchId === NEW_BATCH ? [{ value: NEW_BATCH, label: `New: ${newBatchName}` }] : []),
                      // A submitted batch is with the admin: no sheets are added to it.
                      ...batchList.map(b => ({
                        value: b.id,
                        label: `${b.name}${b.submitted_at ? ' (submitted)' : b.sheet_count > 0 ? ` (${plural(b.sheet_count, 'sheet')})` : ''}`,
                        disabled: !!b.submitted_at,
                      })),
                    ]} />
                  <button type="button" className="btn btn-secondary shrink-0" disabled={locked || !stateId}
                    onClick={() => openNameBox('batch')}>
                    New batch
                  </button>
                </div>
              )}
              <p className="hint font-normal">{batchHint}</p>
            </div>
          </div>

          {ignite && (
            <section aria-labelledby="details-title" className="card flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <h2 id="details-title" className="section-title">Where the test was taken</h2>
                <p className="hint">The district and the block are needed. They go with every sheet of this batch.</p>
              </div>
              <DetailFields value={details} onChange={setDetails} places={places} stateId={stateId} disabled={locked} />
              {fromNamesText && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <p className="hint min-w-0">The file names say: {fromNamesText}.</p>
                  <button type="button" className="btn btn-secondary btn-small" onClick={() => setDetails(fromNames)}>
                    Use these
                  </button>
                </div>
              )}
            </section>
          )}

          <ScansCard files={files} locked={locked} finished={finished} />

          {!finished && (
            <button type="button" className="btn btn-primary btn-big w-full" disabled={!canStart} onClick={start}>
              {buttonLabel}
            </button>
          )}
        </>
      )}

      {startError && <Notice tone="error">{startError}</Notice>}

      {checking && progress}

      {/* Said once by screen readers at the first problem, and once when checking finishes. */}
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </div>
  );
}
