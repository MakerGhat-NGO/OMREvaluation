// The schools at a session: added once each, taken off, and never lost when the box is left.
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Places } from '../../lib/api';
import { BatchDetails, NO_DETAILS } from '../../lib/ignite';
import DetailFields from './DetailFields';

const PLACES: Places = {
  places: [{ state_id: 's1', district: 'Nashik', block: 'Dindori', school: 'Hidden High' }], grades: [],
};

function Form({ seen }: { seen: (d: BatchDetails) => void }) {
  const [value, setValue] = useState<BatchDetails>({ ...NO_DETAILS, district: 'Nashik', block: 'Dindori' });
  return (
    <>
      <DetailFields value={value} places={PLACES} stateId="s1"
        onChange={patch => setValue(v => {
          const next = { ...v, ...patch };
          seen(next);
          return next;
        })} />
      <button type="button">Save</button>
    </>
  );
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
});

test('schools are added once each and can be taken off', () => {
  const seen = jest.fn();
  render(<Form seen={seen} />);
  const box = screen.getByRole('combobox', { name: /Schools at this session/ });
  fireEvent.change(box, { target: { value: 'ZPPS Sunderpur' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ schools: ['ZPPS Sunderpur'] }));
  expect(box).toHaveValue('');
  // The same school spelt another way is not added again.
  fireEvent.change(box, { target: { value: 'z.p.p.s. sunderpur' } });
  fireEvent.click(screen.getByRole('button', { name: /Add/ }));
  expect(seen).toHaveBeenCalledTimes(1);
  // A name from the list is added as soon as it is picked.
  fireEvent.click(box);
  fireEvent.click(screen.getByRole('option', { name: /Hidden High/ }));
  expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ schools: ['ZPPS Sunderpur', 'Hidden High'] }));
  fireEvent.click(screen.getByRole('button', { name: 'Take off ZPPS Sunderpur' }));
  expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ schools: ['Hidden High'] }));
  expect(screen.getAllByRole('listitem').map(li => li.textContent)).toEqual(['Hidden High']);
});

test('a name typed and not added is added when the box is left', () => {
  const seen = jest.fn();
  render(<Form seen={seen} />);
  const box = screen.getByRole('combobox', { name: /Schools at this session/ });
  fireEvent.change(box, { target: { value: 'New Hope School' } });
  fireEvent.blur(box, { relatedTarget: screen.getByRole('button', { name: 'Save' }) });
  expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ schools: ['New Hope School'] }));
});
