// IGNITE: the school details of a batch (district, block, schools, grade, day of the test), typed by
// the teacher. Each box suggests the names typed on earlier batches, so one school is spelt one way.
import { FocusEvent, useState } from 'react';
import { Places } from '../../lib/api';
import { addSchool, BatchDetails, blockCompleted, schoolKey, suggestionsFor, todayInIndia } from '../../lib/ignite';
import DayPicker from '../DayPicker';
import { IconClose, IconPlus } from '../Icons';
import SuggestBox from '../SuggestBox';
import { Notice } from '../ui';

/** The schools at this session: most tests are at a central place, with students from many schools
 *  (the team's answer 3). Each school is added once; a school spelt another way is the same school.
 *  A name typed and not yet added is added when the box is left, so it is never lost on Save. */
function SchoolsField({ value, options, disabled, className, onChange }: {
  value: string[];
  options: string[];
  disabled?: boolean;
  className?: string;
  onChange: (schools: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = (name: string) => {
    const next = addSchool(value, name);
    if (next !== value) onChange(next);
    setDraft('');
  };
  const left = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null) && draft.trim()) add(draft);
  };
  const notAdded = options.filter(o => !value.some(s => schoolKey(s) === schoolKey(o)));
  return (
    <div className={`flex min-w-0 flex-col gap-2.5 ${className || ''}`} onBlur={left}>
      <div className="flex items-end gap-2.5">
        <div className="min-w-0 flex-1">
          <SuggestBox label="Schools at this session" note="(add each school once)" value={draft} options={notAdded}
            placeholder="e.g. ZPPS Sunderpur" disabled={disabled} onChange={setDraft} onPick={add} onEnter={() => add(draft)} />
        </div>
        <button type="button" className="btn btn-secondary h-[52px] shrink-0" disabled={disabled || !draft.trim()}
          onClick={() => add(draft)}>
          <IconPlus size={18} /> Add
        </button>
      </div>
      {value.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Schools added">
          {value.map(name => (
            <li key={schoolKey(name)}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-white py-1 pl-3.5 pr-1 text-[15px] text-heading">
              <span className="min-w-0 break-words">{name}</span>
              <button type="button" disabled={disabled} aria-label={`Take off ${name}`}
                onClick={() => onChange(value.filter(s => s !== name))}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-coral-wash hover:text-brand disabled:hover:bg-transparent">
                <IconClose size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">No school added yet. Each school counts once for its block.</p>
      )}
    </div>
  );
}

export default function DetailFields({ value, onChange, places, stateId, disabled, oneColumn }: {
  value: BatchDetails;
  onChange: (patch: Partial<BatchDetails>) => void;
  /** Names typed on earlier batches; null while they load or when they could not be loaded. */
  places: Places | null;
  stateId: string;
  disabled?: boolean;
  /** In a narrow card (beside the sheet on the results screen) the boxes go one under the other. */
  oneColumn?: boolean;
}) {
  const suggest = suggestionsFor(places, stateId, value);
  // The team said no more papers come for a block marked Completed: the teacher is told at once,
  // and the admin sees the batch flagged on the review screen.
  const completed = blockCompleted(places, value.district, value.block);
  // Across both columns of the wide form; in the narrow card there is one column only (a span of 2
  // there would make a second, squeezed column).
  const wide = oneColumn ? undefined : 'md:col-span-2';
  return (
    <div className={oneColumn ? 'grid grid-cols-1 gap-3.5' : 'grid grid-cols-1 gap-4 md:grid-cols-2'}>
      <SuggestBox label="District" value={value.district} options={suggest.districts} placeholder="e.g. Nashik"
        disabled={disabled} onChange={district => onChange({ district })} />
      <SuggestBox label="Block" value={value.block} options={suggest.blocks} placeholder="e.g. Malegaon"
        disabled={disabled} onChange={block => onChange({ block })} />
      <div className={`grid grid-cols-2 gap-4 ${wide || ''}`}>
        <SuggestBox label="Grade" value={value.grade} options={suggest.grades} placeholder="e.g. 7" maxLength={50}
          disabled={disabled} onChange={grade => onChange({ grade })} />
        {/* A test cannot have been taken after today. The calendar opens leftwards: the box is at the card's right edge. */}
        <DayPicker label="Date of the test" value={value.assessed_on} max={todayInIndia()} disabled={disabled} alignRight
          onChange={assessed_on => onChange({ assessed_on })} />
      </div>
      <SchoolsField value={value.schools} options={suggest.schools} disabled={disabled} className={wide}
        onChange={schools => onChange({ schools })} />
      {completed && (
        <Notice tone="warn" className={wide}
          title={`${value.block.trim()} is marked Completed`}>
          No more papers were expected for this block. Check the block name. If these papers are late ones, carry on:
          the admin will see this batch flagged.
        </Notice>
      )}
    </div>
  );
}
