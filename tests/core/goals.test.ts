import { assert, describe, expect, it } from 'vitest';
import {
  closeGoalRecord,
  createAnnualGoal,
  createKr,
  createObjective,
  reviseKr,
  updateAnnualGoal,
  updateKr,
  updateObjective,
} from '../../src/core/goals';
import type { KrDraft } from '../../src/core/kr';

const annualGoalKey = 'annual-goal:00000000-0000-4000-8000-000000000001';
const objectiveKey = 'objective:00000000-0000-4000-8000-000000000002';
const unknownAnnualGoalKey = 'annual-goal:00000000-0000-4000-8000-000000000003';
const unknownObjectiveKey = 'objective:00000000-0000-4000-8000-000000000004';

const annualDraft = Object.freeze({ statement: 'Improve release reliability' });
const annualGoal = Object.freeze({ kind: 'annual-goal', status: 'active', ...annualDraft });
const annualGoals = Object.freeze({ [annualGoalKey]: annualGoal });

const objectiveDraft = Object.freeze({
  statement: 'Make releases repeatable',
  quarter: '2027-Q1',
  annualGoalKey,
});
const objective = Object.freeze({ kind: 'objective', status: 'active', ...objectiveDraft });
const objectives = Object.freeze({ [objectiveKey]: objective });

const krFields: KrDraft = Object.freeze({
  statement: 'Reduce release lead time',
  baseline: '10 days',
  dataSource: 'Weekly release report',
  target: '5 days',
});
const krDraft = Object.freeze({ ...krFields, objectiveKey });
const krVersion = Object.freeze({ kind: 'kr', status: 'active', ...krDraft });
const previousRevision = Object.freeze({
  ...krVersion,
  statement: 'Measure release lead time',
  target: '7 days',
  revisionReason: 'Set a new lead time threshold',
});
const kr = Object.freeze({ ...krVersion, history: Object.freeze([previousRevision]) });
const krClosure = Object.freeze({
  outcome: 'not-achieved',
  reason: 'The quarter ended before rollout',
});
const closedKrVersion = Object.freeze({
  ...krVersion,
  status: 'closed',
  outcome: krClosure.outcome,
  closureReason: krClosure.reason,
});
const closedKr = Object.freeze({ ...closedKrVersion, history: kr.history });
const revisedFields: KrDraft = Object.freeze({
  statement: 'Reduce the median time from approval to release',
  baseline: '8 days',
  dataSource: 'Release audit log',
  target: '4 days',
});
const revisionReason = 'Use a consistent measurement window';

const blank = ['', '   '] as const;
const goalOutcomes = ['achieved', 'completed', 'cancelled'] as const;
const krOutcomes = ['achieved', 'not-achieved', 'cancelled'] as const;
const requiredKrFields = ['statement', 'baseline', 'dataSource', 'target'] as const;

function expectRejected(result: unknown, field: string, code = 'required'): void {
  expect(result).toStrictEqual({ ok: false, errors: [{ field, code }] });
}

describe('goal-lifecycle', () => {
  describe('Create edit and close an annual goal', () => {
    it.each(goalOutcomes)('preserves the edited statement when closed as %s', (outcome) => {
      const created = createAnnualGoal(annualDraft);
      expect(created).toStrictEqual({ ok: true, value: annualGoal });
      assert(created.ok);

      const draft = Object.freeze({ statement: 'Improve release reliability and recovery' });
      const edited = updateAnnualGoal(created.value, draft);
      const expected = { ...annualGoal, ...draft };
      expect(edited).toStrictEqual({ ok: true, value: expected });
      expect(created.value).toStrictEqual(annualGoal);
      assert(edited.ok);

      const reason = 'The annual review is complete';
      expect(closeGoalRecord(edited.value, { outcome, reason })).toStrictEqual({
        ok: true,
        value: { ...expected, status: 'closed', outcome, closureReason: reason },
      });
      expect(edited.value).toStrictEqual(expected);
    });
  });

  describe('Require a statement for an annual goal', () => {
    it.each(blank)('rejects a statement of %j on creation and update', (statement) => {
      const draft = Object.freeze({ statement });
      expectRejected(createAnnualGoal(draft), 'statement');
      expectRejected(updateAnnualGoal(annualGoal, draft), 'statement');
    });
  });

  describe('Create edit and close an Objective', () => {
    it.each(goalOutcomes)('preserves the edited fields and parent when closed as %s', (outcome) => {
      const created = createObjective(objectiveDraft, annualGoals);
      expect(created).toStrictEqual({ ok: true, value: objective });
      assert(created.ok);

      const draft = Object.freeze({
        ...objectiveDraft,
        statement: 'Automate release checks',
        quarter: '2027-Q2',
      });
      const edited = updateObjective(created.value, draft, annualGoals);
      const expected = { ...objective, ...draft };
      expect(edited).toStrictEqual({ ok: true, value: expected });
      expect(created.value).toStrictEqual(objective);
      assert(edited.ok);

      const reason = 'Quarterly review is complete';
      expect(closeGoalRecord(edited.value, { outcome, reason })).toStrictEqual({
        ok: true,
        value: { ...expected, status: 'closed', outcome, closureReason: reason },
      });
      expect(edited.value).toStrictEqual(expected);
    });
  });

  describe('Reject an Objective without an annual goal', () => {
    it.each([
      ['', 'required'],
      ['   ', 'required'],
      [unknownAnnualGoalKey, 'unknown-parent'],
    ])('rejects parent key %j on creation and update', (annualGoalKey, code) => {
      const draft = Object.freeze({ ...objectiveDraft, annualGoalKey });
      expectRejected(createObjective(draft, annualGoals), 'annualGoalKey', code);
      expectRejected(updateObjective(objective, draft, annualGoals), 'annualGoalKey', code);
    });
  });

  describe('Require an Objective statement and quarter', () => {
    describe.each(['statement', 'quarter'] as const)('%s', (field) => {
      it.each(blank)('rejects %j on creation and update', (value) => {
        const draft = Object.freeze({ ...objectiveDraft, [field]: value });
        expectRejected(createObjective(draft, annualGoals), field);
        expectRejected(updateObjective(objective, draft, annualGoals), field);
      });
    });
  });

  describe('Require outcome and reason to close a goal or Objective', () => {
    it.each([
      [{ outcome: '', reason: 'The review is complete' }, 'outcome', 'required'],
      [{ outcome: 'not-achieved', reason: 'The review is complete' }, 'outcome', 'invalid'],
      [{ outcome: 'completed', reason: '' }, 'reason', 'required'],
      [{ outcome: 'completed', reason: '   ' }, 'reason', 'required'],
    ] as const)('rejects %j for both record kinds', (closure, field, code) => {
      expectRejected(closeGoalRecord(annualGoal, closure), field, code);
      expectRejected(closeGoalRecord(objective, closure), field, code);
    });
  });
});

describe('key-results', () => {
  describe('Create edit and close a KR', () => {
    it.each(krOutcomes)('preserves the edited fields and parent when closed as %s', (outcome) => {
      const draft = Object.freeze({ ...krDraft, dataSource: '  Weekly release report  ' });
      const created = createKr(draft, objectives);
      const expectedCreated = { ...krVersion, ...draft, history: [] };
      expect(created).toStrictEqual({ ok: true, value: expectedCreated });
      assert(created.ok);

      const edit = Object.freeze({ ...revisedFields, objectiveKey });
      const edited = updateKr(created.value, edit, objectives);
      const expectedEdited = { ...expectedCreated, ...edit };
      expect(edited).toStrictEqual({ ok: true, value: expectedEdited });
      expect(created.value).toStrictEqual(expectedCreated);
      assert(edited.ok);

      const reason = 'The release review is complete';
      expect(closeGoalRecord(edited.value, { outcome, reason })).toStrictEqual({
        ok: true,
        value: { ...expectedEdited, status: 'closed', outcome, closureReason: reason },
      });
      expect(edited.value).toStrictEqual(expectedEdited);
    });
  });

  describe('Reject an incomplete KR save', () => {
    describe.each(requiredKrFields)('%s', (field) => {
      it.each(blank)('reports a value of %j on creation, update and revision', (value) => {
        const fields = Object.freeze({ ...krFields, [field]: value });
        const draft = Object.freeze({ ...fields, objectiveKey });
        expectRejected(createKr(draft, objectives), field);
        expectRejected(updateKr(kr, draft, objectives), field);
        expectRejected(reviseKr(closedKr, fields, revisionReason), field);
      });
    });

    it('reports all missing fields in validation order', () => {
      const draft = Object.freeze({
        objectiveKey,
        target: '',
        dataSource: '',
        baseline: '',
        statement: '',
      });
      const rejection = {
        ok: false,
        errors: requiredKrFields.map((field) => ({ field, code: 'required' })),
      };
      expect(createKr(draft, objectives)).toStrictEqual(rejection);
      expect(updateKr(kr, draft, objectives)).toStrictEqual(rejection);
    });
  });

  describe('Reject creation of a KR without an existing Objective', () => {
    it.each([
      ['', 'required'],
      ['   ', 'required'],
      [unknownObjectiveKey, 'unknown-parent'],
    ])('rejects parent key %j with all KR fields filled', (objectiveKey, code) => {
      const draft = Object.freeze({ ...krFields, objectiveKey });
      expectRejected(createKr(draft, objectives), 'objectiveKey', code);
    });
  });

  describe('Reject editing a KR without an existing Objective', () => {
    it.each([
      { key: '', code: 'required', parents: objectives, caseName: 'empty key' },
      { key: '   ', code: 'required', parents: objectives, caseName: 'whitespace key' },
      {
        key: unknownObjectiveKey,
        code: 'unknown-parent',
        parents: objectives,
        caseName: 'unknown key',
      },
      {
        key: objectiveKey,
        code: 'unknown-parent',
        parents: Object.freeze({}),
        caseName: 'parent removed by sync',
      },
    ])('rejects an edit with $caseName', ({ key, code, parents }) => {
      const before = structuredClone(kr);
      const draft = Object.freeze({ ...revisedFields, objectiveKey: key });
      expectRejected(updateKr(kr, draft, parents), 'objectiveKey', code);
      expect(kr).toStrictEqual(before);
    });
  });

  describe('Require an outcome and reason to close a KR', () => {
    it.each([
      [{ outcome: '', reason: krClosure.reason }, 'outcome', 'required'],
      [{ outcome: 'completed', reason: krClosure.reason }, 'outcome', 'invalid'],
      [{ outcome: krClosure.outcome, reason: '' }, 'reason', 'required'],
      [{ outcome: krClosure.outcome, reason: '   ' }, 'reason', 'required'],
    ] as const)('rejects %j and preserves the active KR', (closure, field, code) => {
      const before = structuredClone(kr);
      expectRejected(closeGoalRecord(kr, closure), field, code);
      expect(kr).toStrictEqual(before);
    });
  });

  it('Revise a KR with a reason', () => {
    const before = structuredClone(kr);
    expect(reviseKr(kr, revisedFields, revisionReason)).toStrictEqual({
      ok: true,
      value: {
        ...krVersion,
        ...revisedFields,
        history: [previousRevision, { ...krVersion, revisionReason }],
      },
    });
    expect(kr).toStrictEqual(before);
  });

  it('Revise a closed KR without changing its closure', () => {
    const before = structuredClone(closedKr);
    expect(reviseKr(closedKr, revisedFields, revisionReason)).toStrictEqual({
      ok: true,
      value: {
        ...closedKrVersion,
        ...revisedFields,
        history: [previousRevision, { ...closedKrVersion, revisionReason }],
      },
    });
    expect(closedKr).toStrictEqual(before);
  });

  describe('Reject a revision without a reason', () => {
    describe.each([kr, closedKr])('with status $status', (record) => {
      it.each(blank)('rejects reason %j and preserves the record and history', (reason) => {
        const before = structuredClone(record);
        expectRejected(reviseKr(record, revisedFields, reason), 'revisionReason');
        expect(record).toStrictEqual(before);
      });
    });
  });

  it('Preserve history on an ordinary KR write', () => {
    const before = structuredClone(kr);
    const draft = Object.freeze({ ...revisedFields, objectiveKey });
    const edited = updateKr(kr, draft, objectives);
    const expected = { ...before, ...draft };
    expect(edited).toStrictEqual({ ok: true, value: expected });
    expect(kr).toStrictEqual(before);
    assert(edited.ok);

    expect(closeGoalRecord(edited.value, krClosure)).toStrictEqual({
      ok: true,
      value: {
        ...expected,
        status: 'closed',
        outcome: krClosure.outcome,
        closureReason: krClosure.reason,
      },
    });
    expect(edited.value).toStrictEqual(expected);
  });
});
