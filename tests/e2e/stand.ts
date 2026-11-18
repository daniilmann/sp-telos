/// <reference types="node" />
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type Dialog,
  type FrameLocator,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';

// Keep these origins aligned with compose.yml.
const WEB_ORIGIN = 'http://127.0.0.1:47173';
export const SYNC_ORIGIN = 'http://127.0.0.1:47901';
const SYNC_WS_ORIGIN = 'ws://127.0.0.1:47901';
const CONFIG_URL = WEB_ORIGIN + '/#/config';
const pluginIframe = 'plugin-index iframe[data-plugin-id="sp-telos"]';

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json'],
  ['.webmanifest', 'application/manifest+json'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.mp3', 'audio/mpeg'],
]);

async function assetPath(variable: string, kind: 'file' | 'directory'): Promise<string> {
  const value = process.env[variable];
  if (!value) throw new Error(`Set ${variable} to the ${kind} for this run`);
  const path = await realpath(value);
  const info = await stat(path);
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) {
    throw new Error(`${variable} must point to a ${kind}`);
  }
  return path;
}

async function staticAsset(webDir: string, requestUrl: string): Promise<string> {
  const pathname = decodeURIComponent(new URL(requestUrl, WEB_ORIGIN).pathname);
  const path = resolve(webDir, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!path.startsWith(webDir + sep)) throw new Error('Asset outside web build');
  const file = await realpath(path);
  if (!file.startsWith(webDir + sep)) throw new Error('Asset outside web build');
  return file;
}

async function serveWebBuild(webDir: string): Promise<() => Promise<void>> {
  await stat(await staticAsset(webDir, '/'));
  const origin = new URL(WEB_ORIGIN);
  const server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    void (async () => {
      const file = await staticAsset(webDir, request.url ?? '/');
      const data = await readFile(file);
      response
        .writeHead(200, {
          'Content-Type': contentTypes.get(extname(file)) ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
        })
        .end(request.method === 'HEAD' ? undefined : data);
    })().catch(() => response.writeHead(404).end());
  });
  server.listen(Number(origin.port), origin.hostname);
  await once(server, 'listening');
  return () =>
    new Promise((done, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else done();
      });
      server.closeAllConnections();
    });
}

interface SyncAccount {
  userId: number;
  token: string;
  encryptionPassword: string;
}

function syncRequest(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(SYNC_ORIGIN + path, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
}

async function createSyncAccount(): Promise<SyncAccount> {
  await expectSyncHealthy();
  const response = await syncRequest('/api/test/create-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `sp-telos-${randomUUID()}@e2e.local`,
      password: randomUUID(),
    }),
  });
  expect(response.status, 'SuperSync test account creation').toBe(201);
  const user = (await response.json().catch(() => null)) as {
    userId?: unknown;
    token?: unknown;
  } | null;
  const { userId, token } = user ?? {};
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0)
    throw new Error('Invalid user ID from SuperSync test account endpoint');
  if (typeof token !== 'string' || !token.length)
    throw new Error('Invalid token from SuperSync test account endpoint');
  return { userId, token, encryptionPassword: randomUUID() };
}

export async function expectSyncHealthy(): Promise<void> {
  expect((await syncRequest('/health')).status, 'Loopback SuperSync /health').toBe(200);
}

export function isSyncOps(request: Request, method: 'GET' | 'POST'): boolean {
  const { origin, pathname } = new URL(request.url());
  return request.method() === method && origin === SYNC_ORIGIN && pathname === '/api/sync/ops';
}

export function expectSyncReady(page: Page) {
  const ready = page.locator(
    'body:not(:has(mat-dialog-container)) button.sync-btn:not(.is-in-progress):has(mat-icon:is([data-mat-icon-name="sync_ring"], [data-mat-icon-name="sync_done"]))',
  );
  return expect(ready, 'Restarted host has a ready and idle online sync provider').toBeVisible();
}

async function deleteSyncAccount(account: SyncAccount): Promise<void> {
  const response = await syncRequest(`/api/test/user/${String(account.userId)}`, {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`SuperSync test account cleanup returned HTTP ${String(response.status)}`);
  }
}

export interface StandProfile {
  context: BrowserContext;
  page: Page;
  frame: FrameLocator;
}

export interface Stand {
  /** Each call installs the candidate ZIP into a fresh browser profile. */
  newProfile(): Promise<StandProfile>;
  /** Reopens the plugin in an existing profile, including a replacement page. */
  openPlugin(page: Page): Promise<FrameLocator>;
  /** Configures this profile on the shared test account, including after a fresh start. */
  connectSync(profile: StandProfile): Promise<void>;
}

export async function openPluginIndex(page: Page, pluginId: string): Promise<FrameLocator> {
  if (page.url().startsWith(WEB_ORIGIN + '/#/plugins/')) {
    await page.goto(CONFIG_URL, { timeout: 10_000 });
  }
  const frames = page.locator('plugin-index iframe');
  await expect(frames).toHaveCount(0);
  await page.goto(WEB_ORIGIN + `/#/plugins/${pluginId}/index`, { timeout: 10_000 });
  const iframe = frames.and(page.locator(`iframe[data-plugin-id="${pluginId}"]`));
  await expect(iframe).toBeVisible();
  const frame = iframe.contentFrame();
  await expect
    .poll(() => frame.locator('body').evaluate(() => typeof PluginAPI !== 'undefined'))
    .toBe(true);
  return frame;
}

async function openPlugin(page: Page): Promise<FrameLocator> {
  const frame = await openPluginIndex(page, 'sp-telos');
  await expect(frame.locator('#app > *').first()).toBeVisible();
  return frame;
}

export async function openPluginPanel(profile: StandProfile): Promise<StandProfile> {
  await profile.frame.locator('body').evaluate(() => {
    PluginAPI.dispatchAction({ type: '[Layout] Show PluginPanel', pluginId: 'sp-telos' });
  });
  const frame = profile.page.frameLocator('plugin-panel-container ' + pluginIframe);
  await expect(frame.getByRole('heading', { name: 'Годовые цели', exact: true })).toBeVisible();
  await profile.page.goto(CONFIG_URL, { timeout: 10_000 });
  return { ...profile, frame };
}

export async function exportAndImport(page: Page): Promise<void> {
  const timeout = 8_000;
  const tab = page.locator('mat-tab-header .mat-mdc-tab:has(mat-icon:has-text("cloud_sync"))');
  const panel = page.locator('collapsible').filter({ hasText: 'Import/Export' });
  const imex = panel.locator('file-imex');
  await base.step('Select the Sync & Backup settings tab', async () => {
    await tab.click({ timeout });
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout });
  });
  await base.step('Expand Import/Export and wait for its controls', async () => {
    await panel.locator('.collapsible-header, .header').click({ timeout });
    await expect(panel.locator('.collapsible-panel:not(.ng-animating)')).toBeVisible({ timeout });
  });
  const backup = await base.step(
    'Download the real backup',
    async () => {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout }),
        imex.locator('button:has(mat-icon:text-is("file_upload"))').click({ timeout }),
      ]);
      return download.path();
    },
    { timeout: 12_000 },
  );
  await base.step('Import that file and handle the encryption warning if shown', async () => {
    const warning = page.locator('dialog-import-encryption-warning');
    const today = /#\/tag\/TODAY\//;
    await imex.locator('input[type="file"]').setInputFiles(backup, { timeout });
    await expect
      .poll(async () => today.test(page.url()) || (await warning.isVisible()), { timeout })
      .toBe(true);
    if (await warning.isVisible()) await warning.locator('button[color="warn"]').click({ timeout });
    await expect(page).toHaveURL(today, { timeout });
  });
}

async function installPlugin(page: Page, zip: string): Promise<void> {
  await page.goto(CONFIG_URL);
  await page.locator('mat-tab-header .mat-mdc-tab:has(mat-icon:has-text("extension"))').click();
  const manager = page.locator('plugin-management');
  await manager.locator('input[type="file"][accept=".zip"]').setInputFiles(zip);
  await page.locator('dialog-confirm button[e2e="confirmBtn"]').click();
  const toggle = manager.locator('mat-card').filter({ hasText: 'SP Telos' }).getByRole('switch');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
}

async function newProfile(browser: Browser, zip: string, contexts: BrowserContext[]) {
  const context = await browser.newContext({
    locale: 'en-US',
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 900 },
  });
  contexts.push(context);
  await context.route('**/*', async (route) => {
    const origin = new URL(route.request().url()).origin;
    if (origin === WEB_ORIGIN || origin === SYNC_ORIGIN) {
      await route.continue();
    } else {
      await route.abort();
    }
  });
  await context.routeWebSocket('**/*', (socket) => {
    if (new URL(socket.url()).origin === SYNC_WS_ORIGIN) {
      socket.connectToServer();
    } else {
      void socket.close();
    }
  });

  const page = await context.newPage();
  await installPlugin(page, zip);
  return { context, page, frame: await openPlugin(page) };
}

async function configureSync(page: Page, token: string): Promise<boolean> {
  await page.locator('button.sync-btn').click({ button: 'right' });
  const signIn = page.locator('dialog-sync-setup');
  const settings = page.locator('dialog-sync-cfg');
  await expect(signIn.or(settings)).toBeVisible();
  const freshSetup = await signIn.isVisible();
  if (freshSetup) await signIn.locator('.e2e-other-sync-options').click();
  const provider = settings.locator('formly-field-mat-select mat-select');
  const option = page.getByRole('option', { name: /^SuperSync(?: \(Beta\))?$/ });
  await provider.click();
  await option.click();
  await expect(provider).toHaveAttribute('aria-expanded', 'false');

  const input = settings.locator('.e2e-accessToken input, .e2e-accessToken textarea');
  await expect(input).toBeVisible();
  const baseUrl = settings.locator('.e2e-baseUrl input');
  if (!(await baseUrl.isVisible())) {
    await settings.locator('.collapsible-header').filter({ hasText: 'Advanced' }).click();
  }
  await baseUrl.fill(SYNC_ORIGIN);
  await input.fill(token).catch(() => {
    throw new Error('Could not enter the SuperSync test token');
  });
  await settings.locator('mat-dialog-actions button[mat-flat-button]').click();
  return freshSetup;
}

async function setEncryption(dialog: Locator, password: string): Promise<void> {
  const fields = dialog.locator('input[type="password"]');
  const confirm = dialog.locator('button[mat-flat-button][color="primary"]');
  await expect(async () => {
    await fields.nth(0).fill(password);
    await fields.nth(1).fill(password);
    await expect(confirm).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await confirm.click();
}

async function waitForInitialSync(
  page: Page,
  password: string,
  freshSetup: boolean,
): Promise<void> {
  const enable = page.locator('dialog-enable-encryption:visible');
  const unlock = page.locator('dialog-enter-encryption-password:visible');
  const choice = page.locator('sync-first-choice:visible');
  const importConflict = page.locator('dialog-sync-import-conflict:visible');
  const fresh = page
    .locator('dialog-confirm:visible')
    .filter({ hasText: /initial sync|fresh installation/i });
  const prompts = enable.or(unlock).or(choice).or(importConflict).or(fresh);
  const synced = page.locator(
    'body:not(:has(mat-dialog-container)) button.sync-btn[data-sync-confirmation="remote"]:not(:has(mat-icon.spin)):not(:has(mat-icon[data-mat-icon-name="sync_error"]))',
  );
  // Fresh setup can report remote confirmation before the async encryption prompt opens.
  let encryptionHandled = !freshSetup;
  for (let step = 0; step <= 6; step++) {
    const outcome = encryptionHandled ? prompts.or(synced) : prompts;
    await expect(outcome.first()).toBeVisible({ timeout: 30_000 });
    if (encryptionHandled && (await synced.isVisible())) return;
    if (step === 6) break;
    const prompt = prompts.last();
    // Bind the close wait to this instance. Setup and sync can open separate
    // encryption dialogs, and the next one must remain eligible for handling.
    const containerId = await prompt.evaluate(
      (element) => element.closest('mat-dialog-container')?.id,
    );
    if (!containerId) throw new Error('SuperSync prompt is missing its dialog container');
    const container = page.locator('mat-dialog-container').and(page.locator('#' + containerId));
    if (await container.locator(enable).isVisible()) {
      await setEncryption(container, password);
      encryptionHandled = true;
    } else if (await container.locator(unlock).isVisible()) {
      await container.locator('input[type="password"]').fill(password);
      await container.locator('button[mat-flat-button][color="primary"]').click();
      encryptionHandled = true;
    } else if (await container.locator(choice).isVisible()) {
      await container.locator('.e2e-first-sync-use-account input').check();
      await container.locator('.e2e-first-sync-submit').click();
    } else if (await container.locator(importConflict).isVisible()) {
      await container.getByRole('button', { name: 'Use Server Data', exact: true }).click();
    } else {
      await container.locator(fresh).locator('button[mat-flat-button]').click();
    }
    await expect(container).toBeHidden({ timeout: 30_000 });
  }
  throw new Error('SuperSync initial sync did not settle');
}

async function connectSync(profile: StandProfile, account: SyncAccount): Promise<void> {
  const { page } = profile;
  const unexpectedDialogs: string[] = [];
  const handleDialog = async (dialog: Dialog): Promise<void> => {
    const message = dialog.message();
    if (
      dialog.type() === 'confirm' &&
      (/^Initial Sync\s+This appears to be a fresh installation\./.test(message) ||
        /^This replaces this device's data with the server's and discards \d+ local change\(s\)\. Continue\?$/.test(
          message,
        ))
    ) {
      await dialog.accept();
    } else {
      unexpectedDialogs.push(dialog.type());
      await dialog.dismiss();
    }
  };
  page.on('dialog', handleDialog);
  try {
    const freshSetup = await configureSync(page, account.token);
    await waitForInitialSync(page, account.encryptionPassword, freshSetup);
    await openPlugin(page);
  } finally {
    page.off('dialog', handleDialog);
    if (unexpectedDialogs.length > 0) {
      throw new Error(
        'Unexpected native dialog during SuperSync setup: ' + unexpectedDialogs.join(', '),
      );
    }
  }
}

export const test = base.extend<{ stand: Stand }, { pluginZip: string }>({
  pluginZip: [
    async ({}, provide) => {
      const webDir = await assetPath('SP_TELOS_E2E_WEB_DIR', 'directory');
      const zip = await assetPath('SP_TELOS_E2E_PLUGIN_ZIP', 'file');
      const stop = await serveWebBuild(webDir);
      try {
        await provide(zip);
      } finally {
        await stop();
      }
    },
    { scope: 'worker' },
  ],
  stand: async ({ browser, pluginZip }, provide) => {
    const contexts: BrowserContext[] = [];
    let account: Promise<SyncAccount> | undefined;
    try {
      await provide({
        newProfile: () => newProfile(browser, pluginZip, contexts),
        openPlugin,
        connectSync: async (profile) => {
          account ??= createSyncAccount();
          await connectSync(profile, await account);
        },
      });
    } finally {
      const cleanup = await Promise.allSettled(contexts.map((context) => context.close()));
      const user = await account?.catch(() => undefined);
      if (user) await deleteSyncAccount(user);
      for (const result of cleanup) {
        if (result.status === 'rejected') throw result.reason;
      }
    }
  },
});

export { expect };
