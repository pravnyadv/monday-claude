const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findColumn, findEstimateColumn, columnValue } = require('../lib/columns');

const status = { id: 'status', title: 'Status', type: 'status', settings_str: JSON.stringify({ labels: { 0: 'Dev In Progress', 8: 'Ready For QA', 9: 'Old' }, deactivated_labels: [9] }) };
const cols = [
  status,
  { id: 'numeric_dev', title: 'Dev Estimate', type: 'numbers' },
  { id: 'numeric_qa', title: 'QA Estimate', type: 'numbers' },
  { id: 'date_go', title: 'Go live Date', type: 'date' },
  { id: 'person', title: 'Person', type: 'people' },
  { id: 'duration', title: 'Time tracking', type: 'time_tracking' },
];

test('findColumn: id, alias, exact title, unique partial title; ambiguous and missing throw', () => {
  assert.equal(findColumn(cols, 'date_go').id, 'date_go');
  assert.equal(findColumn(cols, 'estimate', { estimate: 'numeric_dev' }).id, 'numeric_dev');
  assert.equal(findColumn(cols, 'qa estimate').id, 'numeric_qa');
  assert.equal(findColumn(cols, 'go live').id, 'date_go');
  assert.throws(() => findColumn(cols, 'estimate'), /ambiguous: Dev Estimate \(numeric_dev\), QA Estimate/);
  assert.throws(() => findColumn(cols, 'nope'), /No column "nope"/);
});

test('findEstimateColumn: alias first, then the single numbers column titled like an estimate', () => {
  assert.equal(findEstimateColumn(cols, { timeEstimateHrs: 'numeric_qa' }).id, 'numeric_qa');
  assert.throws(() => findEstimateColumn(cols), /Can't tell which column is the estimate/);
  assert.equal(findEstimateColumn(cols.filter((c) => c.id !== 'numeric_qa')).id, 'numeric_dev');
});

test('columnValue: encodes each type the way change_multiple_column_values expects', () => {
  const resolve = (n) => ({ Alex: '70000001', Jordan: '70000002' })[n];
  assert.equal(columnValue(cols[1], ['6.5'], resolve), '6.5');
  assert.deepEqual(columnValue(cols[3], ['2026-11-06'], resolve), { date: '2026-11-06' });
  assert.deepEqual(columnValue(cols[3], ['2026-11-06', '10:30'], resolve), { date: '2026-11-06', time: '10:30:00' });
  assert.deepEqual(columnValue(status, ['Ready', 'For', 'QA'], resolve), { label: 'Ready For QA' });
  assert.deepEqual(columnValue(cols[4], ['Alex,', 'Jordan'], resolve), { personsAndTeams: [{ id: 70000001, kind: 'person' }, { id: 70000002, kind: 'person' }] });
  assert.deepEqual(columnValue({ id: 't', title: 'T', type: 'timeline' }, ['2026-11-01..2026-11-05'], resolve), { from: '2026-11-01', to: '2026-11-05' });
  assert.deepEqual(columnValue({ id: 'l', title: 'L', type: 'link' }, ['https://x', 'MR', '452'], resolve), { url: 'https://x', text: 'MR 452' });
  assert.deepEqual(columnValue({ id: 'd', title: 'D', type: 'dropdown' }, ['a, b'], resolve), { labels: ['a', 'b'] });
  assert.equal(columnValue(cols[1], [''], resolve), '');
  assert.deepEqual(columnValue(cols[3], [], resolve), {});
});

test('columnValue: rejects bad input before anything is sent', () => {
  assert.throws(() => columnValue(cols[1], ['six'], () => null), /not a number/);
  assert.throws(() => columnValue(cols[3], ['06-11-2026'], () => null), /not a date/);
  assert.throws(() => columnValue(status, ['Old'], () => null), /not a label of Status/);
  assert.throws(() => columnValue(cols[5], ['2'], () => null), /cannot write time tracking/);
});
