// Entry of ui.js (iframe). No Plugin API write methods here: writes go through plugin.js.
import { render } from 'preact';
import { send } from './platform/iframe-messaging';
import { App } from './ui/App';

const root = document.getElementById('app');
if (root) {
  render(<App buildId={BUILD_ID} onApply={(plan) => send({ cmd: 'apply', plan })} />, root);
}
