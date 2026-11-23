// A button that asks before it acts: pressing it shows the question with Yes and No in its place.
// For things that are hard to take back (taking a block off the dashboard, showing earlier numbers).
import { useState } from 'react';

export default function AskFirst({ label, question, yes, onYes, disabled, className = 'btn btn-quiet btn-small' }: {
  label: string;
  question: string;
  /** The words on the button that goes ahead, e.g. "Yes, remove it". */
  yes: string;
  onYes: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={className} disabled={disabled} onClick={() => setAsking(true)}>{label}</button>
    );
  }
  return (
    <span role="group" aria-label={question} className="inline-flex flex-wrap items-center gap-2">
      <span className="text-[15px] font-semibold leading-[22px] text-heading">{question}</span>
      <button type="button" className="btn btn-primary btn-small" disabled={disabled}
        onClick={() => {
          setAsking(false);
          onYes();
        }}>
        {yes}
      </button>
      <button type="button" className="btn btn-quiet btn-small" onClick={() => setAsking(false)}>No</button>
    </span>
  );
}
