import { PluginHooks, type PluginHookHandler } from '@super-productivity/plugin-api';
import type { ComponentProps, VNode } from 'preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { App } from '../../src/ui/App';
import type { Command, CompatibilityQuery } from '../../src/app/commands';
import { buildPlan } from '../../src/core/plan';
import { WIPE_KEY } from '../../src/core/records';
import { createDraftStore } from '../../src/platform/draft-store';
import { linkedRecordKey } from '../../src/platform/linked-record-keys';
import { createFakeDraftDatabase } from '../fakes/fake-draft-database';
import {
  baseAppState,
  baseTag,
  baseTask,
  createDeferred,
  createFakeHost,
  goalWrite,
  startLinkedHost,
  versionOf,
  type FakeHost,
} from '../fakes/fake-facade';

type Properties = Record<string, unknown>;
type Node = VNode<Properties>;

// Capture the iframe's real root component and run its hooks under Vitest's clock.
// The application components, editor, message bridge and reader are all real.
const preact = vi.hoisted(() => {
  let cursor = 0;
  let effect: (() => (() => void) | undefined) | undefined;
  const state: unknown[] = [];
  return {
    mount: vi.fn<(root: Node) => void>(),
    hooks: {
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in state))
          state[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
        return [
          state[index],
          (value: unknown) => {
            state[index] =
              typeof value === 'function'
                ? (value as (previous: unknown) => unknown)(state[index])
                : value;
          },
        ];
      },
      useEffect(callback: () => (() => void) | undefined) {
        effect ??= callback;
      },
    },
    render() {
      cursor = 0;
      const root = this.mount.mock.lastCall![0];
      return Reflect.apply(root.type as (props: Properties) => Node, undefined, [root.props]);
    },
    runEffect: () => effect?.(),
    reset() {
      state.length = 0;
      effect = undefined;
      this.mount.mockClear();
    },
  };
});
vi.mock('preact', async (original) => ({
  ...(await original<typeof import('preact')>()),
  render: preact.mount,
}));
vi.mock('preact/hooks', async (original) => ({
  ...(await original<typeof import('preact/hooks')>()),
  ...preact.hooks,
}));

function elements(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (typeof value !== 'object' || value === null || !('type' in value)) return [];
  const item = value as Node;
  if (typeof item.type === 'function')
    return elements(Reflect.apply(item.type, undefined, [item.props]));
  return [item, ...elements(item.props.children)];
}

function ownText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return Array.isArray(value) ? value.map(ownText).join('') : '';
}

const at = Date.UTC(2026, 10, 18, 9);
const goal = goalWrite(1, 11);
const statement = 'New local text';
const local = { at, baseVer: versionOf(goal), fields: { action: 'edit', statement } };
const goalWithSphere = {
  ...goal,
  value: JSON.stringify({ ...(JSON.parse(goal.value) as Properties), sphereTagKey: 'tag:team' }),
};
const other = goalWrite(2, 12);
const unknownVersion = JSON.stringify({ ...(JSON.parse(other.value) as Properties), v: 99 });
const databaseName = 'sp-telos-drafts';
const settle = () => vi.advanceTimersByTimeAsync(0);
let cleanup: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers({ now: at });
  vi.resetModules();
  preact.reset();
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function fixture(
  entries: Record<string, string>,
  draft?: typeof local,
  beforeView?: (host: FakeHost) => void,
) {
  const host = createFakeHost({ entries });
  const hooks = new Map<PluginHooks, PluginHookHandler>();
  const api = {
    ...host.api,
    registerHook: vi.fn((hook: PluginHooks, listener: PluginHookHandler) =>
      hooks.set(hook, listener),
    ),
  };
  await startLinkedHost(host, api);
  const database = createFakeDraftDatabase();
  const drafts = createDraftStore(database.factory);
  const commitInput = async () => {
    await settle();
    const pending = database.mutations.filter((tx) => !tx.finished);
    expect(pending).toHaveLength(1);
    pending[0]!.succeedRequest();
    pending[0]!.complete();
    await settle();
  };
  if (draft) {
    drafts.write(goal.key, draft);
    await commitInput();
  }
  host.api.getAppState.mockResolvedValue(baseAppState({}, { team: baseTag('team', 'Old sphere') }));
  vi.stubGlobal('indexedDB', database.factory);
  vi.stubGlobal('document', { getElementById: () => ({}) });

  type Request = { messageId: string; message: CompatibilityQuery | Command };
  type Reply = { source: object; data: { type: string; messageId: string; result: unknown } };
  let listener: ((event: Reply) => void) | undefined;
  let nextReply:
    | { received: ReturnType<typeof createDeferred>; release: ReturnType<typeof createDeferred> }
    | undefined;
  const windowParent = {
    postMessage: vi.fn(({ messageId, message }: Request) => {
      const barrier = message.cmd === 'compatibility' ? nextReply : undefined;
      if (barrier) nextReply = undefined;
      void host.deliver(message).then(async (result) => {
        barrier?.received.resolve();
        await barrier?.release.promise;
        listener?.({
          source: windowParent,
          data: { type: 'PLUGIN_MESSAGE_RESPONSE', messageId, result },
        });
      });
    }),
  };
  vi.stubGlobal('window', {
    parent: windowParent,
    addEventListener: (_event: string, callback: typeof listener) => {
      listener = callback;
    },
  });
  beforeView?.(host);
  await import('../../src/ui');
  preact.render();
  const stop = preact.runEffect();
  cleanup = typeof stop === 'function' ? stop : undefined;
  const view = () => preact.render().props as unknown as ComponentProps<typeof App>;
  const tree = () => elements(preact.render());
  const text = () =>
    tree()
      .map(({ props }) => ownText(props.children))
      .join(' ');
  const button = (label: string | RegExp) =>
    tree().find(
      ({ type, props }) =>
        type === 'button' &&
        (typeof label === 'string'
          ? ownText(props.children) === label
          : label.test(ownText(props.children))),
    );
  const click = (label: string | RegExp) => {
    const control = button(label);
    expect(control, `expected a control matching ${String(label)}`).toBeDefined();
    (control!.props.onClick as () => void)();
  };
  const signal = async (hook: PluginHooks) => {
    const callback = hooks.get(hook);
    expect(callback, `iframe subscription to ${hook}`).toBeDefined();
    // Signals have no payload, and their callbacks may start asynchronous rereads.
    void callback!(undefined);
    await settle();
  };
  const holdCompatibility = () => {
    nextReply = { received: createDeferred(), release: createDeferred() };
    return nextReply;
  };
  const commands = (command: string) =>
    host.deliver.mock.calls.filter(([value]) => (value as { cmd?: string }).cmd === command);
  await vi.waitFor(() => {
    expect(view().records[goal.key]).toBeDefined();
  });
  return {
    host,
    view,
    text,
    button,
    click,
    signal,
    commitInput,
    commands,
    holdCompatibility,
    disk: (key = goal.key) => database.committedRows(databaseName).get(key),
  };
}

it.each([PluginHooks.DATA_CHANGED, PluginHooks.PERSISTED_DATA_CHANGED])(
  'Refresh an open form without dropping input after %s',
  async (event) => {
    const f = await fixture({ [goal.key]: goalWithSphere.value });
    f.click('Цель 11');
    await vi.waitFor(() => {
      expect(f.view().view.ready).toBe(true);
    });
    expect(f.view().editor.input({ action: 'edit', fields: { statement } })).toBe(true);
    await f.commitInput();
    const draft = f.disk();
    expect(draft).toMatchObject({ fields: local.fields });

    const getAppState = f.host.api.getAppState.getMockImplementation()!;
    const reached = vi.fn();
    const release = createDeferred();
    f.host.api.getAppState.mockImplementationOnce(async () => {
      const stale = await getAppState();
      reached();
      await release.promise;
      return stale;
    });
    await f.signal(event);
    await vi.waitFor(() => {
      expect(reached).toHaveBeenCalledOnce();
    });
    f.host.api.getAppState.mockResolvedValue(
      baseAppState({}, { team: baseTag('team', 'Newest sphere') }),
    );
    await f.signal(event);
    await vi.waitFor(() => {
      expect(f.text()).toContain('Newest sphere');
    });
    release.resolve();
    await settle();
    expect(f.text()).toContain('Newest sphere');
    expect(f.text()).not.toContain('Old sphere');
    expect(f.view().view).toMatchObject({
      key: goal.key,
      intent: { action: 'edit', fields: { statement } },
    });
    expect(f.disk()).toEqual(draft);
    expect(f.commands('apply')).toHaveLength(0);
  },
);

it('reads an archive-only change on explicit refresh and keeps the open input', async () => {
  const archivedTask = 'task:archive';
  const key = await linkedRecordKey(archivedTask);
  const metadata = buildPlan(
    'manual',
    [
      {
        key,
        base: 'absent',
        record: { kind: 'task-meta', taskKey: archivedTask },
      },
    ],
    { at, newId: () => crypto.randomUUID() },
  ).writes[0]!;
  const f = await fixture({ [goal.key]: goal.value, [key]: metadata.value });
  f.host.api.getArchivedTasks.mockResolvedValue([baseTask('archive', 'Before archive change')]);
  f.view().open(key);
  await vi.waitFor(() => {
    expect(f.view().view.ready).toBe(true);
  });
  const fields = { sphereTagKey: 'tag:team' };
  expect(f.view().editor.input({ action: 'edit', fields })).toBe(true);
  await f.commitInput();
  const draft = f.disk(key);
  expect(draft).toMatchObject({ fields: { action: 'edit', ...fields } });
  expect.soft(f.text()).toContain('Before archive change');
  f.host.api.getArchivedTasks.mockResolvedValue([baseTask('archive', 'After archive change')]);
  f.click(/Обновить/);
  await vi.waitFor(() => {
    expect(f.text()).toContain('After archive change');
  });
  expect(f.text()).not.toContain('Before archive change');
  expect(f.view().view).toMatchObject({ key, intent: { action: 'edit', fields } });
  expect(f.disk(key)).toEqual(draft);
  expect(f.commands('apply')).toHaveLength(0);
});

it('Enter read-only at startup, ignore a stale block and recheck before each plan', async () => {
  const f = await fixture({ [goal.key]: goal.value, [other.key]: unknownVersion }, local);
  f.click('Цель 11');
  await vi.waitFor(() => {
    expect(f.view().view).toMatchObject({ ready: true, readOnly: true });
  });
  expect(f.text()).toMatch(/неизвестная версия схемы/);
  expect(f.view().view.intent.fields).toEqual({ statement });
  const before = f.commands('compatibility').length;

  const old = f.holdCompatibility();
  await f.signal(PluginHooks.PERSISTED_DATA_CHANGED);
  await vi.waitFor(() => old.received.promise);
  f.host.receiveImport({ [goal.key]: goal.value });
  await f.signal(PluginHooks.DATA_CHANGED);
  await vi.waitFor(() => {
    expect(f.view().view.readOnly).toBe(false);
  });
  expect(f.commands('compatibility')).toHaveLength(before + 2);
  old.release.resolve();
  await settle();
  expect(f.view().view.readOnly).toBe(false);
  expect(f.button('Сохранить')?.props.disabled).toBe(false);
  expect(f.view().view.intent.fields).toEqual({ statement });
  expect(f.disk()).toEqual(local);
  expect(f.commands('apply')).toHaveLength(0);

  f.host.receiveSync(other.key, unknownVersion);
  await f.view().editor.save();
  expect(f.commands('compatibility')).toHaveLength(before + 3);
  expect(f.view().view.readOnly).toBe(true);
  expect(f.commands('apply')).toHaveLength(0);
  expect(f.disk()).toEqual(local);
});

it('keeps the newer version, write mode and wipe when opening replies late', async () => {
  const fresh = goalWrite(1, 21);
  const draft = { ...local, baseVer: versionOf(fresh) };
  const f = await fixture({ [goal.key]: goal.value, [other.key]: unknownVersion }, draft);
  const opening = f.holdCompatibility();
  f.click('Цель 11');
  await opening.received.promise;
  await settle();
  expect(f.view().view.ready).toBeFalsy();

  const wipe = buildPlan('manual', [{ key: WIPE_KEY, base: 'absent', record: {} }], {
    at,
    newId: () => versionOf(other),
  }).writes[0]!;
  f.host.receiveImport({ [fresh.key]: fresh.value, [WIPE_KEY]: wipe.value });
  await f.signal(PluginHooks.DATA_CHANGED);
  await vi.waitFor(() => {
    expect(f.view().records[goal.key]).toMatchObject({ ver: versionOf(fresh) });
  });
  opening.release.resolve();
  await settle();
  await vi.waitFor(() => {
    expect(f.view().view.ready).toBe(true);
  });
  expect.soft(f.view().view.readOnly).toBe(false);
  expect.soft(f.view().view.record).toMatchObject({ ver: versionOf(fresh), statement: 'Цель 21' });
  expect.soft(f.view().view.wipe?.ver).toBe(versionOf(wipe));
  expect(f.disk()).toEqual(draft);
  expect(f.commands('apply')).toHaveLength(0);
});

it('retries a timed-out initial enumeration and keeps writes disabled until recovery', async () => {
  const healthy = createDeferred();
  const recover = vi.fn();
  const f = await fixture({ [goal.key]: goal.value }, undefined, (host) => {
    const list = host.api.listSyncedDataKeys.getMockImplementation()!;
    let attempt = 0;
    host.api.listSyncedDataKeys.mockImplementation(async (prefix) => {
      if (prefix === 'initiative:') {
        attempt += 1;
        if (attempt === 1) throw new Error('API call timeout');
        // The host compatibility check runs separately from the initial iframe read.
        if (attempt > 2) {
          recover();
          await healthy.promise;
        }
      }
      return list(prefix);
    });
  });
  const blocked = /Не удалось перечислить ключи для проверки схемы/;
  expect(f.text()).toMatch(blocked);
  expect(f.button('Создать')?.props.disabled).toBe(true);
  for (let elapsed = 0; elapsed < 30_000 && recover.mock.calls.length === 0; elapsed += 500) {
    await vi.advanceTimersByTimeAsync(500);
  }
  expect.soft(recover, 'automatic enumeration after API call timeout').toHaveBeenCalled();
  expect(f.text()).toMatch(blocked);
  expect(f.button('Создать')?.props.disabled).toBe(true);
  expect(f.commands('apply')).toHaveLength(0);

  healthy.resolve();
  await settle();
  expect.soft(f.text()).not.toMatch(blocked);
  expect(f.button('Создать')?.props.disabled).toBe(false);
});
