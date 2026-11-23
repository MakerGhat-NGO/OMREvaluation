// The admin's IGNITE data screen against a fake API: review a block, type a figure, leave a batch
// out, mark a top student, publish and show earlier numbers again.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { api, ApiError, Me } from '../lib/api';
import { Figures, IgniteBatch, IgniteBlock, IgniteOverview } from '../lib/igniteData';
import IgnitePage from './IgnitePage';

jest.mock('../lib/api', () => ({
  ...jest.requireActual('../lib/api'),
  api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), del: jest.fn(), upload: jest.fn() },
}));

const admin: Me = {
  signed_in: true,
  user: { id: 'u1', email: 'hisham@example.org', name: 'Hisham', role: 'admin', status: 'approved', created_at: '', approved_by: null },
  sheet: { question_count: 25, field_labels: [] },
  features: { ignite: true },
};
const NONE: Figures = {
  schools_reached: null, students_reached: null, assessed: null, avg: null, girls: null, above70: null, above50: null,
  below50: null, hands_count: null, hands_avg: null,
};
const opening: Figures = {
  schools_reached: 12, students_reached: 273, assessed: 109, avg: 0.52, girls: 0.45, above70: 12, above50: 30, below50: 67,
  hands_count: 40, hands_avg: 3.4,
};
const batch = (over: Partial<IgniteBatch> = {}): IgniteBatch => ({
  id: 'x1', name: 'Saykheda 7', test_name: 'Shakti', state_name: 'Maharashtra', district: 'Nashik', block: 'Dindori',
  school: 'Janta Highschool', grade: '7', assessed_on: '2026-11-02', submitted_at: new Date().toISOString(),
  submitted_by: 'asha@example.org', sheets: 3, average: 0.8, students_reached: 3, hands_on_count: 3, left_out: false, ...over,
});
const block = (over: Partial<IgniteBlock> = {}): IgniteBlock => ({
  id: 'b1', district_id: 'd1', name: 'Dindori', position: 1, total_schools: 200, selected_schools: 20, student_target: 1500,
  status: '', status_shown: 'In Progress', opening, added: { ...NONE, assessed: 3, avg: 0.8, students_reached: 3 },
  worked_out: { ...opening, assessed: 112, students_reached: 276, avg: 0.5275 }, overrides: {},
  shown: { ...opening, assessed: 112, students_reached: 276, avg: 0.5275 }, published: { ...opening, status: 'In Progress' },
  batches: [batch()], ...over,
});

let view: IgniteOverview;

beforeEach(() => {
  view = {
    settings: { hands_on_max: 5 }, statuses: ['Not started', 'In Progress', 'Completed'],
    districts: [{
      id: 'd1', state: 'Maharashtra', name: 'Nashik', position: 1, blocks_count: 15, total_schools: 3200, grade: '6 to 8',
      total_students: 150000, target_date: '2026-10-15', top_imported: 83, top_marked: 0,
      blocks: [block(), block({ id: 'b2', name: 'Yeola', status_shown: 'Not started', opening: NONE, added: NONE, worked_out: NONE,
        shown: NONE, published: { ...NONE, status: 'Not started' }, batches: [] })],
    }],
    unmatched: [batch({ id: 'x9', name: 'Top performers', block: 'Dindoree' })],
    working: [],
    last_publish: { id: 'p1', published_at: new Date().toISOString(), published_by: 'hisham@example.org', note: 'Opening numbers', restored_from: '' },
    publishes: 2, changed: true,
  };
  (api.get as jest.Mock).mockImplementation(async (url: string) => {
    if (url === '/api/ignite/overview') return view;
    if (url === '/api/ignite/snapshots') {
      return [view.last_publish, { id: 'p0', published_at: '2026-11-01T10:00:00Z', published_by: 'asha@example.org', note: 'First try', restored_from: '' }];
    }
    if (url.startsWith('/api/ignite/top?')) {
      return { imported: 83, imported_top1: 47, students: [
        { id: 's1', batch_id: 'x1', batch_name: 'Saykheda 7', name: 'ASHA PATIL', school: 'Janta Highschool', block: 'Dindori',
          gender: 'F', score: 23, max_score: 25, percent: 0.92, skills: {}, top5: false, top1: false },
      ] };
    }
    throw new ApiError(404, 'not found');
  });
  (api.post as jest.Mock).mockResolvedValue({});
  (api.patch as jest.Mock).mockResolvedValue({});
  (api.put as jest.Mock).mockImplementation(async (url: string, body: Record<string, boolean>) =>
    (url.startsWith('/api/ignite/top/') ? { id: 's1', top5: !!(body.top5 || body.top1), top1: !!body.top1 } : {}));
});

afterEach(() => jest.clearAllMocks());

async function open() {
  render(
    <MemoryRouter initialEntries={['/ignite']}>
      <ToastProvider><IgnitePage me={admin} /></ToastProvider>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Nashik' });
}

test('it shows what is published, what changed and the batches that match no block', async () => {
  await open();
  expect(screen.getByText('Changes not published yet')).toBeInTheDocument();
  expect(screen.getByText(/Published today .* by you\. 1 block differs from what is published\./)).toBeInTheDocument();
  expect(screen.getByText('Note: Opening numbers')).toBeInTheDocument();
  expect(screen.getByText('1 submitted batch matches no block')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Top performers' })).toHaveAttribute('href', '/batches/x9');
  const dindori = screen.getByRole('button', { name: /Dindori/ });
  expect(dindori).toHaveTextContent('Changed');
  expect(dindori).toHaveTextContent('Reached 276 · assessed 112 · average 52.8% · 1 batch');
  expect(screen.getByRole('button', { name: /Yeola/ })).not.toHaveTextContent('Changed');
});

test('publish sends the note and loads the numbers again', async () => {
  await open();
  fireEvent.change(screen.getByLabelText(/Note for this publish/), { target: { value: 'Week 2 batches' } });
  fireEvent.click(screen.getByRole('button', { name: 'Publish to the dashboard' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/ignite/publish', { note: 'Week 2 batches' }));
  await waitFor(() => expect((api.get as jest.Mock).mock.calls.filter(c => c[0] === '/api/ignite/overview')).toHaveLength(2));
  expect(await screen.findByText('Published. The dashboard shows these numbers now.')).toBeInTheDocument();
});

test('with nothing changed there is nothing to publish', async () => {
  view.changed = false;
  await open();
  expect(screen.getByText('Up to date')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Publish to the dashboard' })).toBeDisabled();
});

test('an admin types a figure of their own for a block, with a note', async () => {
  await open();
  fireEvent.click(screen.getByRole('button', { name: /Dindori/ }));
  expect(screen.getByText('Before the app: 109. From batches: 3.')).toBeInTheDocument();
  expect(screen.getByText('On the dashboard now: 109')).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Your own figure for Students reached'), { target: { value: '300' } });
  fireEvent.change(screen.getByLabelText('Why this figure for Students reached'), { target: { value: 'Counted on the visit' } });
  fireEvent.change(screen.getByLabelText('Your own figure for Average score'), { target: { value: '55' } });
  // The status list is the app's own: open it and take a choice.
  fireEvent.click(screen.getByLabelText('Assessment status'));
  fireEvent.click(screen.getByRole('option', { name: 'Completed' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save this block' }));
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/ignite/blocks/b1', {
    status: 'Completed', total_schools: 200, selected_schools: 20, student_target: 1500,
    overrides: { students_reached: { value: 300, note: 'Counted on the visit' }, avg: { value: 0.55, note: '' } },
  }));
});

test('a figure that cannot be right is not sent', async () => {
  await open();
  fireEvent.click(screen.getByRole('button', { name: /Dindori/ }));
  fireEvent.change(screen.getByLabelText('Your own figure for Girls among them'), { target: { value: '140' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save this block' }));
  expect(await screen.findByText('Your own figure for "Girls among them" must be between 0 and 100.')).toBeInTheDocument();
  expect(api.patch).not.toHaveBeenCalled();
});

test('a batch can be left out of the dashboard', async () => {
  await open();
  fireEvent.click(screen.getByRole('button', { name: /Dindori/ }));
  expect(screen.getByRole('link', { name: 'Saykheda 7' })).toHaveAttribute('href', '/batches/x1');
  fireEvent.click(screen.getByRole('button', { name: 'Leave it out: Saykheda 7' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/ignite/batches/x1', { left_out: true }));
});

test('marking a student top 1% marks top 5% too', async () => {
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Top students · 83' }));
  const row = (await screen.findByText('1. Asha Patil')).closest('li')!;
  expect(screen.getByText(/83 top students came from the team's sheet, 47 of them in the top 1%/)).toBeInTheDocument();
  fireEvent.click(within(row).getByRole('button', { name: /Top 1%/ }));
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/ignite/top/s1', { top1: true }));
  await waitFor(() => expect(within(row).getByRole('button', { name: /Top 5%/ })).toHaveAttribute('aria-pressed', 'true'));
});

test('an earlier publish is shown again only after a yes', async () => {
  await open();
  const earlier = (await screen.findByText(/by Asha/)).closest('li')!;
  fireEvent.click(within(earlier).getByRole('button', { name: 'Show these numbers again' }));
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(within(earlier).getByRole('button', { name: 'Yes, show them' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/ignite/snapshots/p0/restore'));
});
