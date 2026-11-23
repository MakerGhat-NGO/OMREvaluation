// IGNITE on the results of a batch: correcting a sheet, hands-on scores and Submit, against a fake API.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { api, ApiError, Batch, Me, Sheet, Test } from '../lib/api';
import BatchPage from './BatchPage';
import { batchStep } from './BatchesPage';

jest.mock('../lib/api', () => ({
  ...jest.requireActual('../lib/api'),
  api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), del: jest.fn(), upload: jest.fn() },
}));

const teacher: Me = {
  signed_in: true,
  user: { id: 'u1', email: 'asha@example.org', name: 'Asha', role: 'teacher', status: 'approved', created_at: '', approved_by: null },
  sheet: { question_count: 5, field_labels: [] },
  features: { ignite: true },
};
const key: Test = {
  id: 't1', name: 'Shakti', question_count: 5, options: 'ABCD', marks_correct: 1, marks_incorrect: 0, marks_unmarked: 0,
  answer_key: { q1: 'A', q2: 'B', q3: 'C', q4: 'D', q5: 'A' }, created_by: 'asha@example.org', created_at: '', archived: false,
  skill_map: {}, hands_on_max: 5,
};
const sheet = (id: string, name: string, extra: Partial<Sheet> = {}): Sheet => ({
  id, batch_id: 'b1', source_name: `${name}.jpg`, page_no: 1, status: 'ok', error_reason: '',
  fields: { Name: name, 'Roll Number': '7', 'Mobile Number': '', gender: 'Female' },
  answers: { q1: 'A', q2: 'B', q3: 'C', q4: 'D', q5: 'A' }, score: 5, needs_review: false, review_reason: '',
  has_checked_image: true, created_at: '', created_by: 'asha@example.org', hands_on_score: null, left_out: false, ...extra,
});

let batch: Batch;
let sheets: Sheet[];

beforeAll(() => {
  // A wide screen: the open sheet sits beside the list.
  window.matchMedia = ((query: string) => ({
    matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = () => undefined;
});

beforeEach(() => {
  batch = {
    id: 'b1', test_id: 't1', test_name: key.name, state_id: 's1', state_name: 'Maharashtra', name: 'Saykheda 7',
    created_by: 'asha@example.org', created_at: new Date().toISOString(), finished_at: null, status: 'finished',
    sheet_count: 2, read_count: 2, review_count: 1, error_count: 0, average_score: 4, max_score: 5,
    district: 'Nashik', block: 'Niphad', school: 'Janta Highschool', grade: '7', assessed_on: '2026-11-02',
    students_reached: 40, submitted_at: null, submitted_by: '', hands_on_count: 2, hands_on_max: 5,
  };
  sheets = [
    sheet('s1', 'ASHA PATIL', { hands_on_score: 4 }),
    sheet('s2', 'RAVI KALE', { answers: { q1: 'A', q2: 'BC', q3: 'C', q4: 'D', q5: 'A' }, score: 4, needs_review: true,
      review_reason: 'two bubbles filled for q2', hands_on_score: 3 }),
  ];
  (api.get as jest.Mock).mockImplementation(async (url: string) => {
    if (url === '/api/batches/b1') return batch;
    if (url === '/api/batches/b1/sheets') return sheets;
    if (url === '/api/tests/t1') return key;
    if (url.endsWith('/layout')) return new Promise(() => undefined);
    throw new ApiError(404, 'not found');
  });
  // The fake server saves what it is sent, the way the real one does.
  (api.patch as jest.Mock).mockImplementation(async (url: string, body: Record<string, any>) => {
    if (url === '/api/batches/b1') {
      batch = { ...batch, ...body };
      return batch;
    }
    const id = /^\/api\/sheets\/(\w+)$/.exec(url)![1];
    const before = sheets.find(s => s.id === id)!;
    const answers = { ...before.answers, ...(body.answers || {}) };
    const after: Sheet = {
      ...before, answers, fields: { ...before.fields, ...(body.fields || {}) },
      score: Object.keys(key.answer_key).filter(q => answers[q] === key.answer_key[q]).length,
      needs_review: body.confirm ? false : before.needs_review, review_reason: body.confirm ? '' : before.review_reason,
      confirmed_by: body.confirm ? 'asha@example.org' : before.confirmed_by,
      hands_on_score: 'hands_on_score' in body ? body.hands_on_score : before.hands_on_score,
      left_out: 'left_out' in body ? body.left_out : before.left_out,
    };
    sheets = sheets.map(s => (s.id === id ? after : s));
    batch = { ...batch, review_count: sheets.filter(s => s.needs_review).length };
    return after;
  });
  (api.post as jest.Mock).mockImplementation(async () => {
    batch = { ...batch, submitted_at: new Date().toISOString(), submitted_by: 'asha@example.org' };
    return batch;
  });
});

afterEach(() => jest.restoreAllMocks());

function renderPage(me: Me = teacher) {
  return render(
    <MemoryRouter initialEntries={['/batches/b1']}>
      <ToastProvider>
        <Routes>
          <Route path="/batches/:id" element={<BatchPage me={me} />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

test('switched off, the results look as they always did', async () => {
  renderPage({ ...teacher, features: { ignite: false } });
  await screen.findByRole('heading', { name: 'Saykheda 7' });
  expect(screen.queryByText('Submit this batch')).toBeNull();
  expect(screen.queryByText('Correct this sheet')).toBeNull();
  expect(screen.queryByLabelText(/Hands-on score of/)).toBeNull();
  // None of the IGNITE wording or layout: no steps, no folded details, the download is the main button.
  expect(screen.queryByText('What is left to do')).toBeNull();
  expect(screen.queryByText('More about this sheet')).toBeNull();
  expect(screen.queryByText(/Open it to/)).toBeNull();
  expect(screen.getByRole('link', { name: /Download for Google Sheets/ })).toHaveClass('btn-primary');
});

test('a flagged sheet is corrected, rescored and marked as checked, then the batch is submitted', async () => {
  renderPage();
  await screen.findByRole('heading', { name: 'Saykheda 7' });
  // The flagged sheet is first in the list, so it is the open one.
  const submit = screen.getByRole('button', { name: 'Submit this batch' });
  expect(submit).toBeDisabled();
  expect(screen.getByText(/1 sheet still needs a check/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Correct this sheet' }));
  fireEvent.change(screen.getByLabelText('Roll number'), { target: { value: '12' } });
  fireEvent.click(screen.getByRole('button', { name: /^Question 2:/ }));
  const picker = screen.getByRole('group', { name: 'Answer for question 2' });
  fireEvent.click(within(picker).getByRole('button', { name: 'B' }));
  expect(screen.getByText('Score with these answers: 5 of 5')).toBeInTheDocument();
  // Moving to another sheet is off while the form is open.
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save and mark as checked' }));

  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/sheets/s2',
    { fields: { 'Roll Number': '12' }, answers: { q2: 'B' }, confirm: true }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Submit this batch' })).toBeEnabled());
  expect(screen.getByRole('button', { name: /To check 0/ })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Submit this batch' }));
  await screen.findByText(/Submitted by you/);
  expect(api.post).toHaveBeenCalledWith('/api/batches/b1/submit');
  // Submitted: a teacher can change nothing more.
  expect(screen.queryByRole('button', { name: 'Correct this sheet' })).toBeNull();
  expect(screen.getByText('This batch was submitted. An admin can open it again.')).toBeInTheDocument();
  expect(screen.queryByLabelText(/Hands-on score of/)).toBeNull();
});

test('the steps say what is left to do, in order, and what holds Submit back', async () => {
  batch = { ...batch, district: '', block: '', students_reached: null, hands_on_count: 0 };
  sheets = sheets.map(s => ({ ...s, hands_on_score: null }));
  renderPage();
  await screen.findByRole('heading', { name: 'What is left to do' });
  const titles = screen.getAllByRole('listitem').map(li => li.querySelector('h3')?.textContent).filter(Boolean);
  expect(titles).toEqual([
    'Step 1: Check the flagged sheets', 'Step 2: Type the activity scores',
    'Step 3: Add the district, the block and the students in the hands-on challenge', 'Step 4: Submit to the admin',
  ]);
  expect(screen.getByText('1 left')).toBeInTheDocument();
  expect(screen.getByText('0 of 2')).toBeInTheDocument();
  expect(screen.getByText(/^2 papers have no activity score yet\./)).toBeInTheDocument();
  expect(screen.getByText('Finish steps 1, 2 and 3 first.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Submit this batch' })).toBeDisabled();
  // The flagged row says what to do with it, and each hands-on box says what it is for.
  expect(screen.getByText(/Open it to confirm or correct\./)).toBeInTheDocument();
  expect(screen.getAllByText('out of 5')).toHaveLength(2);
  // Submit is the main step now, so the download is the quieter button.
  expect(screen.getByRole('link', { name: /Download for Google Sheets/ })).toHaveClass('btn-secondary');

  // The place is typed inside its own step.
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
});

test('with every step done, the list shows ticks and Submit is open', async () => {
  sheets = [sheet('s1', 'ASHA PATIL', { hands_on_score: 4 })];
  batch = { ...batch, sheet_count: 1, review_count: 0, hands_on_count: 1 };
  renderPage();
  await screen.findByRole('heading', { name: 'What is left to do' });
  const titles = screen.getAllByRole('listitem').map(li => li.querySelector('h3')?.textContent).filter(Boolean);
  expect(titles).toEqual([
    'Done: Check the flagged sheets', 'Done: Type the activity scores', 'Done: Where the test was taken',
    'Step 4: Submit to the admin',
  ]);
  expect(screen.getByText(/Nashik · Niphad/)).toBeInTheDocument();
  expect(screen.getByText(/^Everything is ready\./)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Submit this batch' })).toBeEnabled();
});

test('the sheet panel shows the student under the picture and keeps the rest folded', async () => {
  renderPage();
  await screen.findByRole('heading', { name: 'Saykheda 7' });
  const student = within(screen.getByLabelText('Student details'));
  ['Name', 'Roll number', 'Gender', 'Activity score'].forEach(label => expect(student.getByText(label)).toBeInTheDocument());
  expect(student.queryByText('Answer key')).toBeNull();
  const rest = within(screen.getByText('More about this sheet').closest('details')!);
  ['State', 'Batch', 'Answer key', 'Scan', 'Checked'].forEach(label => expect(rest.getByText(label)).toBeInTheDocument());
  expect(screen.getByText('More about this sheet').closest('details')).not.toHaveAttribute('open');
});

test('the results list says where each batch stands', () => {
  expect(batchStep({ ...batch, sheet_count: 0 })).toBeNull();
  expect(batchStep(batch)).toEqual({ text: '1 sheet to check', tone: 'tone-check' });
  expect(batchStep({ ...batch, review_count: 0, error_count: 0, block: '' })?.text).toBe('Add district and block');
  expect(batchStep({ ...batch, review_count: 0, error_count: 0 })?.text).toBe('Ready to submit');
  expect(batchStep({ ...batch, review_count: 0, error_count: 0, hands_on_count: 1 })?.text).toBe('1 activity score to type');
  expect(batchStep({ ...batch, review_count: 0, error_count: 0, students_reached: null })?.text)
    .toBe('Add students in the challenge');
  expect(batchStep({ ...batch, review_count: 0, error_count: 0, hands_on_max: null, hands_on_count: 0, students_reached: null })
    ?.text).toBe('Ready to submit');
  expect(batchStep({ ...batch, submitted_at: '2026-11-03T05:30:00Z' })?.text).toMatch(/^Submitted /);
});

test('a hands-on score is typed beside the student and saved on Enter', async () => {
  renderPage();
  const box = await screen.findByLabelText('Hands-on score of Asha Patil, out of 5');
  fireEvent.change(box, { target: { value: '9' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(await screen.findByText('Type a number from 0 to 5.')).toBeInTheDocument();
  expect(api.patch).not.toHaveBeenCalled();
  fireEvent.change(box, { target: { value: '4.5' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/sheets/s1', { hands_on_score: 4.5 }));
});

test('a sheet left out is in no count and blocks nothing', async () => {
  renderPage();
  await screen.findByRole('heading', { name: 'Saykheda 7' });
  fireEvent.click(screen.getByRole('button', { name: 'Leave it out' }));
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/sheets/s2', { left_out: true }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Submit this batch' })).toBeEnabled());
  expect(screen.getByRole('button', { name: /^All 1$/ })).toBeInTheDocument();
  expect(screen.getByText('Left out of the results')).toBeInTheDocument();
});

test('the teacher types the students in the hands-on challenge, never fewer than the papers', async () => {
  batch = { ...batch, students_reached: null, review_count: 0 };
  sheets = [sheet('s1', 'ASHA PATIL', { hands_on_score: 4 }), sheet('s2', 'RAVI KALE', { hands_on_score: 2 })];
  renderPage();
  await screen.findByRole('heading', { name: 'Step 3: Add the students in the hands-on challenge' });
  expect(screen.getByText('Students in the hands-on challenge: not typed yet')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Submit this batch' })).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  fireEvent.change(screen.getByLabelText(/Students in the hands-on challenge/), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/batches/b1', expect.objectContaining({ students_reached: 1 })));
  // The fake server took it; the card says it is fewer than the papers and Submit stays shut.
  expect(await screen.findByText(/That is fewer than the 2 papers\./)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Submit this batch' })).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText(/Students in the hands-on challenge/), { target: { value: '60' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Submit this batch' })).toBeEnabled());
  expect(screen.getByText('Students in the hands-on challenge: 60')).toBeInTheDocument();
});

test('a block marked Completed is pointed out while the place is typed', async () => {
  (api.get as jest.Mock).mockImplementation(async (url: string) => {
    if (url === '/api/batches/b1') return batch;
    if (url === '/api/batches/b1/sheets') return sheets;
    if (url === '/api/tests/t1') return key;
    if (url === '/api/places') {
      return { places: [{ state_id: 's1', district: 'Nashik', block: 'Niphad', school: '', status: 'Completed' }], grades: [] };
    }
    if (url.endsWith('/layout')) return new Promise(() => undefined);
    throw new ApiError(404, 'not found');
  });
  renderPage();
  await screen.findByRole('heading', { name: 'What is left to do' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(await screen.findByText('Niphad is marked Completed')).toBeInTheDocument();
});
