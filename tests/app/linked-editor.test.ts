import type { SaveState } from '@super-productivity/plugin-api';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGoalEditor, type GoalEditor } from '../../src/app/goal-editor';
import { buildPlan, type Plan } from '../../src/core/plan';
import { decodeRecord, splitRecord, WIPE_KEY, type RecordInput } from '../../src/core/records';
import { createDraftStore, type Draft } from '../../src/platform/draft-store';
import { createHostFacade } from '../../src/platform/facade';
import { linkedRecordKey } from '../../src/platform/linked-record-keys';
import { apply } from '../../src/platform/sp-facade';
import { createFakeDraftDatabase } from '../fakes/fake-draft-database';
import {
  baseAppState,
  baseProject,
  baseTag,
  baseTask,
  createDeferred,
  createFakeHost,
  versionOf,
} from '../fakes/fake-facade';

const at = Date.UTC(2026, 10, 18, 9);
const uuid = (n: number) => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectKey = 'project:initiative';
const taskKey = 'task:work';
const first = { taskKey, sphereTagKey: 'tag:team' };
const latest = { taskKey, sphereTagKey: null, directKrKeys: [] };
const krKey = 'kr:' + uuid(3);
const secondKr = 'kr:' + uuid(4);
const databaseName = 'sp-telos-drafts';
const settle = () => vi.advanceTimersByTimeAsync(0);

function write(key: string, record: RecordInput, ver: number) {
  return buildPlan('manual', [{ key, record, base: 'absent' }], {
    at,
    newId: () => uuid(ver),
  }).writes[0]!;
}

function readBody({ key, value }: Plan['writes'][number]) {
  const result = decodeRecord(key, value);
  if (!result.ok) throw new Error(result.reason);
  return splitRecord(result.value).record;
}

function input(form: GoalEditor, fields: Draft['fields']) {
  const intent = { action: 'edit', fields };
  expect(Reflect.apply(form.input, form, [intent])).toBe(true);
  return intent;
}

async function fixture() {
  const taskMetaKey = await linkedRecordKey(taskKey);
  const initiativeKey = await linkedRecordKey(projectKey);
  const database = createFakeDraftDatabase();
  let drafts = createDraftStore(database.factory);
  const taskMeta = { kind: 'task-meta', taskKey, initiativeKey, directKrKeys: [krKey] } as const;
  const initiative = {
    kind: 'initiative',
    projectKey,
    krKey,
    initiativeType: 'regular',
    cadence: 'Weekly',
  } as const;
  const original = write(taskMetaKey, taskMeta, 11);
  const mark = write(initiativeKey, initiative, 12);
  // prettier-ignore
  const kr = {
    kind: 'kr', status: 'active', statement: 'Result', baseline: '1', target: '2',
    dataSource: 'Journal', objectiveKey: 'objective:' + uuid(2), history: [],
  } as const;
  const initial = [
    original,
    mark,
    write(krKey, kr, 13),
    write(secondKr, { ...kr, statement: 'Another result' }, 14),
  ];
  const host = createFakeHost({
    entries: Object.fromEntries(initial.map(({ key, value }) => [key, value])),
  });
  const replacement = baseProject('other', 'Replacement project');
  host.api.getAppState.mockResolvedValue(
    baseAppState(
      {
        initiative: baseProject('initiative'),
        other: replacement,
      },
      { team: baseTag('team') },
    ),
  );
  host.api.getTasks.mockResolvedValue([baseTask('work'), baseTask('orphan')]);
  vi.stubGlobal('PluginAPI', host.api);
  const facade = { ...createHostFacade(), apply: vi.fn(apply) };
  let id = 100;
  const editor = () => createGoalEditor({ facade, drafts, now: Date.now, newId: () => uuid(id++) });
  const open = async (key = taskMetaKey) => {
    const form = editor();
    await form.open(key);
    return form;
  };
  function restart() {
    database.restart();
    drafts = createDraftStore(database.factory);
  }
  async function drain() {
    await settle();
    for (const tx of database.mutations) {
      if (!tx.finished) {
        tx.succeedRequest();
        tx.complete();
        await settle();
      }
    }
  }
  const store = () => drafts;
  const disk = (key = taskMetaKey) => database.committedRows(databaseName).get(key);
  function seed(key: string, fields: Draft['fields'], baseVer = versionOf(original)) {
    const draft = { at, baseVer, fields: { action: 'edit', ...fields } };
    drafts.write(key, draft);
    return draft;
  }
  function planWrite() {
    expect(facade.apply).toHaveBeenCalled();
    const [plan] = facade.apply.mock.lastCall!;
    expect(plan.writes).toHaveLength(1);
    return plan.writes[0]!;
  }
  // prettier-ignore
  return {
    host, facade, open, restart, drain, store, disk, seed, database,
    taskMetaKey, initiativeKey, original, mark, taskMeta, planWrite,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function sendFirst(f: Fixture) {
  const form = await f.open();
  input(form, first);
  await f.drain();
  await form.save();
  const sent = f.planWrite();
  expect(sent).toMatchObject({ key: f.taskMetaKey, base: versionOf(f.original) });
  expect(readBody(sent)).toEqual({ ...f.taskMeta, ...first });
  await f.drain();
  await f.host.commitAfter(Promise.resolve());
  expect(form.view().status).toBe('pending');
  return { form, sent };
}

beforeEach(() => vi.useFakeTimers({ now: at }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('Recover an unconfirmed linked edit while a handoff reply is held', async () => {
  const f = await fixture();
  const form = await f.open();
  const reached = createDeferred();
  const release = createDeferred();
  f.host.beforeHandoff.mockImplementationOnce(() => {
    reached.resolve();
    return release.promise;
  });
  input(form, first);
  await f.drain();
  const sending = form.save();
  expect(
    await Promise.race([reached.promise.then(() => 'host'), sending.then(() => 'returned')]),
  ).toBe('host');
  const intent = input(form, latest);
  await f.drain();
  release.resolve();
  await sending;
  await f.host.commitAfter(Promise.resolve());
  f.host.acknowledge(f.taskMetaKey, at);
  await vi.advanceTimersByTimeAsync(1000);
  await f.drain();
  expect(form.view()).toMatchObject({ intent, status: 'changed' });
  expect(f.disk()).toMatchObject({ fields: { action: 'edit', ...latest } });
});

it.each(['remote edit', 'tombstone'] as const)(
  'offers the owner a choice over a %s when recovering',
  async (change) => {
    const f = await fixture();
    const local = f.seed(f.taskMetaKey, first);
    await f.drain();
    const current = { ...f.taskMeta, directKrKeys: [secondKr] };
    const remote = write(f.taskMetaKey, change === 'tombstone' ? { deleted: true } : current, 31);
    f.host.receiveSync(remote.key, remote.value);
    f.restart();
    const form = await f.open();
    expect(form.view()).toMatchObject({
      intent: { action: 'edit', fields: first },
      baseVer: local.baseVer,
    });
    expect(form.view().draftChoices).toEqual(
      change === 'tombstone' ? ['discard-draft', 'restore-as-new'] : ['keep-draft', 'use-saved'],
    );
    await form.save();
    expect(f.facade.apply).not.toHaveBeenCalled();
    if (change === 'tombstone') {
      expect(f.disk()).toEqual(local);
      return;
    }
    await form.resolveDraft('keep-draft');
    await f.drain();
    expect(f.disk()).toMatchObject({ baseVer: versionOf(remote), fields: local.fields });
    await form.save();
    expect(f.planWrite().base).toBe(versionOf(remote));
    expect(readBody(f.planWrite())).toEqual({ ...current, ...first });
  },
);

it('Retry an unconfirmed form save with a new plan and ignore the old receipt', async () => {
  const f = await fixture();
  const { form, sent } = await sendFirst(f);
  await vi.advanceTimersByTimeAsync(20_000);
  await vi.waitFor(() => {
    expect(form.view().status).toBe('retry');
  });

  f.host.acknowledge(f.taskMetaKey, at);
  const originalStatus = await f.host.api.getSyncedDataSaveState([f.taskMetaKey]);
  expect(originalStatus.keys[f.taskMetaKey]).toMatchObject({ state: 'saved' });
  f.host.api.loadSyncedData.mockClear();
  await form.retry();
  const next = f.planWrite();
  expect(next).toMatchObject({ key: sent.key, base: versionOf(sent) });
  expect(versionOf(next)).not.toBe(versionOf(sent));
  expect(next.value).not.toBe(sent.value);
  expect(readBody(next)).toEqual(readBody(sent));
  expect(f.host.api.loadSyncedData).toHaveBeenCalledWith(sent.key);
  expect(f.host.api.triggerSync).toHaveBeenCalledOnce();
  await f.drain();
  await f.host.commitAfter(Promise.resolve());
  f.host.api.getSyncedDataSaveState.mockClear().mockResolvedValueOnce(originalStatus);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.host.api.getSyncedDataSaveState).toHaveBeenCalledExactlyOnceWith([sent.key]);
  expect(form.view().status).toBe('pending');
  expect(f.disk()).toMatchObject({ baseVer: versionOf(next), fields: first });

  f.host.acknowledge(next.key, at + 20_000);
  await vi.waitFor(
    () => {
      expect(form.view().status).toBe('saved');
    },
    { timeout: 2000 },
  );
  await f.drain();
  expect(f.disk()).toBeUndefined();
});

it('does not consume a valid receipt delayed until after a new linked edit', async () => {
  const f = await fixture();
  const { form, sent } = await sendFirst(f);
  f.host.acknowledge(sent.key, at);
  const proof = await f.host.api.getSyncedDataSaveState([sent.key]);
  const reached = createDeferred();
  let reply!: (value: SaveState) => void;
  const response = new Promise<SaveState>((resolve) => {
    reply = resolve;
  });
  f.host.api.getSyncedDataSaveState.mockImplementationOnce(() => {
    reached.resolve();
    return response;
  });
  await vi.advanceTimersByTimeAsync(1000);
  await reached.promise;
  const intent = input(form, latest);
  await f.drain();
  reply(proof);
  await settle();
  await f.drain();
  expect(form.view()).toMatchObject({ intent, status: 'changed' });
  expect(f.disk()).toMatchObject({ fields: latest });
});

it('stops Retry on a fresh divergence and preserves the local draft for a choice', async () => {
  const f = await fixture();
  const { form, sent } = await sendFirst(f);
  const current = write(sent.key, { ...f.taskMeta, directKrKeys: [secondKr] }, 32);
  f.host.receiveSync(sent.key, current.value);
  await form.retry();
  expect(form.view().draftChoices).toEqual(['keep-draft', 'use-saved']);
  expect(f.facade.apply).toHaveBeenCalledOnce();
  expect(f.disk()).toMatchObject({ fields: first });
});

it.each(['keep', 'discard'] as const)(
  'Apply existing tombstone and wipe rules to linked keys (%s)',
  async (choice) => {
    const f = await fixture();
    const taskDraft = f.seed(f.taskMetaKey, latest);
    const projectDraft = f.seed(
      f.initiativeKey,
      { projectKey, cadence: 'Daily' },
      versionOf(f.mark),
    );
    await f.drain();
    const wipe = write(WIPE_KEY, {}, 51);
    const tombstones = [f.taskMetaKey, f.initiativeKey].map((key, i) =>
      write(key, { deleted: true }, 52 + i),
    );
    const deliverWipe = () => f.host.receiveSync(WIPE_KEY, wipe.value);
    const deliverTombstones = () => {
      tombstones.forEach(({ key, value }) => f.host.receiveSync(key, value));
    };
    if (choice === 'keep') deliverWipe();
    else deliverTombstones();
    expect((await f.open(f.initiativeKey)).view().wipe?.ver).toBe(
      choice === 'keep' ? versionOf(wipe) : undefined,
    );
    if (choice === 'keep') deliverTombstones();
    else deliverWipe();
    const form = await f.open(f.taskMetaKey);
    expect(form.view()).toMatchObject({
      intent: { action: 'edit', fields: latest },
      wipe: { ver: versionOf(wipe), count: 2 },
    });
    expect(f.disk()).toEqual(taskDraft);
    expect(f.disk(f.initiativeKey)).toEqual(projectDraft);
    const resolving = form.resolveWipe(choice);
    await f.drain();
    await resolving;
    expect(await f.store().readWipeVersion()).toBe(versionOf(wipe));
    expect(f.disk()).toEqual(choice === 'keep' ? taskDraft : undefined);
    expect(f.disk(f.initiativeKey)).toEqual(choice === 'keep' ? projectDraft : undefined);
    f.restart();
    expect((await f.open()).view().wipe).toBeUndefined();
    expect((await f.open(f.initiativeKey)).view().wipe).toBeUndefined();
    expect(f.facade.apply).not.toHaveBeenCalled();
  },
);

it('leaves both linked drafts alone if direct reading of meta:wipe fails', async () => {
  const f = await fixture();
  const taskDraft = f.seed(f.taskMetaKey, latest);
  const projectDraft = f.seed(f.initiativeKey, { projectKey, cadence: 'Daily' }, versionOf(f.mark));
  await f.drain();
  f.host.receiveSync(WIPE_KEY, write(WIPE_KEY, {}, 54).value);
  const load = f.host.api.loadSyncedData.getMockImplementation()!;
  f.host.api.loadSyncedData.mockImplementation((key) =>
    key === WIPE_KEY ? Promise.reject(new Error('Marker unreadable')) : load(key),
  );
  const form = await f.open();
  expect(form.view()).toMatchObject({ readOnly: true, intent: { action: 'edit', fields: latest } });
  expect(form.view().wipe).toBeUndefined();
  await form.resolveWipe('discard');
  expect(await f.store().readWipeVersion()).toBeUndefined();
  expect(f.disk()).toEqual(taskDraft);
  expect(f.disk(f.initiativeKey)).toEqual(projectDraft);
  expect(f.facade.apply).not.toHaveBeenCalled();
});

it('Continue a draft from its list after restart, including a live row with a missing task', async () => {
  const f = await fixture();
  const orphan = 'task:orphan';
  const orphanKey = await linkedRecordKey(orphan);
  f.seed(f.taskMetaKey, latest);
  f.seed(orphanKey, { action: 'create', ...first, taskKey: orphan }, 'absent');
  await f.drain();
  f.host.api.getTasks.mockResolvedValue([baseTask('orphan')]);
  f.restart();
  const listed = await f.store().list();
  expect(listed.failed).toBe(false);
  expect(new Set(listed.keys)).toEqual(new Set([f.taskMetaKey, orphanKey]));
  const { resolveLinkedReferences } = await import('../../src/app/initiative-task-links');
  const view: unknown = await resolveLinkedReferences(
    await f.facade.read(),
    await f.facade.readBaseReferences(),
    listed.keys,
  );
  expect(view).toMatchObject({
    taskRows: expect.arrayContaining([
      { key: f.taskMetaKey, title: 'Недоступно', hasDraft: true },
      { key: orphanKey, hasDraft: true },
    ]),
  });
  const editor = await f.open(orphanKey);
  expect(editor.view()).toMatchObject({
    key: orphanKey,
    ready: true,
    intent: { action: 'create', fields: { ...first, taskKey: orphan } },
  });
  await editor.open(f.taskMetaKey);
  expect(editor.view()).toMatchObject({
    key: f.taskMetaKey,
    ready: true,
    intent: { action: 'edit', fields: latest },
  });
  expect(f.facade.apply).not.toHaveBeenCalled();
});

it.each(['failure', 'timeout'] as const)(
  'stays in the current form on flush %s and switches on retry',
  async (outcome) => {
    const f = await fixture();
    const editor = await f.open();
    const intent = input(editor, first);
    await settle();
    const pending = f.database.mutations[0]!;
    const switching = editor.open(f.initiativeKey);
    if (outcome === 'failure') pending.abort();
    else await vi.advanceTimersByTimeAsync(5000);
    await switching;
    expect(editor.view()).toMatchObject({
      key: f.taskMetaKey,
      intent,
      leaveChoices: ['retry', 'stay', 'discard'],
    });
    expect((await f.store().read(f.taskMetaKey)).value).toMatchObject({ fields: first });
    const retrying = editor.open(f.initiativeKey);
    await f.drain();
    await retrying;
    expect(editor.view()).toMatchObject({ key: f.initiativeKey, ready: true });
    expect(f.disk()).toMatchObject({ fields: first });
  },
);
