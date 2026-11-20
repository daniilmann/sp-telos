// Entry of plugin.js: an es2020 IIFE script.
import { isApplyingQuery, isCommand, isCompatibilityQuery } from './app/commands';
import { apply, checkCompatibility } from './platform/sp-facade';

const compatibilityFailure = 'Только чтение. Не удалось проверить совместимость основы.';

async function compatibilityReason(): Promise<string | null> {
  try {
    const { readOnlyReason } = await checkCompatibility();
    return readOnlyReason ?? null;
  } catch {
    return compatibilityFailure;
  }
}

const startup = new Promise<void>((resolve) => {
  const checkStartup = async () => {
    await compatibilityReason();
    resolve();
  };
  if (typeof PluginAPI.onReady === 'function') PluginAPI.onReady(checkStartup);
  else void checkStartup();
});

let tail = startup;
const applying = new Set<string>();
const editCooldowns = new Map<string, Promise<void>>();

// The host binds the original iframe window and bridge generation before forwarding the body.
if (typeof PluginAPI.onMessage === 'function') {
  PluginAPI.onMessage((message: unknown) => {
    if (isCompatibilityQuery(message)) return startup.then(compatibilityReason);
    if (isApplyingQuery(message)) return Promise.resolve(applying.has(message.requestId));
    if (!isCommand(message)) return Promise.reject(new Error('Некорректная команда плагина.'));

    const { plan, requestId } = message;
    if (requestId !== undefined) {
      if (applying.has(requestId))
        return Promise.reject(new Error('План с таким идентификатором уже выполняется.'));
      applying.add(requestId);
    }
    const result = tail
      .then(() => apply(plan, message, editCooldowns))
      .finally(() => {
        if (requestId !== undefined) applying.delete(requestId);
      });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  });
}

PluginAPI.registerMenuEntry({
  label: 'SP Telos',
  icon: 'flag',
  onClick: () => {
    PluginAPI.showIndexHtmlAsView();
  },
});
