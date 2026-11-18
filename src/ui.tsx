// Entry of ui.js (iframe).
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { goalRecords, recordAt } from './app/commands';
import { createGoalEditor, type GoalEditor } from './app/goal-editor';
import { WIPE_KEY } from './core/records';
import { createDraftStore } from './platform/draft-store';
import {
  createHostFacade,
  newId,
  now,
  type EditorFacade,
  type ReadSnapshot,
} from './platform/facade';
import { send } from './platform/iframe-messaging';
import { App } from './ui/App';

function View() {
  const [snapshot, setSnapshot] = useState<ReadSnapshot>();
  const [message, setMessage] = useState('Загрузка…');
  const [draftKeys, setDraftKeys] = useState<readonly string[]>([]);
  const [model, setModel] = useState<{
    editor: GoalEditor;
    view: ReturnType<GoalEditor['view']>;
  }>();
  const [refresh, setRefresh] = useState<() => Promise<void>>(() => () => Promise.resolve());

  useEffect(() => {
    let active = true;
    const isActive = () => active;
    const drafts = createDraftStore();
    const showSnapshot = (result: ReadSnapshot) => {
      if (active) setSnapshot(result);
    };
    const host = createHostFacade();
    const compatibility = send({ cmd: 'compatibility' }).then(
      (reason) => (typeof reason === 'string' ? reason : undefined),
      () => 'Только чтение. Не удалось проверить совместимость основы.',
    );
    const facade: EditorFacade = {
      ...host,
      apply: (plan, onIncomplete) =>
        send({ cmd: 'apply', plan }, onIncomplete ? { onIncomplete } : undefined),
      async read(keys?: readonly string[]) {
        const [result, reason] = await Promise.all([host.read(keys), compatibility]);
        return reason ? { ...result, readOnlyReason: result.readOnlyReason ?? reason } : result;
      },
    };

    const editor = createGoalEditor({
      facade,
      drafts,
      now,
      newId,
      onRead: showSnapshot,
      onChange() {
        if (active) setModel({ editor, view: editor.view() });
      },
    });
    setModel({ editor, view: editor.view() });
    const load = async (initial = false) => {
      try {
        const [result, listed] = await Promise.all([facade.read(), drafts.list()]);
        if (!active) return;
        showSnapshot(result);
        setDraftKeys(listed.keys);
        setMessage(listed.failed ? 'Не удалось прочитать список черновиков.' : '');
        const firstDraft = listed.keys[0];
        const wipe = recordAt(result, WIPE_KEY)?.ver;
        if (initial && firstDraft && wipe) {
          const handled = await drafts.readWipeVersion().catch(() => undefined);
          if (isActive() && !editor.view().key && wipe !== handled) await editor.open(firstDraft);
        }
      } catch {
        if (active) setMessage('Не удалось прочитать данные.');
      }
    };
    setRefresh(() => load);
    void load(true);
    const draftWatch = setInterval(() => {
      void editor.checkDraft();
    }, 500);
    return () => {
      active = false;
      clearInterval(draftWatch);
      editor.close();
    };
  }, []);

  if (!model) return <p role="status">Загрузка…</p>;
  const { editor, view } = model;
  const open = (key: string) => {
    void editor.open(key);
  };
  return (
    <App
      editor={editor}
      view={view}
      records={snapshot ? goalRecords(snapshot) : {}}
      draftKeys={draftKeys}
      readOnly={snapshot?.readOnlyReason}
      message={message}
      open={open}
      create={(kind) => {
        open(`${kind}:${newId()}`);
      }}
      back={(choice) => {
        void editor.leave(choice).then((left) => {
          if (left) {
            return refresh();
          }
          return undefined;
        });
      }}
    />
  );
}

const root = document.getElementById('app');
if (root) render(<View />, root);
