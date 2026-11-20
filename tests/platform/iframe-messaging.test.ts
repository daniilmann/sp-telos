import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Command } from '../../src/app/commands';
import { createGoalEditor } from '../../src/app/goal-editor';
import { applyPlan, EMPTY_STATE } from '../../src/core/plan';
import { canonicalJson, WIPE_KEY } from '../../src/core/records';
import { createDraftStore } from '../../src/platform/draft-store';
import { createFakeDraftDatabase } from '../fakes/fake-draft-database';
import {
  createDeferred,
  createFakeHost,
  goalWrite,
  manualPlan,
  versionOf,
} from '../fakes/fake-facade';

type Request = {
  readonly type: string;
  readonly messageId: string;
  readonly message: Command | { readonly cmd: 'isApplying'; readonly requestId: string };
};
type Reply =
  | {
      readonly type: 'PLUGIN_MESSAGE_RESPONSE';
      readonly messageId: string;
      readonly result: unknown;
    }
  | { readonly type: 'PLUGIN_MESSAGE_ERROR'; readonly messageId: string; readonly error: string };

const original = goalWrite(1, 11);
const initial = applyPlan(EMPTY_STATE, manualPlan(original));
const edit = goalWrite(1, 12, versionOf(original));
const next = goalWrite(1, 13, versionOf(edit));

function command(write = edit): Command {
  return { cmd: 'apply', plan: manualPlan(write) };
}

async function startHost(entries = initial.entries) {
  const host = createFakeHost({ entries });
  vi.stubGlobal('PluginAPI', host.api);
  await import('../../src/plugin');
  await host.ready();
  return host;
}

function createBridge(host: Awaited<ReturnType<typeof startHost>>) {
  let currentWindow: object | undefined;
  let generation = 0;

  return {
    close() {
      currentWindow = undefined;
      generation += 1;
    },
    async open(
      iframeWindow = {},
      dropReply?: (answer: Reply, message: Request['message']) => boolean,
    ) {
      // A new document runs its own copy of iframe-messaging, even if WindowProxy is reused.
      vi.resetModules();
      currentWindow = iframeWindow;
      const boundGeneration = ++generation;
      let listener: ((event: { source: object; data: Reply }) => void) | undefined;
      const deliveries: Promise<void>[] = [];
      const postMessage = vi.fn((data: Request) => {
        deliveries.push(receive({ source: iframeWindow, data }));
      });
      const hostWindow = { postMessage };
      const reply = vi.fn((data: Reply, source: object = hostWindow) =>
        listener?.({ data, source }),
      );
      const receive = async (event: { source: object; data: Request }) => {
        const { source, data } = event;
        // PluginIndexComponent binds sender and generation before routing PLUGIN_MESSAGE.
        if (source !== currentWindow || boundGeneration !== generation) return;
        if (data.type !== 'PLUGIN_MESSAGE' || !data.messageId) return;
        const answer = await host.deliver(data.message).then<Reply, Reply>(
          (result) => ({ type: 'PLUGIN_MESSAGE_RESPONSE', messageId: data.messageId, result }),
          (error: unknown) => ({
            type: 'PLUGIN_MESSAGE_ERROR',
            messageId: data.messageId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        // Legacy PLUGIN_MESSAGE replies are addressed to event.source. A closed
        // document cannot receive them.
        if (source === currentWindow && !dropReply?.(answer, data.message)) reply(answer);
      };
      vi.stubGlobal('window', {
        parent: hostWindow,
        addEventListener: (_type: string, callback: NonNullable<typeof listener>) => {
          listener = callback;
        },
      });
      const { createIframeFacade, send } = await import('../../src/platform/iframe-messaging');
      return { deliveries, createIframeFacade, send, iframeWindow, postMessage, receive, reply };
    },
  };
}

function holdFirstWrite(host: Awaited<ReturnType<typeof startHost>>) {
  const entered = createDeferred();
  const release = createDeferred();
  host.beforeHandoff.mockImplementationOnce(() => {
    entered.resolve();
    return release.promise;
  });
  return { entered, release };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const krKey = 'kr:00000000-0000-4000-8000-000000000031';
const fact = {
  key: 'kr-value:00000000-0000-4000-8000-000000000032',
  base: 'absent',
  value: canonicalJson({ v: 2, ver: versionOf(edit), at: 12, kind: 'kr-value', krKey, value: '0' }),
};
const factPlan = manualPlan(fact);
const absentGuard = { expectedWipe: 'absent', byteCheck: 'allow-absent' } as const;
const factCommand = { cmd: 'apply', plan: factPlan, ...absentGuard } as const;

const noVersion = { ...factPlan };
Reflect.deleteProperty(noVersion, 'v');

it.each([
  ['no guard', {}],
  ['missing expectedWipe', { byteCheck: factCommand.byteCheck }],
  ['missing byteCheck', { expectedWipe: factCommand.expectedWipe }],
  ['bad wipe UUID', { ...factCommand, expectedWipe: 'bad' }],
  ['bad byteCheck', { ...factCommand, byteCheck: 'bad' }],
  ['extra field', { ...factCommand, extra: true }],
  ['other origin', { ...factCommand, plan: { ...factPlan, origin: 'kr-revision' } }],
  ['empty plan', { ...factCommand, plan: manualPlan() }],
  ['second write', { ...factCommand, plan: manualPlan(fact, goalWrite(2, 21)) }],
  ['non-absent base', { ...factCommand, plan: manualPlan({ ...fact, base: versionOf(original) }) }],
  ['bad key', { ...factCommand, plan: manualPlan({ ...fact, key: 'kr-value:bad' }) }],
  ['wrong record type', { ...factCommand, plan: manualPlan({ ...fact, value: edit.value }) }],
  ['missing plan v', { ...factCommand, plan: noVersion }],
] as const)('rejects a fact command with %s before enqueueing', async (_label, fields) => {
  const host = await startHost();
  const view = await createBridge(host).open();
  const { entered, release } = holdFirstWrite(host);
  const ahead = view.send(command());
  try {
    await Promise.race([entered.promise, ahead]);
    host.api.loadSyncedData.mockClear();
    const request = { cmd: 'apply', plan: factPlan, forceSync: true, ...fields } as const;
    const result = view.send(request).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const error = expect.stringMatching(/некорректная команда/i);
    const response = { type: 'PLUGIN_MESSAGE_ERROR', error };
    expect.soft(view.reply.mock.lastCall?.[0]).toMatchObject(response);
    release.resolve();
    await result;
    expect.soft(host.api.loadSyncedData).not.toHaveBeenCalled();
    expect(host.api.persistDataSynced).toHaveBeenCalledExactlyOnceWith(edit.value, edit.key);
    expect(host.api.triggerSync).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await ahead;
  }
});

it('rejects a valid plan from a foreign iframe before enqueueing', async () => {
  const host = await startHost();
  const bridge = createBridge(host);
  const oldView = await bridge.open();
  const view = await bridge.open(oldView.iframeWindow);
  const message = command();
  const request = { type: 'PLUGIN_MESSAGE', messageId: 'valid-request', message } as const;
  const reads = host.api.loadSyncedData.mock.calls.length;

  await view.receive({ source: {}, data: request });
  await oldView.receive({ source: view.iframeWindow, data: request });
  expect(host.deliver).not.toHaveBeenCalled();
  expect(host.api.loadSyncedData).toHaveBeenCalledTimes(reads);
  expect(host.api.persistDataSynced).not.toHaveBeenCalled();
  expect(view.reply).not.toHaveBeenCalled();
  expect(oldView.reply).not.toHaveBeenCalled();

  await view.receive({ source: view.iframeWindow, data: request });
  expect(host.deliver).toHaveBeenCalledExactlyOnceWith(request.message);
  expect(view.reply).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ type: 'PLUGIN_MESSAGE_RESPONSE', messageId: request.messageId }),
  );
  expect(host.api.persistDataSynced).toHaveBeenCalledExactlyOnceWith(edit.value, edit.key);
});

it('keeps applying after the iframe closes', async () => {
  const host = await startHost();
  const bridge = createBridge(host);
  const firstView = await bridge.open();
  const { entered, release } = holdFirstWrite(host);
  const first = firstView.send(command());
  const firstResult = first.catch((error: unknown) => error);
  await Promise.race([entered.promise, first]);

  bridge.close();
  const secondView = await bridge.open();
  const reads = host.api.loadSyncedData.mock.calls.length;
  const second = secondView.send(command(next));
  const secondResult = second.catch((error: unknown) => error);
  const wire = secondView.postMessage.mock.calls[0]![0];
  secondView.reply(
    { type: 'PLUGIN_MESSAGE_RESPONSE', messageId: wire.messageId, result: 'foreign' },
    {},
  );
  const complete = vi.fn();
  void secondResult.then(complete);

  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).not.toHaveBeenCalled();
    expect(host.api.loadSyncedData).toHaveBeenCalledTimes(reads);
    expect(host.api.persistDataSynced).toHaveBeenCalledExactlyOnceWith(edit.value, edit.key);
  } finally {
    release.resolve();
  }
  await Promise.all(firstView.deliveries);
  await second;
  expect(firstView.reply).not.toHaveBeenCalled();
  const replies = secondView.reply.mock.calls.slice(1).map(([reply]) => reply);
  expect(replies).toMatchObject([{ type: 'PLUGIN_MESSAGE_RESPONSE', messageId: wire.messageId }]);
  await host.commitAfter(Promise.resolve());
  expect(host.committed()).toEqual(
    applyPlan(applyPlan(initial, command().plan), command(next).plan),
  );

  await vi.advanceTimersByTimeAsync(30_000);
  expect(await firstResult).toBeInstanceOf(Error);
});

it('requests sync for a retry handed to the executor before the form closes', async () => {
  const host = await startHost();
  const view = await createBridge(host).open();
  const form = createGoalEditor({
    facade: view.createIframeFacade({}),
    drafts: createDraftStore(createFakeDraftDatabase().factory),
    now: Date.now,
    newId: () => crypto.randomUUID(),
  });
  await form.open(original.key);
  expect(form.input({ action: 'edit', fields: { statement: 'Нужно синхронизировать' } })).toBe(
    true,
  );
  await form.save();
  await host.commitAfter(view.deliveries[0]!);
  const first = view.postMessage.mock.calls[0]?.[0].message;
  if (first?.cmd !== 'apply') throw new Error('Expected the initial plan');
  expect(host.api.triggerSync).not.toHaveBeenCalled();

  host.api.getSyncedDataSaveState.mockResolvedValue({
    sync: 'offline',
    keys: { [original.key]: { state: 'pending' } },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(form.view()).toMatchObject({ status: 'retry', busy: false });
  host.api.loadSyncedData.mockClear();
  const { entered, release } = holdFirstWrite(host);
  const retry = form.retry();
  try {
    await Promise.race([entered.promise, retry]);
    const repeated = view.postMessage.mock.calls[1]?.[0].message;
    if (repeated?.cmd !== 'apply') throw new Error('Expected the retry plan');
    const write = repeated.plan.writes[0]!;
    expect(write).toMatchObject({ key: original.key, base: versionOf(first.plan.writes[0]!) });
    expect(versionOf(write)).not.toBe(versionOf(first.plan.writes[0]!));
    expect(host.api.loadSyncedData).toHaveBeenCalledWith(original.key);
    expect(host.api.persistDataSynced).toHaveBeenLastCalledWith(write.value, write.key);
    expect(view.reply).toHaveBeenCalledTimes(1);

    form.close();
    release.resolve();
    await host.commitAfter(view.deliveries[1]!);
    await retry;
    expect(view.reply).toHaveBeenCalledTimes(2);
    expect(host.committed().entries[write.key]).toBe(write.value);
    expect(form.view().key).toBe('');
    expect(host.api.triggerSync).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
  }
});

it.each(['editor', 'fact replay', 'fact replay after wipe'] as const)(
  're-reads after a timed-out %s request and keeps the queue locked',
  async (scenario) => {
    const isFact = scenario !== 'editor';
    const wipeChanged = scenario === 'fact replay after wipe';
    const parent = canonicalJson({
      v: 1,
      ver: versionOf(original),
      at: 11,
      kind: 'kr',
      status: 'active',
      objectiveKey: 'objective:00000000-0000-4000-8000-000000000030',
      statement: 'Lead time',
      baseline: '10 days',
      target: '5 days',
      dataSource: 'Release audit',
      history: [],
    });
    const expectedWipe = versionOf(goalWrite(2, 21));
    const marker = canonicalJson({ v: 2, ver: expectedWipe, at: 21 });
    const entries = isFact
      ? { ...initial.entries, [krKey]: parent, [WIPE_KEY]: marker }
      : initial.entries;
    const host = await startHost(entries);
    const view = await createBridge(host).open();
    const { entered, release } = holdFirstWrite(host);
    const firstWrite = isFact ? fact : edit;
    const firstCommand = { ...factCommand, expectedWipe };
    const first = view.send(isFact ? firstCommand : command()).catch((error: unknown) => error);
    try {
      expect(await Promise.race([entered.promise, first])).toBeUndefined();
      const { loadSyncedData, persistDataSynced, triggerSync } = host.api;
      loadSyncedData.mockClear();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(loadSyncedData).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await first).toMatchObject({ message: expect.stringMatching(/unknown|неизвест/i) });
      expect(loadSyncedData).toHaveBeenCalledWith(firstWrite.key);
      expect(host.committed().entries).toEqual(entries);
      loadSyncedData.mockClear();

      const retry = { ...firstCommand, forceSync: true } as const;
      const second = view.send(isFact ? retry : command(next)).catch((error: unknown) => error);
      const independent = isFact && view.send(command()).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(loadSyncedData).not.toHaveBeenCalled();
      expect(persistDataSynced).toHaveBeenCalledExactlyOnceWith(firstWrite.value, firstWrite.key);
      expect(view.reply).not.toHaveBeenCalled();
      const wipe = canonicalJson({ v: 2, ver: versionOf(next), at: 13 });
      if (wipeChanged) host.receiveSync(WIPE_KEY, wipe);
      release.resolve();

      expect(await second).toMatchObject(
        wipeChanged ? expect.any(Error) : { transferred: isFact ? 0 : 1 },
      );
      if (isFact) expect(await independent).toMatchObject({ transferred: 1 });
      expect(triggerSync).toHaveBeenCalledTimes(isFact && !wipeChanged ? 1 : 0);
      const last = isFact ? edit : next;
      const calls = [firstWrite, last].map(({ value, key }) => [value, key]);
      expect(persistDataSynced.mock.calls).toEqual(calls);
      const ids = view.postMessage.mock.calls.map(([wire]) => wire.messageId);
      expect(new Set(ids).size).toBe(ids.length);
      const replies = view.reply.mock.calls.map(([reply]) => reply);
      expect(replies.map(({ messageId }) => messageId)).toEqual(ids);
      const errors = replies.filter(({ type }) => type === 'PLUGIN_MESSAGE_ERROR');
      expect(errors).toHaveLength(Number(wipeChanged));
      await host.commitAfter(Promise.resolve());
      expect(host.committed().entries).toEqual({
        ...entries,
        [firstWrite.key]: firstWrite.value,
        [last.key]: last.value,
        ...(wipeChanged && { [WIPE_KEY]: wipe }),
      });
    } finally {
      release.resolve();
    }
  },
);

it.each([
  ['reports a plan still incomplete at 60 seconds', false],
  ['does not report a completed plan whose reply was lost', true],
] as const)('%s', async (_label, completed) => {
  const host = await startHost();
  const dropReply = vi.fn((_answer: Reply, message: Request['message']) => message.cmd === 'apply');
  const view = await createBridge(host).open({}, completed ? dropReply : undefined);
  const { entered, release } = holdFirstWrite(host);
  const onIncomplete = vi.fn();
  const onReread = vi.fn();
  const first = view.send(command(), { onIncomplete, onReread }).catch((error: unknown) => error);
  const [{ messageId: applyId, message }] = view.postMessage.mock.calls[0]!;
  try {
    await Promise.race([entered.promise, first]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await first).toMatchObject({ message: expect.stringMatching(/unknown|неизвест/i) });
    expect(onReread).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(initial));

    await vi.advanceTimersByTimeAsync(1);
    const second = completed ? undefined : view.send(command(next));
    void second?.catch(() => undefined);
    if (completed) {
      release.resolve();
      await host.commitAfter(view.deliveries[0]!);
      expect(host.committed()).toEqual(applyPlan(initial, command().plan));
      expect(dropReply).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: 'PLUGIN_MESSAGE_RESPONSE', messageId: applyId }),
        message,
      );
    }
    await vi.advanceTimersByTimeAsync(29_998);
    expect(onIncomplete).not.toHaveBeenCalled();
    expect(view.reply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(message).toMatchObject({ cmd: 'apply', requestId: applyId });
    const [statusWire] = view.postMessage.mock.lastCall!;
    expect(statusWire.message).toEqual({ cmd: 'isApplying', requestId: applyId });
    const status = {
      type: 'PLUGIN_MESSAGE_RESPONSE',
      messageId: statusWire.messageId,
      result: !completed,
    };
    expect(view.reply).toHaveBeenCalledExactlyOnceWith(status);
    expect(host.api.persistDataSynced).toHaveBeenCalledExactlyOnceWith(edit.value, edit.key);
    if (completed) {
      expect(onIncomplete).not.toHaveBeenCalled();
    } else {
      expect(onIncomplete).toHaveBeenCalledExactlyOnceWith(
        'Запись не завершена — перезапустите приложение',
      );
      release.resolve();
      await second;
      expect(host.api.persistDataSynced).toHaveBeenLastCalledWith(next.value, next.key);
      expect(host.api.persistDataSynced).toHaveBeenCalledTimes(2);
    }
  } finally {
    release.resolve();
  }
});
