import { describe, expect, it } from 'vitest';
import { reviseKr, updateKr, type AnnualGoal, type Kr, type Objective } from '../../src/core/goals';
import {
  applyPlan,
  buildPlan,
  classifyPlan,
  MODEL_VERSION,
  type PlanState,
} from '../../src/core/plan';
import { canonicalJson } from '../../src/core/records';

const annualGoalKey = 'annual-goal:00000000-0000-4000-8000-000000000001';
const objectiveKey = 'objective:00000000-0000-4000-8000-000000000002';
const krKey = 'kr:00000000-0000-4000-8000-000000000003';
const at = Date.UTC(2026, 10, 18, 9);
const maxBytes = 256 * 1024;
const currentSchema: number = MODEL_VERSION;
const annualGoal = {
  kind: 'annual-goal',
  status: 'active',
  statement: 'Reduce support wait time',
} satisfies AnnualGoal;
const objective = {
  kind: 'objective',
  status: 'active',
  statement: 'Answer requests faster',
  quarter: '2026-Q4',
  annualGoalKey,
} satisfies Objective;
const previousKr = {
  kind: 'kr',
  status: 'closed',
  statement: 'Shorten median wait',
  baseline: '12 minutes',
  dataSource: 'Support report',
  target: '8 minutes',
  objectiveKey,
  outcome: 'achieved',
  closureReason: 'Quarter ended',
} as const;
const kr = { ...previousKr, history: [] } satisfies Kr;
const tombstone = { deleted: true } as const;
const empty: PlanState = { entries: {} };

type RecordValue = AnnualGoal | Objective | Kr | typeof tombstone;
type PlanInput = { readonly key: string; readonly base: string; readonly record: RecordValue };
type Plan = ReturnType<typeof buildPlan>;
type PlanWrite = { readonly key: string; readonly base: string; readonly value: string };

function version(id: number): string {
  return `10000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
}

function stored(record: RecordValue, id: number, time = at) {
  return { v: MODEL_VERSION, ver: version(id), at: time, ...record };
}

function makePlan(
  writes: readonly PlanInput[],
  firstVersion: number,
  time = at,
  origin: 'manual' | 'kr-revision' = 'manual',
): Plan {
  let id = firstVersion;
  return buildPlan(origin, writes, { at: time, newId: () => version(id++) });
}

function goalCreation() {
  return makePlan([{ key: annualGoalKey, base: 'absent', record: annualGoal }], 1);
}

function expectRejection(state: PlanState, plan: Plan, reason: string): void {
  const before = structuredClone(state);
  const originalPlan = structuredClone(plan);

  expect(classifyPlan(state, plan)).toEqual({ ok: false, reason });
  expect(applyPlan(state, plan)).toEqual(before);
  expect(state).toEqual(before);
  expect(plan).toEqual(originalPlan);
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function cyrillicPadding(bytes: number): string {
  return 'я'.repeat(Math.floor(bytes / 2)) + 'x'.repeat(bytes % 2);
}

it('replays only the original measurement bytes and rejects reuse of its key', () => {
  const key = 'kr-value:00000000-0000-4000-8000-000000000004';
  const ver = version(2);
  const record = { v: 2, ver, at, kind: 'kr-value', krKey, value: '12,5 кг' };
  const write = { key, base: 'absent', value: canonicalJson(record) };
  const plan: Plan = { v: 2, origin: 'manual', writes: [write] };
  const before = { entries: { [krKey]: JSON.stringify(stored(kr, 1)) } };
  const applied = { entries: { ...before.entries, [key]: write.value } };
  expect.soft(classifyPlan(before, plan)).toEqual({ ok: true, writes: [write] });
  expect.soft(applyPlan(before, plan)).toEqual(applied);
  expect.soft(classifyPlan(applied, plan)).toEqual({ ok: true, writes: [] });
  expect(applyPlan(applied, plan)).toEqual(applied);
  const reformatted = { entries: { ...applied.entries, [key]: `${write.value}\n` } };
  expectRejection(reformatted, plan, 'invalid');

  for (const [raw, base, reason] of [
    [canonicalJson({ ...record, value: 'Подмена' }), 'absent', 'invalid'],
    [canonicalJson({ ...record, ver: version(3) }), 'absent', 'stale'],
    [canonicalJson({ ...record, ver: version(3) }), ver, undefined],
  ] as const) {
    const attempt = { ...plan, writes: [{ key, base, value: raw }] };
    expect
      .soft(classifyPlan(applied, attempt))
      .toMatchObject({ ok: false, ...(reason && { reason }) });
    expect(applyPlan(applied, attempt)).toEqual(applied);
  }
  const deleted = { entries: { ...before.entries, [key]: canonicalJson(stored(tombstone, 3)) } };
  expectRejection(deleted, plan, 'stale');
});

it('applies a new version and skips the same plan on replay', () => {
  const original = { entries: { [annualGoalKey]: JSON.stringify(stored(annualGoal, 1)) } };
  const edited = { ...annualGoal, statement: 'Reduce wait time by half' };
  const now = at + 500;
  const plan = makePlan([{ key: annualGoalKey, base: version(1), record: edited }], 2, now);
  const pristinePlan = structuredClone(plan);
  const expectedValue = stored(edited, 2, now);
  const first = structuredClone(original);
  const second = structuredClone(original);

  expect(classifyPlan(first, plan)).toEqual({ ok: true, writes: plan.writes });
  const applied = applyPlan(first, plan);
  expect(applied).toEqual({ entries: { [annualGoalKey]: plan.writes[0]!.value } });
  expect(JSON.parse(applied.entries[annualGoalKey]!)).toEqual(expectedValue);
  expect(applyPlan(second, plan)).toEqual(applied);
  const beforeReplay = structuredClone(applied);
  expect(classifyPlan(applied, plan)).toEqual({ ok: true, writes: [] });
  expect(applyPlan(applied, plan)).toEqual(beforeReplay);
  expect(applied).toEqual(beforeReplay);
  expect(first).toEqual(original);
  expect(second).toEqual(original);
  expect(plan).toEqual(pristinePlan);
});

describe('rejects the whole stale plan and an absent base over a tombstone', () => {
  it('leaves even a valid write untouched when another base changed', () => {
    const state = { entries: { [annualGoalKey]: JSON.stringify(stored(annualGoal, 3)) } };
    const plan = makePlan(
      [
        { key: objectiveKey, base: 'absent', record: objective },
        { key: annualGoalKey, base: version(1), record: annualGoal },
      ],
      4,
    );

    expectRejection(state, plan, 'stale');
  });

  it('does not resurrect a deleted record by replaying its creation', () => {
    const create = goalCreation();
    const remove = makePlan([{ key: annualGoalKey, base: version(1), record: tombstone }], 2);
    const current = { entries: { [annualGoalKey]: JSON.stringify(stored(tombstone, 2)) } };
    expect(JSON.parse(remove.writes[0]!.value)).toEqual(stored(tombstone, 2));
    expect(applyPlan(applyPlan(empty, create), remove)).toEqual({
      entries: { [annualGoalKey]: remove.writes[0]!.value },
    });

    const plan = {
      ...create,
      writes: [
        ...makePlan([{ key: objectiveKey, base: 'absent', record: objective }], 3).writes,
        ...create.writes,
      ],
    };
    expectRejection(current, create, 'stale');
    expectRejection(current, plan, 'stale');
  });
});

describe('resumes a partially applied plan only with unchanged bases', () => {
  const state = { entries: { [annualGoalKey]: JSON.stringify(stored(annualGoal, 1)) } };
  const changedGoal = { ...annualGoal, statement: 'Reduce wait for urgent requests' };
  const writes = [
    { key: annualGoalKey, base: version(1), record: changedGoal },
    { key: objectiveKey, base: 'absent', record: objective },
    { key: krKey, base: 'absent', record: kr },
  ];

  it.each([[], [0], [1], [2], [0, 1], [0, 2], [1, 2], [0, 1, 2]].map((indices) => ({ indices })))(
    'writes only the remainder after delivery of indices $indices',
    ({ indices }) => {
      const plan = makePlan(writes, 2);
      const planWrites: readonly PlanWrite[] = plan.writes;
      const delivered = indices.map((index) => planWrites[index]!);
      const partial: PlanState = {
        entries: {
          ...state.entries,
          ...Object.fromEntries(delivered.map(({ key, value }) => [key, value])),
        },
      };
      const before = structuredClone(partial);
      const pending = planWrites.filter((_write, index) => !indices.includes(index));

      expect(classifyPlan(partial, plan)).toEqual({ ok: true, writes: pending });
      expect(applyPlan(partial, plan)).toEqual({
        entries: Object.fromEntries(planWrites.map(({ key, value }) => [key, value])),
      });
      expect(partial).toEqual(before);
    },
  );

  it.each([
    { label: 'an unapplied key', key: annualGoalKey, record: annualGoal },
    { label: 'an already applied key', key: objectiveKey, record: objective },
  ])('rejects the remainder when a different version reaches $label', ({ key, record }) => {
    const plan = makePlan(writes, 2);
    const partial = {
      entries: {
        ...state.entries,
        [objectiveKey]: plan.writes[1]!.value,
        [key]: JSON.stringify(stored(record, 5)),
      },
    };

    expectRejection(partial, plan, 'stale');
  });
});

describe('checks UTF-8 size and preserves history at the limit', () => {
  const snapshot = { ...previousKr, revisionReason: 'Corrected the reporting method' };
  const record = { ...kr, history: [snapshot] };

  it('accepts exactly 256 KiB and rejects a multibyte overflow atomically', () => {
    const padBytes = maxBytes - utf8Size(JSON.stringify(stored(annualGoal, 1)));
    const statement = annualGoal.statement + cyrillicPadding(padBytes);
    const exact = makePlan(
      [{ key: annualGoalKey, base: 'absent', record: { ...annualGoal, statement } }],
      1,
    );
    expect(utf8Size(exact.writes[0]!.value)).toBe(maxBytes);
    expect(classifyPlan(empty, exact)).toEqual({ ok: true, writes: exact.writes });
    expect(applyPlan(empty, exact)).toEqual({
      entries: { [annualGoalKey]: exact.writes[0]!.value },
    });

    const overflow = { ...annualGoal, statement: statement + 'x' };
    const value = JSON.stringify(stored(overflow, 1));
    expect(value.length).toBeLessThan(maxBytes);
    expect(utf8Size(value)).toBe(maxBytes + 1);
    const plan = {
      ...exact,
      writes: [
        ...makePlan([{ key: objectiveKey, base: 'absent', record: objective }], 2).writes,
        { ...exact.writes[0]!, value },
      ],
    };
    expectRejection(empty, plan, 'size');
  });

  it('preserves a KR at the history limit even when an ordinary edit still fits', () => {
    const padBytes = maxBytes - utf8Size(JSON.stringify(stored(record, 1)));
    const full = {
      ...record,
      history: [
        { ...snapshot, revisionReason: snapshot.revisionReason + cyrillicPadding(padBytes) },
      ],
    };
    const currentValue = JSON.stringify(stored(full, 1));
    const state = { entries: { [krKey]: currentValue } };
    const plan = makePlan(
      [{ key: krKey, base: version(1), record: { ...full, target: '7 minutes' } }],
      2,
    );

    expect(utf8Size(currentValue)).toBe(maxBytes);
    expect(utf8Size(plan.writes[0]!.value)).toBe(maxBytes);
    expectRejection(state, plan, 'history');
  });
});

describe('rejects an invalid or forged plan', () => {
  it('rejects the whole plan when a target value is non-canonical JSON', () => {
    const state = applyPlan(empty, goalCreation());
    const plan = makePlan(
      [
        {
          key: annualGoalKey,
          base: version(1),
          record: { ...annualGoal, statement: 'Reduce wait for urgent requests' },
        },
        { key: objectiveKey, base: 'absent', record: objective },
      ],
      2,
    );
    expect(classifyPlan(state, plan)).toEqual({ ok: true, writes: plan.writes });

    const objectiveWrite = plan.writes[1]!;
    const nonCanonicalPlan = {
      ...plan,
      writes: [plan.writes[0]!, { ...objectiveWrite, value: `${objectiveWrite.value} ` }],
    };
    expectRejection(state, nonCanonicalPlan, 'invalid');
  });

  it('rejects duplicate keys even if their writes are identical', () => {
    const plan = goalCreation();
    expectRejection(empty, { ...plan, writes: [...plan.writes, ...plan.writes] }, 'invalid');
  });

  it('rejects an invalid record key', () => {
    const plan = goalCreation();
    expectRejection(
      empty,
      { ...plan, writes: [{ ...plan.writes[0]!, key: 'annual-goal:no-uuid' }] },
      'invalid',
    );
  });

  it('rejects a future version in the plan envelope or target value', () => {
    const plan = goalCreation();
    expectRejection(empty, { ...plan, v: currentSchema + 1 }, 'unsupported-version');
    const value = JSON.stringify({ ...stored(annualGoal, 1), v: currentSchema + 1 });
    expectRejection(
      empty,
      { ...plan, writes: [{ ...plan.writes[0]!, value }] },
      'unsupported-version',
    );
  });

  it('rejects writing over a current record of a newer model even on its matching base', () => {
    const current = { ...stored(annualGoal, 1), v: currentSchema + 1 };
    const state = { entries: { [annualGoalKey]: JSON.stringify(current) } };
    const plan = makePlan([{ key: annualGoalKey, base: version(1), record: annualGoal }], 2);

    expectRejection(state, plan, 'unsupported-version');
  });

  it('rejects a different value forged with an already applied version', () => {
    const plan = goalCreation();
    const state = applyPlan(empty, plan);
    const value = JSON.stringify(stored({ ...annualGoal, statement: 'Forged edit' }, 1));

    expectRejection(state, { ...plan, writes: [{ ...plan.writes[0]!, value }] }, 'invalid');
  });

  it('rejects a history append made through an ordinary edit', () => {
    const state = { entries: { [krKey]: JSON.stringify(stored(kr, 1)) } };
    const plan = makePlan(
      [{ key: krKey, base: version(1), record: { ...kr, target: '7 minutes' } }],
      2,
    );
    const revised = reviseKr(kr, { ...kr, target: '7 minutes' }, 'Changed the target');
    if (!revised.ok) throw new Error('Expected a valid explicit revision');
    const value = JSON.stringify(stored(revised.value, 2));

    expectRejection(state, { ...plan, writes: [{ ...plan.writes[0]!, value }] }, 'history');
  });

  it('rejects an explicit revision with a snapshot of the wrong previous value', () => {
    const state = { entries: { [krKey]: JSON.stringify(stored(kr, 1)) } };
    const value = JSON.stringify(
      stored(
        {
          ...kr,
          target: '7 minutes',
          history: [{ ...previousKr, baseline: '99 minutes', revisionReason: 'New target' }],
        },
        2,
      ),
    );
    const plan: Plan = {
      v: MODEL_VERSION,
      origin: 'kr-revision',
      writes: [{ key: krKey, base: version(1), value }],
    };

    expectRejection(state, plan, 'history');
  });
});

it('computes the state for successive plans on their current bases', () => {
  const legacy = 'legacy demonstration data';
  const initial = { entries: { state: legacy } };
  const create = makePlan(
    [
      { key: annualGoalKey, base: 'absent', record: annualGoal },
      { key: objectiveKey, base: 'absent', record: objective },
      { key: krKey, base: 'absent', record: kr },
    ],
    1,
  );
  const reason = 'Use a more representative source';
  const revised = reviseKr(kr, { ...kr, dataSource: 'Support dashboard' }, reason);
  if (!revised.ok) throw new Error('Expected a valid explicit revision');
  const revision = makePlan(
    [{ key: krKey, base: version(3), record: revised.value }],
    4,
    at + 100,
    'kr-revision',
  );
  const edited = updateKr(
    revised.value,
    { ...revised.value, statement: 'Shorten median wait for all queues' },
    { [objectiveKey]: objective },
  );
  if (!edited.ok) throw new Error('Expected a valid ordinary edit');
  const edit = makePlan([{ key: krKey, base: version(4), record: edited.value }], 5, at + 200);

  const result = [create, revision, edit].reduce<PlanState>(applyPlan, initial);
  expect(result.entries).toEqual({
    state: legacy,
    [annualGoalKey]: create.writes[0]!.value,
    [objectiveKey]: create.writes[1]!.value,
    [krKey]: edit.writes[0]!.value,
  });
  expect(JSON.parse(result.entries[annualGoalKey]!)).toEqual(stored(annualGoal, 1));
  expect(JSON.parse(result.entries[objectiveKey]!)).toEqual(stored(objective, 2));
  expect(JSON.parse(result.entries[krKey]!)).toEqual(
    stored(
      {
        ...kr,
        statement: 'Shorten median wait for all queues',
        dataSource: 'Support dashboard',
        history: [{ ...previousKr, revisionReason: reason }],
      },
      5,
      at + 200,
    ),
  );
  expect(initial).toEqual({ entries: { state: legacy } });
});
