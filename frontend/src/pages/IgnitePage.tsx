// IGNITE data (admins only): the numbers the dashboard shows, and where each one comes from.
// Teachers submit checked batches; this screen adds them to the numbers from before the app, block
// by block. An admin looks them over, types a figure of their own where needed, leaves a batch out,
// marks the top students, and presses Publish. The dashboard shows only what was published last.
import classNames from 'classnames';
import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import DayPicker from '../components/DayPicker';
import AskFirst from '../components/ignite/AskFirst';
import BlockReview from '../components/ignite/BlockReview';
import TopStudents from '../components/ignite/TopStudents';
import { IconChevronDown, IconRefresh, IconUpload } from '../components/Icons';
import IgniteSkeleton from '../components/skeletons/IgniteSkeleton';
import { useToast } from '../components/Toast';
import { EmptyState, Notice } from '../components/ui';
import { api, Me } from '../lib/api';
import { friendlyDate, plural, whoDid } from '../lib/format';
import { dayText } from '../lib/ignite';
import {
  blockDiffers, boxText, districtSum, figureText, IgniteBlock, IgniteDistrict, IgniteOverview, problemText, Publish,
  typedFigure,
} from '../lib/igniteData';

const statusTone = (status: string) =>
  (/^completed$/i.test(status) ? 'tone-fine' : /progress/i.test(status) ? 'tone-check' : 'tone-neutral');

interface ImportResult { districts: number; blocks: number; top_students: number; hands_on_max: number | null; }

export default function IgnitePage({ me }: { me: Me }) {
  const toast = useToast();
  const [view, setView] = useState<IgniteOverview | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [openBlock, setOpenBlock] = useState('');
  const [openTop, setOpenTop] = useState('');
  const [editing, setEditing] = useState('');       // a district's id, or 'new'
  // Only the newest load may update the page, so a slow older answer never replaces a newer one.
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++latestLoad.current;
    try {
      const found = await api.get<IgniteOverview>('/api/ignite/overview');
      if (ticket !== latestLoad.current) return;
      setView(found);
      setLoadError('');
    } catch (e) {
      if (ticket === latestLoad.current) setLoadError(problemText(e));
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      latestLoad.current += 1;
    };
  }, [load]);

  /** Makes one change, says so, and loads the numbers again. True when it was saved. */
  const run = async (what: string, change: () => Promise<unknown>, done?: string): Promise<boolean> => {
    setBusy(what);
    setError('');
    try {
      await change();
      if (done) toast(done);
      await load();
      return true;
    } catch (e) {
      setError(`That was not saved. ${problemText(e)}`);
      return false;
    } finally {
      setBusy('');
    }
  };

  const publish = async () => {
    if (await run('publish', () => api.post('/api/ignite/publish', { note }), 'Published. The dashboard shows these numbers now.')) {
      setNote('');
    }
  };

  const districts = view?.districts || [];
  const blocks = districts.flatMap(d => d.blocks);
  const differing = view?.last_publish ? blocks.filter(blockDiffers).length : 0;
  const last = view?.last_publish;

  return (
    <div className="page flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="page-title">IGNITE data</h1>
        <p className="hint">The numbers the dashboard shows. Nothing changes on the dashboard until you press Publish.</p>
      </div>

      {loadError && (
        <div className="flex flex-col items-start gap-3">
          <Notice tone="error" className="w-full">
            {view ? 'The numbers could not be refreshed, so they may be out of date.' : 'The numbers could not be loaded.'} {loadError}
          </Notice>
          <button type="button" className="btn btn-secondary" onClick={() => { setLoadError(''); load(); }}>
            <IconRefresh /> Try again
          </button>
        </div>
      )}
      {error && <Notice tone="error" onClose={() => setError('')}>{error}</Notice>}

      {!view ? (
        !loadError && <IgniteSkeleton />
      ) : (
        <>
          <section aria-labelledby="publish-title" className="card flex flex-col gap-3.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="publish-title" className="section-title">On the dashboard now</h2>
              {blocks.length > 0 && (
                <span className={classNames('pill', view.changed ? 'tone-check' : 'tone-fine')}>
                  {view.changed ? 'Changes not published yet' : 'Up to date'}
                </span>
              )}
            </div>
            <p className="m-0 break-words">
              {last
                ? `Published ${friendlyDate(last.published_at)} by ${whoDid(last.published_by, me.user)}.`
                : 'Nothing is published yet. The dashboard has no numbers from this app.'}
              {differing > 0 && ` ${plural(differing, 'block differs', 'blocks differ')} from what is published.`}
            </p>
            {last?.note && <p className="hint">Note: {last.note}</p>}
            <label className="field min-w-0">
              <span>Note for this publish <span className="field-note">(optional)</span></span>
              <input className="input" type="text" maxLength={500} autoComplete="off" value={note} disabled={busy !== ''}
                placeholder="For example: Malegaon batches of this week added" onChange={e => setNote(e.target.value)} />
            </label>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
              <button type="button" className="btn btn-primary" disabled={busy !== '' || !view.changed || blocks.length === 0}
                onClick={publish}>
                <IconUpload />
                {busy === 'publish' ? 'Publishing…' : 'Publish to the dashboard'}
              </button>
              {last && <a className="link" href="/api/ignite/feed" target="_blank" rel="noreferrer">See what the dashboard reads</a>}
            </div>
            {blocks.length === 0 && <p className="hint">Add a district with its blocks first: see Set-up below.</p>}
          </section>

          {view.unmatched.length > 0 && (
            <Notice tone="warn" title={`${plural(view.unmatched.length, 'submitted batch matches', 'submitted batches match')} no block`}>
              <p className="m-0">
                They are in no number yet. Open a batch and correct its district or block, or add the block below.
              </p>
              <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
                {view.unmatched.map(x => (
                  <li key={x.id} className="break-words">
                    <Link className="link" to={`/batches/${x.id}`}>{x.name || 'Batch with no name'}</Link>
                    {`: ${[x.district, x.block].filter(Boolean).join(', ')} · ${plural(x.sheets, 'sheet')}`}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          {view.working.length > 0 && (
            <details className="rounded-2xl border border-line bg-white px-4 py-3">
              <summary className="cursor-pointer font-semibold text-heading">
                {plural(view.working.length, 'batch is', 'batches are')} still with teachers
              </summary>
              <p className="hint mt-2">They count once the teacher submits them.</p>
              <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
                {view.working.map(x => (
                  <li key={x.id} className="break-words">
                    <Link className="link" to={`/batches/${x.id}`}>{x.name || 'Batch with no name'}</Link>
                    {`: ${[x.district, x.block, x.school].filter(Boolean).join(', ')} · ${plural(x.sheets, 'sheet')} · ${whoDid(x.created_by, me.user)}`}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {districts.length === 0 && (
            <EmptyState title="No district yet">
              Take over the team&apos;s sheet in Set-up below, or add a district there by hand.
            </EmptyState>
          )}
          {districts.map(d => (
            <DistrictCard key={d.id} district={d} me={me} view={view} busy={busy !== ''} openBlock={openBlock} topOpen={openTop === d.id}
              editing={editing === d.id}
              onOpenBlock={id => setOpenBlock(open => (open === id ? '' : id))}
              onTop={() => setOpenTop(open => (open === d.id ? '' : d.id))}
              onEdit={on => setEditing(on ? d.id : '')}
              onSaveDistrict={async body => {
                const ok = await run('district', () => api.patch(`/api/ignite/districts/${d.id}`, body), `${d.name} saved.`);
                if (ok) setEditing('');
                return ok;
              }}
              onDeleteDistrict={() => run('district', () => api.del(`/api/ignite/districts/${d.id}`), `${d.name} was taken off.`)}
              onAddBlock={name => run('block', () => api.post('/api/ignite/blocks', { district_id: d.id, name }), `${name} added.`)}
              onSaveBlock={(b, body) => run('block', () => api.patch(`/api/ignite/blocks/${b.id}`, body), `${b.name} saved.`)}
              onDeleteBlock={b => run('block', () => api.del(`/api/ignite/blocks/${b.id}`), `${b.name} was taken off.`)}
              onBatch={(id, leftOut) => run('batch', () => api.put(`/api/ignite/batches/${id}`, { left_out: leftOut }),
                leftOut ? 'The batch is left out of the dashboard.' : 'The batch is back in the numbers.')}
              onChanged={load} />
          ))}

          <SetUp view={view} busy={busy !== ''} adding={editing === 'new'} onAdding={on => setEditing(on ? 'new' : '')}
            onImport={file => {
              const form = new FormData();
              form.append('file', file);
              let got: ImportResult | undefined;
              return run('import', async () => { got = await api.upload<ImportResult>('/api/ignite/import', form); })
                .then(ok => {
                  if (ok && got) {
                    toast(`Taken over: ${plural(got.districts, 'district')}, ${plural(got.blocks, 'block')}, ${plural(got.top_students, 'top student')}.`);
                  }
                  return ok;
                });
            }}
            onHandsOn={most => run('settings', () => api.put('/api/ignite/settings', { hands_on_max: most }), 'Saved.')}
            onAddDistrict={async body => {
              const ok = await run('district', () => api.post('/api/ignite/districts', body), 'District added.');
              if (ok) setEditing('');
              return ok;
            }} />

          {view.publishes > 0 && (
            <Publishes key={view.last_publish?.id} me={me} busy={busy !== ''}
              onRestore={p => run('restore', () => api.post(`/api/ignite/snapshots/${p.id}/restore`),
                'The dashboard shows those numbers again.')} />
          )}
        </>
      )}
    </div>
  );
}

function DistrictCard({ district: d, me, view, busy, openBlock, topOpen, editing, onOpenBlock, onTop, onEdit, onSaveDistrict,
  onDeleteDistrict, onAddBlock, onSaveBlock, onDeleteBlock, onBatch, onChanged }: {
  district: IgniteDistrict; me: Me; view: IgniteOverview; busy: boolean; openBlock: string; topOpen: boolean; editing: boolean;
  onOpenBlock: (id: string) => void; onTop: () => void; onEdit: (on: boolean) => void;
  onSaveDistrict: (body: Record<string, unknown>) => Promise<boolean>; onDeleteDistrict: () => void;
  onAddBlock: (name: string) => Promise<boolean>;
  onSaveBlock: (b: IgniteBlock, body: Record<string, unknown>) => Promise<boolean>; onDeleteBlock: (b: IgniteBlock) => void;
  onBatch: (batchId: string, leftOut: boolean) => void; onChanged: () => void;
}) {
  const [newBlock, setNewBlock] = useState('');
  const titleId = `district-${d.id}`;
  const top = d.top_imported + d.top_marked;
  const summary = [d.state, plural(d.blocks.length, 'block'), d.grade && `Grade ${d.grade}`,
    `${figureText('count', districtSum(d, 'students_reached'))} reached`,
    `${figureText('count', districtSum(d, 'assessed'))} assessed`,
    d.target_date && `until ${dayText(d.target_date)}`].filter(Boolean).join(' · ');

  return (
    <section aria-labelledby={titleId} className="card flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={titleId} className="section-title break-words">{d.name}</h2>
          <p className="hint">{summary}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary btn-small" aria-expanded={topOpen} onClick={onTop}>
            Top students · {top}
          </button>
          <button type="button" className="btn btn-quiet btn-small" aria-expanded={editing} onClick={() => onEdit(!editing)}>
            Edit<span className="sr-only"> {d.name}</span>
          </button>
        </div>
      </div>

      {editing && (
        <DistrictForm district={d} busy={busy} onSave={onSaveDistrict} onCancel={() => onEdit(false)}
          extra={<AskFirst label="Take this district off" question={`Take ${d.name} and its blocks off the dashboard?`}
            yes="Yes, take it off" disabled={busy} onYes={onDeleteDistrict} />} />
      )}
      {topOpen && <TopStudents district={d} onChanged={onChanged} />}

      {d.blocks.length === 0 ? (
        <p className="hint">This district has no blocks yet, so it is on the state table only. Add its blocks below.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {d.blocks.map(b => {
            const open = openBlock === b.id;
            return (
              <li key={b.id} className="flex flex-col gap-2.5">
                <button type="button" aria-expanded={open} onClick={() => onOpenBlock(b.id)}
                  className={classNames('flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl border bg-white px-4 py-3 text-left hover:border-heading',
                    open ? 'border-heading' : 'border-line')}>
                  <span className="min-w-0 flex-[1_1_160px] break-words text-[17px] font-semibold text-heading">{b.name}</span>
                  <span className={classNames('pill', statusTone(b.status_shown))}>{b.status_shown}</span>
                  {view.last_publish && blockDiffers(b) && (
                    <span className="pill tone-check">{b.published ? 'Changed' : 'Not on the dashboard yet'}</span>
                  )}
                  <IconChevronDown className={classNames('ml-auto shrink-0 text-muted transition-transform', open && 'rotate-180')} />
                  <span className="hint basis-full">
                    {[`Reached ${figureText('count', b.shown.students_reached)}`, `assessed ${figureText('count', b.shown.assessed)}`,
                      `average ${figureText('share', b.shown.avg)}`,
                      b.batches.length > 0 && plural(b.batches.length, 'batch', 'batches')].filter(Boolean).join(' · ')}
                  </span>
                </button>
                {open && (
                  <BlockReview block={b} statuses={view.statuses} me={me} busy={busy} onSave={body => onSaveBlock(b, body)}
                    onBatch={onBatch} onDelete={() => onDeleteBlock(b)} />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form className="flex flex-wrap items-end gap-3"
        onSubmit={async e => {
          e.preventDefault();
          if (newBlock.trim() && await onAddBlock(newBlock.trim())) setNewBlock('');
        }}>
        <label className="field min-w-0 flex-[1_1_220px] text-[15px]">
          <span>Add a block to {d.name}</span>
          <input className="input h-11 px-3 text-base" type="text" maxLength={200} autoComplete="off" value={newBlock}
            placeholder="Name of the block" disabled={busy} onChange={e => setNewBlock(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-secondary btn-small" disabled={busy || !newBlock.trim()}>Add the block</button>
      </form>
    </section>
  );
}

const DISTRICT_FIELDS: [key: 'blocks_count' | 'total_schools' | 'total_students', label: string][] = [
  ['blocks_count', 'Number of blocks'],
  ['total_schools', 'Schools in the district'],
  ['total_students', 'Students in the district'],
];

function DistrictForm({ district, busy, onSave, onCancel, extra }: {
  district?: IgniteDistrict; busy: boolean; onSave: (body: Record<string, unknown>) => Promise<boolean>;
  onCancel: () => void; extra?: ReactNode;
}) {
  const [text, setText] = useState({ name: district?.name || '', state: district?.state || '', grade: district?.grade || '',
    target_date: district?.target_date || '' });
  const [numbers, setNumbers] = useState<Record<string, string>>(() =>
    Object.fromEntries(DISTRICT_FIELDS.map(([key]) => [key, boxText('count', district?.[key])])));
  const [error, setError] = useState('');

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!text.name.trim()) return setError('Type the name of the district.');
    const body: Record<string, unknown> = { ...text, target_date: text.target_date || null };
    for (const [key, label] of DISTRICT_FIELDS) {
      const typed = typedFigure('count', numbers[key]);
      if ('error' in typed) return setError(`"${label}" ${typed.error}.`);
      body[key] = typed.value;
    }
    setError('');
    onSave(body);
    return undefined;
  };
  const box = 'input h-11 px-3 text-base';

  return (
    <form className="flex flex-col gap-3 rounded-2xl bg-ivory p-4 md:p-5" onSubmit={save}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="field min-w-0 text-[15px]">
          <span>District</span>
          <input className={box} type="text" maxLength={200} autoComplete="off" value={text.name} disabled={busy}
            onChange={e => setText(t => ({ ...t, name: e.target.value }))} />
        </label>
        <label className="field min-w-0 text-[15px]">
          <span>State</span>
          <input className={box} type="text" maxLength={200} autoComplete="off" value={text.state} disabled={busy}
            onChange={e => setText(t => ({ ...t, state: e.target.value }))} />
        </label>
        <label className="field min-w-0 text-[15px]">
          <span>Grades <span className="field-note">(for example 6 to 8)</span></span>
          <input className={box} type="text" maxLength={50} autoComplete="off" value={text.grade} disabled={busy}
            onChange={e => setText(t => ({ ...t, grade: e.target.value }))} />
        </label>
        <div className="text-[15px]">
          <DayPicker label="Target date" value={text.target_date} disabled={busy} boxClassName={box}
            onChange={day => setText(t => ({ ...t, target_date: day }))} />
        </div>
        {DISTRICT_FIELDS.map(([key, label]) => (
          <label key={key} className="field min-w-0 text-[15px]">
            <span>{label}</span>
            <input className={box} type="text" inputMode="numeric" maxLength={9} autoComplete="off" value={numbers[key]} disabled={busy}
              onChange={e => setNumbers(n => ({ ...n, [key]: e.target.value }))} />
          </label>
        ))}
      </div>
      {error && <Notice tone="error" onClose={() => setError('')}>{error}</Notice>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-primary btn-small" disabled={busy}>{district ? 'Save the district' : 'Add the district'}</button>
        <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={onCancel}>Cancel</button>
        {extra}
      </div>
    </form>
  );
}

function SetUp({ view, busy, adding, onAdding, onImport, onHandsOn, onAddDistrict }: {
  view: IgniteOverview; busy: boolean; adding: boolean; onAdding: (on: boolean) => void;
  onImport: (file: File) => Promise<boolean>; onHandsOn: (most: number | null) => Promise<boolean>;
  onAddDistrict: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [most, setMost] = useState(boxText('average', view.settings.hands_on_max));
  const [error, setError] = useState('');

  const saveMost = (e: FormEvent) => {
    e.preventDefault();
    const typed = typedFigure('average', most);
    if ('error' in typed || typed.value === 0) return setError('The hands-on maximum must be a number above 0, or empty.');
    setError('');
    onHandsOn(typed.value);
    return undefined;
  };

  return (
    <section aria-labelledby="setup-title" className="card flex flex-col gap-5">
      <h2 id="setup-title" className="section-title">Set-up</h2>

      <div className="flex flex-col gap-2.5">
        <h3 className="section-label">Take over the team&apos;s sheet</h3>
        <p className="hint">
          Download the Google Sheet the dashboard reads today as Excel (File, Download, Microsoft Excel) and choose that file.
          Districts, blocks, their figures, the numbers so far and the top students so far are taken over.
          The names and schools of students are not read. Doing it again updates the same districts and blocks.
        </p>
        <input ref={file} type="file" accept=".xlsx" className="sr-only" tabIndex={-1} aria-hidden="true"
          onChange={e => {
            const chosen = e.target.files?.[0];
            e.target.value = '';
            if (chosen) onImport(chosen);
          }} />
        <button type="button" className="btn btn-secondary btn-small self-start" disabled={busy} onClick={() => file.current?.click()}>
          <IconUpload size={20} /> Choose the Excel file
        </button>
      </div>

      <form className="flex flex-col gap-2.5" onSubmit={saveMost}>
        <h3 className="section-label">Hands-on activity</h3>
        <div className="flex flex-wrap items-end gap-3">
          <label className="field min-w-0 flex-[0_1_260px] text-[15px]">
            <span>The dashboard shows the average out of</span>
            <input className="input h-11 px-3 text-base" type="text" inputMode="decimal" maxLength={6} autoComplete="off" value={most}
              disabled={busy} placeholder="No scale" onChange={e => setMost(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-secondary btn-small" disabled={busy}>Save</button>
        </div>
        <p className="hint">Use the same number as the answer keys take for the hands-on score.</p>
        {error && <Notice tone="error" onClose={() => setError('')}>{error}</Notice>}
      </form>

      <div className="flex flex-col gap-2.5">
        <h3 className="section-label">Districts</h3>
        {adding ? (
          <DistrictForm busy={busy} onSave={onAddDistrict} onCancel={() => onAdding(false)} />
        ) : (
          <button type="button" className="btn btn-secondary btn-small self-start" disabled={busy} onClick={() => onAdding(true)}>
            Add a district by hand
          </button>
        )}
      </div>
    </section>
  );
}

function Publishes({ me, busy, onRestore }: { me: Me; busy: boolean; onRestore: (p: Publish) => void }) {
  const [list, setList] = useState<Publish[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get<Publish[]>('/api/ignite/snapshots')
      .then(found => {
        if (!cancelled) setList(found);
      })
      .catch(e => {
        if (!cancelled) setError(`The earlier publishes could not be loaded. ${problemText(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section aria-labelledby="publishes-title" className="card flex flex-col gap-3">
      <h2 id="publishes-title" className="section-title">Every publish</h2>
      <p className="hint">The dashboard shows the one at the top. Showing an earlier one again does not change the numbers on this page.</p>
      {error && <Notice tone="error">{error}</Notice>}
      {list && (
        <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
          {list.map((p, i) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3">
              <div className="min-w-0 flex-[1_1_240px]">
                <p className="m-0 flex flex-wrap items-center gap-2 font-semibold text-heading">
                  <span>{friendlyDate(p.published_at)} by {whoDid(p.published_by, me.user)}</span>
                  {i === 0 && <span className="pill tone-fine">On the dashboard</span>}
                </p>
                {(p.note || p.restored_from) && (
                  <p className="hint">{[p.restored_from && 'An earlier publish, shown again.', p.note].filter(Boolean).join(' ')}</p>
                )}
              </div>
              {i > 0 && (
                <AskFirst label="Show these numbers again" question="Put these numbers back on the dashboard?" yes="Yes, show them"
                  disabled={busy} onYes={() => onRestore(p)} className="btn btn-secondary btn-small" />
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
