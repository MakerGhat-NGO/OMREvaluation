// The date box with its own calendar.
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { dayText, todayInIndia } from '../lib/ignite';
import DayPicker, { addDays, isoDay, monthGrid } from './DayPicker';

function Box({ seen, start = '', max }: { seen: (v: string) => void; start?: string; max?: string }) {
  const [value, setValue] = useState(start);
  return (
    <DayPicker label="Date of the test" value={value} max={max}
      onChange={v => {
        setValue(v);
        seen(v);
      }} />
  );
}

test('a month is laid out Monday first', () => {
  // November 2026 starts on a Sunday and has 30 days.
  const rows = monthGrid(2026, 10);
  expect(rows[0]).toEqual([null, null, null, null, null, null, 1]);
  expect(rows[1]).toEqual([2, 3, 4, 5, 6, 7, 8]);
  expect(rows[rows.length - 1]).toEqual([30, null, null, null, null, null, null]);
  expect(isoDay(2026, 0, 5)).toBe('2026-01-05');
  expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
});

test('the box shows the day in words and the calendar opens on its month', () => {
  const seen = jest.fn();
  render(<Box seen={seen} start="2026-11-02" max="2026-11-10" />);
  const box = screen.getByLabelText('Date of the test');
  expect(box).toHaveTextContent('2 Nov 2026');
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(box);
  expect(screen.getByRole('dialog', { name: 'Date of the test: pick a day' })).toBeInTheDocument();
  expect(screen.getByText('November 2026')).toBeInTheDocument();
  // A day after the last one allowed cannot be picked, and the month after cannot be opened.
  expect(screen.getByRole('button', { name: dayText('2026-11-11') })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Month after' })).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: dayText('2026-11-05') }));
  expect(seen).toHaveBeenLastCalledWith('2026-11-05');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(box).toHaveTextContent('5 Nov 2026');
});

test('the keyboard moves through days and months, and Escape closes the calendar', () => {
  const seen = jest.fn();
  render(<Box seen={seen} start="2026-11-02" />);
  fireEvent.click(screen.getByLabelText('Date of the test'));
  const day = (iso: string) => screen.getByRole('button', { name: dayText(iso) });
  expect(day('2026-11-02')).toHaveFocus();
  fireEvent.keyDown(day('2026-11-02'), { key: 'ArrowDown' });
  expect(day('2026-11-09')).toHaveFocus();
  fireEvent.keyDown(day('2026-11-09'), { key: 'ArrowLeft' });
  expect(day('2026-11-08')).toHaveFocus();
  fireEvent.keyDown(day('2026-11-08'), { key: 'PageUp' });
  expect(screen.getByText('October 2026')).toBeInTheDocument();
  expect(day('2026-10-08')).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Month before' }));
  expect(screen.getByText('September 2026')).toBeInTheDocument();
  fireEvent.keyDown(day('2026-09-08'), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(seen).not.toHaveBeenCalled();
});

test('Today and Clear', () => {
  const seen = jest.fn();
  render(<Box seen={seen} />);
  const box = screen.getByLabelText('Date of the test');
  expect(box).toHaveTextContent('Pick a day');
  fireEvent.click(box);
  expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  expect(seen).toHaveBeenLastCalledWith(todayInIndia());
  fireEvent.click(box);
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  expect(seen).toHaveBeenLastCalledWith('');
  expect(box).toHaveTextContent('Pick a day');
});
