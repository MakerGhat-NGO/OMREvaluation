import { parseQuestions, skillMapOf } from '../components/ignite/SkillsEditor';
import { Batch, Places, Sheet } from './api';
import {
  addSchool, blockCompleted, dayText, detailsFromFileName, detailsOf, guessDetails, igniteOn, NO_DETAILS, schoolKey, schoolsText,
  scoreOf, submitBlocker, suggestionsFor, todayInIndia,
} from './ignite';

const sheet = (over: Partial<Sheet>): Sheet => ({
  id: 's', batch_id: 'b', source_name: 'a.jpg', page_no: 1, status: 'ok', error_reason: '', fields: {}, answers: {},
  score: 1, needs_review: false, review_reason: '', has_checked_image: true, created_at: '', created_by: '', ...over,
});
const batch = (over: Partial<Batch>): Batch => ({
  id: 'b', test_id: 't', test_name: 'Key', state_id: 's1', state_name: 'Maharashtra', name: 'Batch', created_by: 'a@b.c',
  created_at: '', finished_at: null, status: 'finished', sheet_count: 0, read_count: 0, review_count: 0, error_count: 0,
  average_score: null, max_score: null, district: 'Nashik', block: 'Malegaon', ...over,
});

test('the feature is off unless the server says it is on', () => {
  expect(igniteOn(null)).toBe(false);
  expect(igniteOn({ signed_in: true, user: {} as never, sheet: { question_count: 50, field_labels: [] } })).toBe(false);
  expect(igniteOn({ signed_in: true, user: {} as never, sheet: { question_count: 50, field_labels: [] }, features: { ignite: true } })).toBe(true);
});

test('a score is worked out the way the server does', () => {
  const key = { answer_key: { q1: 'A', q2: 'B', q3: 'C' }, marks_correct: 4, marks_incorrect: -1, marks_unmarked: 0 };
  expect(scoreOf({ q1: 'A', q2: 'C', q3: '' }, key)).toBe(3);
  expect(scoreOf({ q1: 'A', q2: 'BC', q3: 'C', q4: 'D' }, key)).toBe(7);   // two marks count as wrong; q4 is not in the key
});

test('the name of a scan says the grade, school and block', () => {
  expect(detailsFromFileName('Asha Patil_G7_ZPPS Sunderpur_Malegaon.pdf')).toEqual({ grade: '7', school: 'ZPPS Sunderpur', block: 'Malegaon' });
  expect(detailsFromFileName('Ravi_Grade 8_Janta  Highschool_Niphad.jpg')).toEqual({ grade: '8', school: 'Janta Highschool', block: 'Niphad' });
  expect(detailsFromFileName('class7.pdf')).toBeNull();
  expect(detailsFromFileName('a_b_c.pdf')).toBeNull();
});

test('the grade and block are guessed when most files agree, and every school is offered', () => {
  const names = ['C_G8_ZPPS Kesarwadi_Malegaon.pdf', 'A_G7_ZPPS Sunderpur_Malegaon.pdf', 'B_G7_zpps  sunderpur_Malegaon.pdf'];
  expect(guessDetails(names)).toEqual({ grade: '7', schools: ['ZPPS Sunderpur', 'ZPPS Kesarwadi'], block: 'Malegaon' });
  expect(guessDetails(['A_G7_One_Malegaon.pdf', 'B_G8_Two_Niphad.pdf'])).toEqual({ schools: ['One', 'Two'] });
  expect(guessDetails(['class7.pdf'])).toEqual({});
});

test('a school is added once, however it is spelt', () => {
  expect(schoolKey('Z.P.P.S. Sunderpur')).toBe(schoolKey('zpps sunderpur'));
  expect(schoolKey('रामनगर')).not.toBe(schoolKey('रमनगर'));       // a vowel sign makes another name
  const one = addSchool([], '  ZPPS   Sunderpur ');
  expect(one).toEqual(['ZPPS Sunderpur']);
  expect(addSchool(one, 'Z.P.P.S. sunderpur')).toBe(one);
  expect(addSchool(one, '  ')).toBe(one);
  expect(addSchool(one, 'Hidden High')).toEqual(['ZPPS Sunderpur', 'Hidden High']);
  expect(schoolsText(['A', 'B'])).toBe('A and B');
  expect(schoolsText(['A', 'B', 'C'])).toBe('3 schools');
  // A batch from before the list has one school.
  expect(detailsOf(batch({ school: 'Old School' })).schools).toEqual(['Old School']);
  expect(detailsOf(batch({ school: 'A, B', schools: ['A', 'B'] })).schools).toEqual(['A', 'B']);
});

test('suggestions narrow with what is typed', () => {
  const places: Places = {
    places: [
      { state_id: 's1', district: 'Nashik', block: 'Malegaon', school: 'ZPPS Sunderpur' },
      { state_id: 's1', district: 'Nashik', block: 'Niphad', school: 'Janta Highschool' },
      { state_id: 's1', district: 'Sangli', block: 'Miraj', school: 'ZP Miraj' },
      { state_id: 's2', district: 'Cuttack', block: 'Banki', school: 'Banki High' },
    ],
    grades: ['7', '8'],
  };
  expect(suggestionsFor(places, 's1', NO_DETAILS).districts).toEqual(['Nashik', 'Sangli']);
  const typed = suggestionsFor(places, 's1', { ...NO_DETAILS, district: 'nashik ', block: 'Niphad' });
  expect(typed.blocks).toEqual(['Malegaon', 'Niphad']);
  expect(typed.schools).toEqual(['Janta Highschool']);
  expect(suggestionsFor(null, 's1', NO_DETAILS)).toEqual({ districts: [], blocks: [], schools: [], grades: [] });
});

test('a batch is submitted only when every sheet is settled and it says where it is from', () => {
  expect(submitBlocker(batch({}), [])).toMatch(/no sheets/);
  const sheets = [sheet({}), sheet({ id: 'c', needs_review: true }), sheet({ id: 'e', status: 'error' }),
    sheet({ id: 'o', status: 'error', left_out: true })];
  expect(submitBlocker(batch({}), sheets)).toBe(
    '1 sheet still needs a check and 1 sheet could not be read. Correct them, type them in or leave them out first.');
  expect(submitBlocker(batch({ block: '' }), [sheet({})])).toBe('Add the block of this batch first.');
  expect(submitBlocker(batch({ district: '', block: '' }), [sheet({})])).toBe('Add the district and the block of this batch first.');
  expect(submitBlocker(batch({}), [sheet({}), sheet({ id: 'o', status: 'error', left_out: true })])).toBe('');
});

test('days read as dates', () => {
  expect(dayText('2026-11-02')).toMatch(/2 Nov 2026/);
  expect(dayText(null)).toBe('');
  expect(todayInIndia(new Date('2026-11-09T20:00:00Z'))).toBe('2026-11-10');   // already the 10th in India
});

test('question numbers of a skill', () => {
  expect(parseQuestions('3, 8-10 12', 25)).toEqual([3, 8, 9, 10, 12]);
  expect(parseQuestions('', 25)).toEqual([]);
  expect(parseQuestions('3, x', 25)).toBeNull();
  expect(parseQuestions('26', 25)).toBeNull();
  expect(parseQuestions('9-3', 25)).toBeNull();
});

test('skills become a map of questions, or say what is wrong', () => {
  expect(skillMapOf([{ name: ' Logic ', questions: '1-2' }, { name: 'Data', questions: '4' }, { name: '', questions: '' }], 5))
    .toEqual({ map: { q1: 'Logic', q2: 'Logic', q4: 'Data' } });
  expect(skillMapOf([{ name: 'Logic', questions: '1' }, { name: 'Data', questions: '1' }], 5))
    .toEqual({ problem: 'Question 1 is in two skills: "Logic" and "Data".' });
  expect(skillMapOf([{ name: '', questions: '1' }], 5)).toEqual({ problem: 'Give every skill a name.' });
  expect(skillMapOf([{ name: 'Logic', questions: '' }], 5)).toEqual({ problem: '"Logic" has no questions yet.' });
  expect(skillMapOf([{ name: 'Logic', questions: '1' }, { name: 'logic', questions: '2' }], 5))
    .toHaveProperty('problem');
});

test('with an activity score on the key, Submit waits for every score and the students in the challenge', () => {
  const two = [sheet({ hands_on_score: 4 }), sheet({ id: 'c', hands_on_score: null })];
  expect(submitBlocker(batch({ students_reached: 40 }), two, 5)).toBe('1 paper has no activity score yet. Type it first.');
  const scored = [sheet({ hands_on_score: 4 }), sheet({ id: 'c', hands_on_score: 0 })];
  expect(submitBlocker(batch({}), scored, 5)).toBe('Type how many students did the hands-on challenge first.');
  expect(submitBlocker(batch({ students_reached: 1 }), scored, 5)).toBe(
    'The students in the hands-on challenge (1) cannot be fewer than the papers (2).');
  expect(submitBlocker(batch({ students_reached: 2 }), scored, 5)).toBe('');
  // A key with no activity score asks for neither.
  expect(submitBlocker(batch({}), [sheet({ hands_on_score: null })])).toBe('');
});

test('a block marked Completed is found whatever the case or spaces', () => {
  const places: Places = {
    places: [{ state_id: 's1', district: 'Nashik', block: 'Chandwad', school: '', status: 'Completed' },
      { state_id: 's1', district: 'Nashik', block: 'Satana', school: '', status: 'In Progress' }],
    grades: [],
  };
  expect(blockCompleted(places, ' nashik', 'CHANDWAD ')).toBe(true);
  expect(blockCompleted(places, 'Nashik', 'Satana')).toBe(false);
  expect(blockCompleted(places, '', 'Chandwad')).toBe(false);
  expect(blockCompleted(null, 'Nashik', 'Chandwad')).toBe(false);
});
