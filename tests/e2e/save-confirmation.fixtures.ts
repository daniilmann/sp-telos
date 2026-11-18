import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { BrowserContext, FrameLocator, Locator, Page, Request } from '@playwright/test';
import { buildPlan, isPlan, type Plan } from '../../src/core/plan';
import { RECORD_PREFIXES } from '../../src/core/records';
import type { Draft } from '../../src/platform/draft-store';
import { expect, SYNC_ORIGIN, test, type Stand, type StandProfile } from './stand';

export const saved = /^Сохранено в (?:[01]\d|2[0-3]):[0-5]\d$/;
const partitions = new WeakSet<BrowserContext>();
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
export function receipt(raw: string) {
  return { state: 'saved', valueSha256: digest(raw), savedAt: expect.any(Number) };
}

async function nextPlan(profile: StandProfile, action: string): Promise<Plan> {
  const timeout = action === 'Повторить' ? 25_000 : 8_000;
  const iframe = profile.frame.owner();
  await iframe.waitFor({ state: 'attached', timeout });
  const message = await iframe.evaluateHandle((element, duration) => {
    const source = (element as HTMLIFrameElement).contentWindow;
    const signal = AbortSignal.timeout(duration);
    const plan = new Promise<unknown>((resolve) => {
      function read(
        event: MessageEvent<{ type?: string; message?: { cmd?: string; plan?: unknown } } | null>,
      ) {
        if (event.origin !== window.location.origin || !Object.is(event.source, source)) return;
        if (event.data?.type !== 'PLUGIN_MESSAGE' || event.data.message?.cmd !== 'apply') return;
        window.removeEventListener('message', read);
        resolve(event.data.message.plan);
      }
      signal.addEventListener(
        'abort',
        () => {
          resolve(undefined);
        },
        { once: true },
      );
      window.addEventListener('message', read, { signal });
    });
    return { plan };
  }, timeout + 2_000);
  try {
    await button(profile.frame, action).click({ timeout });
    const plan = await message.evaluate((message) => message.plan);
    if (!isPlan(plan)) throw new Error('Expected a plan from the form');
    return plan;
  } finally {
    await message.dispose();
  }
}

export async function submit(profile: StandProfile, text: string, action = 'Сохранить') {
  if (action === 'Сохранить') await statement(profile.frame).fill(text, { timeout: 8_000 });
  const plan = await nextPlan(profile, action);
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
    .click({ timeout: 8_000 });
  return submit(profile, title);
}

export async function confirm(
  profile: StandProfile,
  write: { key: string; value: string },
  trigger = true,
) {
  await expect(async () => {
    if (trigger) await sync(form(profile));
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
    id: string;
    c: string;
    d?: string;
    e?: string;
    p?: { actionPayload?: { pluginUserData?: { data: string } } };
  };
};

export async function committedWrite(
  profile: StandProfile,
  { key, value }: { key: string; value: string },
  pluginId = 'sp-telos',
) {
  const entityId = `${pluginId}:${key}`;
  const find = async () => {
    const rows = await idb<JournalRow[]>(profile.page.locator('body'), 'SUP_OPS', 'ops', 'all');
    return rows?.find(({ source, op }) => {
      const encoded = op.p?.actionPayload?.pluginUserData?.data;
      if (source !== 'local' || op.e !== 'PLUGIN_USER_DATA' || op.d !== entityId || !encoded)
        return false;
      const data = encoded.startsWith('GZ1:')
        ? gunzipSync(Buffer.from(encoded.slice(4), 'base64'), {
            maxOutputLength: 256 * 1024,
          }).toString('utf8')
        : encoded;
      return data === value;
    })?.op;
  };
  await expect
    .poll(async () => Boolean(await find()), {
      message: 'Exact value committed in SUP_OPS',
    })
    .toBe(true);
  const operation = await find();
  if (!operation) throw new Error('No committed operation');
  return { id: operation.id, clientId: operation.c };
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
      const { put, delete: remove } = proto;
      const state = { entered: false, released: false, deletes: 0, outcome: '', reason: '' };
      Object.assign(window, { draftBarrier: state });
      const matches = (store: IDBObjectStore, key: unknown) =>
        key === wait.key &&
        store.transaction.db.name === 'sp-telos-drafts' &&
        store.name === 'drafts';
      function hold(store: IDBObjectStore) {
        if (state.released) {
          if (wait.abort) store.transaction.abort();
          return;
        }
        store.count(wait.key).addEventListener('success', () => {
          hold(store);
        });
      }
      function intercept(store: IDBObjectStore, request: IDBRequest) {
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
      proto.put = function (value: unknown, id?: IDBValidKey) {
        const request = put.call(this, value, id);
        if (!matches(this, id)) return request;
        if (wait.method === 'put' && value && typeof value === 'object' && 'handoffVer' in value) {
          intercept(this, request);
        }
        if (wait.method === 'delete' && state.entered) {
          const fields = (value as Draft | undefined)?.fields;
          this.transaction.addEventListener('complete', () => {
            if (fields?.action === 'close' && typeof fields.reason === 'string') {
              state.reason = fields.reason;
            }
          });
        }
        return request;
      };
      proto.delete = function (id) {
        const request = remove.call(this, id);
        if (matches(this, id)) {
          state.deletes += 1;
          if (wait.method === 'delete') intercept(this, request);
        }
        return request;
      };
    },
    { key, method, abort },
  );
  const read = () =>
    body.evaluate(
      () =>
        (
          window as unknown as {
            draftBarrier: { entered: boolean; deletes: number; outcome: string; reason: string };
          }
        ).draftBarrier,
    );
  return {
    read,
    entered: () => expect.poll(async () => (await read()).entered).toBe(true),
    release: () =>
      body.evaluate(
        () => {
          (window as unknown as { draftBarrier: { released: boolean } }).draftBarrier.released =
            true;
        },
        undefined,
        { timeout: 2_000 },
      ),
  };
}

export async function planInIframe(body: Locator, plan: Plan) {
  await body.evaluate(
    (_body, data) =>
      new Promise<void>((resolve, reject) => {
        const messageId = crypto.randomUUID();
        const signal = AbortSignal.timeout(10_000);
        signal.addEventListener(
          'abort',
          () => {
            reject(new Error('No reply to the seed plan'));
          },
          {
            once: true,
          },
        );
        function receive(event: MessageEvent<{ type?: string; messageId?: string } | null>) {
          if (event.origin !== 'http://127.0.0.1:47173') return;
          if (event.source !== window.parent || event.data?.messageId !== messageId) return;
          window.removeEventListener('message', receive);
          if (event.data.type === 'PLUGIN_MESSAGE_RESPONSE') resolve();
          else reject(new Error('Seed plan rejected'));
        }
        window.addEventListener('message', receive, { signal });
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

const browserOnline = (page: Page) => page.evaluate(() => navigator.onLine);

export async function setOffline(profile: StandProfile) {
  const assets = new URL(profile.page.url()).origin + '/**';
  await profile.context.route(assets, async (route) => {
    // Fetch real loopback assets through Playwright while the browser transport is offline.
    await route.fulfill({ response: await route.fetch({ maxRedirects: 0 }) });
  });
  partitions.add(profile.context);
  await profile.context.setOffline(true);
  await expect.poll(() => browserOnline(profile.page)).toBe(false);
  return async (page = profile.page) => {
    await profile.context.unroute(assets);
    await profile.context.setOffline(false);
    partitions.delete(profile.context);
    await expect.poll(() => browserOnline(page)).toBe(true);
  };
}

export function blockBackgroundSync(page: Page) {
  // Use the same scheduler gates as the pinned fork's E2E suite.
  return page.addInitScript(() => {
    if (window !== window.top) return;
    Object.assign(globalThis, {
      __SP_E2E_BLOCK_AUTO_SYNC: true,
      __SP_E2E_BLOCK_WS_DOWNLOAD: true,
      __SP_E2E_BLOCK_IMMEDIATE_UPLOAD: true,
    });
  });
}

export function watchUploads(context: BrowserContext) {
  const sent: Request[] = [];
  context.on('request', (request) => {
    if (request.method() === 'POST' && request.url().startsWith(SYNC_ORIGIN + '/api/sync/ops?'))
      sent.push(request);
  });
  const accepted = async (local: { id: string; clientId: string }) => {
    const find = () =>
      sent.find((request) => {
        const raw = request.postDataBuffer();
        if (!raw) return false;
        const json = raw[0] === 0x1f ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
        const { ops } = JSON.parse(json) as {
          ops: { id: string; clientId: string; isPayloadEncrypted: boolean }[];
        };
        return ops.some(
          (op) => op.id === local.id && op.clientId === local.clientId && op.isPayloadEncrypted,
        );
      });
    await expect.poll(find, { timeout: 20_000 }).toBeDefined();
    const reply = await find()?.response();
    expect(reply?.status(), 'HTTP status of the exact upload').toBe(200);
    const { results } = (await reply!.json()) as {
      results: { opId: string; accepted: boolean; serverSeq?: number }[];
    };
    const result = results.find(({ opId }) => opId === local.id);
    expect(result?.accepted, 'SuperSync accepted the exact operation').toBe(true);
    expect(result?.serverSeq).toEqual(expect.any(Number));
  };
  return { accepted, count: () => sent.length };
}
