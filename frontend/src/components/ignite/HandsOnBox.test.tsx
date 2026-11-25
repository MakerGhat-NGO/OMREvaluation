import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, Sheet } from '../../lib/api';
import HandsOnBox from './HandsOnBox';

jest.mock('../../lib/api', () => ({
  ...jest.requireActual('../../lib/api'),
  api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), del: jest.fn(), upload: jest.fn() },
}));

const sheet: Sheet = {
  id: 's1', batch_id: 'b1', source_name: 'a.jpg', page_no: 1, status: 'ok', error_reason: '', fields: {}, answers: {},
  score: 20, needs_review: false, review_reason: '', has_checked_image: true, created_at: '', created_by: '',
  hands_on_score: null,
};

afterEach(() => jest.restoreAllMocks());

test('a score out of range is refused before it is sent; a good one is saved on Enter', async () => {
  const onSaved = jest.fn();
  (api.patch as jest.Mock).mockResolvedValue({ ...sheet, hands_on_score: 4.5 });
  render(<HandsOnBox sheet={sheet} max={5} who="Asha Patil" onSaved={onSaved} />);
  const box = screen.getByLabelText('Hands-on score of Asha Patil, out of 5');
  fireEvent.change(box, { target: { value: '9' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(await screen.findByText('Type a number from 0 to 5.')).toBeInTheDocument();
  expect(api.patch).not.toHaveBeenCalled();

  fireEvent.change(box, { target: { value: '4.5' } });
  fireEvent.blur(box);
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/sheets/s1', { hands_on_score: 4.5 }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
});

test('the box shows a score saved somewhere else', () => {
  const { rerender } = render(<HandsOnBox sheet={sheet} max={5} who="Asha Patil" onSaved={() => undefined} />);
  rerender(<HandsOnBox sheet={{ ...sheet, hands_on_score: 3 }} max={5} who="Asha Patil" onSaved={() => undefined} />);
  expect(screen.getByLabelText('Hands-on score of Asha Patil, out of 5')).toHaveValue('3');
});

test('a saved score below the pass mark is flagged, and one at the pass mark is not', () => {
  const { rerender } = render(<HandsOnBox sheet={{ ...sheet, hands_on_score: 2 }} max={5} pass={3} who="Asha Patil" onSaved={() => undefined} />);
  expect(screen.getByText('Below pass mark (3)')).toBeInTheDocument();
  rerender(<HandsOnBox sheet={{ ...sheet, hands_on_score: 3 }} max={5} pass={3} who="Asha Patil" onSaved={() => undefined} />);
  expect(screen.queryByText('Below pass mark (3)')).not.toBeInTheDocument();
  rerender(<HandsOnBox sheet={{ ...sheet, hands_on_score: 2 }} max={5} who="Asha Patil" onSaved={() => undefined} />);
  expect(screen.queryByText(/Below pass mark/)).not.toBeInTheDocument();
});
