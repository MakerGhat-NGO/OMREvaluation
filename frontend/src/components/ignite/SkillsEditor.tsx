// IGNITE: for one answer key, which skill each question tests, and whether students also get a
// hands-on activity score. Only admins see it. A skill is a name and its question numbers
// ("3, 8-10, 12"), which is how the team's own answer key sheet lists them.
import { useState } from 'react';
import { api, ApiError, Test } from '../../lib/api';
import { capitalise, fmtScore, plural } from '../../lib/format';
import { IconPlus, IconTrash } from '../Icons';
import { Notice } from '../ui';

interface Row { name: string; questions: string; }

/** "6 skills · activity score out of 5", for the button under an answer key. */
export function skillsSummary(test: Test): string {
  const skills = new Set(Object.values(test.skill_map || {})).size;
  const parts = [skills ? plural(skills, 'skill') : 'no skills yet'];
  parts.push(test.hands_on_max == null ? 'no activity score'
    : `activity score out of ${fmtScore(test.hands_on_max)}`
      + (test.hands_on_pass != null ? `, pass mark ${fmtScore(test.hands_on_pass)}` : ''));
  return parts.join(' · ');
}

/** The skills of a key as rows, in the order of their first question. */
function rowsOf(test: Test): Row[] {
  const bySkill = new Map<string, number[]>();
  for (let n = 1; n <= test.question_count; n++) {
    const skill = test.skill_map?.[`q${n}`];
    if (skill) bySkill.set(skill, (bySkill.get(skill) || []).concat(n));
  }
  const rows = Array.from(bySkill.entries()).map(([name, numbers]) => ({ name, questions: numbers.join(', ') }));
  return rows.length ? rows : [{ name: '', questions: '' }];
}

/** "3, 8-10, 12" as [3, 8, 9, 10, 12]; null when something in it is not a question number. */
export function parseQuestions(text: string, questionCount: number): number[] | null {
  const numbers: number[] = [];
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) return null;
    const from = Number(range[1]);
    const to = range[2] ? Number(range[2]) : from;
    if (from < 1 || to > questionCount || from > to) return null;
    for (let n = from; n <= to; n++) numbers.push(n);
  }
  return numbers;
}

/** The rows as the map the server keeps, or a sentence saying what is wrong with them. */
export function skillMapOf(rows: Row[], questionCount: number): { map: Record<string, string> } | { problem: string } {
  const map: Record<string, string> = {};
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.name.replace(/\s+/g, ' ').trim();
    if (!name && !row.questions.trim()) continue;
    if (!name) return { problem: 'Give every skill a name.' };
    if (names.has(name.toLowerCase())) return { problem: `"${name}" is there twice. Put its questions in one row.` };
    names.add(name.toLowerCase());
    const numbers = parseQuestions(row.questions, questionCount);
    if (!numbers) return { problem: `The questions of "${name}" must be numbers from 1 to ${questionCount}, like 3, 8-10, 12.` };
    if (numbers.length === 0) return { problem: `"${name}" has no questions yet.` };
    for (const n of numbers) {
      if (map[`q${n}`] && map[`q${n}`] !== name) return { problem: `Question ${n} is in two skills: "${map[`q${n}`]}" and "${name}".` };
      map[`q${n}`] = name;
    }
  }
  return { map };
}

export default function SkillsEditor({ test, onSaved, onCancel }: {
  test: Test;
  onSaved: (test: Test) => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => rowsOf(test));
  const [handsOn, setHandsOn] = useState(test.hands_on_max != null);
  const [handsOnMax, setHandsOnMax] = useState(test.hands_on_max != null ? String(test.hands_on_max) : '5');
  // A new activity score starts with the team's pass mark, 3 of 5 (the call on 25 November).
  const [handsOnPass, setHandsOnPass] = useState(test.hands_on_pass != null ? String(test.hands_on_pass)
    : test.hands_on_max == null ? '3' : '');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');

  const setRow = (i: number, patch: Partial<Row>) => setRows(list => list.map((r, at) => (at === i ? { ...r, ...patch } : r)));
  const result = skillMapOf(rows, test.question_count);
  const withSkill = 'map' in result ? Object.keys(result.map).length : 0;
  const without: number[] = [];
  if ('map' in result) {
    for (let n = 1; n <= test.question_count; n++) if (!result.map[`q${n}`]) without.push(n);
  }

  const save = async () => {
    if ('problem' in result) {
      setProblem(result.problem);
      return;
    }
    const most = Number(handsOnMax);
    if (handsOn && (handsOnMax.trim() === '' || Number.isNaN(most) || most <= 0)) {
      setProblem('The hands-on score must be out of a number more than 0.');
      return;
    }
    const least = Number(handsOnPass);
    if (handsOn && handsOnPass.trim() !== '' && (Number.isNaN(least) || least <= 0 || least > most)) {
      setProblem(`The pass mark must be more than 0 and at most ${fmtScore(most)}, or left empty.`);
      return;
    }
    setSaving(true);
    setProblem('');
    try {
      onSaved(await api.put<Test>(`/api/tests/${test.id}/ignite`, {
        skill_map: result.map, hands_on_max: handsOn ? most : null,
        hands_on_pass: handsOn && handsOnPass.trim() !== '' ? least : null,
      }));
    } catch (e) {
      const said = e instanceof ApiError && e.status < 500 && e.status !== 401 ? capitalise(e.message) : '';
      setProblem(said ? `${said}.` : 'It could not be saved. Check your internet connection and try again.');
      setSaving(false);
    }
  };

  return (
    <section aria-label={`Skills and activity score of ${test.name}`} className="card mt-2 flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="section-title [overflow-wrap:anywhere]">Skills and activity score, for the dashboard</h2>
        <p className="hint">
          {test.name}, {plural(test.question_count, 'question')}. The IGNITE dashboard shows a score for each skill and
          for the hands-on activity. Here you say what they are for this test.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="m-0 font-sans text-[17px] font-semibold leading-7 text-ink">Skills</h3>
        <p className="hint">
          A skill is a group of questions that test the same thing, like “Logical thinking”. Each question belongs to
          one skill. Write the question numbers with commas, like 3, 8-10, 12.
        </p>
      </div>

      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {rows.map((row, i) => (
          <li key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-end">
            <label className="field min-w-0">
              <span className={i > 0 ? 'sm:sr-only' : undefined}>Skill</span>
              <input className="input" type="text" maxLength={80} autoComplete="off" value={row.name} disabled={saving}
                placeholder="e.g. Logical thinking" onChange={e => setRow(i, { name: e.target.value })} />
            </label>
            <label className="field min-w-0">
              <span className={i > 0 ? 'sm:sr-only' : undefined}>Questions</span>
              <input className="input" type="text" inputMode="text" autoComplete="off" value={row.questions} disabled={saving}
                placeholder="e.g. 3, 8-10, 12" onChange={e => setRow(i, { questions: e.target.value })} />
            </label>
            <button type="button" aria-label={`Remove ${row.name || 'this skill'}`} disabled={saving}
              className="btn btn-quiet h-[52px] w-[52px] shrink-0 justify-self-start px-0 text-danger"
              onClick={() => setRows(list => (list.length > 1 ? list.filter((_, at) => at !== i) : [{ name: '', questions: '' }]))}>
              <IconTrash />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn-secondary btn-small self-start" disabled={saving}
        onClick={() => setRows(list => list.concat({ name: '', questions: '' }))}>
        <IconPlus size={20} />
        Add a skill
      </button>
      {'map' in result && (
        <p className="hint" aria-live="polite">
          {withSkill} of {plural(test.question_count, 'question')} {withSkill === 1 ? 'has' : 'have'} a skill.
          {without.length > 0 && without.length <= 20 && ` Without one: ${without.join(', ')}.`}
        </p>
      )}

      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <div className="flex flex-col gap-1">
          <h3 className="m-0 font-sans text-[17px] font-semibold leading-7 text-ink">Hands-on activity score</h3>
          <p className="hint">
            The mark a teacher gives each student for the hands-on activity. It is not on the answer sheet: the teacher
            types it beside each student in Results.
          </p>
        </div>
        <label className="flex min-h-[44px] items-center gap-3 text-base font-semibold text-ink">
          <input type="checkbox" className="h-6 w-6 shrink-0 accent-brand" checked={handsOn} disabled={saving}
            onChange={e => setHandsOn(e.target.checked)} />
          Students also get a hands-on activity score
        </label>
        {handsOn && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:max-w-[700px]">
            <label className="field min-w-0">
              <span>Out of <span className="field-note">(the most one student can score)</span></span>
              <input className="input" type="text" inputMode="decimal" maxLength={6} autoComplete="off" value={handsOnMax}
                disabled={saving} onChange={e => setHandsOnMax(e.target.value)} />
            </label>
            <label className="field min-w-0">
              <span>Pass mark <span className="field-note">(the least score to write the test; may be empty)</span></span>
              <input className="input" type="text" inputMode="decimal" maxLength={6} autoComplete="off" value={handsOnPass}
                disabled={saving} placeholder="e.g. 3" onChange={e => setHandsOnPass(e.target.value)} />
            </label>
          </div>
        )}
      </div>

      {problem && <Notice tone="error">{problem}</Notice>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn-quiet" disabled={saving} onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
