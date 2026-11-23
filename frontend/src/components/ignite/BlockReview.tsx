// IGNITE: one block on the admin's review screen, opened. Each figure the dashboard will show is the
// number from before the app plus what the submitted batches add, unless an admin types another
// figure over it (with a note). Below: the programme figures of the block and the batches behind it.
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Me } from '../../lib/api';
import { friendlyDate, plural, whoDid } from '../../lib/format';
import { dayText, schoolsText } from '../../lib/ignite';
import { boxText, changedFigures, FIGURES, figureText, IgniteBlock, typedFigure } from '../../lib/igniteData';
import SelectBox from '../SelectBox';
import { Notice } from '../ui';
import AskFirst from './AskFirst';

type Boxes = Record<string, string>;

const PROGRAMME: [key: 'total_schools' | 'selected_schools' | 'student_target', label: string][] = [
  ['total_schools', 'Schools in the block'],
  ['selected_schools', 'Schools selected'],
  ['student_target', 'Students to reach'],
];

export default function BlockReview({ block, statuses, me, busy, onSave, onBatch, onDelete }: {
  block: IgniteBlock;
  statuses: string[];
  me: Me;
  busy: boolean;
  /** Saves the changes to this block; true when they were saved. */
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
  onBatch: (batchId: string, leftOut: boolean) => void;
  onDelete: () => void;
}) {
  const [programme, setProgramme] = useState<Boxes>(() =>
    Object.fromEntries(PROGRAMME.map(([key]) => [key, boxText('count', block[key])])));
  const [status, setStatus] = useState(block.status);
  const statusId = useId();
  const [own, setOwn] = useState<Boxes>(() =>
    Object.fromEntries(FIGURES.map(f => [f.key, boxText(f.kind, block.overrides[f.key]?.value)])));
  const [notes, setNotes] = useState<Boxes>(() =>
    Object.fromEntries(FIGURES.map(f => [f.key, block.overrides[f.key]?.note || ''])));
  // The numbers from before the app, open for changes only when asked for.
  const [opening, setOpening] = useState<Boxes | null>(null);
  // The schools the team had already counted, one per line as pasted from its list.
  const countedBefore = (block.schools_counted || []).join('\n');
  const [counted, setCounted] = useState(countedBefore);
  const countedNames = counted.split('\n').filter(line => line.trim()).length;
  const [error, setError] = useState('');
  const changed = changedFigures(block);
  const id = `block-${block.id}`;

  const save = async () => {
    const body: Record<string, unknown> = { status };
    for (const [key, label] of PROGRAMME) {
      const typed = typedFigure('count', programme[key]);
      if ('error' in typed) return setError(`"${label}" ${typed.error}.`);
      body[key] = typed.value;
    }
    const overrides: Record<string, unknown> = {};
    for (const f of FIGURES) {
      const typed = typedFigure(f.kind, own[f.key]);
      if ('error' in typed) return setError(`Your own figure for "${f.label}" ${typed.error}.`);
      const had = block.overrides[f.key];
      const note = notes[f.key].trim();
      if (typed.value === null) {
        if (had) overrides[f.key] = null;
      } else if (!had || Math.abs(had.value - typed.value) > 1e-9 || had.note !== note) {
        overrides[f.key] = { value: typed.value, note };
      }
    }
    body.overrides = overrides;
    if (opening) {
      const before: Record<string, number | null> = {};
      for (const f of FIGURES) {
        const typed = typedFigure(f.kind, opening[f.key]);
        if ('error' in typed) return setError(`"${f.label}" from before the app ${typed.error}.`);
        before[f.key] = typed.value;
      }
      body.opening = before;
    }
    if (counted !== countedBefore) body.schools_counted = counted;
    setError('');
    if (await onSave(body)) setOpening(null);
    return undefined;
  };

  return (
    <div className="flex flex-col gap-5 rounded-2xl bg-ivory p-4 md:p-5">
      <section aria-labelledby={`${id}-figures`} className="flex flex-col">
        <h4 id={`${id}-figures`} className="section-label">What the dashboard will show</h4>
        <p className="hint mt-1">
          Each figure is the number from before the app plus the batches below. Type your own figure to use that instead.
        </p>
        <div className="mt-2 hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_150px] gap-x-4 text-sm font-semibold text-muted sm:grid">
          <span>Figure</span><span>Will show</span><span>Your own figure</span>
        </div>
        {FIGURES.map(f => {
          const had = block.overrides[f.key];
          const typedOwn = own[f.key].trim() !== '';
          return (
            <div key={f.key}
              className="grid grid-cols-1 gap-x-4 gap-y-1.5 border-t border-line py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_150px] sm:items-start">
              <div className="min-w-0">
                <p className="m-0 font-semibold text-heading">{f.label}</p>
                <p className="hint">
                  Before the app: {figureText(f.kind, block.opening[f.key])}. From batches: {figureText(f.kind, block.added[f.key])}.
                </p>
              </div>
              <div className="min-w-0">
                <p className="m-0 flex flex-wrap items-center gap-2 text-[17px]">
                  <span className="font-semibold text-heading">{figureText(f.kind, block.shown[f.key])}</span>
                  {had && <span className="pill tone-check">Your figure</span>}
                </p>
                {changed.includes(f.key) && (
                  <p className="hint">On the dashboard now: {figureText(f.kind, block.published?.[f.key])}</p>
                )}
                {had && (
                  <p className="hint">
                    Worked out: {figureText(f.kind, block.worked_out[f.key])}. Typed by {whoDid(had.by, me.user)}, {friendlyDate(had.at)}.
                  </p>
                )}
              </div>
              <label className="field min-w-0 text-[15px]">
                <span className="sm:sr-only">Your own figure<span className="sr-only"> for {f.label}</span></span>
                <input className="input h-11 px-3 text-base" type="text" inputMode="decimal" autoComplete="off" maxLength={12}
                  value={own[f.key]} disabled={busy} placeholder={f.kind === 'share' ? 'Percent' : 'None'}
                  onChange={e => setOwn(o => ({ ...o, [f.key]: e.target.value }))} />
              </label>
              {typedOwn && (
                <input className="input h-11 px-3 text-base sm:col-span-3" type="text" maxLength={300} autoComplete="off"
                  aria-label={`Why this figure for ${f.label}`} placeholder="Why this figure? A note for the other admins"
                  value={notes[f.key]} disabled={busy} onChange={e => setNotes(n => ({ ...n, [f.key]: e.target.value }))} />
              )}
            </div>
          );
        })}
      </section>

      <section aria-labelledby={`${id}-programme`} className="flex flex-col gap-3">
        <h4 id={`${id}-programme`} className="section-label">The block in the programme</h4>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PROGRAMME.map(([key, label]) => (
            <label key={key} className="field min-w-0 text-[15px]">
              <span>{label}</span>
              <input className="input h-11 px-3 text-base" type="text" inputMode="numeric" autoComplete="off" maxLength={9}
                value={programme[key]} disabled={busy} onChange={e => setProgramme(p => ({ ...p, [key]: e.target.value }))} />
            </label>
          ))}
          <div className="field min-w-0 text-[15px]">
            <label htmlFor={statusId}>Assessment status</label>
            <SelectBox id={statusId} className="select select-small" value={status} disabled={busy} onChange={setStatus}
              options={[
                { value: '', label: 'Let the app decide' },
                ...[...statuses, ...(block.status && !statuses.includes(block.status) ? [block.status] : [])]
                  .map(s => ({ value: s, label: s })),
              ]} />
          </div>
        </div>
      </section>

      <section aria-labelledby={`${id}-schools`} className="flex flex-col gap-2">
        <h4 id={`${id}-schools`} className="section-label">Schools the team had already counted · {countedNames}</h4>
        <p className="hint">
          Paste the team&apos;s list, one school per line. A batch at one of these schools adds no school, so a school
          visited again is not counted twice. The number from before the app: {figureText('count', block.opening.schools_reached)}.
        </p>
        <textarea className="input min-h-[132px] resize-y py-2.5 text-base leading-relaxed" value={counted} disabled={busy}
          aria-labelledby={`${id}-schools`} placeholder={'ZPPS Sunderpur\nZP School Ramnagar'} spellCheck={false}
          onChange={e => setCounted(e.target.value)} />
      </section>

      <section aria-labelledby={`${id}-batches`} className="flex flex-col gap-3">
        <h4 id={`${id}-batches`} className="section-label">Batches from teachers · {block.batches.length}</h4>
        {block.batches.length === 0 ? (
          <p className="hint">No batch has been submitted for this block yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {block.batches.map(x => (
              <li key={x.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3">
                <div className="min-w-0 flex-[1_1_240px]">
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <Link className="link break-words" to={`/batches/${x.id}`}>{x.name || 'Batch with no name'}</Link>
                    {x.left_out && <span className="pill tone-neutral">Left out</span>}
                    {x.block_completed && (
                      <span className="pill tone-check" title="No more papers were expected for this block">
                        Block marked Completed
                      </span>
                    )}
                  </p>
                  <p className="hint">
                    {[schoolsText(x.schools ?? (x.school ? [x.school] : [])),
                      x.schools_counted_before?.length && `${x.schools_counted_before.length} already counted`,
                      x.grade && `Grade ${x.grade}`, dayText(x.assessed_on), plural(x.sheets, 'sheet'),
                      x.average !== null && `average ${figureText('share', x.average)}`, `${x.students_reached} reached`,
                      `sent by ${whoDid(x.submitted_by, me.user)}`].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <button type="button" className="btn btn-secondary btn-small" disabled={busy}
                  aria-label={`${x.left_out ? 'Put it back' : 'Leave it out'}: ${x.name}`} onClick={() => onBatch(x.id, !x.left_out)}>
                  {x.left_out ? 'Put it back' : 'Leave it out'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`${id}-before`} className="flex flex-col gap-3">
        <h4 id={`${id}-before`} className="section-label">Numbers from before the app</h4>
        {opening ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {FIGURES.map(f => (
              <label key={f.key} className="field min-w-0 text-[15px]">
                <span>{f.label}{f.kind === 'share' && <span className="field-note"> (percent)</span>}</span>
                <input className="input h-11 px-3 text-base" type="text" inputMode="decimal" autoComplete="off" maxLength={12}
                  value={opening[f.key]} disabled={busy}
                  onChange={e => setOpening(o => (o ? { ...o, [f.key]: e.target.value } : o))} />
              </label>
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="hint min-w-0 flex-[1_1_260px]">
              These came from the team&apos;s sheet. The batches are added on top of them.
            </p>
            <button type="button" className="btn btn-quiet btn-small" disabled={busy}
              onClick={() => setOpening(Object.fromEntries(FIGURES.map(f => [f.key, boxText(f.kind, block.opening[f.key])])))}>
              Change them
            </button>
          </div>
        )}
      </section>

      {error && <Notice tone="error" onClose={() => setError('')}>{error}</Notice>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save this block'}
        </button>
        <AskFirst label="Take this block off" question={`Take ${block.name} off the dashboard?`} yes="Yes, take it off"
          disabled={busy} onYes={onDelete} />
      </div>
    </div>
  );
}
