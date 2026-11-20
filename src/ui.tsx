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
  enumerationTimeout,
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
  readonly open: (key: string) => void;
  readonly openSource: (source: string) => void;
  readonly discard: (key: string) => void;
}

const emptyLinks: LinkedReferences = {
  projects: {},
  tasks: {},
  tags: {},
  krs: {},
  initiatives: {},
  initiativeRows: [],
  taskRows: [],
  live: new Set(),
};

function View() {
  const [data, setData] = useState<{
    snapshot: ReadSnapshot;
    draftKeys: readonly string[];
  }>();
  const [links, setLinks] = useState(emptyLinks);
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
    let hookFailure = '';
    const stamps = new WeakMap<ReadSnapshot, number>();
    const drafts = createDraftStore();
    const host = createHostFacade();
    const facade: EditorFacade = {
      ...host,
      apply: (plan, onIncomplete) =>
        send({ cmd: 'apply', plan }, onIncomplete ? { onIncomplete } : undefined),
      async read(keys?: readonly string[]) {
        const stamp = ++readNumber;
        const compatibilityFailure = 'Только чтение. Не удалось проверить совместимость основы.';
        const compatibility = send({ cmd: 'compatibility' }).then(
          (reason) => {
            if (reason === null) return undefined;
            return typeof reason === 'string' && reason ? reason : compatibilityFailure;
          },
          () => compatibilityFailure,
        );
        const [result, reason] = await Promise.all([host.read(keys), compatibility]);
        const readOnlyReason =
          [result.readOnlyReason, reason].find((issue) => issue && issue !== enumerationTimeout) ??
          result.readOnlyReason ??
          reason;
        const snapshot = readOnlyReason ? { ...result, readOnlyReason } : result;
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

    async function publish(snapshot: ReadSnapshot) {
      const stamp = stamps.get(snapshot) ?? 0;
      const latest = () => active && stamp >= displayed;
      const listed = await drafts.list();
      if (!latest()) return;
      displayed = stamp;
      setData({ snapshot, draftKeys: listed.keys });
      setMessage(listed.failed ? 'Не удалось прочитать список черновиков.' : hookFailure);
      void publishReferences(snapshot, listed.keys, latest);
      return listed.keys;
    }

    async function publishReferences(
      snapshot: ReadSnapshot,
      draftKeys: readonly string[],
      latest: () => boolean,
    ) {
      try {
        const references = await host.readBaseReferences();
        const linked = await resolveLinkedReferences(snapshot, references, draftKeys, (key) =>
          drafts.read(key),
        );
        if (latest()) setLinks(linked);
      } catch {
        if (latest()) setMessage('Не удалось прочитать ссылки.');
      }
    }

    async function load(initial = false) {
      try {
        const key = editor.view().key;
        const updateOpen = editor.beginRefresh();
        const result = await facade.read(key ? [key] : undefined);
        const [keys] = await Promise.all([publish(result), updateOpen(result)]);
        if (initial && keys && result.readOnlyReason === enumerationTimeout) void load();
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
      if (!isRefreshHook(hook)) continue;
      void Promise.resolve()
        .then(PluginAPI.registerHook.bind(PluginAPI, hook, refresh))
        .catch(() => {
          hookFailure = 'Не удалось подписаться на обновления. Доступно ручное обновление.';
          if (active) setMessage(hookFailure);
        });
    }
    setActions({
      load: refresh,
      open(key) {
        selection += 1;
        void editor.open(key);
      },
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

  if (!model || !actions) return <p role="status">{message}</p>;
  const { editor, view } = model;
  const open = actions.open;
  return (
    <App
      editor={editor}
      view={view}
      records={data ? goalRecords(data.snapshot) : {}}
      links={links}
      draftKeys={data?.draftKeys ?? []}
      readOnly={data?.snapshot.readOnlyReason}
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
