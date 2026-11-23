// The suggestion box: the list in the app's own look, with the keyboard and free typing.
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import SuggestBox, { matching } from './SuggestBox';

const BLOCKS = ['Chandwad', 'Dindori', 'Malegaon', 'Nandgaon', 'Niphad'];

function Box({ seen, start = '' }: { seen: (v: string) => void; start?: string }) {
  const [value, setValue] = useState(start);
  return (
    <SuggestBox label="Block" value={value} options={BLOCKS} placeholder="e.g. Malegaon"
      onChange={v => {
        setValue(v);
        seen(v);
      }} />
  );
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
});

test('names that start with what is typed come first, then names that hold it', () => {
  expect(matching(BLOCKS, 'n')).toEqual(['Nandgaon', 'Niphad', 'Chandwad', 'Dindori', 'Malegaon']);
  expect(matching(BLOCKS, ' DIN ')).toEqual(['Dindori']);
  expect(matching(BLOCKS, '')).toEqual(BLOCKS);
});

test('a click opens the whole list and a click on a name takes it', () => {
  const seen = jest.fn();
  render(<Box seen={seen} start="Niphad" />);
  const box = screen.getByLabelText('Block');
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.click(box);
  // Every name shows, the one in the box marked as chosen.
  expect(screen.getAllByRole('option')).toHaveLength(5);
  expect(screen.getByRole('option', { name: 'Niphad' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('option', { name: 'Dindori' }));
  expect(seen).toHaveBeenLastCalledWith('Dindori');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(box).toHaveValue('Dindori');
});

test('typing narrows the list, the arrow keys and Enter take a name, Escape closes it', () => {
  const seen = jest.fn();
  render(<Box seen={seen} />);
  const box = screen.getByLabelText('Block');
  fireEvent.change(box, { target: { value: 'n' } });
  expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['Nandgaon', 'Niphad', 'Chandwad', 'Dindori', 'Malegaon']);
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  expect(box).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Niphad' }).id);
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(seen).toHaveBeenLastCalledWith('Niphad');
  expect(box).toHaveAttribute('aria-expanded', 'false');

  fireEvent.keyDown(box, { key: 'ArrowDown' });
  expect(box).toHaveAttribute('aria-expanded', 'true');
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
});

test('a name that is not in the list can still be typed', () => {
  const seen = jest.fn();
  render(<Box seen={seen} />);
  fireEvent.change(screen.getByLabelText('Block'), { target: { value: 'Yeola' } });
  expect(seen).toHaveBeenLastCalledWith('Yeola');
  expect(screen.queryAllByRole('option')).toHaveLength(0);
  expect(screen.getByText('Not in the list. It is saved the way you type it.')).toBeInTheDocument();
});
