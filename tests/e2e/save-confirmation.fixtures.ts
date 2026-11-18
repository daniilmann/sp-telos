import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { BrowserContext, FrameLocator, Locator, Page } from '@playwright/test';
import { buildPlan, isPlan, type Plan } from '../../src/core/plan';
import { RECORD_PREFIXES } from '../../src/core/records';
import type { Draft } from '../../src/platform/draft-store';
import { expect, test, type Stand, type StandProfile } from './stand';

export const saved = /^Сохранено в (?:[01]\d|2[0-3]):[0-5]\d$/;
const syncOrigin = 'http://127.0.0.1:47901';
const partitions = new WeakSet<BrowserContext>();
const plugin = 'plugin-index iframe[data-plugin-id="sp-telos"]';
export const annual = 'Годовые цели';
export const form = (profile: StandProfile) => profile.frame.locator('body');
export const button = (frame: FrameLocator, name: string) =>
  frame.getByRole('button', { name, exact: true });
export const statement = (frame: FrameLocator) => frame.getByLabel('Формулировка', { exact: true });

export async function pair(stand: Stand) {
  test.setTimeout(240_000);
  async function connect() {
    const profile = await stand.newProfile();
    const { context } = profile;
    await context.routeWebSocket('ws://127.0.0.1:47901/**', (socket) => {
      if (partitions.has(context)) {
        void socket.close();
        return;
      }
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        if (!partitions.has(context)) server.send(message);
      });
      server.onMessage((message) => {
        if (!partitions.has(context)) socket.send(message);
      });
    });
    await stand.connectSync(profile);
    return profile;
  }
  const a = await connect();
  const b = await connect();
  expect(a.context).not.toBe(b.context);
  return { a, b };
}

export function load(body: Locator, key: string) {
  return body.evaluate((_body, id) => PluginAPI.loadSyncedData(id), key);
}

export function status(body: Locator, keys: string[]) {
  return body.evaluate((_body, ids) => PluginAPI.getSyncedDataSaveState(ids), keys);
}

export async function sync(body: Locator) {
  await body.evaluate(() => PluginAPI.triggerSync());
}

export const digest = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');
function receipt(raw: string) {
  return { state: 'saved', valueSha256: digest(raw), savedAt: expect.any(Number) };
}

async function nextPlan(profile: StandProfile, click: () => Promise<void>): Promise<Plan> {
  const message = profile.page.evaluate(
    (selector) =>
      new Promise<unknown>((resolve, reject) => {
        const timeout = AbortSignal.timeout(10_000);
        timeout.addEventListener(
          'abort',
          () => {
            reject(new Error('The form did not submit a plan'));
          },
          { once: true },
        );
        function read(
          event: MessageEvent<{ type?: string; message?: { cmd?: string; plan?: unknown } } | null>,
        ) {
          if (event.origin !== window.location.origin) return;
          const source = document.querySelector<HTMLIFrameElement>(selector)?.contentWindow;
          if (!source || !Object.is(event.source, source)) return;
          if (event.data?.type !== 'PLUGIN_MESSAGE' || event.data.message?.cmd !== 'apply') return;
          window.removeEventListener('message', read);
          resolve(event.data.message.plan);
        }
        window.addEventListener('message', read, { signal: timeout });
      }),
    plugin,
  );
  const [plan] = await Promise.all([message, click()]);
  if (!isPlan(plan)) throw new Error('Expected a plan from the form');
  return plan;
}

export async function submit(
  profile: StandProfile,
  text: string,
  action = 'Сохранить',
  afterSubmission?: () => Promise<void>,
) {
  if (action === 'Сохранить') await statement(profile.frame).fill(text);
  const plan = await nextPlan(profile, () => button(profile.frame, action).click());
  await afterSubmission?.();
  expect(plan.writes).toHaveLength(1);
  const write = plan.writes[0]!;
  await expect.poll(() => load(form(profile), write.key)).toBe(write.value);
  return { plan, ...write };
}

export async function create(profile: StandProfile, title: string) {
  await profile.frame
    .locator('section')
    .filter({ has: profile.frame.getByRole('heading', { name: annual, exact: true }) })
    .getByRole('button', { name: 'Создать', exact: true })
    .click();
  return submit(profile, title);
}

export async function confirm(profile: StandProfile, write: { key: string; value: string }) {
  await expect(async () => {
    await sync(form(profile));
    expect((await status(form(profile), [write.key])).keys).toEqual({
      [write.key]: receipt(write.value),
    });
  }).toPass({ timeout: 20_000 });
  await expect(profile.frame.getByText(saved)).toBeVisible();
}

export async function pull(profile: StandProfile, key: string, value: string) {
  await expect(async () => {
    await sync(form(profile));
    expect(await load(form(profile), key)).toBe(value);
  }).toPass({ timeout: 20_000 });
}

export async function snapshot(body: Locator) {
  return body.evaluate(async (_body, prefixes) => {
    const keys = (
      await Promise.all(prefixes.map((prefix) => PluginAPI.listSyncedDataKeys(prefix)))
    ).flat();
    const pairs = await Promise.all(
      keys.map(async (key) => [key, await PluginAPI.loadSyncedData(key)] as const),
    );
    return {
      entries: Object.fromEntries(
        pairs.filter((pair): pair is readonly [string, string] => pair[1] !== null),
      ),
    };
  }, RECORD_PREFIXES);
}

async function idb<T>(
  body: Locator,
  database: string,
  store: string,
  query: { key: string } | 'keys' | 'all',
): Promise<T | undefined> {
  return body.evaluate(
    (_body, names) =>
      new Promise<T | undefined>((resolve, reject) => {
        const request = indexedDB.open(names.database);
        request.onupgradeneeded = () => request.transaction?.abort();
        request.onerror = () => {
          reject(request.error ?? new Error('IDB open failed'));
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(names.store, 'readonly');
          const rows = tx.objectStore(names.store);
          const readCollection = names.query === 'all' ? rows.getAll : rows.getAllKeys;
          const read =
            typeof names.query === 'string' ? readCollection.call(rows) : rows.get(names.query.key);
          tx.oncomplete = () => {
            db.close();
            resolve(read.result as T | undefined);
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error ?? new Error('IDB read aborted'));
          };
        };
      }),
    { database, store, query },
  );
}

export const draft = (body: Locator, key: string) =>
  idb<Draft>(body, 'sp-telos-drafts', 'drafts', { key });
export const draftKeys = (body: Locator) =>
  idb<IDBValidKey[]>(body, 'sp-telos-drafts', 'drafts', 'keys');
export const deviceId = (page: Page) =>
  idb<string>(page.locator('body'), 'SUP_OPS', 'client_id', { key: 'current' });

type JournalRow = {
  source: string;
  op: {
    d?: string;
    e?: string;
    p?: { actionPayload?: { pluginUserData?: { data: string } } };
  };
};

export async function committedWrite(profile: StandProfile, key: string, value: string) {
  const entityId = 'sp-telos:' + key;
  await expect
    .poll(async () => {
      const rows = await idb<JournalRow[]>(profile.page.locator('body'), 'SUP_OPS', 'ops', 'all');
      return rows?.flatMap(({ source, op }) => {
        const encoded = op.p?.actionPayload?.pluginUserData?.data;
        if (source !== 'local' || op.e !== 'PLUGIN_USER_DATA' || op.d !== entityId || !encoded)
          return [];
        return [
          encoded.startsWith('GZ1:')
            ? gunzipSync(Buffer.from(encoded.slice(4), 'base64'), {
                maxOutputLength: 256 * 1024,
              }).toString('utf8')
            : encoded,
        ];
      });
    })
    .toContain(value);
}

export async function pauseDraft(
  body: Locator,
  key: string,
  method: 'put' | 'delete',
  abort = false,
) {
  await body.evaluate(
    (_body, wait) => {
      const proto = IDBObjectStore.prototype;
      const original = proto[wait.method];
      const state = { entered: false, released: false, deletes: 0, outcome: '' };
      Object.assign(window, { draftBarrier: state });
      function hold(store: IDBObjectStore) {
        if (state.released) {
          if (wait.abort) store.transaction.abort();
          return;
        }
        store.count(wait.key).addEventListener('success', () => {
          hold(store);
        });
      }
      function intercept(store: IDBObjectStore, request: IDBRequest, matches: boolean) {
        if (!matches || store.transaction.db.name !== 'sp-telos-drafts' || store.name !== 'drafts')
          return;
        if (wait.method === 'delete') state.deletes += 1;
        if (state.entered) return;
        state.entered = true;
        store.transaction.addEventListener('complete', () => {
          state.outcome = 'complete';
        });
        store.transaction.addEventListener('abort', () => {
          state.outcome = 'abort';
        });
        request.addEventListener('success', () => {
          hold(store);
        });
      }
      if (wait.method === 'put') {
        proto.put = function (value: unknown, id?: IDBValidKey) {
          const request = Reflect.apply(original, this, [value, id]) as IDBRequest<IDBValidKey>;
          intercept(
            this,
            request,
            id === wait.key && !!value && typeof value === 'object' && 'handoffVer' in value,
          );
          return request;
        };
        const remove = proto.delete;
        proto.delete = function (id) {
          if (id === wait.key && this.transaction.db.name === 'sp-telos-drafts') state.deletes += 1;
          return remove.call(this, id);
        };
      } else {
        proto.delete = function (id) {
          const request = Reflect.apply(original, this, [id]) as IDBRequest<undefined>;
          intercept(this, request, id === wait.key);
          return request;
        };
      }
    },
    { key, method, abort },
  );
  const read = () =>
    body.evaluate(
      () =>
        (
          window as unknown as {
            draftBarrier: { entered: boolean; released: boolean; deletes: number; outcome: string };
          }
        ).draftBarrier,
    );
  return {
    read,
    entered: () => expect.poll(async () => (await read()).entered).toBe(true),
    release: () =>
      body.evaluate(() => {
        (window as unknown as { draftBarrier: { released: boolean } }).draftBarrier.released = true;
      }),
  };
}

export async function planInIframe(body: Locator, plan: Plan) {
  await body.evaluate(
    (_body, data) =>
      new Promise<void>((resolve, reject) => {
        const messageId = crypto.randomUUID();
        function receive(event: MessageEvent<{ type?: string; messageId?: string } | null>) {
          if (event.origin !== 'http://127.0.0.1:47173') return;
          if (event.source !== window.parent || event.data?.messageId !== messageId) return;
          window.removeEventListener('message', receive);
          if (event.data.type === 'PLUGIN_MESSAGE_RESPONSE') resolve();
          else reject(new Error('Seed plan rejected'));
        }
        window.addEventListener('message', receive);
        window.parent.postMessage(
          {
            type: 'PLUGIN_MESSAGE',
            messageId,
            message: { cmd: 'apply', requestId: messageId, plan: data },
          },
          'http://127.0.0.1:47173',
        );
      }),
    plan,
  );
}

export const makePlan = (inputs: Parameters<typeof buildPlan>[1]) =>
  buildPlan('manual', inputs, { at: Date.now(), newId: randomUUID });

export async function checkForeignKey(profile: StandProfile, own: { key: string; value: string }) {
  const page = profile.page;
  const origin = new URL(page.url()).origin;
  const key = 'other:' + randomUUID();
  const value = '\uFEFF{ "text": "e\u0301" }\n';
  await page.goto(origin + '/#/config');
  await page.locator('mat-tab-header .mat-mdc-tab:has(mat-icon:has-text("extension"))').click();
  const toggle = page
    .locator('plugin-management mat-card')
    .filter({ hasText: 'Doc Mode' })
    .getByRole('switch');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.goto(origin + '/#/plugins/doc-mode/index');
  const other = page.frameLocator('plugin-index iframe[data-plugin-id="doc-mode"]').locator('body');
  await other.evaluate((_body, data) => PluginAPI.persistDataSynced(data.value, data.key), {
    key,
    value,
  });
  await expect(async () => {
    await sync(other);
    expect((await status(other, [key])).keys).toEqual({ [key]: receipt(value) });
  }).toPass({ timeout: 20_000 });
  await page.goto(origin + '/#/config');
  await page.goto(origin + '/#/plugins/sp-telos/index');
  expect(await load(form(profile), key)).toBeNull();
  expect((await status(form(profile), [own.key, key])).keys).toEqual({
    [own.key]: receipt(own.value),
    [key]: { state: 'unknown' },
  });
}

export async function setOffline(profile: StandProfile) {
  const assets = new URL(profile.page.url()).origin + '/**';
  await profile.context.route(assets, async (route) => {
    // Fetch real loopback assets through Playwright while the browser transport is offline.
    await route.fulfill({ response: await route.fetch({ maxRedirects: 0 }) });
  });
  partitions.add(profile.context);
  await profile.context.setOffline(true);
  expect(await profile.page.evaluate(() => navigator.onLine)).toBe(false);
  expect(
    await profile.page.evaluate(async (url) => {
      try {
        await fetch(url);
        return true;
      } catch {
        return false;
      }
    }, syncOrigin + '/health'),
  ).toBe(false);
  return async () => {
    partitions.delete(profile.context);
    await profile.context.setOffline(false);
    await profile.context.unroute(assets);
  };
}
