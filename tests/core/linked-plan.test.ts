import { describe, expect, it } from 'vitest';
import { applyPlan, buildPlan, classifyPlan, type Plan, type PlanState } from '../../src/core/plan';
import { canonicalJson, WIPE_KEY } from '../../src/core/records';

const initiativeKey = 'initiative:183803da-3882-5fec-aec2-e3a6d6978a1f';
const taskMetaKey = 'task-meta:9beace6d-4c3c-5d0e-b7d3-1e6e196953fa';
const krKey = 'kr:00000000-0000-4000-8000-000000000003';
const objectiveKey = 'objective:00000000-0000-4000-8000-000000000004';
const annualGoalKey = 'annual-goal:00000000-0000-4000-8000-000000000005';
const at = Date.UTC(2026, 10, 18, 9);
const maxBytes = 256 * 1024;
const empty: PlanState = { entries: {} };

const initiative = {
  kind: 'initiative',
  projectKey: 'project:PrOj-é',
  krKey,
  initiativeType: 'regular',
  cadence: 'Every Monday',
} as const;
const taskMeta = {
  kind: 'task-meta',
  taskKey: 'task:rpt_🚀',
  initiativeKey,
  sphereTagKey: 'tag:Release',
  directKrKeys: [krKey],
} as const;
const tombstone = { deleted: true } as const;
const previousKr = {
  kind: 'kr',
  status: 'closed',
  statement: 'Shorten release lead time',
  baseline: '10 days',
  target: '8 days',
  dataSource: 'Release audit',
  objectiveKey,
  outcome: 'achieved',
  closureReason: 'Review complete',
} as const;
const kr = {
  ...previousKr,
  target: '7 days',
  history: [{ ...previousKr, revisionReason: 'Use the audited baseline' }],
} as const;

const version = (id: number) => `20000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const stored = (record: object, id: number, schema = 2) =>
  canonicalJson({ ...record, v: schema, ver: version(id), at });

type Write = Plan['writes'][number];

function write(key: string, record: object, targetId: number, base = 'absent'): Write {
  return { key, base, value: stored(record, targetId) };
}

function manual(...writes: Write[]): Plan {
  return { v: 2, origin: 'manual', writes };
}

function expectRejected(state: PlanState, plan: Plan, reason: string): void {
  const before = structuredClone(state);
  const submitted = structuredClone(plan);
  const rejected = classifyPlan(state, plan);
  expect(applyPlan(state, plan)).toStrictEqual(before);
  expect(state).toStrictEqual(before);
  expect(plan).toStrictEqual(submitted);
  expect(rejected).toStrictEqual({ ok: false, reason });
}

const initiativeCreation = write(initiativeKey, initiative, 11);
const taskCreation = write(taskMetaKey, taskMeta, 12);
const krState = { entries: { [krKey]: stored(kr, 1, 1) } };
const krEdit = write(krKey, { ...kr, target: '6 days' }, 13, version(1));

function filledCadence(bytes: number): string {
  return 'я'.repeat(Math.floor(bytes / 2)) + 'x'.repeat(bytes % 2);
}

const cadenceBytes =
  maxBytes - new TextEncoder().encode(stored({ ...initiative, cadence: '' }, 11)).byteLength;
const exactCadence = filledCadence(cadenceBytes);

describe('Block an unread listed key and stale or invalid plans', () => {
  it('distinguishes a free key from an unread listed key and retains other unread keys', () => {
    const goal = { kind: 'annual-goal', status: 'active', statement: 'Ship reliably' } as const;
    const versions = [version(13), version(14)].values();
    const plan = buildPlan(
      'manual',
      [
        { key: krKey, base: version(1), record: { ...kr, target: '6 days' } },
        { key: annualGoalKey, base: 'absent', record: goal },
      ],
      { at, newId: () => versions.next().value! },
    );
    const unrelatedUnreadKey = objectiveKey;
    const free: PlanState = { ...krState, unreadKeys: [unrelatedUnreadKey] };
    const blocked: PlanState = { ...free, unreadKeys: [unrelatedUnreadKey, annualGoalKey] };

    const before = structuredClone(blocked);
    expect(classifyPlan(free, plan)).toStrictEqual({ ok: true, writes: plan.writes });
    expect(classifyPlan(blocked, plan)).toMatchObject({ ok: false });
    expect(applyPlan(blocked, plan)).toStrictEqual(before);
    expect(blocked).toStrictEqual(before);
    expect(applyPlan(free, plan)).toStrictEqual({
      entries: { [krKey]: plan.writes[0]!.value, [annualGoalKey]: plan.writes[1]!.value },
      unreadKeys: [unrelatedUnreadKey],
    });
  });

  it('rejects a v1 plan envelope even if its target is valid v2', () => {
    expectRejected(empty, { ...manual(initiativeCreation), v: 1 }, 'unsupported-version');
  });

  it.each([
    {
      label: 'a v1 target that is valid for reading',
      bad: { ...krEdit, value: stored({ ...kr, target: '6 days' }, 13, 1) },
      first: taskCreation,
      reason: 'unsupported-version',
    },
    {
      label: 'an extra field',
      bad: write(initiativeKey, { ...initiative, extra: true }, 11),
      first: krEdit,
      reason: 'invalid',
    },
    {
      label: 'noncanonical JSON',
      bad: { ...initiativeCreation, value: initiativeCreation.value + '\n' },
      first: krEdit,
      reason: 'invalid',
    },
    {
      label: 'a one-byte UTF-8 overflow',
      bad: write(initiativeKey, { ...initiative, cadence: exactCadence + 'x' }, 11),
      first: krEdit,
      reason: 'size',
    },
  ])('rejects the entire plan on $label', ({ first, bad, reason }) => {
    expectRejected(krState, manual(first, bad), reason);
  });

  it('accepts exactly 256 KiB of UTF-8, including multibyte cadence text', () => {
    const writeAtLimit = write(initiativeKey, { ...initiative, cadence: exactCadence }, 11);
    expect(new TextEncoder().encode(writeAtLimit.value)).toHaveLength(maxBytes);
    expect(writeAtLimit.value.length).toBeLessThan(maxBytes);
    const plan = manual(krEdit, writeAtLimit);
    expect(classifyPlan(krState, plan)).toStrictEqual({ ok: true, writes: plan.writes });
    expect(applyPlan(krState, plan).entries).toStrictEqual({
      [krKey]: krEdit.value,
      [initiativeKey]: writeAtLimit.value,
    });
  });

  it('Reject a stale base before writing any entry', () => {
    const state = { entries: { [krKey]: stored(kr, 2, 1) } };
    expectRejected(state, manual(taskCreation, krEdit), 'stale');
  });

  it('rejects a manual edit that replaces the previous KR history', () => {
    const rewritten = write(
      krKey,
      { ...kr, history: [{ ...kr.history[0], revisionReason: 'A different reason' }] },
      13,
      version(1),
    );
    expectRejected(krState, manual(taskCreation, rewritten), 'history');
  });
});

describe('protects the original source reference of an existing linked record', () => {
  it.each([
    {
      key: initiativeKey,
      record: initiative,
      update: { ...initiative, projectKey: 'project:PrOj-e\u0301' },
    },
    {
      key: taskMetaKey,
      record: taskMeta,
      update: { ...taskMeta, taskKey: 'task:rpt_🚀-copy' },
    },
  ])('keeps the exact source reference at $key, including on a matching base', (testCase) => {
    const { key, record, update } = testCase;
    const state = { entries: { ...krState.entries, [key]: stored(record, 1) } };
    const valid = write(key, record, 2, version(1));
    expect(classifyPlan(state, manual(valid))).toStrictEqual({ ok: true, writes: [valid] });
    expectRejected(state, manual(krEdit, write(key, update, 2, version(1))), 'invalid');
  });
});

describe('Replay a plan with its original version', () => {
  const plan = manual(initiativeCreation, taskCreation);
  const first = { entries: { [initiativeKey]: initiativeCreation.value } };

  it('classifies only the unapplied suffix, preserving its exact value and version', () => {
    const originalPlan = structuredClone(plan);
    expect(classifyPlan(empty, plan)).toStrictEqual({ ok: true, writes: plan.writes });
    expect(classifyPlan(first, plan)).toStrictEqual({ ok: true, writes: [taskCreation] });

    const applied = applyPlan(first, plan);
    expect(applied.entries).toStrictEqual({
      [initiativeKey]: initiativeCreation.value,
      [taskMetaKey]: taskCreation.value,
    });
    expect(applyPlan(empty, plan)).toStrictEqual(applied);
    expect(classifyPlan(applied, plan)).toStrictEqual({ ok: true, writes: [] });
    expect(applyPlan(applied, plan)).toStrictEqual(applied);
    expect(first.entries).toStrictEqual({ [initiativeKey]: initiativeCreation.value });
    expect(plan).toStrictEqual(originalPlan);
  });

  it.each([
    { label: 'the same version with different canonical bytes', id: 11, reason: 'invalid' },
    { label: 'an intervening version', id: 21, reason: 'stale' },
  ])('leaves the suffix untouched after $label', ({ id, reason }) => {
    const otherValue = stored({ ...initiative, cadence: 'Every Friday' }, id);
    expectRejected({ entries: { [initiativeKey]: otherValue } }, plan, reason);
  });

  it('also rejects a replay whose stored bytes differ only in JSON whitespace', () => {
    const state = { entries: { [initiativeKey]: initiativeCreation.value + '\n' } };
    expectRejected(state, plan, 'invalid');
  });
});

describe('Apply existing tombstone and wipe rules to linked keys', () => {
  it.each([
    { key: initiativeKey, record: initiative },
    { key: taskMetaKey, record: taskMeta },
  ])('rejects resurrection of $key from either base', ({ key, record }) => {
    const state = { entries: { ...krState.entries, [key]: stored(tombstone, 1) } };
    expectRejected(state, manual(krEdit, write(key, record, 2)), 'stale');
    expectRejected(state, manual(krEdit, write(key, record, 2, version(1))), 'stale');
  });

  it('accepts the v2 wipe marker and tombstones for both linked record kinds', () => {
    const live = {
      entries: {
        [initiativeKey]: initiativeCreation.value,
        [taskMetaKey]: taskCreation.value,
      },
    };
    const marker = write(WIPE_KEY, {}, 21);
    const removeInitiative = write(initiativeKey, tombstone, 22, version(11));
    const removeTask = write(taskMetaKey, tombstone, 23, version(12));
    const startWipe = manual(marker);
    const deleteLinked = manual(removeInitiative, removeTask);

    expect(classifyPlan(live, startWipe)).toStrictEqual({ ok: true, writes: [marker] });
    const marked = applyPlan(live, startWipe);
    expect(marked.entries).toStrictEqual({ ...live.entries, [WIPE_KEY]: marker.value });
    expect(classifyPlan(marked, deleteLinked)).toStrictEqual({
      ok: true,
      writes: deleteLinked.writes,
    });
    expect(applyPlan(marked, deleteLinked).entries).toStrictEqual({
      [WIPE_KEY]: marker.value,
      [initiativeKey]: removeInitiative.value,
      [taskMetaKey]: removeTask.value,
    });
  });
});
