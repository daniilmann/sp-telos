import { Buffer } from 'node:buffer';
import { assert, describe, expect, it } from 'vitest';
import type { GoalRecord } from '../../src/core/goals';
import { applyPlan, buildPlan, classifyPlan, MODEL_VERSION, type Plan } from '../../src/core/plan';
import {
  canonicalJson,
  decodeRecord,
  MAX_RECORD_BYTES,
  splitRecord,
  WIPE_KEY,
} from '../../src/core/records';

const annualGoalKey = 'annual-goal:00000000-0000-4000-8000-000000000001';
const objectiveKey = 'objective:00000000-0000-4000-8000-000000000002';
const krKey = 'kr:00000000-0000-4000-8000-000000000003';
const at = Date.UTC(2026, 10, 18, 9);
const ver = '10000000-0000-4000-8000-000000000001';
const currentSchema: number = MODEL_VERSION;
const annualGoal = {
  kind: 'annual-goal',
  status: 'closed',
  statement: 'Сократить время ожидания',
  outcome: 'completed',
  closureReason: 'Итоги подведены',
} as const;
const objective = {
  kind: 'objective',
  status: 'active',
  statement: 'Ускорить обработку заявок',
  quarter: '2026-Q4',
  annualGoalKey,
} as const;
const previousKr = {
  kind: 'kr',
  status: 'closed',
  statement: 'Сократить медианное ожидание',
  baseline: '12 минут',
  dataSource: 'Отчёт «Заявки»',
  target: '8 минут',
  objectiveKey,
  outcome: 'achieved',
  closureReason: 'Измерение завершено',
} as const;
const kr = {
  ...previousKr,
  target: '7 минут',
  history: [{ ...previousKr, revisionReason: 'Уточнили ориентир' }],
} as const;

const records: ReadonlyArray<readonly [string, GoalRecord | { readonly deleted: true }]> = [
  [annualGoalKey, annualGoal],
  [objectiveKey, objective],
  [krKey, kr],
  [krKey, { deleted: true }],
];

describe('KR measurement records', () => {
  const key = 'kr-value:00000000-0000-4000-8000-000000000009';
  const record = { v: 2, ver, at, kind: 'kr-value', krKey, value: '0' };

  it('decodes a measurement and its tombstone and rejects invalid or unsupported records', () => {
    const tombstone = { v: 2, ver, at, deleted: true };
    expect.soft(decodeRecord(key, canonicalJson(record))).toEqual({ ok: true, value: record });
    expect
      .soft(decodeRecord(key, canonicalJson(tombstone)))
      .toEqual({ ok: true, value: tombstone });
    for (const [fields, reason] of [
      [{ v: 1 }, 'invalid'],
      [{ value: '' }, 'invalid'],
      [{ value: ' \t' }, 'invalid'],
      [{ value: 0 }, 'invalid'],
      [{ krKey: objectiveKey }, 'invalid'],
      [{ extra: true }, 'invalid'],
      [{ v: 3 }, 'unsupported-version'],
    ] as const) {
      expect
        .soft(decodeRecord(key, canonicalJson({ ...record, ...fields })), canonicalJson(fields))
        .toEqual({ ok: false, reason });
    }
  });

  it('counts the entire measurement in UTF-8 at the storage boundary', () => {
    const remaining = MAX_RECORD_BYTES - Buffer.byteLength(canonicalJson({ ...record, value: '' }));
    const value = 'я'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2);
    const exact = canonicalJson({ ...record, value });
    const overflow = canonicalJson({ ...record, value: value + 'x' });
    expect(Buffer.byteLength(exact)).toBe(MAX_RECORD_BYTES);
    expect(Buffer.byteLength(overflow)).toBe(MAX_RECORD_BYTES + 1);
    expect.soft(decodeRecord(key, exact).ok).toBe(true);
    expect(decodeRecord(key, overflow)).toEqual({ ok: false, reason: 'size' });
  });

  it('replays only the original measurement bytes and rejects reuse of its key', () => {
    const measurement = {
      ...record,
      ver: '10000000-0000-4000-8000-000000000002',
      value: '12,5 кг',
    };
    const nextVer = '10000000-0000-4000-8000-000000000003';
    const write = { key, base: 'absent', value: canonicalJson(measurement) };
    const plan: Plan = { v: 2, origin: 'manual', writes: [write] };
    const before = { entries: { [krKey]: canonicalJson({ ...kr, v: MODEL_VERSION, ver, at }) } };
    const applied = { entries: { ...before.entries, [key]: write.value } };
    expect.soft(classifyPlan(applied, plan)).toEqual({ ok: true, writes: [] });
    expect.soft(applyPlan(applied, plan)).toEqual(applied);

    const newer = canonicalJson({ ...measurement, ver: nextVer });
    const cases = [
      ['different stored bytes', `${write.value}\n`, write, 'invalid'],
      [
        'different value at the same version',
        write.value,
        { ...write, value: canonicalJson({ ...measurement, value: 'Подмена' }) },
        'invalid',
      ],
      ['new version at the same key', write.value, { ...write, value: newer }, 'stale'],
      [
        'overwrite against the current version',
        write.value,
        { ...write, value: newer, base: measurement.ver },
        undefined,
      ],
      [
        'tombstoned measurement',
        canonicalJson({ v: 2, ver: nextVer, at, deleted: true }),
        write,
        'stale',
      ],
    ] as const;
    for (const [label, raw, attemptWrite, reason] of cases) {
      const state = { entries: { ...before.entries, [key]: raw } };
      const attempt = { ...plan, writes: [attemptWrite] };
      const snapshot = structuredClone(state);
      const originalPlan = structuredClone(attempt);
      expect
        .soft(classifyPlan(state, attempt), label)
        .toMatchObject({ ok: false, ...(reason && { reason }) });
      expect.soft(applyPlan(state, attempt), label).toEqual(snapshot);
      expect.soft(state, label).toEqual(snapshot);
      expect.soft(attempt, label).toEqual(originalPlan);
    }
  });
});

describe('round-trips each record with a child-to-parent key', () => {
  it.each(records)('writes and reads %s with %j', (key, record) => {
    const stored = { v: MODEL_VERSION, ver, at, ...record };
    const expected = JSON.stringify(stored);
    const plan = buildPlan('manual', [{ key, base: 'absent', record }], { at, newId: () => ver });

    expect(plan).toMatchObject({ v: MODEL_VERSION, origin: 'manual' });
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]).toMatchObject({ key, base: 'absent' });
    expect(JSON.parse(plan.writes[0]!.value)).toEqual(stored);
    expect(decodeRecord(key, plan.writes[0]!.value)).toEqual({ ok: true, value: stored });
    expect(decodeRecord(key, expected)).toEqual({ ok: true, value: stored });
  });

  it.each([
    { objectiveDevice: 1, krDevice: 1 },
    { objectiveDevice: 1, krDevice: 2 },
    { objectiveDevice: 2, krDevice: 1 },
    { objectiveDevice: 2, krDevice: 2 },
  ] as const)(
    'retains the link and branch history with Objective from device $objectiveDevice and KR from device $krDevice',
    ({ objectiveDevice, krDevice }) => {
      const objectives = {
        1: { ...objective, ver: '20000000-0000-4000-8000-000000000001' },
        2: {
          ...objective,
          statement: 'Ускорить обработку срочных заявок',
          ver: '20000000-0000-4000-8000-000000000002',
        },
      };
      const results = {
        1: { ...kr, ver: '30000000-0000-4000-8000-000000000001' },
        2: {
          ...kr,
          target: '6 минут',
          history: [{ ...previousKr, revisionReason: 'Поменяли методику отчёта' }],
          ver: '30000000-0000-4000-8000-000000000002',
        },
      };
      const selectedObjective = { v: MODEL_VERSION, at, ...objectives[objectiveDevice] };
      const selectedKr = { v: MODEL_VERSION, at, ...results[krDevice] };

      expect(decodeRecord(objectiveKey, JSON.stringify(selectedObjective))).toEqual({
        ok: true,
        value: selectedObjective,
      });
      expect(decodeRecord(krKey, JSON.stringify(selectedKr))).toEqual({
        ok: true,
        value: selectedKr,
      });
    },
  );
});

it('reports an unsupported model version', () => {
  const stored = { v: MODEL_VERSION, ver, at, ...annualGoal };
  const future = JSON.stringify({ ...stored, v: currentSchema + 1 });

  expect(decodeRecord(annualGoalKey, future)).toMatchObject({
    ok: false,
    reason: 'unsupported-version',
  });
  expect(decodeRecord(annualGoalKey, JSON.stringify(stored))).toEqual({ ok: true, value: stored });
});

const initiativeKey = 'initiative:00000000-0000-5000-8000-000000000004';
const taskMetaKey = 'task-meta:00000000-0000-5000-8000-000000000005';
const sphereTagKey = 'tag:Семья';
const tombstone = { deleted: true } as const;
const initiative = {
  kind: 'initiative',
  projectKey: 'project:PrOj-é',
  krKey,
  initiativeType: 'regular',
  cadence: 'Каждую неделю',
} as const;
const taskMeta = {
  kind: 'task-meta',
  taskKey: 'task:rpt_🚀',
  initiativeKey,
  sphereTagKey,
  directKrKeys: [krKey],
} as const;

describe('Read old values and migrate only on a manual write', () => {
  const archivedAnnualGoal = 'annual-goal:00000000-0000-4000-8000-000000000006';
  const archivedObjective = 'objective:00000000-0000-4000-8000-000000000007';
  const archivedKr = 'kr:00000000-0000-4000-8000-000000000008';
  const legacy = {
    [annualGoalKey]: { v: 1, ver: '10000000-0000-4000-8000-000000000003', at, ...annualGoal },
    [objectiveKey]: { v: 1, ver: '10000000-0000-4000-8000-000000000004', at, ...objective },
    [krKey]: { v: 1, ver, at, ...kr },
    [archivedAnnualGoal]: { v: 1, ver: '10000000-0000-4000-8000-000000000005', at, ...tombstone },
    [archivedObjective]: { v: 1, ver: '10000000-0000-4000-8000-000000000006', at, ...tombstone },
    [archivedKr]: { v: 1, ver: '10000000-0000-4000-8000-000000000007', at, ...tombstone },
    [WIPE_KEY]: { v: 1, ver: '10000000-0000-4000-8000-000000000008', at },
  } as const;

  it.each(Object.entries(legacy))('keeps the literal v1 record at %s when read', (key, value) => {
    const raw = JSON.stringify(value, null, 2) + '\n';
    const entries = Object.freeze({ [key]: raw });
    expect(decodeRecord(key, entries[key]!)).toStrictEqual({ ok: true, value });
    expect(entries).toStrictEqual({ [key]: raw });
  });

  it('migrates only the edited KR and keeps its closure, history and v1 neighbours', () => {
    const entries = Object.freeze(
      Object.fromEntries(
        Object.entries(legacy).map(([key, value]) => [key, JSON.stringify(value, null, 2)]),
      ),
    );
    const state = Object.freeze({ entries });
    const before = structuredClone(state);
    const decoded = decodeRecord(krKey, entries[krKey]!);
    assert(decoded.ok);
    assert('kind' in decoded.value && decoded.value.kind === 'kr');
    const { record, ver: base } = splitRecord(decoded.value);
    assert(typeof base === 'string');
    const edited = { ...record, target: '6 минут' };
    const writeVer = '10000000-0000-4000-8000-000000000002';
    const writeAt = at + 60_000;
    const expectedValue = { ...kr, target: edited.target, v: 2, ver: writeVer, at: writeAt };
    const value = canonicalJson(expectedValue);
    const plan = buildPlan('manual', [{ key: krKey, base, record: edited }], {
      at: writeAt,
      newId: () => writeVer,
    });

    expect(plan).toStrictEqual({
      v: 2,
      origin: 'manual',
      writes: [{ key: krKey, base: ver, value }],
    });
    expect(classifyPlan(state, plan)).toStrictEqual({ ok: true, writes: plan.writes });
    expect(applyPlan(state, plan).entries).toStrictEqual({ ...entries, [krKey]: value });
    expect(decodeRecord(krKey, value)).toStrictEqual({ ok: true, value: expectedValue });
    expect(state).toStrictEqual(before);
  });
});

describe('closed v1 and v2 value schemas', () => {
  const legacyOnly = { v: 1, ver, at };
  const current = { v: 2, ver, at };
  const { cadence, ...regularFields } = initiative;
  const oneOff = { ...regularFields, initiativeType: 'one-off' };
  const openTask = { kind: 'task-meta', taskKey: taskMeta.taskKey, directKrKeys: [] };

  it.each([
    [annualGoalKey, { ...annualGoal, sphereTagKey }],
    [objectiveKey, { ...objective, sphereTagKey }],
    [krKey, kr],
    [initiativeKey, initiative],
    [initiativeKey, oneOff],
    [taskMetaKey, taskMeta],
    [taskMetaKey, openTask],
    [initiativeKey, tombstone],
    [taskMetaKey, tombstone],
    [WIPE_KEY, {}],
  ])('accepts only the v2 record shape at %s (%j)', (key, record) => {
    const value = { ...current, ...record };
    expect(decodeRecord(key, canonicalJson(value))).toStrictEqual({ ok: true, value });
    expect(decodeRecord(key, canonicalJson({ ...value, extra: true }))).toStrictEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it.each([
    [annualGoalKey, { ...annualGoal, sphereTagKey }],
    [objectiveKey, { ...objective, sphereTagKey }],
    [initiativeKey, initiative],
    [taskMetaKey, taskMeta],
    [initiativeKey, tombstone],
    [taskMetaKey, tombstone],
  ])('rejects new fields and kinds under v1 at %s (%j)', (key, record) => {
    expect(decodeRecord(key, canonicalJson({ ...legacyOnly, ...record }))).toMatchObject({
      ok: false,
    });
  });

  it.each([
    [annualGoalKey, { ...annualGoal, sphereTagKey: null }],
    [objectiveKey, { ...objective, sphereTagKey: 'tag:' }],
    [krKey, { ...kr, history: [{ ...kr.history[0], history: [] }] }],
    [krKey, { ...kr, history: [{ ...kr.history[0], ...current }] }],
    [initiativeKey, { ...initiative, projectKey: 'task:PrOj-é' }],
    [initiativeKey, { ...initiative, projectKey: 'project:' }],
    [initiativeKey, { ...initiative, krKey: [krKey] }],
    [initiativeKey, { ...initiative, krKey: 'kr:non-uuid' }],
    [initiativeKey, { ...initiative, initiativeType: 'other' }],
    [initiativeKey, regularFields],
    [initiativeKey, { ...initiative, cadence: ' \t' }],
    [initiativeKey, { ...oneOff, cadence }],
    [taskMetaKey, { ...taskMeta, taskKey: 'task:' }],
    [taskMetaKey, { ...taskMeta, initiativeKey: 'initiative:non-uuid' }],
    [taskMetaKey, { ...taskMeta, sphereTagKey: null }],
    [taskMetaKey, { ...taskMeta, initiativeKey: null }],
    [taskMetaKey, { ...taskMeta, directKrKeys: [krKey, krKey] }],
    [taskMetaKey, { ...taskMeta, directKrKeys: [objectiveKey] }],
    [taskMetaKey, { ...taskMeta, directKrKeys: null }],
  ])('rejects malformed v2 data at %s (%j)', (key, record) => {
    expect(decodeRecord(key, canonicalJson({ ...current, ...record }))).toStrictEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it.each([
    [initiativeKey, initiative],
    [taskMetaKey, taskMeta],
    [WIPE_KEY, {}],
  ])('reports an unsupported version at %s (%j)', (key, record) => {
    const raw = canonicalJson({ ...current, ...record, v: 3 });
    expect(decodeRecord(key, raw)).toStrictEqual({ ok: false, reason: 'unsupported-version' });
  });
});
