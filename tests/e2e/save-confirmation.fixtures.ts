import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { BrowserContext, FrameLocator, Locator, Page, Response } from '@playwright/test';
import { buildPlan, isPlan, type Plan } from '../../src/core/plan';
import { RECORD_PREFIXES } from '../../src/core/records';
import type { Draft } from '../../src/platform/draft-store';
import { expect, isSyncOps, SYNC_ORIGIN, test, type Stand, type StandProfile } from './stand';

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
      if (partitions.has(context)) return void socket.close();
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

export const sync = (body: Locator) => body.evaluate(() => PluginAPI.triggerSync());

export const digest = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');
export function receipt(raw: string) {
  return { state: 'saved', valueSha256: digest(raw), savedAt: expect.any(Number) };
}

export async function pressEnter(control: Locator, timeout?: number) {
  const options = timeout === undefined ? undefined : { timeout };
  await expect(control).toBeVisible(options);
  await expect(control).toBeEnabled(options);
  await control.focus(options);
  await control.press('Enter', options);
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
      signal.onabort = () => {
        resolve(undefined);
      };
      window.addEventListener('message', read, { signal });
    });
    return { plan };
  }, timeout + 2_000);
  try {
    const control = button(profile.frame, action);
    if (action === 'Подтвердить пересмотр') await pressEnter(control, timeout);
    else await control.click({ timeout });
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
  await expect.poll(find, { message: 'Exact value committed in SUP_OPS' }).toBeDefined();
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
  const barrier = await body.evaluateHandle(
    (_body, wait) => {
      const proto = IDBObjectStore.prototype;
      const { put, delete: remove } = proto;
      const state = { entered: false, released: false, deletes: 0, outcome: '', reason: '' };
      const matches = (store: IDBObjectStore, key: unknown) =>
        key === wait.key &&
        store.name === 'drafts' &&
        store.transaction.db.name === 'sp-telos-drafts';
      function hold(store: IDBObjectStore) {
        if (!state.released) {
          store.count(wait.key).addEventListener('success', () => {
            hold(store);
          });
        } else if (wait.abort) store.transaction.abort();
      }
      function intercept(store: IDBObjectStore, request: IDBRequest) {
        if (state.entered) return;
        state.entered = true;
        const finish = ({ type }: Event) => {
          state.outcome = type;
        };
        store.transaction.addEventListener('complete', finish);
        store.transaction.addEventListener('abort', finish);
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
            if (fields?.action === 'close' && typeof fields.reason === 'string')
              state.reason = fields.reason;
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
      return state;
    },
    { key, method, abort },
  );
  return {
    read: () => barrier.jsonValue(),
    entered: () => expect.poll(async () => (await barrier.jsonValue()).entered).toBe(true),
    release: () =>
      body.evaluate(
        (_body, state) => {
          state.released = true;
        },
        barrier,
        { timeout: 2_000 },
      ),
  };
}

export async function planInIframe(body: Locator, plan: Plan) {
  await body.evaluate(
    (_body, data) =>
      new Promise<void>((resolve, reject) => {
        const messageId = crypto.randomUUID();
        const origin = 'http://127.0.0.1:47173';
        const signal = AbortSignal.timeout(10_000);
        signal.onabort = () => {
          reject(new Error('No reply to the seed plan'));
        };
        function receive(event: MessageEvent<{ type?: string; messageId?: string } | null>) {
          if (event.origin !== origin) return;
          if (event.source !== window.parent || event.data?.messageId !== messageId) return;
          window.removeEventListener('message', receive);
          if (event.data.type === 'PLUGIN_MESSAGE_RESPONSE') resolve();
          else reject(new Error('Seed plan rejected'));
        }
        window.addEventListener('message', receive, { signal });
        const message = { cmd: 'apply', requestId: messageId, plan: data };
        window.parent.postMessage({ type: 'PLUGIN_MESSAGE', messageId, message }, origin);
      }),
    plan,
  );
}

export const makePlan = (inputs: Parameters<typeof buildPlan>[1]) =>
  buildPlan('manual', inputs, { at: Date.now(), newId: randomUUID });

const browserOnline = (page: Page) => page.evaluate(() => navigator.onLine);

export async function setOffline(profile: StandProfile) {
  partitions.add(profile.context);
  await profile.context.setOffline(true);
  await expect.poll(() => browserOnline(profile.page)).toBe(false);
  return async (page = profile.page) => {
    await profile.context.setOffline(false);
    partitions.delete(profile.context);
    await expect.poll(() => browserOnline(page)).toBe(true);
  };
}

export async function reopenOffline({ context }: StandProfile, stand: Stand) {
  const syncRequests = SYNC_ORIGIN + '/**';
  const abort = (route: import('@playwright/test').Route) => route.abort('internetdisconnected');
  await context.route(syncRequests, abort);
  try {
    // Let Chromium load the document natively while the WebSocket partition and HTTP block hold.
    await context.setOffline(false);
    const page = await context.newPage();
    // Use the same scheduler gates as the pinned fork's E2E suite.
    await page.addInitScript(() => {
      if (window !== window.top) return;
      Object.assign(globalThis, {
        __SP_E2E_BLOCK_AUTO_SYNC: true,
        __SP_E2E_BLOCK_WS_DOWNLOAD: true,
        __SP_E2E_BLOCK_IMMEDIATE_UPLOAD: true,
      });
    });
    return { context, page, frame: await stand.openPlugin(page) };
  } finally {
    await context.setOffline(true);
    await context.unroute(syncRequests, abort);
  }
}

type SyncOperation = { id: string; clientId: string; isPayloadEncrypted: boolean };
type UploadResult = { opId: string; accepted: boolean; serverSeq: number };
type SyncReply = { results?: UploadResult[]; ops?: { serverSeq: number; op: SyncOperation }[] };

function observeOps(source: BrowserContext | Page, method: 'GET' | 'POST') {
  const replies: (SyncReply & { response: Response })[] = [];
  source.on('response', async (response: Response) => {
    if (!response.ok() || !isSyncOps(response.request(), method)) return;
    const body = (await response.json().catch(() => null)) as SyncReply | null;
    if (body) replies.push({ response, ...body });
  });
  return replies;
}

export function watchUploads(context: BrowserContext) {
  let sent = 0;
  context.on('request', (request) => {
    if (isSyncOps(request, 'POST')) sent++;
  });
  // Read replies as they arrive, before the test looks up the committed operation ID.
  const replies = observeOps(context, 'POST');
  return {
    count: () => sent,
    async accepted(local: { id: string; clientId: string }, proof: 'body' | 'gzip' = 'body') {
      const find = () =>
        replies.find(({ results }) => results?.some(({ opId }) => opId === local.id));
      const replyStatus = () =>
        find()?.response.status() ?? (sent ? 'no matching successful reply' : 'no SuperSync POST');
      await expect
        .poll(replyStatus, { timeout: 20_000, message: 'POST status for the exact operation ID' })
        .toBe(200);
      const { response, results } = find()!;
      const result = results!.find(({ opId }) => opId === local.id)!;
      expect(result).toMatchObject({ accepted: true, serverSeq: expect.any(Number) });
      const request = response.request();
      if (proof === 'gzip') {
        expect(await request.headerValue('content-encoding'), 'Retry POST encoding').toBe('gzip');
      } else {
        const raw = request.postDataBuffer();
        if (!raw) throw new Error('Playwright could not read the encrypted upload body');
        const json = (raw[0] === 0x1f ? gunzipSync(raw) : raw).toString('utf8');
        const { ops } = JSON.parse(json) as { ops: SyncOperation[] };
        expect(ops).toContainEqual(expect.objectContaining({ ...local, isPayloadEncrypted: true }));
      }
      return result.serverSeq;
    },
  };
}

export function watchDownloads(page: Page) {
  const replies = observeOps(page, 'GET');
  return (op: SyncOperation, serverSeq: number) =>
    expect
      .poll(() => replies.flatMap((reply) => reply.ops ?? []).find((row) => row.op.id === op.id), {
        message: 'Second profile received the exact encrypted server operation',
      })
      .toMatchObject({ serverSeq, op });
}
