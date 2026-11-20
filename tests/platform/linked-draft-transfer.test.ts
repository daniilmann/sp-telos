import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGoalEditor } from '../../src/app/goal-editor';
import { buildPlan } from '../../src/core/plan';
import { createDraftStore, type Draft } from '../../src/platform/draft-store';
import { createHostFacade } from '../../src/platform/facade';
import { linkedRecordKey } from '../../src/platform/linked-record-keys';
import { apply } from '../../src/platform/sp-facade';
import { createFakeDraftDatabase } from '../fakes/fake-draft-database';
import { baseAppState, baseProject, createFakeHost } from '../fakes/fake-facade';

const at = Date.UTC(2026, 10, 18);
const uuid = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const databaseName = 'sp-telos-drafts';
const krKey = 'kr:' + uuid(1);
const from = 'project:old';
const to = 'project:new';
const fields = {
  action: 'edit',
  projectKey: from,
  krKey,
  initiativeType: 'regular',
  cadence: 'Weekly',
};
const source = { fields, baseVer: uuid(11), at };
const other = {
  ...source,
  baseVer: 'absent',
  fields: { ...fields, projectKey: to, cadence: 'Daily' },
};
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers({ now: at }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function fixture(local: Draft = source) {
  const sourceKey = await linkedRecordKey(from);
  const destinationKey = await linkedRecordKey(to);
  const tombstone = buildPlan(
    'manual',
    [{ key: sourceKey, base: source.baseVer, record: { deleted: true } }],
    {
      at,
      newId: () => uuid(12),
    },
  ).writes[0]!;
  const kr = buildPlan(
    'manual',
    [
      {
        key: krKey,
        base: 'absent',
        record: {
          kind: 'kr',
          status: 'active',
          statement: 'Result',
          history: [],
          baseline: '1',
          target: '2',
          dataSource: 'Journal',
          objectiveKey: 'objective:' + uuid(3),
        },
      },
    ],
    { at, newId: () => uuid(13) },
  ).writes[0]!;
  const host = createFakeHost({ entries: { [kr.key]: kr.value, [sourceKey]: tombstone.value } });
  host.api.getAppState.mockResolvedValue(baseAppState({ new: baseProject('new', 'Replacement') }));
  vi.stubGlobal('PluginAPI', host.api);
  const database = createFakeDraftDatabase();
  const drafts = createDraftStore(database.factory);
  const disk = () => database.committedRows(databaseName);
  const mutation = async () => {
    await settle();
    const pending = database.mutations.filter((tx) => !tx.finished);
    expect(pending).toHaveLength(1);
    return pending[0]!;
  };
  const commit = async () => {
    const tx = await mutation();
    tx.succeedRequest();
    tx.complete();
    await settle();
  };

  drafts.write(sourceKey, local);
  await commit();
  let id = 100;
  const facade = { ...createHostFacade(), apply: vi.fn(apply) };
  const form = createGoalEditor({
    facade,
    drafts,
    now: Date.now,
    newId: () => uuid(id++),
  });
  await form.open(sourceKey);
  expect(form.view().draftChoices).toContain('restore-as-new');
  const restore = (): Promise<void> => {
    const choice: Parameters<typeof form.resolveDraft>[0] = 'restore-as-new';
    return Reflect.apply(form.resolveDraft, form, [choice, to]) as Promise<void>;
  };
  return {
    host,
    facade,
    drafts,
    database,
    disk,
    form,
    sourceKey,
    destinationKey,
    tombstone,
    commit,
    mutation,
    restore,
  };
}

it.each(['Telos', 'pending draft', 'committed draft'] as const)(
  'rejects a destination occupied by %s',
  async (occupation) => {
    const f = await fixture();
    if (occupation === 'Telos') {
      const value = buildPlan(
        'manual',
        [
          {
            key: f.destinationKey,
            base: 'absent',
            record: { kind: 'initiative', projectKey: to, krKey, initiativeType: 'one-off' },
          },
        ],
        { at, newId: () => uuid(15) },
      ).writes[0]!.value;
      f.host.receiveSync(f.destinationKey, value);
    } else {
      f.drafts.write(f.destinationKey, other);
      if (occupation === 'committed draft') await f.commit();
    }
    const settled = vi.fn();
    void f.restore().then(settled);
    await vi.waitFor(() => {
      expect(f.form.view().key !== f.sourceKey || settled.mock.calls.length > 0).toBe(true);
    });
    expect(f.form.view().key).toBe(f.sourceKey);
    expect(settled).toHaveBeenCalledOnce();
    expect(await f.drafts.read(f.sourceKey)).toMatchObject({ value: source });
    expect(f.disk().get(f.sourceKey)).toEqual(source);
    if (occupation !== 'Telos')
      expect(await f.drafts.read(f.destinationKey)).toMatchObject({ value: other });
    expect(f.host.committed().entries[f.sourceKey]).toBe(f.tombstone.value);
    expect(f.host.api.persistDataSynced).not.toHaveBeenCalled();
  },
);

it('retains a competing draft committed by another connection ahead of the destination transaction', async () => {
  const f = await fixture();
  const request = f.database.factory.open(databaseName, 1);
  const writer = await new Promise<IDBDatabase>((resolve) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
  });
  f.database.beforeNextReadwrite(() => {
    // An already-open connection queues the competing draft just before the editor's
    // conditional transaction is created. The committed destination was absent until then.
    const transaction = writer.transaction('drafts', 'readwrite');
    transaction.objectStore('drafts').put(other, f.destinationKey);
  });
  expect(f.disk().get(f.destinationKey)).toBeUndefined();
  const moving = f.restore();
  const done = vi.fn();
  void moving.then(done);
  await vi.waitFor(() => {
    expect(f.database.mutations.find((tx) => !tx.finished)?.pendingKeys).toEqual([
      f.destinationKey,
    ]);
  });
  expect(done).not.toHaveBeenCalled();
  await f.commit();
  expect(f.disk().get(f.destinationKey)).toEqual(other);
  await finishMutations(f, moving);
  writer.close();
  expect(f.form.view().key).toBe(f.sourceKey);
  expect(f.disk().get(f.destinationKey)).toEqual(other);
  expect(f.disk().get(f.sourceKey)).toEqual(source);
  expect(f.host.api.persistDataSynced).not.toHaveBeenCalled();
});

it.each(['abort', 'timeout'] as const)(
  'retains the source when the destination transaction ends in %s',
  async (outcome) => {
    const f = await fixture();
    const moving = f.restore();
    await vi.waitFor(() => {
      expect(f.database.mutations.filter((tx) => !tx.finished)).toHaveLength(1);
    });
    const tx = await f.mutation();
    expect(tx.pendingKeys).toEqual([f.destinationKey]);
    tx.succeedRequest();
    if (outcome === 'abort') tx.abort();
    else await vi.advanceTimersByTimeAsync(5000);
    await moving;
    expect(f.form.view().key).toBe(f.sourceKey);
    expect(await f.drafts.read(f.sourceKey)).toMatchObject({ value: source });
    expect(f.disk().get(f.sourceKey)).toEqual(source);
    expect(f.disk().get(f.destinationKey)).toBeUndefined();
    if (outcome === 'timeout' && !tx.finished) {
      tx.complete();
      await settle();
      expect(f.disk().get(f.sourceKey)).toEqual(source);
    }
    expect(f.host.api.persistDataSynced).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'keeps the source through request success and protects a newer source draft (%s)',
  async (changed) => {
    const f = await fixture();
    const moving = f.restore();
    await vi.waitFor(() => {
      expect(f.database.mutations.filter((tx) => !tx.finished)).toHaveLength(1);
    });
    const destination = await f.mutation();
    expect(destination.pendingKeys).toEqual([f.destinationKey]);
    const newSource = { ...source, at: at + 1, fields: { ...fields, cadence: 'New input' } };
    if (changed) {
      // Queue the other connection's write behind the destination and ahead of any source deletion.
      const writer = createDraftStore(f.database.factory);
      await writer.read(f.sourceKey);
      writer.write(f.sourceKey, newSource);
      await settle();
    }
    destination.succeedRequest();
    await settle();
    expect(f.disk().get(f.destinationKey)).toBeUndefined();
    expect(f.disk().get(f.sourceKey)).toEqual(source);
    expect(await f.drafts.read(f.sourceKey)).toMatchObject({ value: source });
    destination.complete();
    await settle();
    expect(f.disk().get(f.destinationKey)).toMatchObject({
      baseVer: 'absent',
      fields: { projectKey: to, cadence: 'Weekly', krKey },
    });
    await finishMutations(f, moving);
    expect(f.disk().get(f.sourceKey)).toEqual(changed ? newSource : undefined);
    expect(f.form.view().key).toBe(f.destinationKey);
    expect(f.host.committed().entries[f.sourceKey]).toBe(f.tombstone.value);
    expect(f.host.api.persistDataSynced).not.toHaveBeenCalled();
  },
);

it.each([
  [
    'unavailable KR',
    { krKey: 'kr:' + uuid(81), initiativeType: 'regular', cadence: 'Weekly' },
    'krKey',
  ],
  ['blank cadence', { krKey, initiativeType: 'regular', cadence: '  ' }, 'cadence'],
  ['missing type', { krKey, cadence: 'Weekly' }, 'initiativeType'],
  ['missing KR', { initiativeType: 'regular', cadence: 'Weekly' }, 'krKey'],
] as const)(
  'does not prepare a plan for a moved initiative with %s',
  async (_case, changes, field) => {
    const local = { ...source, fields: { action: 'edit', projectKey: from, ...changes } };
    const f = await fixture(local);
    await finishMutations(f, f.restore());
    expect(f.form.view().key).toBe(f.destinationKey);
    await f.form.save();
    expect(f.form.view().errors).toContainEqual(expect.objectContaining({ field }));
    expect(f.facade.apply).not.toHaveBeenCalled();
    expect(f.host.api.persistDataSynced).not.toHaveBeenCalled();
  },
);

async function finishMutations(f: Awaited<ReturnType<typeof fixture>>, moving: Promise<void>) {
  const done = vi.fn();
  void moving.then(done);
  await vi.waitFor(() => {
    for (const pending of f.database.mutations.filter((tx) => !tx.finished)) {
      pending.succeedRequest();
      if (!pending.finished) pending.complete();
    }
    expect(done).toHaveBeenCalledOnce();
  });
}
