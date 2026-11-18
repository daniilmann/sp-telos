import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Command } from '../../src/app/commands';
import { applyPlan, EMPTY_STATE } from '../../src/core/plan';
import {
  createDeferred,
  createFakeHost,
  goalWrite,
  manualPlan,
  versionOf,
} from '../fakes/fake-facade';

type Request = {
  readonly type: 'PLUGIN_MESSAGE';
  readonly messageId: string;
  readonly message: Command;
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

async function startHost() {
  const host = createFakeHost(initial);
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
    async open(iframeWindow = {}) {
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
      const receive = async ({
        source,
        data,
      }: {
        source: object;
        data: Omit<Request, 'type'> & { type: string };
      }) => {
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
        if (source === currentWindow) reply(answer);
      };
      vi.stubGlobal('window', {
        parent: hostWindow,
        addEventListener: (_type: string, callback: NonNullable<typeof listener>) => {
          listener = callback;
        },
      });
      const { send } = await import('../../src/platform/iframe-messaging');
      return { deliveries, send, iframeWindow, postMessage, receive, reply };
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

it('rejects a valid plan from a foreign iframe before enqueueing', async () => {
  const host = await startHost();
  const bridge = createBridge(host);
  const oldView = await bridge.open();
  const view = await bridge.open(oldView.iframeWindow);
  const request: Request = {
    type: 'PLUGIN_MESSAGE',
    messageId: 'valid-request',
    message: command(),
  };
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
  const completion = secondResult.then(complete);

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
  await completion;
  expect(firstView.reply).not.toHaveBeenCalled();
  expect(secondView.reply.mock.calls.slice(1)).toEqual([
    [
      expect.objectContaining({
        type: 'PLUGIN_MESSAGE_RESPONSE',
        messageId: wire.messageId,
      }),
    ],
  ]);
  await host.commitAfter(Promise.resolve());
  expect(host.committed()).toEqual(
    applyPlan(applyPlan(initial, command().plan), command(next).plan),
  );

  await vi.advanceTimersByTimeAsync(30_000);
  expect(await firstResult).toBeInstanceOf(Error);
});

it('re-reads after a timed-out reply without unlocking the queue', async () => {
  const host = await startHost();
  const view = await createBridge(host).open();
  const { entered, release } = holdFirstWrite(host);
  const first = view.send(command());
  const firstResult = first.catch((error: unknown) => error);
  await Promise.race([entered.promise, first]);

  const reads = host.api.loadSyncedData.mock.calls.length;
  try {
    await vi.advanceTimersByTimeAsync(29_999);
    expect(host.api.loadSyncedData).toHaveBeenCalledTimes(reads);
    expect(view.reply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await firstResult).toMatchObject({
      message: expect.stringMatching(/unknown|неизвест/i),
    });
    expect(host.api.loadSyncedData.mock.calls.slice(reads)).toContainEqual([edit.key]);
    expect(host.committed()).toEqual(initial);
    const afterReread = host.api.loadSyncedData.mock.calls.length;

    const second = view.send(command(next));
    const secondResult = second.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.api.loadSyncedData).toHaveBeenCalledTimes(afterReread);
    expect(host.api.persistDataSynced).toHaveBeenCalledExactlyOnceWith(edit.value, edit.key);
    expect(view.reply).not.toHaveBeenCalled();
    release.resolve();
    await second;
    await secondResult;
    await Promise.all(view.deliveries);
    const [firstWire, secondWire] = view.postMessage.mock.calls;
    expect(firstWire![0].messageId).not.toBe(secondWire![0].messageId);
    expect(view.reply.mock.calls).toEqual([
      [
        expect.objectContaining({
          type: 'PLUGIN_MESSAGE_RESPONSE',
          messageId: firstWire![0].messageId,
        }),
      ],
      [
        expect.objectContaining({
          type: 'PLUGIN_MESSAGE_RESPONSE',
          messageId: secondWire![0].messageId,
        }),
      ],
    ]);
    await host.commitAfter(Promise.resolve());
    expect(host.committed()).toEqual(
      applyPlan(applyPlan(initial, command().plan), command(next).plan),
    );
  } finally {
    release.resolve();
  }
});

it('reports a plan still incomplete after 60 seconds', async () => {
  const host = await startHost();
  const view = await createBridge(host).open();
  const { entered, release } = holdFirstWrite(host);
  const onIncomplete = vi.fn<(message: string) => void>();
  const first = view.send(command(), { onIncomplete });
  const firstResult = first.catch((error: unknown) => error);
  try {
    await Promise.race([entered.promise, first]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await firstResult).toMatchObject({
      message: expect.stringMatching(/unknown|неизвест/i),
    });
    expect(onIncomplete).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const second = view.send(command(next));
    const secondResult = second.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(29_998);
    expect(onIncomplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onIncomplete).toHaveBeenCalledExactlyOnceWith(
      'Запись не завершена — перезапустите приложение',
    );
    expect(view.reply).not.toHaveBeenCalled();
    expect(host.api.persistDataSynced).toHaveBeenCalledExactlyOnceWith(edit.value, edit.key);
    release.resolve();
    await Promise.all(view.deliveries);
    await second;
    await secondResult;
    expect(host.api.persistDataSynced.mock.calls).toEqual([
      [edit.value, edit.key],
      [next.value, next.key],
    ]);
  } finally {
    release.resolve();
  }
});
