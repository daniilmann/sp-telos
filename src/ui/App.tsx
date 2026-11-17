import { useState } from 'preact/hooks';
import { setEntry } from '../app/commands';
import type { Plan } from '../core/plan';

export interface AppProps {
  readonly buildId: string;
  readonly onApply: (plan: Plan) => Promise<unknown>;
}

export function App({ buildId, onApply }: AppProps) {
  const [status, setStatus] = useState('idle');

  const save = async (): Promise<void> => {
    setStatus('saving');
    try {
      await onApply(setEntry('hello', 'world'));
      setStatus('saved');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'failed');
    }
  };

  return (
    <main>
      <h2>SP Telos</h2>
      <p>Build {buildId}</p>
      <button type="button" onClick={() => void save()}>
        Save
      </button>
      <p role="status">{status}</p>
    </main>
  );
}
