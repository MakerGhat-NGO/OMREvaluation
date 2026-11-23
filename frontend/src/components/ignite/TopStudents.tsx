// IGNITE: marking the top students of a district. The scanned students are listed best score first,
// with their names: this list is for admins and stays in the app. The dashboard gets a marked student
// as gender, block, score and skills only.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { fmtScore, plural, titleCase } from '../../lib/format';
import { IgniteDistrict, marksText, problemText, shareCount, TopList, TopStudent } from '../../lib/igniteData';
import { Chip, Notice, Skeleton, SkeletonScreen } from '../ui';

const FIRST = 40;   // students shown before "Show all"

export default function TopStudents({ district, onChanged }: {
  district: IgniteDistrict;
  /** A mark was saved: the numbers on the page are out of date. */
  onChanged: () => void;
}) {
  const [list, setList] = useState<TopList | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  const [all, setAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get<TopList>(`/api/ignite/top?district_id=${encodeURIComponent(district.id)}`)
      .then(found => {
        if (!cancelled) setList(found);
      })
      .catch(e => {
        if (!cancelled) setError(`The students could not be loaded. ${problemText(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [district.id]);

  const mark = async (s: TopStudent, body: { top5?: boolean; top1?: boolean }) => {
    setSaving(s.id);
    setError('');
    try {
      const saved = await api.put<{ id: string; top5: boolean; top1: boolean }>(`/api/ignite/top/${s.id}`, body);
      setList(l => l && { ...l, students: l.students.map(x => (x.id === saved.id ? { ...x, top5: saved.top5, top1: saved.top1 } : x)) });
      onChanged();
    } catch (e) {
      setError(`The mark was not saved. ${problemText(e)}`);
    } finally {
      setSaving('');
    }
  };

  const students = list?.students || [];
  const shown = all ? students : students.slice(0, FIRST);
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-ivory p-4 md:p-5">
      <h3 className="section-label">Top students of {district.name}</h3>
      {error && <Notice tone="error" onClose={() => setError('')}>{error}</Notice>}
      {!list ? (
        !error && (
          <SkeletonScreen label="Loading the students…" className="flex flex-col gap-2.5">
            {[0, 1, 2].map(i => <Skeleton key={i} className="h-[68px] w-full rounded-2xl" />)}
          </SkeletonScreen>
        )
      ) : (
        <>
          {list.imported > 0 && (
            <p className="hint">
              {plural(list.imported, 'top student')} came from the team&apos;s sheet, {list.imported_top1} of them in the top 1%.
              They stay on the dashboard.
            </p>
          )}
          {students.length === 0 ? (
            <p className="hint">No scanned students in this district yet. They show here once a teacher submits a batch.</p>
          ) : (
            <>
              <p className="hint">
                {plural(students.length, 'scanned student')}, best score first. 5% of them is {shareCount(students.length, 0.05)} and
                1% is {shareCount(students.length, 0.01)}. Marked now: {students.filter(s => s.top5).length} in the top 5%,{' '}
                {students.filter(s => s.top1).length} in the top 1%. The dashboard never shows a name or a school.
              </p>
              <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
                {shown.map((s, i) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3">
                    <div className="min-w-0 flex-[1_1_240px]">
                      <p className="m-0 break-words font-semibold text-heading">
                        {i + 1}. {titleCase(s.name) || 'No name read'}
                      </p>
                      <p className="hint">
                        {[marksText(s, fmtScore), s.block, s.school,
                          s.gender === 'F' ? 'Girl' : s.gender === 'M' ? 'Boy' : ''].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Chip pressed={s.top5} onClick={() => saving || mark(s, { top5: !s.top5 })}>
                        Top 5%<span className="sr-only">: {titleCase(s.name)}</span>
                      </Chip>
                      <Chip pressed={s.top1} onClick={() => saving || mark(s, { top1: !s.top1 })}>
                        Top 1%<span className="sr-only">: {titleCase(s.name)}</span>
                      </Chip>
                    </div>
                  </li>
                ))}
              </ol>
              {!all && students.length > FIRST && (
                <button type="button" className="btn btn-secondary btn-small self-start" onClick={() => setAll(true)}>
                  Show all {students.length} students
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
