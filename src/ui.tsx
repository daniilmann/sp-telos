// Entry of ui.js (iframe).
import type { PluginHooks } from '@super-productivity/plugin-api';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { goalRecords, recordAt } from './app/commands';
import { createGoalEditor, type GoalEditor } from './app/goal-editor';
import { resolveLinkedReferences, type LinkedReferences } from './app/initiative-task-links';
import { createKrValueEditor, listKrValueDrafts, type KrValueEditor } from './app/kr-values';
import { isRecordKeyOfKind, WIPE_KEY } from './core/records';
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
  readonly openMeasurement: (key: string, krKey: string) => void;
  readonly back: (choice?: Parameters<GoalEditor['leave']>[0]) => void;
  readonly resolveWipe: (choice: Parameters<GoalEditor['resolveWipe']>[0]) => void;
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
    measurementDrafts: Awaited<ReturnType<typeof listKrValueDrafts>>;
  }>();
  const [links, setLinks] = useState(emptyLinks);
  const [message, setMessage] = useState('Загрузка…');
  const [model, setModel] = useState<{
    editor: GoalEditor;
    view: ReturnType<GoalEditor['view']>;
    measurements: KrValueEditor;
    measurementView: ReturnType<KrValueEditor['view']>;
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
      onChange: showEditors,
    });
    const measurements = createKrValueEditor({ facade, drafts, now, newId, onChange: showEditors });
    showEditors();

    function showEditors() {
      if (active)
        setModel({
          editor,
          view: editor.view(),
          measurements,
          measurementView: measurements.view(),
        });
    }

    async function publish(snapshot: ReadSnapshot) {
      const stamp = stamps.get(snapshot) ?? 0;
      const latest = () => active && stamp >= displayed;
      const listed = await drafts.list();
      const measurementDrafts = await listKrValueDrafts(drafts, listed.keys);
      if (!latest()) return;
      displayed = stamp;
      setData({ snapshot, draftKeys: listed.keys, measurementDrafts });
      setMessage(listed.failed ? 'Не удалось прочитать список черновиков.' : hookFailure);
      void publishReferences(snapshot, listed.keys, latest);
      return { keys: listed.keys, measurementDrafts };
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
        const updateMeasurements = measurements.beginRefresh();
        const draftKey = measurements.view().draftKey;
        const result = await facade.read([...(key ? [key] : []), ...(draftKey ? [draftKey] : [])]);
        const [listed] = await Promise.all([
          publish(result),
          updateOpen(result),
          updateMeasurements(result),
        ]);
        if (initial && listed && result.readOnlyReason === enumerationTimeout) void load();
        const wipe = recordAt(result, WIPE_KEY)?.ver;
        if (initial && listed?.keys[0] && wipe) {
          const handled = await drafts.readWipeVersion().catch(() => undefined);
          if (active && !editor.view().key && wipe !== handled) {
            const first = listed.keys[0];
            const measurement = listed.measurementDrafts.find(({ key }) => key === first);
            await openCard(measurement?.krKey ?? first, measurement?.key);
          }
        }
      } catch {
        if (active) setMessage('Не удалось прочитать данные.');
      }
    }

    function refresh() {
      if (active) void load();
    }
    async function openCard(key: string, draftKey?: string) {
      const requested = ++selection;
      await editor.open(key);
      if (!active || requested !== selection || editor.view().key !== key) return;
      if (isRecordKeyOfKind(key, 'kr')) await measurements.open(key, draftKey);
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
        void openCard(key);
      },
      openMeasurement(key, krKey) {
        void openCard(krKey, key);
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
      back(choice) {
        measurements.pause();
        const requested = ++selection;
        void editor.leave(choice, measurements.view().draftKey).then((left) => {
          if (!active || selection !== requested) return;
          if (left) measurements.close();
          else if (choice === 'stay') measurements.pause(false);
          if (left || choice === 'stay') refresh();
        });
      },
      resolveWipe(choice) {
        const requested = selection;
        const { key } = measurements.view();
        measurements.pause();
        void editor.resolveWipe(choice).then(async () => {
          if (!active || selection !== requested) return;
          if (key && choice === 'discard' && !editor.view().wipe) await measurements.open(key);
          else measurements.pause(false);
          refresh();
        });
      },
    });
    void load(true);
    const draftWatch = setInterval(() => {
      void editor.checkDraft();
      void measurements.checkDraft();
    }, 500);
    return () => {
      active = false;
      clearInterval(draftWatch);
      measurements.close();
      editor.close();
    };
  }, []);

  if (!model || !actions) return <p role="status">{message}</p>;
  const { editor, view, measurements, measurementView } = model;
  const open = actions.open;
  return (
    <App
      editor={editor}
      view={view}
      measurements={measurements}
      measurementView={measurementView}
      records={data ? goalRecords(data.snapshot) : {}}
      links={links}
      draftKeys={data?.draftKeys ?? []}
      measurementDrafts={data?.measurementDrafts ?? []}
      readOnly={data?.snapshot.readOnlyReason}
      message={message}
      open={open}
      refresh={actions.load}
      openSource={actions.openSource}
      openMeasurement={actions.openMeasurement}
      resolveWipe={actions.resolveWipe}
      discard={actions.discard}
      create={(kind) => {
        open(`${kind}:${newId()}`);
      }}
      back={actions.back}
    />
  );
}

const root = document.getElementById('app');
if (root) render(<View />, root);
