import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPlan, classifyPlan, type Plan } from '../../src/core/plan';
import { canonicalJson, WIPE_KEY, type RecordInput, type TaskMeta } from '../../src/core/records';
import { createHostFacade, readRecords } from '../../src/platform/facade';
import { apply } from '../../src/platform/sp-facade';
import {
  baseAppState,
  baseProject,
  baseTag,
  baseTask,
  collideOnLinkedKey,
  createDeferred,
  createFakeHost,
  goalWrite,
  manualPlan,
  reachEditBoundary,
  startLinkedHost,
  versionOf,
} from '../fakes/fake-facade';

const projectId = 'V2a91_nAn0XWz4Df79Qre';
const taskId = 'rpt_Sk9例';
const initiativeKey = 'initiative:b072ff74-faf2-5d4d-8422-68048d6bbde4';
const taskMetaKey = 'task-meta:22ec6855-1751-54b3-bfb6-4b64c14d7ba2';
const otherInitiativeKey = 'initiative:b3087993-6427-524d-9ff6-1feace2810dc';
const otherTaskMetaKey = 'task-meta:05ea742c-73f3-56a6-869c-8bda177fed37';
const krKey = 'kr:20000000-0000-4000-8000-000000000001';
const otherKrKey = 'kr:20000000-0000-4000-8000-000000000002';
const objectiveKey = 'objective:20000000-0000-4000-8000-000000000003';

const initiative = {
  kind: 'initiative',
  projectKey: `project:${projectId}`,
  krKey,
  initiativeType: 'one-off',
} as const;
const taskMeta = { kind: 'task-meta', taskKey: `task:${taskId}`, directKrKeys: [krKey] } as const;
const priorKr = {
  kind: 'kr',
  status: 'active',
  statement: 'Release with shorter lead time',
  baseline: '10 days',
  target: '5 days',
  dataSource: 'Release audit',
  objectiveKey,
  history: [],
} as const;
const deleted = { deleted: true } as const;
type Write = Plan['writes'][number];

function write(key: string, record: RecordInput, id: number, base = 'absent'): Write {
  return buildPlan('manual', [{ key, record, base }], {
    at: id,
    newId: () => `20000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  }).writes[0]!;
}

const initiativeCreation = write(initiativeKey, initiative, 11);
const taskCreation = write(taskMetaKey, taskMeta, 12);
const kr = write(krKey, priorKr, 13);
const neighbor = goalWrite(8, 108);
const editTask = (changes: Partial<TaskMeta>, id: number, current = taskCreation) =>
  write(taskMetaKey, { ...taskMeta, ...changes }, id, versionOf(current));

function linkedHost(...initial: Write[]) {
  const host = createFakeHost({
    entries: Object.fromEntries(initial.map(({ key, value }) => [key, value])),
  });
  host.api.getAppState.mockResolvedValue(
    baseAppState({ [projectId]: baseProject(projectId) }, { Sphere: baseTag('Sphere') }),
  );
  host.api.getTasks.mockResolvedValue([baseTask(taskId)]);
  return host;
}

const handoffs = (...writes: Write[]) => writes.map(({ value, key }) => [value, key]);
const staleReason = /stale|устар/i;

describe('Apply a measurement', () => {
  const key = 'kr-value:20000000-0000-4000-8000-000000000004';
  const ver = '20000000-0000-4000-8000-000000000051';
  const value = canonicalJson({ v: 2, ver, at: 51, kind: 'kr-value', krKey, value: '5 дней' });
  const plan = manualPlan({ key, base: 'absent', value });
  const parent = write(
    krKey,
    { ...priorKr, status: 'closed', outcome: 'achieved', closureReason: 'Done' },
    52,
  );
  const guard = { expectedWipe: 'absent', byteCheck: 'allow-absent', forceSync: true } as const;

  it('writes beside a closed KR, reading the exact fact before and after enumeration', async () => {
    const host = linkedHost(parent);
    vi.stubGlobal('PluginAPI', host.api);
    await expect(apply(plan, guard)).resolves.toMatchObject({ transferred: 1 });
    const entries = { [krKey]: parent.value, [key]: value };
    expect((await readRecords([key])).entries).toEqual(entries);
    await host.commitAfter(Promise.resolve());
    expect((await readRecords()).entries).toEqual(entries);
    expect(host.committed().entries).toEqual(entries);
    const replay = { ...guard, byteCheck: 'require-exact' } as const;
    await expect(apply(plan, replay)).resolves.toMatchObject({ transferred: 0 });
    expect(host.api.persistDataSynced).toHaveBeenCalledExactlyOnceWith(value, key);
  });

  it.each([
    ['missing parent', [], undefined],
    ['deleted parent', [write(krKey, deleted, 53)], undefined],
    ['wipe read error', [parent], new Error('Read failed')],
    ['damaged wipe', [parent], '{'],
    ['missing observed bytes', [parent], undefined],
  ] as const)('rejects %s without write or sync', async (failure, parents, wipe) => {
    const host = linkedHost(...parents);
    vi.stubGlobal('PluginAPI', host.api);
    if (typeof wipe === 'string') host.receiveSync(WIPE_KEY, wipe);
    if (wipe instanceof Error) {
      const load = host.api.loadSyncedData.getMockImplementation()!;
      host.api.loadSyncedData.mockImplementation((key) =>
        key === WIPE_KEY ? Promise.reject(wipe) : load(key),
      );
    }
    const byteCheck = failure === 'missing observed bytes' ? 'require-exact' : guard.byteCheck;
    const options = { ...guard, byteCheck } as const;
    await expect.soft(apply(plan, options)).rejects.toThrow();
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
    expect(host.api.triggerSync).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Reject a mismatched canonical key or source reference', () => {
  const cases = [
    {
      name: 'initiative',
      valid: initiativeCreation,
      forged: write(initiativeKey, { ...initiative, projectKey: 'project:Other' }, 21),
      wrongTarget: write(otherInitiativeKey, initiative, 22),
    },
    {
      name: 'task-meta',
      valid: taskCreation,
      forged: write(taskMetaKey, { ...taskMeta, taskKey: 'task:Other' }, 23),
      wrongTarget: write(otherTaskMetaKey, taskMeta, 24),
    },
  ];

  it.each(cases)('hides an imported $name and guards its key', async ({ valid, forged }) => {
    const host = linkedHost(kr, valid);
    const run = await startLinkedHost(host);
    const facade = createHostFacade();
    expect((await facade.read()).entries[valid.key]).toBe(valid.value);

    host.receiveImport({ [kr.key]: kr.value, [forged.key]: forged.value });
    const imported = await facade.read();
    expect.soft(imported.entries).toEqual({ [kr.key]: kr.value });
    expect.soft(imported.readOnlyReason).toBeUndefined();

    for (const attempt of [
      valid,
      { ...valid, base: versionOf(forged) },
      forged,
      write(forged.key, deleted, 25, versionOf(forged)),
    ]) {
      await expect.soft(run.apply(manualPlan(neighbor, attempt))).rejects.toThrow();
      expect.soft(host.api.persistDataSynced).not.toHaveBeenCalled();
    }
    expect(host.committed().entries[forged.key]).toBe(forged.value);
  });

  it.each(cases)('allows a separate edit beside a corrupt $name', async ({ forged }) => {
    const host = linkedHost(kr, forged);
    const run = await startLinkedHost(host);
    const entries = { [kr.key]: kr.value };
    expect(await readRecords()).toEqual({ entries, unreadKeys: [forged.key] });
    await expect(run.apply(manualPlan(neighbor))).resolves.toMatchObject({ transferred: 1 });
    expect(host.api.persistDataSynced.mock.calls).toEqual(handoffs(neighbor));
  });

  it.each(cases)('rejects a mismatched $name target at apply', async ({ wrongTarget }) => {
    const host = linkedHost(kr);
    const run = await startLinkedHost(host);
    const plan = manualPlan(neighbor, wrongTarget);
    expect(classifyPlan(host.committed(), plan).ok).toBe(true);

    await expect.soft(run.apply(plan)).rejects.toThrow();
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
  });

  it('rejects a changed source at an occupied key when the computed UUIDs collide', async () => {
    await collideOnLinkedKey(taskMeta.taskKey);
    const host = linkedHost(kr, taskCreation);
    host.api.getTasks.mockResolvedValue([baseTask(taskId), baseTask('Other')]);
    const run = await startLinkedHost(host);
    expect((await createHostFacade().read()).entries[taskMetaKey]).toBe(taskCreation.value);
    const other = editTask({ taskKey: 'task:Other' }, 26);

    await expect(run.apply(manualPlan(neighbor, other))).rejects.toThrow();
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
  });
});

describe('Reject unavailable new links at direct apply', () => {
  const annual = goalWrite(9, 109);
  const goalBody = { status: 'active', statement: 'Release' } as const;
  const missingSphere = { sphereTagKey: 'tag:Missing' } as const;
  const initial = [kr, taskCreation, annual];
  const absentKrLinks = [
    ['initiative KR', write(initiativeKey, { ...initiative, krKey: otherKrKey }, 31)],
    ['direct KR added to a nonempty set', editTask({ directKrKeys: [krKey, otherKrKey] }, 32)],
  ] as const;
  const annualBody = { ...goalBody, ...missingSphere, kind: 'annual-goal' } as const;
  const objectiveBody = {
    ...goalBody,
    ...missingSphere,
    kind: 'objective',
    quarter: '2026-Q4',
    annualGoalKey: annual.key,
  } as const;
  const unavailable: readonly {
    name: string;
    target: Write;
    removeProject?: boolean;
    removeTask?: boolean;
    tombstone?: Write;
  }[] = [
    { name: 'the source project at creation', target: initiativeCreation, removeProject: true },
    { name: 'the source task at creation', target: taskCreation, removeTask: true },
    {
      name: 'a sphere tag on an annual goal',
      target: write(annual.key, annualBody, 34, versionOf(annual)),
    },
    { name: 'a sphere tag on an objective', target: write(objectiveKey, objectiveBody, 35) },
    { name: 'a sphere tag on task metadata', target: editTask(missingSphere, 36) },
    ...absentKrLinks.flatMap(([name, target]) => [
      { name: `missing ${name}`, target },
      { name: `deleted ${name}`, target, tombstone: write(otherKrKey, deleted, 37) },
    ]),
    ...(['missing', 'deleted'] as const).map((state) => ({
      name: `${state} initiative on task metadata`,
      target: editTask({ initiativeKey }, 38),
      ...(state === 'deleted' && { tombstone: write(initiativeKey, deleted, 39) }),
    })),
  ];

  it.each(unavailable)('refuses $name before handing off a valid neighbor', async (test) => {
    const host = linkedHost(...(test.removeTask ? [kr, annual] : initial));
    if (test.tombstone) host.receiveSync(test.tombstone.key, test.tombstone.value);
    if (test.removeProject)
      host.api.getAppState.mockRejectedValue(new Error('Project and tag state unavailable.'));
    if (test.removeTask) host.api.getTasks.mockResolvedValue([]);
    const run = await startLinkedHost(host);
    const original = host.committed();
    const plan = manualPlan(neighbor, test.target);
    expect(classifyPlan(original, plan)).toEqual({ ok: true, writes: plan.writes });
    await expect.soft(run.apply(plan)).rejects.toThrow();
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
    expect(host.committed()).toEqual(original);
  });

  it('checks the tag again after the edit interval before handing off any write', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const host = linkedHost(annual);
    const run = await startLinkedHost(host);
    const first = goalWrite(9, 110, versionOf(annual));
    await run.apply(manualPlan(first), true);
    host.api.persistDataSynced.mockClear();
    host.api.getAppState.mockClear();
    const next = write(
      annual.key,
      { ...goalBody, kind: 'annual-goal', sphereTagKey: 'tag:Sphere' },
      41,
      versionOf(first),
    );
    const { outcome } = await reachEditBoundary(host, annual.key, () =>
      run.apply(manualPlan(neighbor, next), true),
    );
    expect.soft(host.api.persistDataSynced).not.toHaveBeenCalled();
    expect.soft(host.api.getAppState).toHaveBeenCalled();
    host.api.getAppState.mockClear();
    host.api.getAppState.mockResolvedValue(baseAppState({ [projectId]: baseProject(projectId) }));

    await vi.advanceTimersByTimeAsync(1);
    expect.soft(await outcome).toBeInstanceOf(Error);
    expect.soft(host.api.getAppState).toHaveBeenCalled();
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
  });

  it('passes an independent edit with untouched dangling links and a missing source', async () => {
    const dangling = {
      ...taskMeta,
      initiativeKey: otherInitiativeKey,
      sphereTagKey: 'tag:Missing',
      directKrKeys: [otherKrKey],
    };
    const current = write(taskMetaKey, dangling, 42);
    const edit = editTask({ ...dangling, directKrKeys: [krKey, otherKrKey] }, 43, current);
    const host = linkedHost(kr, current);
    host.api.getTasks.mockRejectedValue(new Error('Active tasks unavailable.'));
    const run = await startLinkedHost(host);

    await expect(run.apply(manualPlan(edit))).resolves.toMatchObject({ transferred: 1 });
    expect(host.api.persistDataSynced.mock.calls).toEqual(handoffs(edit));
  });

  it('skips exact replay after its initiative KR disappears', async () => {
    const host = linkedHost(kr);
    const run = await startLinkedHost(host);
    const plan = manualPlan(initiativeCreation);
    await expect(run.apply(plan)).resolves.toMatchObject({ transferred: 1 });
    await host.commitAfter(Promise.resolve());
    host.receiveImport({ [initiativeCreation.key]: initiativeCreation.value });
    host.api.persistDataSynced.mockClear();

    await expect(run.apply(plan)).resolves.toMatchObject({ transferred: 0 });
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
  });

  it('skips an exact replay and preserves untouched links when the same plan removes their KR', async () => {
    const host = linkedHost(kr, taskCreation, initiativeCreation);
    const run = await startLinkedHost(host);
    const tombstone = write(kr.key, deleted, 44, versionOf(kr));
    const sphereEdit = editTask({ sphereTagKey: 'tag:Sphere' }, 45);

    const plan = manualPlan(tombstone, initiativeCreation, sphereEdit);
    await expect(run.apply(plan)).resolves.toMatchObject({ transferred: 2 });
    expect(host.api.persistDataSynced.mock.calls).toEqual(handoffs(tombstone, sphereEdit));
  });
});

describe('Replay a plan with its original version', () => {
  it('skips the visible write and hands off the remainder byte for byte', async () => {
    const host = linkedHost(kr);
    host.api.getTasks.mockResolvedValue([]);
    host.api.getArchivedTasks.mockResolvedValue([baseTask(taskId)]);
    const run = await startLinkedHost(host);
    const plan = manualPlan(initiativeCreation, taskCreation);
    const entered = createDeferred();
    const refuse = createDeferred();
    host.beforeHandoff.mockImplementation(async (key) => {
      if (key !== taskMetaKey) return;
      entered.resolve();
      await refuse.promise;
      throw new Error('Host refused task metadata.');
    });
    const first = run.apply(plan);
    void first.catch(() => undefined);
    try {
      await Promise.race([entered.promise, first]);
      const attempted = handoffs(initiativeCreation, taskCreation);
      expect(host.api.persistDataSynced.mock.calls).toEqual(attempted);
    } finally {
      refuse.resolve();
    }
    await expect(first).rejects.toThrow(/1\s*(?:of|из|\/)\s*2/i);
    const visible = await readRecords([initiativeKey]);
    expect(visible.entries[initiativeKey]).toBe(initiativeCreation.value);
    host.beforeHandoff.mockResolvedValue(undefined);
    host.api.persistDataSynced.mockClear();

    await expect(run.apply(plan)).resolves.toMatchObject({ transferred: 1, writes: plan.writes });
    expect(host.api.persistDataSynced.mock.calls).toEqual(handoffs(taskCreation));
    host.api.persistDataSynced.mockClear();
    await expect(run.apply(plan)).resolves.toMatchObject({ transferred: 0 });
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
  });

  it('rejects different bytes with the same version before sending a neighbor', async () => {
    const host = linkedHost(kr, taskCreation);
    const run = await startLinkedHost(host);
    const conflicting = write(taskMetaKey, { ...taskMeta, directKrKeys: [] }, 12);
    expect(versionOf(conflicting)).toBe(versionOf(taskCreation));
    expect(conflicting.value).not.toBe(taskCreation.value);

    await expect(run.apply(manualPlan(neighbor, conflicting))).rejects.toThrow();
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
  });
});

describe('Reject a stale base before any handoff', () => {
  const first = editTask({ directKrKeys: [] }, 45);
  const next = editTask({ sphereTagKey: 'tag:Sphere' }, 46, first);
  const remote = write(taskMetaKey, taskMeta, 47, versionOf(first));

  it('rejects both writes when sync changes the second base before apply', async () => {
    const host = linkedHost(kr, first);
    const run = await startLinkedHost(host);
    host.receiveSync(remote.key, remote.value);

    await expect(run.apply(manualPlan(neighbor, next))).rejects.toThrow(staleReason);
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
  });

  it('reads the changed base again after the edit interval and rejects both writes', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const host = linkedHost(kr, taskCreation);
    const run = await startLinkedHost(host);
    await run.apply(manualPlan(first), true);
    await host.commitAfter(Promise.resolve());
    host.api.persistDataSynced.mockClear();
    host.api.loadSyncedData.mockClear();
    const { outcome } = await reachEditBoundary(host, taskMetaKey, () =>
      run.apply(manualPlan(neighbor, next), true),
    );
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
    expect(host.api.loadSyncedData).toHaveBeenCalledWith(taskMetaKey);
    host.api.loadSyncedData.mockClear();
    host.receiveSync(remote.key, remote.value);

    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ message: expect.stringMatching(staleReason) });
    expect(host.api.loadSyncedData).toHaveBeenCalledWith(taskMetaKey);
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
  });
});

it('Apply existing tombstone and wipe rules to linked keys', async () => {
  const host = linkedHost(kr, initiativeCreation, taskCreation);
  const run = await startLinkedHost(host);
  const liveWrites = [initiativeCreation, taskCreation];
  const tombstones = liveWrites.map((live, index) =>
    write(live.key, deleted, 50 + index, versionOf(live)),
  );
  await expect(run.apply(manualPlan(...tombstones))).resolves.toMatchObject({ transferred: 2 });
  expect(host.api.persistDataSynced.mock.calls).toEqual(handoffs(...tombstones));
  await host.commitAfter(Promise.resolve());
  host.api.persistDataSynced.mockClear();

  for (const [index, live] of liveWrites.entries()) {
    const tombstone = tombstones[index]!;
    const restore = { ...live, base: versionOf(tombstone) };
    await expect(run.apply(manualPlan(neighbor, restore))).rejects.toThrow(staleReason);
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
    expect(host.committed().entries[restore.key]).toBe(tombstone.value);
  }
});
