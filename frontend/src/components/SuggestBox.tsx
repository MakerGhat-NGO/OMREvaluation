// A text box that suggests names from a list, drawn in the app's own look (the browser's own list
// cannot be styled). Anything can still be typed: the list only helps to spell a name the way it
// was spelt before. Arrow keys move through the list, Enter takes a name, Escape closes it.
import classNames from 'classnames';
import { KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { IconCheck, IconChevronDown } from './Icons';

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The names to show for what is typed: the ones that start with it first, then the ones that hold it. */
export function matching(options: string[], typed: string): string[] {
  const t = typed.trim().toLowerCase();
  if (!t) return options;
  const starts = options.filter(o => o.toLowerCase().startsWith(t));
  const holds = options.filter(o => !o.toLowerCase().startsWith(t) && o.toLowerCase().includes(t));
  return starts.concat(holds);
}

export default function SuggestBox({ label, note, value, options, placeholder, maxLength = 200, disabled, onChange, onPick,
  onEnter }: {
  label: string;
  note?: string;
  value: string;
  /** The names to suggest. */
  options: string[];
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  onChange: (value: string) => void;
  /** Called, in place of onChange, when a name is taken from the list (a box that adds to a list). */
  onPick?: (name: string) => void;
  /** Called when Enter is pressed while no name of the list is chosen. */
  onEnter?: () => void;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  // The whole list shows when it is opened; it narrows only once the teacher types.
  const [typing, setTyping] = useState(false);
  /** The name the arrow keys are on, as its place in the list; -1 for none. */
  const [active, setActive] = useState(-1);

  const shown = useMemo(() => (typing ? matching(options, value) : options), [options, value, typing]);
  const showing = open && !disabled && options.length > 0;

  const close = () => {
    setOpen(false);
    setTyping(false);
    setActive(-1);
  };
  const openList = () => {
    setOpen(true);
    setActive(options.findIndex(o => same(o, value)));
  };
  const pick = (name: string) => {
    if (onPick) onPick(name);
    else onChange(name);
    close();
  };

  // Keep the name the arrow keys are on in view, and the list itself when it opens near the bottom.
  useEffect(() => {
    if (!showing) return;
    const el = active >= 0 ? list.current?.children[active] : list.current;
    (el as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' });
  }, [showing, active]);

  // A click anywhere else closes the list.
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (options.length === 0) return;
      e.preventDefault();
      if (!showing) {
        openList();
        return;
      }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive(a => Math.min(Math.max(a + step, 0), shown.length - 1));
    } else if (e.key === 'Enter') {
      if (showing && active >= 0 && shown[active]) {
        e.preventDefault();
        pick(shown[active]);
      } else if (onEnter) {
        e.preventDefault();
        close();
        onEnter();
      }
    } else if (e.key === 'Escape') {
      if (showing) {
        // Only the list closes: not the screen the box is on.
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    } else if (e.key === 'Tab') {
      close();
    }
  };

  return (
    <div className="field min-w-0">
      <label htmlFor={id}>{label}{note && <span className="field-note"> {note}</span>}</label>
      <div ref={wrap} className="relative">
        <input id={id} className={classNames('input', options.length > 0 && 'pr-14')} type="text" value={value}
          maxLength={maxLength} autoComplete="off" placeholder={placeholder} disabled={disabled}
          role="combobox" aria-expanded={showing} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={showing && active >= 0 ? `${id}-o${active}` : undefined}
          onChange={e => {
            onChange(e.target.value);
            setTyping(true);
            setOpen(true);
            setActive(-1);
          }}
          onClick={() => {
            if (!open) openList();
          }}
          onKeyDown={onKeyDown} />
        {options.length > 0 && (
          // Not a tab stop: the arrow keys open the list from the box itself.
          <button type="button" tabIndex={-1} disabled={disabled} aria-label={`${showing ? 'Hide' : 'Show'} the list for ${label}`}
            onMouseDown={e => e.preventDefault()}
            onClick={() => {
              if (showing) close();
              else {
                openList();
                (wrap.current?.querySelector('input') as HTMLInputElement | null)?.focus();
              }
            }}
            className="absolute right-2 top-1/2 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-brand hover:bg-coral-wash disabled:text-muted disabled:hover:bg-transparent">
            <IconChevronDown size={22} className={classNames('transition-transform', showing && 'rotate-180')} />
          </button>
        )}
        {showing && (
          <ul ref={list} id={listId} role="listbox" aria-label={`Names for ${label}`}
            className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 m-0 max-h-[272px] list-none overflow-y-auto overscroll-contain rounded-[14px] border-2 border-line bg-white p-1.5 font-normal shadow-[0_12px_28px_-8px_rgba(63,43,18,0.28)]">
            {shown.map((name, i) => {
              const chosen = same(name, value);
              return (
                <li key={name} id={`${id}-o${i}`} role="option" aria-selected={chosen}
                  // Keeps the cursor in the box while a name is clicked.
                  onMouseDown={e => e.preventDefault()} onClick={() => pick(name)} onMouseEnter={() => setActive(i)}
                  className={classNames(
                    'flex min-h-[44px] cursor-pointer items-center justify-between gap-3 rounded-[10px] px-3 py-1.5 text-[17px] leading-6',
                    i === active ? 'bg-coral-wash text-heading' : 'text-ink',
                    chosen && 'font-semibold text-heading',
                  )}>
                  <span className="min-w-0 break-words">{name}</span>
                  {chosen && <IconCheck size={18} className="shrink-0 text-brand" />}
                </li>
              );
            })}
            {shown.length === 0 && (
              <li role="presentation" className="px-3 py-2.5 text-[15px] leading-[22px] text-muted">
                Not in the list. It is saved the way you type it.
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
