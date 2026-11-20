import { afterEach, expect, it, vi } from 'vitest';
import { buildPlan, classifyPlan } from '../../src/core/plan';
import { linkedRecordKey } from '../../src/platform/linked-record-keys';
import {
  baseAppState,
  baseProject,
  baseTask,
  createFakeHost,
  goalWrite,
  manualPlan,
  startLinkedHost,
  versionOf,
} from '../fakes/fake-facade';

const uuid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const krKey = `kr:${uuid(1)}`;
const taskKey = 'task:task';
const projectKey = 'project:project';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it.each([
  ['kr', 'target first', 'deleted'],
  ['kr', 'link first', 'deleted'],
  ['initiative', 'target first', 'deleted'],
  ['initiative', 'link first', 'deleted'],
  ['kr', 'target first', 'live'],
  ['kr', 'link first', 'live'],
  ['initiative', 'target first', 'live'],
  ['initiative', 'link first', 'live'],
] as const)('validates a %s target in the same plan (%s, %s)', async (kind, order, final) => {
  const initiativeKey = await linkedRecordKey(projectKey);
  const taskMetaKey = await linkedRecordKey(taskKey);
  let id = 10;
  const stamp = { at: 1, newId: () => uuid(id++) };
  const [kr, initiative, task] = buildPlan(
    'manual',
    [
      {
        key: krKey,
        base: 'absent',
        record: {
          kind: 'kr',
          status: 'active',
          statement: 'Result',
          baseline: '1',
          target: '2',
          dataSource: 'Journal',
          objectiveKey: `objective:${uuid(2)}`,
          history: [],
        },
      },
      {
        key: initiativeKey,
        base: 'absent',
        record: { kind: 'initiative', projectKey, krKey, initiativeType: 'one-off' },
      },
      { key: taskMetaKey, base: 'absent', record: { kind: 'task-meta', taskKey } },
    ],
    stamp,
  ).writes;
  const target = kind === 'kr' ? kr! : initiative!;
  const [deletion, link] = buildPlan(
    'manual',
    [
      { key: target.key, base: versionOf(target), record: { deleted: true } },
      {
        key: taskMetaKey,
        base: versionOf(task!),
        record: {
          kind: 'task-meta',
          taskKey,
          ...(kind === 'kr' ? { directKrKeys: [krKey] } : { initiativeKey }),
        },
      },
    ],
    stamp,
  ).writes;
  const initial = [
    task!,
    ...(kind === 'initiative' ? [kr!] : []),
    ...(final === 'deleted' ? [target] : []),
  ];
  const host = createFakeHost({
    entries: Object.fromEntries(initial.map(({ key, value }) => [key, value])),
  });
  host.api.getAppState.mockResolvedValue(baseAppState({ project: baseProject('project') }));
  host.api.getTasks.mockResolvedValue([baseTask('task')]);
  const run = await startLinkedHost(host);
  const before = host.committed();
  const neighbor = goalWrite(8, 108);
  const targetWrite = final === 'deleted' ? deletion! : target;
  const plan =
    order === 'target first'
      ? manualPlan(neighbor, targetWrite, link!)
      : manualPlan(neighbor, link!, targetWrite);
  expect(classifyPlan(before, plan)).toEqual({ ok: true, writes: plan.writes });

  if (final === 'deleted') {
    await expect.soft(run.apply(plan)).rejects.toThrow(/недоступ/i);
    expect(host.api.persistDataSynced, 'no write from the rejected plan').not.toHaveBeenCalled();
    expect(host.committed()).toEqual(before);
  } else {
    await expect(run.apply(plan)).resolves.toMatchObject({ transferred: 3 });
    expect(host.api.persistDataSynced.mock.calls).toEqual(
      plan.writes.map(({ key, value }) => [value, key]),
    );
  }
});
