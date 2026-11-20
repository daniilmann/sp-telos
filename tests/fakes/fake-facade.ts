import { vi } from 'vitest';
import type { PluginAppState, Task } from '@super-productivity/plugin-api';
import { EDIT_INTERVAL_MS } from '../../src/app/commands';
import {
  applyPlan,
  buildPlan,
  classifyPlan,
  EMPTY_STATE,
  MODEL_VERSION,
  type Plan,
  type PlanState,
} from '../../src/core/plan';
import { decodeRecord, MAX_RECORD_BYTES, recordByteLength } from '../../src/core/records';
import type { Facade } from '../../src/platform/facade';

export interface AppliedPlan {
  readonly plan: Plan;
  readonly at: number;
}

export interface FakeFacade extends Facade {
  readonly applied: readonly AppliedPlan[];
  now(): number;
  advance(ms: number): void;
}

/** In-memory facade with a manual clock: time moves only through advance(). */
export function createFakeFacade(initial: PlanState = EMPTY_STATE, startAt = 0): FakeFacade {
  let state = initial;
  let clock = startAt;
  const applied: AppliedPlan[] = [];
  return {
    applied,
    now: () => clock,
    advance(ms) {
      clock += ms;
    },
    read: () => Promise.resolve(state),
    apply(plan) {
      const classified = classifyPlan(state, plan);
      if (!classified.ok) {
        return Promise.reject(new Error(classified.reason));
      }
      if (classified.writes.length > 0) {
        state = applyPlan(state, plan);
        applied.push({ plan, at: clock });
      }
      return Promise.resolve(state);
    },
  };
}

type Ready = Parameters<NonNullable<typeof PluginAPI.onReady>>[0];
type OnMessage = Parameters<NonNullable<typeof PluginAPI.onMessage>>[0];
type SaveState = Awaited<ReturnType<typeof PluginAPI.getSyncedDataSaveState>>;

export function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function goalWrite(id: number, version: number, base = 'absent'): Plan['writes'][number] {
  const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return buildPlan(
    'manual',
    [
      {
        key: `annual-goal:${uuid(id)}`,
        base,
        record: { kind: 'annual-goal', status: 'active', statement: `Цель ${String(version)}` },
      },
    ],
    { at: version, newId: () => uuid(version) },
  ).writes[0]!;
}

export function manualPlan(...writes: Plan['writes']): Plan {
  return { v: MODEL_VERSION, origin: 'manual', writes };
}

export function versionOf(write: Plan['writes'][number]): string {
  const decoded = decodeRecord(write.key, write.value);
  if (!decoded.ok) throw new Error(decoded.reason);
  return decoded.value.ver;
}

export function baseTask(id: string, title = id): Task {
  return {
    id,
    title,
    timeEstimate: 0,
    timeSpent: 0,
    isDone: false,
    projectId: null,
    tagIds: [],
    created: 1,
    subTaskIds: [],
  };
}

export function baseAppState(
  projects: PluginAppState['projects'] = {},
  tags: PluginAppState['tags'] = {},
): PluginAppState {
  return {
    projects,
    tags,
    tasks: {},
    notes: {},
    taskRepeatCfgs: {},
    simpleCounters: {},
    globalConfig: {},
  };
}

export function baseProject(id: string, title = id, isArchived = false) {
  return {
    id,
    title,
    isArchived,
    theme: {},
    taskIds: [],
    backlogTaskIds: [],
    noteIds: [],
    advancedCfg: {},
  };
}

export function baseTag(id: string, title = id) {
  return { id, title, created: 1, taskIds: [], theme: {}, advancedCfg: {} };
}

export async function collideOnLinkedKey(source: string) {
  const namespace = '6677f4a3a43854c49e72a4cf18f83b4d';
  const bytes = new Uint8Array([
    ...namespace.match(/../g)!.map((byte) => Number.parseInt(byte, 16)),
    ...new TextEncoder().encode(source),
  ]);
  const hash = crypto.subtle.digest.bind(crypto.subtle);
  const digest = await hash('SHA-1', bytes);
  vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) =>
    algorithm === 'SHA-1' ? Promise.resolve(digest.slice(0)) : hash(algorithm, data),
  );
}

/** Fake only the host API. Handoff and asynchronous commit have independent barriers. */
export function createFakeHost(initial: PlanState = EMPTY_STATE) {
  const committed = new Map(Object.entries(initial.entries));
  const pending = new Map<string, string>();
  const receipts = new Map<string, { value: string; savedAt: number }>();
  const commits = vi.fn<(key: string, value: string) => void>();
  const beforeHandoff = vi.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined);
  const loadSyncedData = vi.fn<typeof PluginAPI.loadSyncedData>((key = 'data') =>
    Promise.resolve(pending.get(key) ?? committed.get(key) ?? null),
  );
  const getSyncedDataSaveState = vi.fn<typeof PluginAPI.getSyncedDataSaveState>(async (keys) => {
    const states = await Promise.all(
      keys.map(async (key): Promise<[string, SaveState['keys'][string]]> => {
        if (pending.has(key)) return [key, { state: 'pending' }];
        const receipt = receipts.get(key);
        if (receipt === undefined || receipt.value !== committed.get(key)) {
          return [key, { state: 'unknown' }];
        }
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(receipt.value));
        const valueSha256 = Array.from(new Uint8Array(hash), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        return [key, { state: 'saved', savedAt: receipt.savedAt, valueSha256 }];
      }),
    );
    return { sync: 'ok', keys: Object.fromEntries(states) };
  });

  let ready: Ready | undefined;
  let handler: OnMessage | undefined;
  const deliver = vi.fn((message: unknown) => {
    if (!handler) return Promise.reject(new Error('No plugin message handler registered.'));
    return Promise.resolve(handler(message));
  });

  const api = {
    onReady: vi.fn((callback: Ready) => {
      ready = callback;
    }),
    onMessage: vi.fn((callback: OnMessage) => {
      handler = callback;
    }),
    registerMenuEntry: vi.fn<typeof PluginAPI.registerMenuEntry>(),
    showIndexHtmlAsView: vi.fn<typeof PluginAPI.showIndexHtmlAsView>(),
    getAppState: vi.fn<typeof PluginAPI.getAppState>().mockResolvedValue(baseAppState()),
    getTasks: vi.fn<typeof PluginAPI.getTasks>().mockResolvedValue([]),
    getArchivedTasks: vi.fn<typeof PluginAPI.getArchivedTasks>().mockResolvedValue([]),
    listSyncedDataKeys: vi.fn<typeof PluginAPI.listSyncedDataKeys>((prefix = '') =>
      Promise.resolve(
        [...committed]
          .filter(([key, value]) => value && key.startsWith(prefix))
          .map(([key]) => key)
          .sort((left, right) => (left < right ? -1 : Number(left > right))),
      ),
    ),
    loadSyncedData,
    getSyncedDataSaveState,
    persistDataSynced: vi.fn<typeof PluginAPI.persistDataSynced>(async (value, key = 'data') => {
      if (recordByteLength(value) > MAX_RECORD_BYTES)
        throw new Error('Plugin data exceeds size limit.');
      await beforeHandoff(key);
      pending.set(key, value);
    }),
    triggerSync: vi.fn<typeof PluginAPI.triggerSync>().mockResolvedValue(undefined),
  };

  return {
    api,
    deliver,
    beforeHandoff,
    commits,
    ready: async () => ready?.(),
    committed: (): PlanState => ({ entries: Object.fromEntries(committed) }),
    receiveSync: (key: string, value: string) => committed.set(key, value),
    receiveImport: (entries: PlanState['entries']) => {
      committed.clear();
      pending.clear();
      receipts.clear();
      for (const [key, value] of Object.entries(entries)) committed.set(key, value);
    },
    acknowledge(key: string, savedAt: number) {
      const value = committed.get(key);
      if (value === undefined) throw new Error('There is no committed value to acknowledge.');
      receipts.set(key, { value, savedAt });
    },
    async commitAfter(barrier: Promise<void>) {
      await barrier;
      for (const [key, value] of pending) {
        committed.set(key, value);
        commits(key, value);
      }
      pending.clear();
    },
  };
}

export type FakeHost = ReturnType<typeof createFakeHost>;

export async function startLinkedHost(
  host: FakeHost,
  api: Partial<FakeHost['api']> = host.api,
  loadPlugin: () => Promise<unknown> = () => import('../../src/plugin'),
) {
  vi.stubGlobal('PluginAPI', api);
  await loadPlugin();
  await host.ready();
  return {
    apply: (plan: Plan, paceEditing = false) =>
      host.deliver({ cmd: 'apply', plan, ...(paceEditing && { paceEditing: true }) }),
    compatibility: () => host.deliver({ cmd: 'compatibility' }),
  };
}

export async function reachEditBoundary(
  host: FakeHost,
  key: string,
  submit: () => Promise<unknown>,
) {
  const load = host.api.loadSyncedData.getMockImplementation()!;
  const read = createDeferred();
  host.api.loadSyncedData.mockImplementation(async (requested) => {
    const value = await load(requested);
    if (requested === key) read.resolve();
    return value;
  });
  const outcome = submit().catch((error: unknown) => error);
  try {
    await Promise.race([read.promise, outcome]);
    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS - 1);
    return { outcome };
  } finally {
    host.api.loadSyncedData.mockImplementation(load);
  }
}
