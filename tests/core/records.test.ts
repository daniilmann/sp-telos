import { describe, expect, it } from 'vitest';
import type { GoalRecord } from '../../src/core/goals';
import { buildPlan, MODEL_VERSION } from '../../src/core/plan';
import { decodeRecord } from '../../src/core/records';

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
