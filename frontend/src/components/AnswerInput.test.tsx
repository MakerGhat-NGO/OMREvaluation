// One row of an answer key: one right answer as always, or several with a rule.
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import AnswerInput from './AnswerInput';

/** The row with the answer kept the way the key editor keeps it. */
function Row({ start = '', allowSeveral = true, seen }: { start?: string; allowSeveral?: boolean; seen: (v: string) => void }) {
  const [value, setValue] = useState(start);
  return (
    <AnswerInput number={5} options="ABCD" value={value} allowSeveral={allowSeveral}
      onChange={(_n, v) => {
        setValue(v);
        seen(v);
      }} />
  );
}

const letter = (l: string) => screen.getByRole('button', { name: `Question 5: ${l}` });
const more = () => screen.getByRole('button', { name: 'Question 5: more than one right answer' });

test('one right answer works as it always did', () => {
  const seen = jest.fn();
  render(<Row seen={seen} allowSeveral={false} />);
  expect(screen.queryByRole('button', { name: /more than one right answer/ })).toBeNull();
  fireEvent.click(letter('B'));
  fireEvent.click(letter('C'));
  expect(seen).toHaveBeenLastCalledWith('C');
  expect(letter('B')).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(letter('C'));
  expect(seen).toHaveBeenLastCalledWith('');
});

test('with +, several letters are chosen and the rule decides how they are written', () => {
  const seen = jest.fn();
  render(<Row seen={seen} start="B" />);
  expect(screen.queryByRole('button', { name: 'Any one is right' })).toBeNull();
  fireEvent.click(more());
  // "Any one is right" is the rule to start with.
  expect(screen.getByRole('button', { name: 'Any one is right' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(letter('D'));
  expect(seen).toHaveBeenLastCalledWith('B/D');
  fireEvent.click(screen.getByRole('button', { name: 'All must be filled' }));
  expect(seen).toHaveBeenLastCalledWith('BD');
  fireEvent.click(letter('A'));
  expect(seen).toHaveBeenLastCalledWith('ABD');           // in the order of the sheet
  fireEvent.click(letter('B'));
  expect(seen).toHaveBeenLastCalledWith('AD');
  // Back to one answer: the first chosen letter stays.
  fireEvent.click(more());
  expect(seen).toHaveBeenLastCalledWith('A');
  expect(screen.queryByRole('button', { name: 'All must be filled' })).toBeNull();
});

test('a key that already has several answers shows them with their rule', () => {
  render(<Row seen={jest.fn()} start="B/C" allowSeveral={false} />);
  expect(letter('B')).toHaveAttribute('aria-pressed', 'true');
  expect(letter('C')).toHaveAttribute('aria-pressed', 'true');
  expect(letter('A')).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: 'Any one is right' })).toHaveAttribute('aria-pressed', 'true');
});
