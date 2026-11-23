// The choice list: the app's own list, the keyboard, and the browser's list when the new look is off.
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import SelectBox, { Choice } from './SelectBox';

const BATCHES: Choice[] = [
  { value: 'b1', label: 'Class 7A (3 sheets)' },
  { value: 'b2', label: 'Class 7B (submitted)', disabled: true },
  { value: 'b3', label: 'Girls High School' },
];

function Box({ seen, start = '', plain, options = BATCHES }: {
  seen: (v: string) => void; start?: string; plain?: boolean; options?: Choice[];
}) {
  const [value, setValue] = useState(start);
  return (
    <div className="field">
      <label htmlFor="batch">Batch</label>
      <SelectBox id="batch" value={value} options={options} placeholder="Choose a batch" plain={plain}
        onChange={v => {
          setValue(v);
          seen(v);
        }} />
    </div>
  );
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
});

test('the box says what is chosen, opens its list on a click and takes a choice', () => {
  const seen = jest.fn();
  render(<Box seen={seen} />);
  const box = screen.getByLabelText('Batch');
  expect(box).toHaveTextContent('Choose a batch');
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.click(box);
  // The words shown while nothing is chosen are not a choice.
  expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(BATCHES.map(b => b.label));
  fireEvent.click(screen.getByRole('option', { name: 'Girls High School' }));
  expect(seen).toHaveBeenLastCalledWith('b3');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(box).toHaveTextContent('Girls High School');

  // The chosen one is ticked; choosing it again changes nothing.
  fireEvent.click(box);
  expect(screen.getByRole('option', { name: 'Girls High School' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('option', { name: 'Girls High School' }));
  expect(seen).toHaveBeenCalledTimes(1);
});

test('a choice that is switched off cannot be taken, by mouse or by keyboard', () => {
  const seen = jest.fn();
  render(<Box seen={seen} start="b1" />);
  const box = screen.getByLabelText('Batch');
  fireEvent.click(box);
  fireEvent.click(screen.getByRole('option', { name: 'Class 7B (submitted)' }));
  expect(seen).not.toHaveBeenCalled();
  expect(screen.getByRole('listbox')).toBeInTheDocument();
  // The arrow steps over it.
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  expect(box).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Girls High School' }).id);
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(seen).toHaveBeenLastCalledWith('b3');
});

test('the keyboard opens, moves, jumps to a letter and closes', () => {
  const seen = jest.fn();
  render(<Box seen={seen} start="b3" />);
  const box = screen.getByLabelText('Batch');
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  expect(box).toHaveAttribute('aria-expanded', 'true');
  fireEvent.keyDown(box, { key: 'Home' });
  expect(box).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Class 7A (3 sheets)' }).id);
  fireEvent.keyDown(box, { key: 'g' });
  expect(box).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Girls High School' }).id);
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(seen).not.toHaveBeenCalled();
  // Closed, a letter takes the next choice that starts with it.
  fireEvent.keyDown(box, { key: 'c' });
  expect(seen).toHaveBeenLastCalledWith('b1');
});

test('with nothing to choose, the list says so', () => {
  render(<Box seen={jest.fn()} options={[]} />);
  fireEvent.click(screen.getByLabelText('Batch'));
  expect(screen.getByRole('listbox')).toHaveTextContent('Choose a batch');
  expect(screen.queryAllByRole('option')).toHaveLength(0);
});

test('plain: the browser\'s own list, as the app had it before', () => {
  const seen = jest.fn();
  render(<Box seen={seen} plain />);
  const select = screen.getByLabelText('Batch') as HTMLSelectElement;
  expect(select.tagName).toBe('SELECT');
  expect(Array.from(select.options).map(o => o.textContent)).toEqual(['Choose a batch', ...BATCHES.map(b => b.label)]);
  expect(select.options[2].disabled).toBe(true);
  fireEvent.change(select, { target: { value: 'b3' } });
  expect(seen).toHaveBeenLastCalledWith('b3');
});
