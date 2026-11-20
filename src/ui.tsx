// Entry of ui.js (iframe).
import type { PluginHooks } from '@super-productivity/plugin-api';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { goalRecords, recordAt } from './app/commands';
import { createGoalEditor, type GoalEditor } from './app/goal-editor';
import { resolveLinkedReferences, type LinkedReferences } from './app/initiative-task-links';
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

type RefreshHook = PluginHooks.DATA_CHANGED | PluginHooks.PERSISTED_DATA_CHANGED;

const refreshHooks = ['dataChanged', 'persistedDataChanged'] satisfies `${RefreshHook}`[];

function isRefreshHook(hook: string): hook is RefreshHook {
  return refreshHooks.some((name) => name === hook);
}

interface ViewActions {
  readonly load: () => void;
  readonly openSource: (source: string) => void;
  readonly discard: (key: string) => void;
}

function View() {
  const [data, setData] = useState<{
    snapshot: ReadSnapshot;
    links: LinkedReferences;
    draftKeys: readonly string[];
  }>();
  const [message, setMessage] = useState('Загрузка…');
  const [model, setModel] = useState<{
    editor: GoalEditor;
    view: ReturnType<GoalEditor['view']>;
  }>();
  const [actions, setActions] = useState<ViewActions>();

  useEffect(() => {
    let active = true;
    let readNumber = 0;
    let selection = 0;
    let displayed = 0;
    const stamps = new WeakMap<ReadSnapshot, number>();
    const drafts = createDraftStore();
    const host = createHostFacade();
    const facade: EditorFacade = {
      ...host,
      apply: (plan, onIncomplete) =>
        send({ cmd: 'apply', plan }, onIncomplete ? { onIncomplete } : undefined),
      async read(keys?: readonly string[]) {
        const stamp = ++readNumber;
        const compatibility = send({ cmd: 'compatibility' }).then(
          (reason) => (typeof reason === 'string' ? reason : undefined),
          () => 'Только чтение. Не удалось проверить совместимость основы.',
        );
        const [result, reason] = await Promise.all([host.read(keys), compatibility]);
        const snapshot =
          reason && !result.readOnlyReason ? { ...result, readOnlyReason: reason } : result;
        stamps.set(snapshot, stamp);
        return snapshot;
      },
    };

    const editor = createGoalEditor({
      facade,
      drafts,
      now,
      newId,
      readForStatus: host.read,
      onRead(snapshot) {
        void publish(snapshot);
      },
      onChange() {
        if (active) setModel({ editor, view: editor.view() });
      },
    });
    setModel({ editor, view: editor.view() });

    async function publish(snapshot: ReadSnapshot, updateOpen = false) {
      const stamp = stamps.get(snapshot) ?? 0;
      const latest = () => active && stamp >= displayed;
      const [references, listed] = await Promise.all([host.readBaseReferences(), drafts.list()]);
      const links = await resolveLinkedReferences(snapshot, references, listed.keys, (key) =>
        drafts.read(key),
      );
      if (!latest()) return;
      displayed = stamp;
      setData({
        snapshot,
        links,
        draftKeys: listed.keys,
      });
      setMessage(listed.failed ? 'Не удалось прочитать список черновиков.' : '');
      if (updateOpen) await editor.refresh(snapshot, latest);
      return listed.keys;
    }

    async function load(initial = false) {
      try {
        const key = editor.view().key;
        const result = await facade.read(key ? [key] : undefined);
        const keys = await publish(result, true);
        const wipe = recordAt(result, WIPE_KEY)?.ver;
        if (initial && keys?.[0] && wipe) {
          const handled = await drafts.readWipeVersion().catch(() => undefined);
          if (active && !editor.view().key && wipe !== handled) await editor.open(keys[0]);
        }
      } catch {
        if (active) setMessage('Не удалось прочитать данные.');
      }
    }

    function refresh() {
      if (active) void load();
    }
    for (const hook of refreshHooks) {
      if (isRefreshHook(hook)) PluginAPI.registerHook(hook, refresh);
    }
    setActions({
      load: refresh,
      openSource(source) {
        const requested = ++selection;
        void host
          .linkedRecordKey(source)
          .then((key) => {
            if (active && requested === selection) return editor.open(key, source);
            return undefined;
          })
          .catch(() => {
            if (active && requested === selection) setMessage('Не удалось определить ключ записи.');
          });
      },
      discard(key) {
        drafts.remove(key);
        void drafts.flush().then((result) => {
          if (result.ok) refresh();
          else if (active) setMessage('Черновик не удалён.');
        });
      },
    });
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

  if (!model || !actions || !data) return <p role="status">{message}</p>;
  const { editor, view } = model;
  const open = (key: string) => {
    void editor.open(key);
  };
  return (
    <App
      editor={editor}
      view={view}
      records={goalRecords(data.snapshot)}
      links={data.links}
      draftKeys={data.draftKeys}
      readOnly={data.snapshot.readOnlyReason}
      message={message}
      open={open}
      refresh={actions.load}
      openSource={actions.openSource}
      discard={actions.discard}
      create={(kind) => {
        open(`${kind}:${newId()}`);
      }}
      back={(choice) => {
        void editor.leave(choice).then((left) => {
          if (left) actions.load();
        });
      }}
    />
  );
}

const root = document.getElementById('app');
if (root) render(<View />, root);
