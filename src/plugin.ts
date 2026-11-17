// Entry of plugin.js: an es2020 IIFE script, the only place that writes host data.
import { isCommand } from './app/commands';
import { createHostFacade } from './platform/facade';

const facade = createHostFacade();

PluginAPI.onMessage?.(async (message: unknown) => {
  if (!isCommand(message)) throw new Error('Unknown message.');
  return facade.apply(message.plan);
});

PluginAPI.registerMenuEntry({
  label: 'SP Telos',
  icon: 'flag',
  onClick: () => {
    PluginAPI.showIndexHtmlAsView();
  },
});
