// Iframe side of the PLUGIN_MESSAGE bridge to plugin.js.
import type { ApplyingQuery, Command, CompatibilityQuery } from '../app/commands';
import {
  createHostFacade,
  newId,
  type EditorFacade,
  type HandoffObserver,
  type PlanHandoff,
  type ReadSnapshot,
} from './facade';

const TIMEOUT_MS = 30_000;
const INCOMPLETE_MS = 60_000;

interface SendOptions {
  readonly onIncomplete?: HandoffObserver;
  readonly onReread?: (snapshot: ReadSnapshot) => void;
}

// The host validates the full wire command before accepting it into the queue.
type ApplyRequest = Omit<Command, 'expectedWipe' | 'byteCheck'> & {
  readonly expectedWipe?: unknown;
  readonly byteCheck?: unknown;
};

interface Reply {
  readonly type?: unknown;
  readonly messageId?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

const pending = new Map<string, (reply: Reply) => void>();

window.addEventListener('message', (event: MessageEvent<Reply | null>) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (
    !data ||
    typeof data.messageId !== 'string' ||
    (data.type !== 'PLUGIN_MESSAGE_RESPONSE' && data.type !== 'PLUGIN_MESSAGE_ERROR')
  ) {
    return;
  }
  const complete = pending.get(data.messageId);
  pending.delete(data.messageId);
  complete?.(data);
});

export function send(message: ApplyRequest, options?: SendOptions): Promise<PlanHandoff>;
export function send(message: CompatibilityQuery): Promise<unknown>;
export function send(
  message: ApplyRequest | CompatibilityQuery,
  options: SendOptions = {},
): Promise<unknown> {
  return sendRequest(message, options);
}

function sendRequest(
  message: ApplyRequest | CompatibilityQuery | ApplyingQuery,
  options: SendOptions = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const messageId = newId();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      reject(new Error('Состояние неизвестно'));
      if (message.cmd === 'apply') {
        const keys = message.plan.writes.map(({ key }) => key);
        void createHostFacade()
          .read(keys)
          .then(options.onReread)
          .catch(() => {
            // The outcome is still unknown if the read also fails.
          });
      } else {
        pending.delete(messageId);
      }
    }, TIMEOUT_MS);
    const incomplete =
      message.cmd === 'apply'
        ? setTimeout(() => {
            pending.delete(messageId);
            const { onIncomplete } = options;
            if (onIncomplete === undefined) return;
            void sendRequest({ cmd: 'isApplying', requestId: messageId }).then(
              (isApplying) => {
                if (isApplying === true)
                  onIncomplete('Запись не завершена — перезапустите приложение');
              },
              () => {
                // The outcome is still unknown if the status request fails.
              },
            );
          }, INCOMPLETE_MS)
        : undefined;

    pending.set(messageId, (reply) => {
      clearTimeout(deadline);
      clearTimeout(incomplete);
      if (timedOut) return;
      if (reply.type === 'PLUGIN_MESSAGE_ERROR') {
        reject(new Error(typeof reply.error === 'string' ? reply.error : 'Ошибка записи плана.'));
      } else {
        resolve(reply.result);
      }
    });
    try {
      const observer = options.onIncomplete;
      const body =
        message.cmd === 'apply'
          ? {
              ...message,
              requestId: messageId,
              ...(observer?.forceSync && { forceSync: true }),
              ...(observer?.paceEditing && { paceEditing: true }),
              ...(observer?.expectedWipe !== undefined && {
                expectedWipe: observer.expectedWipe,
                byteCheck: observer.byteCheck,
              }),
            }
          : message;
      window.parent.postMessage({ type: 'PLUGIN_MESSAGE', messageId, message: body }, '*');
    } catch (error) {
      pending.delete(messageId);
      clearTimeout(deadline);
      clearTimeout(incomplete);
      throw error;
    }
  });
}

export function createIframeFacade(options: SendOptions) {
  return {
    ...createHostFacade(),
    apply: (plan, onIncomplete) =>
      send({ cmd: 'apply', plan }, onIncomplete ? { ...options, onIncomplete } : options),
  } satisfies EditorFacade;
}
