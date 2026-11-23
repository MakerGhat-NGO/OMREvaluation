// A choice list (one of a few fixed answers) drawn in the app's own look: the box looks as before,
// and its list is the app's instead of the browser's, which cannot be styled. The keyboard works as
// on the browser's list: Enter, Space or an arrow opens it, the arrows move, Enter takes, Escape
// closes, and a letter jumps to the next choice that starts with it.
// With `plain` it is the browser's own list, exactly as the app had it before.
import classNames from 'classnames';
import { KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { IconCheck } from './Icons';

export interface Choice {
  value: string;
  label: string;
  /** Shown, but it cannot be picked. */
  disabled?: boolean;
}

export default function SelectBox({
  id, className = 'select', wrapClassName, value, options, placeholder, disabled, onChange, plain,
  'aria-label': ariaLabel, 'aria-describedby': ariaDescribedBy,
}: {
  id?: string;
  /** The look of the box: "select", or "select select-small". */
  className?: string;
  /** Where the box sits in its row: its width and how it stretches. */
  wrapClassName?: string;
  value: string;
  options: Choice[];
  /** What the box says while nothing is chosen ("Choose a state"). It is not a choice in the list. */
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  /** The browser's own list, as before. */
  plain?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
}) {
  const ownId = useId();
  const boxId = id || ownId;
  const listId = `${ownId}-list`;
  const wrap = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  /** The choice the arrow keys are on, as its place in the list; -1 for none. */
  const [active, setActive] = useState(-1);
  const chosen = options.findIndex(o => o.value === value);

  // Keep the choice the arrow keys are on in view, and the list itself when it opens near the bottom.
  useEffect(() => {
    if (!open) return;
    const el = active >= 0 ? list.current?.children[active] : list.current;
    (el as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  // A click anywhere else closes the list.
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  if (plain) {
    return (
      <select id={id} className={classNames(className, wrapClassName)} value={value} disabled={disabled}
        aria-label={ariaLabel} aria-describedby={ariaDescribedBy} onChange={e => onChange(e.target.value)}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map(o => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      </select>
    );
  }

  const openList = () => {
    setActive(chosen);
    setOpen(true);
  };
  const pick = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    setOpen(false);
    if (o.value !== value) onChange(o.value);
  };
  /** The next choice that can be picked, going up or down from `from`; `from` itself when there is none. */
  const step = (from: number, by: number) => {
    for (let i = from + by; i >= 0 && i < options.length; i += by) if (!options[i].disabled) return i;
    return from;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const { key } = e;
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      e.preventDefault();
      if (!open) openList();
      else if (key === 'ArrowDown') setActive(a => step(a, 1));
      else if (key === 'ArrowUp') setActive(a => (a < 0 ? step(options.length, -1) : step(a, -1)));
      else setActive(key === 'Home' ? step(-1, 1) : step(options.length, -1));
    } else if (key === 'Enter' || key === ' ') {
      e.preventDefault();
      if (!open) openList();
      else if (active >= 0) pick(active);
      else setOpen(false);
    } else if (key === 'Escape') {
      if (open) {
        // Only the list closes: not the screen the box is on.
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    } else if (key === 'Tab') {
      setOpen(false);
    } else if (key.length === 1) {
      // A letter jumps to the next choice that starts with it, as on the browser's list.
      const letter = key.toLowerCase();
      const from = open ? active : chosen;
      const order = options.map((_, i) => (from + 1 + i) % options.length);
      const hit = order.find(i => !options[i].disabled && options[i].label.toLowerCase().startsWith(letter));
      if (hit === undefined) return;
      e.preventDefault();
      if (open) setActive(hit);
      else pick(hit);
    }
  };

  return (
    <span ref={wrap} className={classNames('relative block min-w-0', wrapClassName)}>
      <button id={boxId} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
        aria-label={ariaLabel} aria-describedby={ariaDescribedBy} disabled={disabled}
        aria-activedescendant={open && active >= 0 ? `${ownId}-o${active}` : undefined}
        onClick={() => (open ? setOpen(false) : openList())} onKeyDown={onKeyDown}
        className={classNames(className, 'text-left', open && 'border-coral-dark')}>
        <span className={classNames('block truncate', chosen < 0 && 'text-muted')}>
          {chosen >= 0 ? options[chosen].label : placeholder || ' '}
        </span>
      </button>
      {open && (
        // preventDefault on a click: inside a <label>, a click would otherwise press the box again.
        <span ref={list} id={listId} role="listbox" onClick={e => e.preventDefault()}
          className="absolute left-0 top-[calc(100%+6px)] z-30 block max-h-[272px] w-max min-w-full max-w-[min(26rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-[14px] border-2 border-line bg-white p-1.5 text-left font-normal shadow-[0_12px_28px_-8px_rgba(63,43,18,0.28)]">
          {options.map((o, i) => {
            const isChosen = i === chosen;
            return (
              <span key={o.value} id={`${ownId}-o${i}`} role="option" aria-selected={isChosen} aria-disabled={o.disabled || undefined}
                // Keeps the keyboard on the box while a choice is clicked.
                onMouseDown={e => e.preventDefault()} onClick={() => pick(i)}
                onMouseEnter={() => {
                  if (!o.disabled) setActive(i);
                }}
                className={classNames(
                  'flex min-h-[44px] items-center justify-between gap-3 rounded-[10px] px-3 py-1.5 text-[17px] leading-6',
                  o.disabled ? 'cursor-not-allowed text-muted' : 'cursor-pointer',
                  !o.disabled && (i === active ? 'bg-coral-wash text-heading' : 'text-ink'),
                  isChosen && 'font-semibold text-heading',
                )}>
                <span className="min-w-0 break-words">{o.label}</span>
                {isChosen && <IconCheck size={18} className="shrink-0 text-brand" />}
              </span>
            );
          })}
          {options.length === 0 && (
            <span className="block px-3 py-2.5 text-[15px] leading-[22px] text-muted">{placeholder || 'Nothing to choose yet.'}</span>
          )}
        </span>
      )}
    </span>
  );
}
