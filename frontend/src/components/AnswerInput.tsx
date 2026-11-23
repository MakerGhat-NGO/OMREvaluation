// One question of an answer key: its number and one round button per letter, like a row of the
// printed sheet. Tapping the chosen letter again clears it. Where several answers are allowed, the
// "+" at the end of the row lets more than one letter be chosen, with the rule under the row: any
// one of them is right, or all of them must be filled.
import classNames from 'classnames';
import { memo, useState } from 'react';
import { ANY_ONE, anyOneIsRight, keyLetters } from '../lib/sheets';

interface AnswerInputProps {
  /** The question number, from 1. */
  number: number;
  /** The letters a student can fill, e.g. "ABCDE". */
  options: string;
  /** The right answer as the key keeps it: "B", "BC" (both must be filled), "B/C" (either one is
   *  right), or '' when none is chosen yet. */
  value: string;
  /** Marks the row as still needing an answer (after someone tried to save). */
  missing?: boolean;
  /** Shows the "+" that lets a question have more than one right answer. */
  allowSeveral?: boolean;
  /** Called with the answer to keep, or '' to clear the question. */
  onChange: (number: number, value: string) => void;
}

const ROUND = 'inline-flex aspect-square min-h-[44px] w-11 min-w-0 shrink touch-manipulation items-center justify-center '
  + 'rounded-full border-2 p-0 text-base font-bold leading-none transition-colors';
const RULES: { anyOne: boolean; label: string }[] = [
  { anyOne: true, label: 'Any one is right' },
  { anyOne: false, label: 'All must be filled' },
];

function AnswerInput({ number, options, value, missing = false, allowSeveral = false, onChange }: AnswerInputProps) {
  const letters = keyLetters(value);
  // The row takes several letters once "+" is pressed, and always when the key already has several.
  const [opened, setOpened] = useState(false);
  const several = opened || letters.length > 1;
  // The rule is kept here too, so it stays as chosen while only one letter is picked.
  const [anyOne, setAnyOne] = useState(letters.length > 1 ? anyOneIsRight(value) : true);
  const rule = letters.length > 1 ? anyOneIsRight(value) : anyOne;

  /** The letters in the order of the sheet, written with the rule. */
  const written = (picked: string, any: boolean) => {
    const ordered = options.split('').filter(o => picked.includes(o));
    return ordered.join(any && ordered.length > 1 ? ANY_ONE : '');
  };
  const tap = (letter: string) => {
    if (!several) onChange(number, value === letter ? '' : letter);
    else onChange(number, written(letters.includes(letter) ? letters.replace(letter, '') : letters + letter, rule));
  };
  const toggleSeveral = () => {
    // Back to one answer: the first of the chosen letters stays.
    if (several && letters.length > 1) onChange(number, letters[0]);
    setOpened(!several);
  };
  const chooseRule = (any: boolean) => {
    setAnyOne(any);
    if (letters.length > 1) onChange(number, written(letters, any));
  };

  return (
    // The row never splits between two columns of the answer grid.
    <div role="group" aria-label={missing ? `Question ${number}, no answer yet` : `Question ${number}`}
      className={classNames('break-inside-avoid rounded-xl py-1', missing && 'bg-sun-wash')}>
      <div className="flex items-center gap-1.5">
        <span aria-hidden="true"
          className={classNames('w-8 shrink-0 text-right font-semibold', missing ? 'text-sun-ink' : 'text-muted')}>
          {number}.
        </span>
        {options.split('').map(letter => {
          const chosen = several ? letters.includes(letter) : value === letter;
          return (
            <button key={letter} type="button" data-q={number} data-letter={letter}
              aria-pressed={chosen} aria-label={`Question ${number}: ${letter}`}
              onClick={() => tap(letter)}
              // 44 px circles. In a column narrower than a phone they may narrow a little rather than spill out.
              className={classNames(ROUND,
                chosen ? 'border-heading bg-coral text-heading' : 'border-line bg-ivory text-muted hover:border-heading')}>
              {letter}
            </button>
          );
        })}
        {(allowSeveral || several) && (
          <button type="button" aria-pressed={several} aria-label={`Question ${number}: more than one right answer`}
            title="More than one right answer" onClick={toggleSeveral}
            className={classNames(ROUND, 'border-dashed',
              several ? 'border-brand bg-coral-wash text-brand-dark' : 'border-line bg-white text-muted hover:border-brand hover:text-brand')}>
            {several ? '×' : '+'}
          </button>
        )}
      </div>
      {several && (
        <div role="group" aria-label={`Question ${number}: how it is marked`} className="flex flex-wrap gap-1.5 pb-1 pl-[2.375rem] pt-1.5">
          {RULES.map(r => (
            <button key={r.label} type="button" aria-pressed={rule === r.anyOne} onClick={() => chooseRule(r.anyOne)}
              className={classNames('min-h-[36px] rounded-full border-2 px-3 text-[14px] font-semibold leading-none transition-colors',
                rule === r.anyOne ? 'border-heading bg-coral-wash text-heading' : 'border-line bg-white text-muted hover:border-heading')}>
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(AnswerInput);
