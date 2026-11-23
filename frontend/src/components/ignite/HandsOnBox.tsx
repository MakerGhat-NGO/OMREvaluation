// IGNITE: the hands-on activity score of one student, typed beside their row in the results list.
// It saves when the teacher leaves the box or presses Enter, so a class can be typed in one go.
import classNames from 'classnames';
import { useState } from 'react';
import { api, ApiError, Sheet } from '../../lib/api';
import { fmtScore } from '../../lib/format';

const asText = (score: number | null | undefined) => (score == null ? '' : String(score));

export default function HandsOnBox({ sheet, max, who, onSaved }: {
  sheet: Sheet;
  /** The most a student can score. */
  max: number;
  /** The student's name (or file), for screen readers. */
  who: string;
  onSaved: (sheet: Sheet) => void;
}) {
  const saved = asText(sheet.hands_on_score);
  const [value, setValue] = useState(saved);
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);

  // The score can also be typed in the sheet viewer: when the saved score changes, show it. Done
  // while rendering, not in an effect, so it can never run late and wipe what is being typed.
  const [shownFor, setShownFor] = useState(saved);
  if (shownFor !== saved) {
    setShownFor(saved);
    setValue(saved);
    setProblem('');
  }

  const save = async () => {
    const typed = value.trim();
    if (typed === saved) return;
    const marks = Number(typed);
    if (typed !== '' && (Number.isNaN(marks) || marks < 0 || marks > max)) {
      setProblem(`Type a number from 0 to ${fmtScore(max)}.`);
      return;
    }
    setSaving(true);
    setProblem('');
    try {
      onSaved(await api.patch<Sheet>(`/api/sheets/${sheet.id}`, { hands_on_score: typed === '' ? null : marks }));
    } catch (e) {
      setProblem(e instanceof ApiError && e.status < 500 && e.status !== 401 ? `${e.message}.` : 'Not saved. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className="flex w-[100px] shrink-0 flex-col justify-center gap-1">
      {/* Says what the box is for. Screen readers get the fuller label on the box itself. */}
      <span aria-hidden="true" className="flex flex-col text-center text-[13px] leading-4 text-muted">
        <span className="font-semibold">Activity score</span>
        <span>out of {fmtScore(max)}</span>
      </span>
      <input type="text" inputMode="decimal" maxLength={6} autoComplete="off" value={value} disabled={saving}
        aria-label={`Hands-on score of ${who}, out of ${fmtScore(max)}`} aria-invalid={problem ? true : undefined}
        title={problem || `The mark for the hands-on activity, out of ${fmtScore(max)}`} placeholder={`0 to ${fmtScore(max)}`}
        className={classNames('input h-11 px-2 text-center placeholder:text-[13px]', problem && 'border-danger')}
        onChange={e => setValue(e.target.value)} onBlur={save}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          }
        }} />
      {problem && <span role="alert" className="text-[12px] leading-4 text-danger">{problem}</span>}
    </span>
  );
}
