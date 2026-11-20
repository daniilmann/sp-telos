import { afterEach, expect, it, vi } from 'vitest';
import { applyPlan, buildPlan, EMPTY_STATE, type Plan } from '../../src/core/plan';
import {
  decodeRecord,
  splitRecord,
  type Initiative,
  type RecordInput,
} from '../../src/core/records';
import { createGoalEditor } from '../../src/app/goal-editor';
import { createDraftStore } from '../../src/platform/draft-store';
import { createFakeDraftDatabase } from '../fakes/fake-draft-database';
import { createHostFacade } from '../../src/platform/facade';
import { linkedRecordKey } from '../../src/platform/linked-record-keys';
import { apply, checkCompatibility } from '../../src/platform/sp-facade';
import {
  baseAppState,
  baseProject,
  baseTag,
  baseTask,
  createFakeHost,
  goalWrite,
  manualPlan,
  versionOf,
} from '../fakes/fake-facade';

const at = Date.UTC(2026, 10, 18);
const uuid = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const goal = goalWrite(1, 11);
const projectKey = 'project:original';
const taskKey = 'task:original';
const firstSphere = 'tag:first';
const secondSphere = 'tag:second';
const objectiveKey = 'objective:' + uuid(2);
const krKey = 'kr:' + uuid(3);
const otherKr = 'kr:' + uuid(4);
const archivedProject = baseProject('original', 'Original project', true);
const firstTag = baseTag('first', 'First sphere');
const secondTag = baseTag('second', 'Second sphere');
const tags = { first: firstTag, second: secondTag };
const projects = { original: archivedProject };
const task = { ...baseTask('original', 'Original task'), tagIds: ['native'] };

function write(key: string, record: RecordInput, ver: number) {
  return buildPlan('manual', [{ key, record, base: 'absent' }], {
    at,
    newId: () => uuid(ver),
  }).writes[0]!;
}

const objective = {
  kind: 'objective',
  status: 'active',
  statement: 'Quarterly objective',
  quarter: 'Q4',
  annualGoalKey: goal.key,
} as const;
const kr = {
  kind: 'kr',
  status: 'active',
  statement: 'First result',
  objectiveKey,
  baseline: '1',
  target: '2',
  dataSource: 'Journal',
  history: [],
} as const;
const initiative: Initiative = {
  kind: 'initiative',
  projectKey,
  krKey,
  initiativeType: 'regular',
  cadence: 'Weekly',
};

function record({ key, value }: Plan['writes'][number]): RecordInput {
  const decoded = decodeRecord(key, value);
  if (!decoded.ok) throw new Error(decoded.reason);
  return splitRecord(decoded.value).record;
}

async function fixture(withTaskSphere = true) {
  const initiativeKey = await linkedRecordKey(projectKey);
  const metaKey = await linkedRecordKey(taskKey);
  const meta = {
    kind: 'task-meta',
    taskKey,
    initiativeKey,
    directKrKeys: [krKey],
    ...(withTaskSphere && { sphereTagKey: firstSphere }),
  } as const;
  const initial = applyPlan(
    EMPTY_STATE,
    manualPlan(
      goal,
      write(objectiveKey, objective, 12),
      write(krKey, kr, 13),
      write(otherKr, { ...kr, statement: 'Other result' }, 14),
      write(initiativeKey, initiative, 15),
      write(metaKey, meta, 16),
    ),
  );
  const host = createFakeHost(initial);
  host.api.getAppState.mockResolvedValue(baseAppState(projects, tags));
  host.api.getTasks.mockResolvedValue([task]);
  vi.stubGlobal('PluginAPI', host.api);
  const facade = createHostFacade();
  let id = 100;

  async function prepare(key: string, fields: Readonly<Record<string, unknown>>, action = 'edit') {
    const { state, readOnlyReason } = await checkCompatibility([key]);
    expect(readOnlyReason).toBeUndefined();
    const references = await facade.readBaseReferences();
    const raw = state.entries[key];
    const { prepareLinkedPlan } = await import('../../src/app/initiative-task-links');
    return prepareLinkedPlan({
      state,
      references,
      key,
      baseVer: raw ? versionOf({ key, value: raw, base: 'absent' }) : 'absent',
      intent: { action, fields },
      previousValue: undefined,
      handoffVer: undefined,
      at,
      newId: () => uuid(id++),
    });
  }
  async function edit(key: string, fields: Readonly<Record<string, unknown>>) {
    const { plan, write: next } = (await prepare(key, fields)) as {
      plan: Plan;
      write: Plan['writes'][number];
    };
    expect(plan.writes).toEqual([next]);
    await expect(apply(plan)).resolves.toMatchObject({ transferred: 1 });
    await host.commitAfter(Promise.resolve());
    expect(host.committed().entries[key]).toBe(next.value);
    return record(next);
  }
  async function resolve() {
    const { resolveLinkedReferences } = await import('../../src/app/initiative-task-links');
    return resolveLinkedReferences(await facade.read(), await facade.readBaseReferences());
  }
  return { host, initiativeKey, metaKey, meta, edit, prepare, resolve };
}

afterEach(() => vi.unstubAllGlobals());

it.each(['annual goal', 'Objective', 'task'] as const)(
  'Assign change and clear a sphere on %s',
  async (owner) => {
    const f = await fixture(false);
    const key = { 'annual goal': goal.key, Objective: objectiveKey, task: f.metaKey }[owner];
    const untouched = { 'annual goal': record(goal), Objective: objective, task: f.meta }[owner];
    expect(untouched).not.toHaveProperty('sphereTagKey');
    expect(await f.edit(key, { sphereTagKey: firstSphere })).toEqual({
      ...untouched,
      sphereTagKey: firstSphere,
    });

    const nativeEdit = { ...task, tagIds: ['native', 'second'] };
    f.host.api.getTasks.mockResolvedValue([nativeEdit]);
    expect(await f.edit(key, { sphereTagKey: secondSphere })).toEqual({
      ...untouched,
      sphereTagKey: secondSphere,
    });
    const cleared = await f.edit(key, { sphereTagKey: null });
    const expected = { ...untouched };
    Reflect.deleteProperty(expected, 'sphereTagKey');
    expect(cleared).toEqual(expected);
    expect(await f.host.api.getTasks()).toEqual([nativeEdit]);
  },
);

it('resolves archived projects and updates references by original ID without writing', async () => {
  const f = await fixture();
  const original = f.host.committed();
  expect(await f.resolve()).toMatchObject({
    projects: { [projectKey]: { title: 'Original project', isArchived: true } },
    tasks: { [taskKey]: { title: 'Original task' } },
  });
  f.host.api.getAppState.mockResolvedValue(
    baseAppState(
      {
        replacement: baseProject('replacement', 'Original project'),
      },
      tags,
    ),
  );
  f.host.api.getTasks.mockResolvedValue([baseTask('replacement', 'Original task')]);
  const missing: unknown = await f.resolve();
  expect(missing).not.toHaveProperty(['projects', projectKey]);
  expect(missing).not.toHaveProperty(['tasks', taskKey]);
  f.host.api.getAppState.mockResolvedValue(
    baseAppState(
      {
        original: baseProject('original', 'Renamed project'),
      },
      tags,
    ),
  );
  f.host.api.getTasks.mockResolvedValue([]);
  f.host.api.getArchivedTasks.mockResolvedValue([baseTask('original', 'Returned in archive')]);
  expect(await f.resolve()).toMatchObject({
    projects: { [projectKey]: { title: 'Renamed project', isArchived: false } },
    tasks: { [taskKey]: { title: 'Returned in archive' } },
  });
  expect(f.host.committed()).toEqual(original);
  expect(f.host.api.persistDataSynced).not.toHaveBeenCalled();
});

it.each([
  'project missing',
  'task missing',
  'tag missing',
  'KR tombstoned',
  'initiative tombstoned',
  'task reads failed',
] as const)('Preserve unavailable targets across independent edits when %s', async (failure) => {
  const f = await fixture();
  switch (failure) {
    case 'project missing':
      f.host.api.getAppState.mockResolvedValue(
        baseAppState({ copy: baseProject('copy', archivedProject.title) }, tags),
      );
      expect(await f.edit(f.initiativeKey, { krKey: otherKr })).toEqual({
        ...initiative,
        krKey: otherKr,
      });
      break;
    case 'task missing':
      f.host.api.getTasks.mockResolvedValue([baseTask('copy', task.title)]);
      break;
    case 'tag missing':
      f.host.api.getAppState.mockResolvedValue(
        baseAppState(projects, { copy: baseTag('copy', firstTag.title), second: secondTag }),
      );
      break;
    case 'KR tombstoned':
      f.host.receiveSync(krKey, write(krKey, { deleted: true }, 20).value);
      break;
    case 'initiative tombstoned':
      f.host.receiveSync(f.initiativeKey, write(f.initiativeKey, { deleted: true }, 21).value);
      break;
    case 'task reads failed':
      f.host.api.getTasks.mockRejectedValue(new Error('Active tasks unavailable'));
      f.host.api.getArchivedTasks.mockRejectedValue(new Error('Archive unavailable'));
      break;
  }
  const edit =
    failure === 'tag missing' ? { directKrKeys: [krKey, otherKr] } : { sphereTagKey: secondSphere };
  expect(await f.edit(f.metaKey, edit)).toEqual({ ...f.meta, ...edit });
});

it('requires explicit choices and rejects newly selected unavailable IDs before handoff', async () => {
  const f = await fixture();
  f.host.api.getAppState.mockResolvedValue(
    baseAppState(projects, { copy: baseTag('copy', secondTag.title) }),
  );
  const missingInitiative = await linkedRecordKey('project:missing');
  const candidate = 'task:new';
  f.host.api.getTasks.mockResolvedValue([task, baseTask('new')]);
  const created = (await f.prepare(
    await linkedRecordKey(candidate),
    { taskKey: candidate },
    'create',
  )) as { write: Plan['writes'][number] };
  expect(record(created.write)).toEqual({ kind: 'task-meta', taskKey: candidate });
  await expect(
    f.prepare(f.metaKey, { sphereTagKey: secondSphere, initiativeKey: missingInitiative }),
  ).resolves.toMatchObject({
    errors: expect.arrayContaining([
      { field: 'sphereTagKey', code: 'unavailable' },
      { field: 'initiativeKey', code: 'unavailable' },
    ]),
  });
  await expect(
    f.prepare(f.metaKey, { directKrKeys: [krKey, 'kr:' + uuid(92)] }),
  ).resolves.toMatchObject({ errors: [{ field: 'directKrKeys', code: 'unavailable' }] });
  expect(f.host.api.persistDataSynced).not.toHaveBeenCalled();
});

it('decodes explicit linked changes from a real editor draft', async () => {
  const f = await fixture();
  const database = createFakeDraftDatabase();
  const drafts = createDraftStore(database.factory);
  const editor = createGoalEditor({
    facade: { ...createHostFacade(), apply },
    drafts,
    now: () => at,
    newId: () => uuid(98),
  });
  await editor.open(f.metaKey);
  const intent = { action: 'edit', fields: { taskKey, sphereTagKey: null, directKrKeys: [] } };
  try {
    expect(Reflect.apply(editor.input, editor, [intent])).toBe(true);
    await vi.waitFor(() => {
      expect(database.mutations).toHaveLength(1);
    });
    database.mutations[0]!.succeedRequest();
    database.mutations[0]!.complete();
    expect(await drafts.flush()).toEqual({ ok: true });
    const { value } = await drafts.read(f.metaKey);
    const { readLinkedIntent } = await import('../../src/app/linked-editor-intent');
    expect(value?.fields).toEqual({ action: intent.action, ...intent.fields });
    expect(readLinkedIntent(f.metaKey, value!)).toEqual(intent);
    expect(
      readLinkedIntent(f.metaKey, {
        ...value!,
        fields: { ...value!.fields, directKrKeys: 'not a list' },
      }),
    ).toBeUndefined();
  } finally {
    editor.close();
  }
});
