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
} from '@playwright/test';

// Keep these origins aligned with compose.yml.
const WEB_ORIGIN = 'http://127.0.0.1:47173';
const SYNC_ORIGIN = 'http://127.0.0.1:47901';
const SYNC_WS_ORIGIN = 'ws://127.0.0.1:47901';
const PLUGIN_URL = WEB_ORIGIN + '/#/plugins/sp-telos/index';

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

function isTestUser(value: unknown): value is Pick<SyncAccount, 'userId' | 'token'> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'userId' in value &&
    typeof value.userId === 'number' &&
    Number.isSafeInteger(value.userId) &&
    value.userId > 0 &&
    'token' in value &&
    typeof value.token === 'string' &&
    value.token.length > 0
  );
}

function syncRequest(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(SYNC_ORIGIN + path, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
}

async function createSyncAccount(): Promise<SyncAccount> {
  const health = await syncRequest('/health').catch(() => {
    throw new Error(`SuperSync is unavailable at ${SYNC_ORIGIN}/health`);
  });
  if (!health.ok) throw new Error(`SuperSync /health returned HTTP ${String(health.status)}`);
  const response = await syncRequest('/api/test/create-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `sp-telos-${randomUUID()}@e2e.local`,
      password: randomUUID(),
    }),
  });
  if (response.status !== 201) {
    throw new Error(`SuperSync test account creation returned HTTP ${String(response.status)}`);
  }
  const user: unknown = await response.json().catch(() => null);
  if (!isTestUser(user)) throw new Error('Invalid response from SuperSync test account endpoint');
  return { userId: user.userId, token: user.token, encryptionPassword: randomUUID() };
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

async function openPlugin(page: Page): Promise<FrameLocator> {
  await page.goto(PLUGIN_URL);
  const frame = page.frameLocator('plugin-index iframe[data-plugin-id="sp-telos"]');
  await expect(frame.locator('#app > *').first()).toBeVisible();
  return frame;
}

async function installPlugin(page: Page, zip: string): Promise<void> {
  await page.goto(WEB_ORIGIN + '/#/config');
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
