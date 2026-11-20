import { build } from 'esbuild';
import { Buffer } from 'node:buffer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  decodeRecord,
  MODEL_VERSION,
  RECORD_PREFIXES,
  WIPE_KEY,
} from '../../src/core/records';
import { createHostFacade } from '../../src/platform/facade';
import {
  createFakeHost,
  goalWrite,
  manualPlan,
  reachEditBoundary,
  startLinkedHost,
  versionOf,
  type FakeHost,
} from '../fakes/fake-facade';

const known = goalWrite(1, 101);
const edit = goalWrite(1, 102, versionOf(known));
const unrelated = 'task-meta:22ec6855-1751-54b3-bfb6-4b64c14d7ba2';
const nextVersion = '30000000-0000-4000-8000-000000000001';
const marker = canonicalJson({ v: MODEL_VERSION, ver: nextVersion, at: 30 });
const unknown = canonicalJson({ v: MODEL_VERSION + 1, ver: nextVersion, at: 30 });

const newHost = () => createFakeHost({ entries: { [known.key]: known.value } });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('Apply existing tombstone and wipe rules to linked keys', async () => {
  const host = newHost();
  host.receiveSync(WIPE_KEY, marker);
  vi.stubGlobal('PluginAPI', host.api);
  const read = await createHostFacade().read();
  const listed = await Promise.all(
    host.api.listSyncedDataKeys.mock.results.map(({ value }) => value),
  );
  expect(listed.flat()).toContain(known.key);
  expect(listed.flat()).not.toContain(WIPE_KEY);
  expect(host.api.loadSyncedData).toHaveBeenCalledWith(WIPE_KEY);
  expect(read.entries[WIPE_KEY]).toBe(marker);
  expect(decodeRecord(WIPE_KEY, read.entries[WIPE_KEY]!)).toMatchObject({
    ok: true,
    value: { ver: nextVersion },
  });
  expect(host.api.persistDataSynced).not.toHaveBeenCalled();
});

describe('Block an unread listed key and stale or invalid plans', () => {
  const candidate = goalWrite(2, 201);

  it('keeps a listed null occupied', async () => {
    const host = newHost();
    const list = host.api.listSyncedDataKeys.getMockImplementation()!;
    host.api.listSyncedDataKeys.mockImplementation((prefix) =>
      prefix === 'annual-goal:' ? Promise.resolve([known.key, candidate.key]) : list(prefix),
    );
    const run = await startLinkedHost(host);
    const facade = createHostFacade();
    const read = await facade.read();
    expect.soft(read.entries).toEqual({ [known.key]: known.value });
    expect.soft(read.unreadKeys ?? []).toContain(candidate.key);
    await expect.soft(run.apply(manualPlan(candidate))).rejects.toThrow(/\S/);
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
  });

  it('accepts one write when enumeration and direct reading establish absence', async () => {
    const host = newHost();
    const run = await startLinkedHost(host);
    const read = await createHostFacade().read([candidate.key]);
    expect(read.entries).not.toHaveProperty(candidate.key);
    expect(read.unreadKeys ?? []).not.toContain(candidate.key);
    expect(host.api.loadSyncedData).toHaveBeenCalledWith(candidate.key);
    expect(host.api.listSyncedDataKeys).toHaveBeenCalledWith('annual-goal:');
    await expect(run.apply(manualPlan(candidate))).resolves.toMatchObject({ transferred: 1 });
    expect(host.api.persistDataSynced.mock.calls).toEqual([[candidate.value, candidate.key]]);
  });

  it('considers directly readable pending bytes before the key appears in a listing', async () => {
    const host = newHost();
    const run = await startLinkedHost(host);
    await run.apply(manualPlan(candidate));
    const listed = await host.api.listSyncedDataKeys('annual-goal:');
    expect(listed).not.toContain(candidate.key);
    expect((await createHostFacade().read([candidate.key])).entries[candidate.key]).toBe(
      candidate.value,
    );
    host.api.persistDataSynced.mockClear();
    const update = goalWrite(2, 202, versionOf(candidate));
    const unexpectedCreation = { ...update, base: 'absent' };
    await expect(run.apply(manualPlan(edit, unexpectedCreation))).rejects.toThrow(/stale|устар/i);
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();

    await expect(run.apply(manualPlan(update))).resolves.toMatchObject({ transferred: 1 });
    expect(host.api.persistDataSynced.mock.calls).toEqual([[update.value, update.key]]);
  });
});

type HostApi = Partial<FakeHost['api']>;
type Fault = {
  readonly name: string;
  readonly reason: RegExp;
  install(host: FakeHost, api: HostApi): () => void;
};

function unreadFault(name: string, key: string, read: () => Promise<string | null>): Fault {
  return {
    name,
    reason: /чтен|прочита|провер|read|verif|incomplete|wipe/i,
    install(host) {
      const load = host.api.loadSyncedData.getMockImplementation()!;
      host.api.loadSyncedData.mockImplementation((requested) =>
        requested === key ? read() : load(requested),
      );
      if (key !== WIPE_KEY)
        host.receiveSync(
          key,
          canonicalJson({ deleted: true, v: MODEL_VERSION, ver: nextVersion, at: 30 }),
        );
      return () => {
        host.api.loadSyncedData.mockImplementation(load);
      };
    },
  };
}

const faults: readonly Fault[] = [
  ...(['getAppState', 'getTasks', 'getArchivedTasks', 'getSyncedDataSaveState'] as const).map(
    (method): Fault => ({
      name: `missing ${method}`,
      reason: new RegExp(method, 'i'),
      install(host, api) {
        Reflect.deleteProperty(api, method);
        return () => {
          Object.assign(api, { [method]: host.api[method] });
        };
      },
    }),
  ),
  ...[...RECORD_PREFIXES, WIPE_KEY].map(
    (collection): Fault => ({
      name: `unknown version in ${collection}`,
      reason: /схем|верси|schema|version/i,
      install(host) {
        const key = collection === WIPE_KEY ? WIPE_KEY : `${collection}${nextVersion}`;
        host.receiveSync(key, unknown);
        return () => {
          host.receiveImport({ [known.key]: known.value });
        };
      },
    }),
  ),
  {
    name: 'a rejected collection listing',
    reason: /чтен|прочита|провер|перечис|read|list|verif|incomplete/i,
    install(host) {
      const list = host.api.listSyncedDataKeys.getMockImplementation()!;
      host.api.listSyncedDataKeys.mockImplementation((prefix) =>
        prefix === 'objective:' ? Promise.reject(new Error('Fixture fault.')) : list(prefix),
      );
      return () => {
        host.api.listSyncedDataKeys.mockImplementation(list);
      };
    },
  },
  unreadFault('a rejected listed read', unrelated, () =>
    Promise.reject(new Error('Fixture fault.')),
  ),
  unreadFault('a listed null outside the plan', unrelated, () => Promise.resolve(null)),
  unreadFault('an indeterminate version', unrelated, () => Promise.resolve('{"at":30')),
  unreadFault('a rejected direct wipe read', WIPE_KEY, () =>
    Promise.reject(new Error('Fixture fault.')),
  ),
];

describe('Enter read-only at startup and recheck before each plan', () => {
  let pluginDataUrl: string;

  beforeAll(async () => {
    const bundle = await build({
      entryPoints: ['src/plugin.ts'],
      bundle: true,
      format: 'iife',
      target: 'es2020',
      minify: true,
      write: false,
    });
    const script = Buffer.from(bundle.outputFiles[0]!.contents).toString('base64');
    pluginDataUrl = `data:text/javascript;base64,${script}`;
  });

  it.each(faults)(
    'blocks on $name and recovers in the same plugin instance',
    async ({ install, reason }) => {
      const host = newHost();
      const api: HostApi = { ...host.api };
      const repair = install(host, api);
      const run = await startLinkedHost(
        host,
        api,
        () => import(`${pluginDataUrl}#${crypto.randomUUID()}`),
      );

      expect.soft(host.api.onReady).toHaveBeenCalledOnce();
      expect.soft(await run.compatibility()).toEqual(expect.stringMatching(reason));
      const read = await createHostFacade()
        .read()
        .catch((error: unknown) => error);
      expect.soft(read).toMatchObject({ entries: { [known.key]: known.value } });
      if (read && typeof read === 'object' && 'entries' in read) {
        expect.soft(read.entries).not.toHaveProperty(WIPE_KEY);
      }
      const result = await run.apply(manualPlan(edit)).catch((error: unknown) => error);
      expect.soft(result).toBeInstanceOf(Error);
      expect.soft(result).toMatchObject({ message: expect.stringMatching(reason) });
      expect.soft(host.api.persistDataSynced).not.toHaveBeenCalled();

      repair();
      expect.soft(await run.compatibility()).toBeNull();
      expect(host.api.onReady).toHaveBeenCalledOnce();
    },
  );

  it.each(faults)(
    'detects $name introduced after startup, before the next plan',
    async ({ install, reason }) => {
      const host = newHost();
      const api: HostApi = { ...host.api };
      const run = await startLinkedHost(host, api);
      expect(host.api.loadSyncedData).toHaveBeenCalledWith(WIPE_KEY);
      expect(host.api.listSyncedDataKeys.mock.calls).toEqual(
        expect.arrayContaining(RECORD_PREFIXES.map((key) => [key])),
      );
      expect(await run.compatibility()).toBeNull();
      install(host, api);

      const result = await run.apply(manualPlan(edit)).catch((error: unknown) => error);
      expect.soft(result).toBeInstanceOf(Error);
      expect.soft(result).toMatchObject({ message: expect.stringMatching(reason) });
      expect(host.api.persistDataSynced).not.toHaveBeenCalled();
    },
  );

  it('re-enumerates all collections and directly rereads wipe after the edit interval', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const host = newHost();
    const run = await startLinkedHost(host);
    expect(await run.compatibility()).toBeNull();
    await run.apply(manualPlan(edit), true);
    host.api.persistDataSynced.mockClear();
    host.api.listSyncedDataKeys.mockClear();
    host.api.loadSyncedData.mockClear();
    const next = goalWrite(1, 103, versionOf(edit));
    const neighbor = goalWrite(2, 201);
    const { outcome } = await reachEditBoundary(host, known.key, () =>
      run.apply(manualPlan(neighbor, next), true),
    );
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
    expect(host.api.loadSyncedData).toHaveBeenCalledWith(WIPE_KEY);
    expect(host.api.listSyncedDataKeys.mock.calls).toEqual(
      expect.arrayContaining(RECORD_PREFIXES.map((key) => [key])),
    );
    host.api.loadSyncedData.mockClear();
    host.api.listSyncedDataKeys.mockClear();
    host.receiveSync(WIPE_KEY, unknown);

    await vi.advanceTimersByTimeAsync(1);
    expect
      .soft(await outcome)
      .toMatchObject({ message: expect.stringMatching(/схем|верси|schema|version/i) });
    expect(host.api.loadSyncedData).toHaveBeenCalledWith(WIPE_KEY);
    expect(host.api.listSyncedDataKeys.mock.calls).toEqual(
      expect.arrayContaining(RECORD_PREFIXES.map((key) => [key])),
    );
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
  });
});
