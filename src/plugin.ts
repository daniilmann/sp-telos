// Entry of plugin.js: an es2020 IIFE script.
import { isApplyingQuery, isCommand, isCompatibilityQuery } from './app/commands';
import { apply, checkCompatibility, hostMethodsReason } from './platform/sp-facade';

const startup = new Promise<string | undefined>((resolve) => {
  if (typeof PluginAPI.onReady !== 'function') {
    resolve(hostMethodsReason());
    return;
  }
  PluginAPI.onReady(async () => {
    try {
      await checkCompatibility();
      resolve(undefined);
    } catch {
      resolve('Только чтение. Не удалось проверить данные при запуске.');
    }
  });
});

let tail = startup.then(() => undefined);
const applying = new Set<string>();

// The host binds the original iframe window and bridge generation before forwarding the body.
if (typeof PluginAPI.onMessage === 'function') {
  PluginAPI.onMessage((message: unknown) => {
    if (isCompatibilityQuery(message))
      return startup.then((reason) => hostMethodsReason() ?? reason ?? null);
    if (isApplyingQuery(message)) return Promise.resolve(applying.has(message.requestId));
    if (!isCommand(message)) return Promise.reject(new Error('Некорректная команда плагина.'));

    const { plan, requestId } = message;
    if (requestId !== undefined) {
      if (applying.has(requestId))
        return Promise.reject(new Error('План с таким идентификатором уже выполняется.'));
      applying.add(requestId);
    }
    const result = tail
      .then(() => apply(plan))
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
