// Entry of plugin.js: an es2020 IIFE script.
import { isCommand, isCompatibilityQuery } from './app/commands';
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

// The host binds the original iframe window and bridge generation before forwarding the body.
if (typeof PluginAPI.onMessage === 'function') {
  PluginAPI.onMessage((message: unknown) => {
    if (isCompatibilityQuery(message))
      return startup.then((reason) => hostMethodsReason() ?? reason ?? null);
    if (!isCommand(message)) return Promise.reject(new Error('Некорректная команда плагина.'));

    const result = tail.then(() => apply(message.plan));
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
