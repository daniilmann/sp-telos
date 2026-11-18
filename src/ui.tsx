// Entry of ui.js (iframe).
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { decodeRecord } from './core/records';
import type { ReadSnapshot } from './platform/facade';
import { createIframeFacade, send } from './platform/iframe-messaging';
import { App } from './ui/App';

function View() {
  const [snapshot, setSnapshot] = useState<ReadSnapshot>();
  const [readStatus, setReadStatus] = useState('Загрузка…');
  const [compatibility, setCompatibility] = useState('');
  const [deadline, setDeadline] = useState('');

  useEffect(() => {
    let active = true;
    const showSnapshot = (result: ReadSnapshot) => {
      if (!active) return;
      setSnapshot(result);
      setReadStatus('');
    };
    const facade = createIframeFacade({
      onReread: showSnapshot,
      onIncomplete: (message) => {
        if (active) setDeadline(message);
      },
    });
    void facade.read().then(showSnapshot, () => {
      if (active) setReadStatus('Не удалось прочитать данные.');
    });
    void send({ cmd: 'compatibility' }).then(
      (reason) => {
        if (active && typeof reason === 'string') setCompatibility(reason);
      },
      () => {
        if (active) setCompatibility('Только чтение. Не удалось проверить совместимость основы.');
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const statements = Object.entries(snapshot?.entries ?? {}).flatMap(([key, raw]) => {
    const decoded = decodeRecord(key, raw);
    return decoded.ok && 'statement' in decoded.value
      ? [<li key={key}>{decoded.value.statement}</li>]
      : [];
  });

  return (
    <>
      <App buildId={BUILD_ID} />
      {readStatus && <p role="status">{readStatus}</p>}
      {(snapshot?.readOnlyReason || compatibility) && (
        <p role="status">{snapshot?.readOnlyReason || compatibility}</p>
      )}
      {deadline && <p role="status">{deadline}</p>}
      {statements.length > 0 && <ul>{statements}</ul>}
    </>
  );
}

const root = document.getElementById('app');
if (root) {
  render(<View />, root);
}
