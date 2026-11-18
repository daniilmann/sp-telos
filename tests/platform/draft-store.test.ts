import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDraftStore } from '../../src/platform/draft-store';
import { createFakeDraftDatabase } from '../fakes/fake-draft-database';

const databaseName = 'sp-telos-drafts';
const goalKey = 'annual-goal:00000000-0000-4000-8000-000000000001';
const krKey = 'kr:00000000-0000-4000-8000-000000000003';
const baseVer = '10000000-0000-4000-8000-000000000001';
const nextVer = '10000000-0000-4000-8000-000000000002';
const at = Date.UTC(2026, 10, 18, 9);

interface Draft {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly baseVer: string;
  readonly at: number;
}

type FlushResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'failed' | 'timeout'; readonly keys: readonly string[] };

interface DraftStore {
  read(key: string): Promise<{ readonly value: Draft | undefined; readonly failed: boolean }>;
  list(): Promise<readonly string[]>;
  write(key: string, draft: Draft): void;
  remove(key: string): void;
  flush(): Promise<FlushResult>;
  readWipeVersion(): Promise<string | undefined>;
  writeWipeVersion(version: string): void;
}

type Database = ReturnType<typeof createFakeDraftDatabase>;

const first = { fields: { statement: 'Сократить ожидание' }, baseVer: 'absent', at };
const second = { fields: { statement: 'Сократить ожидание вдвое' }, baseVer, at: at + 1 };
const latest = { fields: { statement: 'Уточнить цель после звонка' }, baseVer, at: at + 2 };
const empty = { value: undefined, failed: false };

function connect(database: Database): DraftStore {
  return createDraftStore(database.factory);
}

async function settleEvents(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function watchFlush(store: DraftStore) {
  const resolved = vi.fn<(result: FlushResult) => void>();
  void store.flush().then(resolved);
  return resolved;
}

async function commitNext(database: Database): Promise<void> {
  const mutations = database.mutations.filter((transaction) => !transaction.finished);
  expect(mutations).toHaveLength(1);
  const transaction = mutations[0]!;
  transaction.succeedRequest();
  await settleEvents();
  transaction.complete();
  await settleEvents();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('commits only on completion and keeps the latest intent per key', async () => {
  const database = createFakeDraftDatabase();
  const store = connect(database);
  expect(await store.read(goalKey)).toEqual(empty);

  store.write(goalKey, first);
  await settleEvents();
  expect(database.mutations).toHaveLength(1);
  const writing = database.mutations[0]!;
  store.write(goalKey, second);
  expect(await store.read(goalKey)).toEqual({ value: second, failed: false });
  expect(database.mutations).toHaveLength(1);

  const flushed = watchFlush(store);
  writing.succeedRequest();
  await settleEvents();
  expect(flushed).not.toHaveBeenCalled();
  expect(database.committedRows(databaseName).size).toBe(0);

  store.write(goalKey, latest);
  expect(await store.read(goalKey)).toEqual({ value: latest, failed: false });
  expect(database.mutations).toHaveLength(1);
  writing.complete();
  await settleEvents();
  expect(database.committedRows(databaseName).get(goalKey)).toEqual(first);
  expect(database.mutations).toHaveLength(2);
  expect(flushed).not.toHaveBeenCalled();

  await commitNext(database);
  expect(flushed).toHaveBeenCalledExactlyOnceWith({ ok: true });
  expect(database.mutations).toHaveLength(2);
  expect(database.committedRows(databaseName)).toEqual(new Map([[goalKey, latest]]));
  expect(await store.read(goalKey)).toEqual({ value: latest, failed: false });
});

describe('keeps failed or over-quota input and retries once on flush', () => {
  it.each(['open', 'abort', 'quota'] as const)(
    'retains the latest input after %s failure',
    async (fault) => {
      const database = createFakeDraftDatabase();
      const store = connect(database);
      if (fault === 'open') database.failNextOpen();
      store.write(goalKey, first);
      if (fault !== 'open') await settleEvents();
      store.write(goalKey, latest);
      await settleEvents();

      function failWrite(): void {
        const transaction = database.mutations[database.mutations.length - 1]!;
        if (fault === 'abort') {
          transaction.succeedRequest();
          transaction.abort();
        } else {
          transaction.exceedQuota();
        }
      }

      function attempts(): number {
        return fault === 'open' ? database.openNames.length : database.mutations.length;
      }

      if (fault !== 'open') failWrite();
      await settleEvents();
      expect(attempts()).toBe(1);
      expect(await store.read(goalKey)).toEqual({ value: latest, failed: true });
      expect(database.committedRows(databaseName).size).toBe(0);

      if (fault === 'open') database.failNextOpen();
      const failedFlush = watchFlush(store);
      await settleEvents();
      expect(attempts()).toBe(2);
      if (fault !== 'open') failWrite();
      await settleEvents();
      expect(failedFlush).toHaveBeenCalledExactlyOnceWith({
        ok: false,
        reason: 'failed',
        keys: [goalKey],
      });
      expect(await store.read(goalKey)).toEqual({ value: latest, failed: true });
      expect(database.committedRows(databaseName).size).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(attempts()).toBe(2);

      const retry = watchFlush(store);
      await settleEvents();
      expect(attempts()).toBe(3);
      expect(retry).not.toHaveBeenCalled();
      expect(await store.read(goalKey)).toEqual({ value: latest, failed: true });
      await commitNext(database);
      expect(retry).toHaveBeenCalledExactlyOnceWith({ ok: true });
      expect(database.committedRows(databaseName)).toEqual(new Map([[goalKey, latest]]));
      expect(await store.read(goalKey)).toEqual({ value: latest, failed: false });
      expect(await store.flush()).toEqual({ ok: true });
      expect(attempts()).toBe(3);
    },
  );

  it('retains input above the aggregate byte limit', async () => {
    const database = createFakeDraftDatabase();
    const store = connect(database);
    const largeDraft = { ...first, fields: { statement: 'я'.repeat(275_000) } };
    store.write(goalKey, largeDraft);
    await settleEvents();
    await commitNext(database);

    store.write(krKey, largeDraft);
    await settleEvents();
    expect(await store.read(krKey)).toEqual({ value: largeDraft, failed: true });
    const flushed = watchFlush(store);
    await settleEvents();
    expect(flushed).toHaveBeenCalledExactlyOnceWith({ ok: false, reason: 'failed', keys: [krKey] });
    expect(database.mutations).toHaveLength(1);
    expect(database.committedRows(databaseName)).toEqual(new Map([[goalKey, largeDraft]]));
  });
});

it('times out without discarding an in-flight transaction', async () => {
  const database = createFakeDraftDatabase();
  const store = connect(database);
  store.write(krKey, first);
  await settleEvents();
  const writing = database.mutations[0]!;
  writing.succeedRequest();

  const timed = watchFlush(store);
  await vi.advanceTimersByTimeAsync(4999);
  expect(timed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(timed).toHaveBeenCalledExactlyOnceWith({ ok: false, reason: 'timeout', keys: [krKey] });
  expect(writing.finished).toBe(false);
  expect(database.committedRows(databaseName).size).toBe(0);
  expect(await store.read(krKey)).toMatchObject({ value: first });

  writing.complete();
  await settleEvents();
  expect(await store.flush()).toEqual({ ok: true });
  expect(database.mutations).toHaveLength(1);
  expect(database.committedRows(databaseName)).toEqual(new Map([[krKey, first]]));
  expect(await store.read(krKey)).toEqual({ value: first, failed: false });
});

describe('serializes deletion behind a write', () => {
  it('supersedes a queued edit and commits the deletion only on completion', async () => {
    const database = createFakeDraftDatabase();
    const store = connect(database);
    store.write(goalKey, first);
    await settleEvents();
    store.write(goalKey, second);
    store.remove(goalKey);
    expect(await store.read(goalKey)).toEqual(empty);
    expect(database.mutations).toHaveLength(1);

    const flushed = watchFlush(store);
    await commitNext(database);
    expect(database.mutations).toHaveLength(2);
    expect(database.committedRows(databaseName).get(goalKey)).toEqual(first);

    const removing = database.mutations[1]!;
    removing.succeedRequest();
    await settleEvents();
    expect(flushed).not.toHaveBeenCalled();
    expect(database.committedRows(databaseName).get(goalKey)).toEqual(first);
    removing.complete();
    await settleEvents();
    expect(database.mutations).toHaveLength(2);
    expect(flushed).toHaveBeenCalledExactlyOnceWith({ ok: true });
    expect(database.committedRows(databaseName).size).toBe(0);

    database.restart();
    const reopened = connect(database);
    expect(await reopened.read(goalKey)).toEqual(empty);
    expect(await reopened.list()).toEqual([]);
  });

  it('keeps the failed deletion in memory and restores the committed draft after restart', async () => {
    const database = createFakeDraftDatabase();
    const store = connect(database);
    store.write(goalKey, first);
    await settleEvents();
    await commitNext(database);
    store.remove(goalKey);
    await settleEvents();
    const removing = database.mutations[1]!;
    removing.succeedRequest();
    removing.abort();
    await settleEvents();

    expect(await store.read(goalKey)).toEqual({ value: undefined, failed: true });
    database.restart();
    const reopened = connect(database);
    expect(await reopened.read(goalKey)).toEqual({ value: first, failed: false });
    expect(await reopened.list()).toEqual([goalKey]);
  });
});

it('reopens persisted drafts by key after restart', async () => {
  const database = createFakeDraftDatabase();
  const store = connect(database);
  for (const [key, draft] of [
    [goalKey, first],
    [krKey, second],
  ] as const) {
    store.write(key, draft);
    await settleEvents();
    await commitNext(database);
  }
  store.write(goalKey, second);
  await settleEvents();
  database.mutations[2]!.succeedRequest();
  store.write(goalKey, latest);
  expect(await store.read(goalKey)).toEqual({ value: latest, failed: false });

  database.restart();
  const reopened = connect(database);
  expect(await reopened.read(goalKey)).toEqual({ value: first, failed: false });
  expect(await reopened.read(krKey)).toEqual({ value: second, failed: false });
  expect([...(await reopened.list())].sort((left, right) => left.localeCompare(right))).toEqual([
    goalKey,
    krKey,
  ]);
  expect(database.openNames).toEqual([databaseName, databaseName]);
  expect(database.committedRows(databaseName)).toEqual(
    new Map([
      [goalKey, first],
      [krKey, second],
    ]),
  );
});

it('remembers the last handled wipe version', async () => {
  const database = createFakeDraftDatabase();
  const store = connect(database);
  expect(await store.readWipeVersion()).toBeUndefined();
  store.write(goalKey, first);
  await settleEvents();
  await commitNext(database);
  store.writeWipeVersion(baseVer);
  await settleEvents();
  await commitNext(database);
  expect(await store.flush()).toEqual({ ok: true });

  database.restart();
  const reopened = connect(database);
  expect(await reopened.readWipeVersion()).toBe(baseVer);
  expect(await reopened.list()).toEqual([goalKey]);
  expect(await reopened.read(goalKey)).toEqual({ value: first, failed: false });
  reopened.writeWipeVersion(nextVer);
  await settleEvents();
  await commitNext(database);
  expect(await reopened.flush()).toEqual({ ok: true });

  database.restart();
  const afterSecondWipe = connect(database);
  expect(await afterSecondWipe.readWipeVersion()).toBe(nextVer);
  expect(await afterSecondWipe.list()).toEqual([goalKey]);
  const rows = database.committedRows(databaseName);
  expect(rows.size).toBe(2);
  expect(rows.get(goalKey)).toEqual(first);
});
