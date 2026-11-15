import assert from 'node:assert/strict';
import test from 'node:test';
import { notePlan, planChoice } from '../bin/planview.mjs';

const brief = { path: '/b.md', text: '# Brief', mtime: 10 };
const plan = { path: '/plan.md', text: '# Plan', mtime: 5 };

test('the brief is the plan until the plan file is newer', () => {
  assert.equal(planChoice(brief, plan), 'brief');
  assert.equal(planChoice(brief, null), 'brief');
  assert.equal(planChoice(brief, { ...plan, mtime: 10 }), 'brief');
  assert.equal(planChoice(brief, { ...plan, mtime: 11 }), 'plan');
  assert.equal(planChoice({ text: null, path: '/b.md' }, plan), 'plan');
  assert.equal(planChoice(null, { text: '' }), 'note');
  assert.equal(planChoice(null, null), 'note');
});

test('a change of the plan selects Plan; the first load and a branch change do not', () => {
  const first = notePlan(undefined, plan, null);
  assert.equal(first.select, false);
  assert.equal(notePlan(first.sig, plan, null).select, false);
  const edited = notePlan(first.sig, { ...plan, mtime: 6 }, null);
  assert.equal(edited.select, true);
  const wrote = notePlan(edited.sig, plan, brief);
  assert.equal(wrote.select, true);
  assert.equal(notePlan(wrote.sig, plan, brief).select, false);
  // A checkout with no brief text is not a new plan, whatever its path.
  assert.equal(notePlan(first.sig, plan, { path: '/other.md', text: null, mtime: 99 }).select, false);
});
