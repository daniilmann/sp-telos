// Entry of ui.js (iframe).
import { render } from 'preact';
import { App } from './ui/App';

const root = document.getElementById('app');
if (root) {
  render(<App buildId={BUILD_ID} />, root);
}
