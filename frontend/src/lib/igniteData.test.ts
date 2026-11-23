import {
  blockDiffers, boxText, changedFigures, districtSum, Figures, figureText, IgniteBlock, IgniteDistrict, shareCount, typedFigure,
} from './igniteData';

const figures = (over: Partial<Figures> = {}): Figures => ({
  schools_reached: 12, students_reached: 273, assessed: 109, avg: 0.52, girls: 0.45, above70: 12, above50: 30, below50: 67,
  hands_count: 40, hands_avg: 3.4, ...over,
});
const block = (over: Partial<IgniteBlock> = {}): IgniteBlock => ({
  id: 'b1', district_id: 'd1', name: 'Dindori', position: 1, total_schools: 200, selected_schools: 20, student_target: 1500,
  status: '', status_shown: 'In Progress', opening: figures(), added: figures(), worked_out: figures(), overrides: {},
  shown: figures(), published: { ...figures(), status: 'In Progress' }, batches: [], ...over,
});

test('a figure is shown by its kind', () => {
  expect(figureText('count', 123456)).toBe('1,23,456');
  expect(figureText('share', 0.5234)).toBe('52.3%');
  expect(figureText('share', 1)).toBe('100%');
  expect(figureText('average', 3.456)).toBe('3.46');
  expect(figureText('count', null)).toBe('–');
});

test('a typed figure is read by its kind', () => {
  expect(typedFigure('count', ' 1,203 ')).toEqual({ value: 1203 });
  expect(typedFigure('count', '')).toEqual({ value: null });
  expect(typedFigure('count', '2.5')).toEqual({ error: 'must be a whole number' });
  expect(typedFigure('share', '52.5%')).toEqual({ value: 0.525 });
  expect(typedFigure('share', '120')).toEqual({ error: 'must be between 0 and 100' });
  expect(typedFigure('average', '3.4')).toEqual({ value: 3.4 });
  expect(typedFigure('average', '-1')).toEqual({ error: 'must be a number, 0 or more' });
  expect(typedFigure('count', 'many')).toEqual({ error: 'must be a number, 0 or more' });
});

test('a share goes into a box as its percent and comes back the same', () => {
  expect(boxText('share', 0.523)).toBe('52.3');
  expect(typedFigure('share', boxText('share', 0.523))).toEqual({ value: 0.523 });
  expect(boxText('count', null)).toBe('');
});

test('a block differs from the dashboard when a figure or its status changed, or when it is new', () => {
  expect(blockDiffers(block())).toBe(false);
  const more = block({ shown: figures({ assessed: 110, avg: 0.53 }) });
  expect(changedFigures(more)).toEqual(['assessed', 'avg']);
  expect(blockDiffers(more)).toBe(true);
  expect(blockDiffers(block({ status_shown: 'Completed' }))).toBe(true);
  expect(blockDiffers(block({ published: null }))).toBe(true);
  // A figure with no number on both sides is the same.
  expect(blockDiffers(block({ shown: figures({ girls: null }), published: { ...figures({ girls: null }), status: 'In Progress' } }))).toBe(false);
});

test('a district sums what its blocks have', () => {
  const d = { blocks: [block(), block({ shown: figures({ assessed: null }) }), block({ shown: figures({ assessed: 1 }) })] } as IgniteDistrict;
  expect(districtSum(d, 'assessed')).toBe(110);
  expect(districtSum({ blocks: [block({ shown: figures({ assessed: null }) })] } as IgniteDistrict, 'assessed')).toBeNull();
});

test('5% of the students is at least one of them', () => {
  expect(shareCount(128, 0.05)).toBe(6);
  expect(shareCount(12, 0.01)).toBe(1);
  expect(shareCount(0, 0.05)).toBe(0);
});
