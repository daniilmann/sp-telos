// @ts-check
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

const ALL = ['**/*.{ts,tsx,js,mjs}'];
const TS = ['**/*.{ts,tsx}'];
const JS = ['**/*.{js,mjs}'];
const SRC = ['src/**/*.{ts,tsx}'];

// Files allowed to exceed the default max-lines limit (up to 500 code lines).
// Keep this list empty; adding a file here needs a reason in the change description.
/** @type {string[]} */
const MAX_LINES_EXCEPTIONS = [];

/**
 * @param {string} selector
 * @param {string} message
 */
const ban = (selector, message) => ({ selector, message });

const GLOBAL_OBJECTS = '/^(window|self|globalThis|frames)$/';
const RAW_HTML = 'innerHTML|outerHTML|insertAdjacentHTML';

// Browser globals that src code must not reach, directly or through window/self/globalThis.
const BANNED_GLOBALS = [
  'top',
  'parent',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'eval',
  'Function',
];

// Extra globals for the pure core layer: no clock, randomness, crypto, timers, DOM or host API.
const CORE_GLOBALS = [
  'crypto',
  'performance',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'window',
  'self',
  'globalThis',
  'frames',
  'document',
  'navigator',
  'location',
  'history',
  'Element',
  'HTMLElement',
  'Node',
  'Event',
  'CustomEvent',
  'MessageEvent',
  'MutationObserver',
];

const BASE_SYNTAX = [
  ban(`MemberExpression[property.name=/^(${RAW_HTML})$/]`, 'Raw HTML injection is forbidden.'),
  ban(
    `MemberExpression[computed=true][property.value=/^(${RAW_HTML})$/]`,
    'Raw HTML injection is forbidden.',
  ),
  ban(
    'Property[key.name=/^(innerHTML|outerHTML|dangerouslySetInnerHTML)$/]',
    'Raw HTML injection is forbidden.',
  ),
  ban(
    'JSXAttribute[name.name=/^(innerHTML|outerHTML|dangerouslySetInnerHTML)$/]',
    'Raw HTML injection is forbidden.',
  ),
  ban(
    "MemberExpression[object.name='document'][property.name=/^write(ln)?$/]",
    'document.write is forbidden.',
  ),
  ban("CallExpression[callee.name='eval']", 'eval is forbidden.'),
  ban("NewExpression[callee.name='Function']", 'new Function is forbidden.'),
  ban("CallExpression[callee.name='Function']", 'Function() is forbidden.'),
  ban('ImportExpression', 'Dynamic import is forbidden: bundles must stay single scripts.'),
  ban("MemberExpression[property.name='sendBeacon']", 'Network access is forbidden.'),
  ban(
    "MemberExpression[object.type='MetaProperty'][property.name='vitest']",
    'In-source tests are forbidden in src.',
  ),
];

const NODE_SCRIPT_BAN = ban(
  "MemberExpression[property.name='executeNodeScript']",
  'executeNodeScript is allowed only in src/platform/desktop.ts.',
);

/** @param {string[]} names */
const globalMemberBan = (names) =>
  ban(
    `MemberExpression[object.name=${GLOBAL_OBJECTS}][property.name=/^(${names.join('|')})$/]`,
    'This browser API is forbidden here (storage, network, parent frame or eval).',
  );

// window.parent is allowed only as `window.parent.postMessage(...)` and as an operand of a
// strict comparison (checking that a reply really comes from the host frame).
const PARENT_POST_MESSAGE_ONLY = ban(
  `MemberExpression[object.name=${GLOBAL_OBJECTS}][property.name='parent']:not(MemberExpression[property.name='postMessage'] > MemberExpression.object):not(BinaryExpression[operator=/^[!=]==$/] > MemberExpression)`,
  'Only window.parent.postMessage and a strict event.source comparison are allowed.',
);

const CORE_SYNTAX = [
  ban("CallExpression[callee.object.name='Date'][callee.property.name='now']", 'No clock in core.'),
  ban("NewExpression[callee.name='Date'][arguments.length=0]", 'No clock in core.'),
  ban("CallExpression[callee.name='Date']", 'No clock in core.'),
  ban("MemberExpression[object.name='Math'][property.name='random']", 'No randomness in core.'),
];

const BASE_IMPORTS = [
  {
    regex: '^(?!\\.{1,2}/|preact(/|$)|@super-productivity/plugin-api$)',
    message: 'src may import only relative modules, preact and the Plugin API types.',
  },
  {
    regex: '(^|/)(tests|scripts|node_modules)(/|$)',
    message: 'src must not import tests or tools.',
  },
];

const LAYER_IMPORTS = {
  core: [{ regex: '^(?!\\./|(\\.\\./)+core/)', message: 'core may import only core.' }],
  app: [{ regex: '^(\\.\\./)+ui(\\.tsx)?(/|$)', message: 'app must not import ui.' }],
  ui: [
    {
      regex: '^(?!\\./|(\\.\\./)+(ui|app|core)/|preact(/|$))',
      message: 'ui may import only ui, app, core types and preact.',
    },
    {
      regex: '^(\\.\\./)+core/',
      allowTypeImports: true,
      message: 'ui may import only types from core.',
    },
  ],
  other: [],
};

/**
 * One layer block. Blocks are disjoint per file, so each sets the full rule options.
 * @param {{
 *   files: string[],
 *   ignores?: string[],
 *   layer?: 'core' | 'app' | 'ui' | 'other',
 *   pluginApi?: boolean,
 *   noConsole?: boolean,
 *   allow?: Array<'parentPostMessage' | 'indexedDB' | 'executeNodeScript'>,
 * }} opts
 */
function layer({
  files,
  ignores = [],
  layer = 'other',
  pluginApi = false,
  noConsole = false,
  allow = [],
}) {
  const banned = BANNED_GLOBALS.filter(
    (g) =>
      !(allow.includes('indexedDB') && g === 'indexedDB') &&
      !(allow.includes('parentPostMessage') && g === 'parent'),
  );
  const syntax = [...BASE_SYNTAX, globalMemberBan(banned)];
  if (allow.includes('parentPostMessage')) syntax.push(PARENT_POST_MESSAGE_ONLY);
  if (!allow.includes('executeNodeScript')) syntax.push(NODE_SCRIPT_BAN);
  if (layer === 'core') syntax.push(...CORE_SYNTAX);

  // Bare `parent` stays banned even where window.parent.postMessage is allowed.
  const globals = BANNED_GLOBALS.filter((g) => g !== 'indexedDB' || !allow.includes('indexedDB'));
  if (layer === 'core') globals.push(...CORE_GLOBALS);
  if (!pluginApi) globals.push('PluginAPI');

  return {
    files,
    ignores,
    rules: {
      'no-restricted-syntax': ['error', ...syntax],
      'no-restricted-globals': ['error', ...globals],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [...BASE_IMPORTS, ...LAYER_IMPORTS[layer]] },
      ],
      'no-console': noConsole ? 'error' : 'off',
    },
  };
}

const IFRAME_MESSAGING = 'src/platform/iframe-messaging.ts';
const DRAFT_STORE = 'src/platform/draft-store.ts';
const DESKTOP = 'src/platform/desktop.ts';

export default defineConfig(
  { ignores: ['dist/**', 'node_modules/**', '**/*.zip'] },
  { linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' } },
  {
    files: ALL,
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['vitest.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  // Plain JS tooling files are not part of a TypeScript project.
  { files: JS, extends: [tseslint.configs.disableTypeChecked] },
  { files: TS, ...reactHooks.configs.flat.recommended },
  {
    files: ALL,
    ...sonarjs.configs.recommended,
    rules: { ...sonarjs.configs.recommended.rules, 'sonarjs/cognitive-complexity': 'off' },
  },

  // Security and layer rules for plugin code.
  { files: SRC, rules: { 'no-eval': 'error', 'no-new-func': 'error' } },
  layer({ files: SRC }),
  layer({ files: ['src/core/**/*.{ts,tsx}'], layer: 'core', noConsole: true }),
  layer({ files: ['src/app/**/*.{ts,tsx}'], layer: 'app' }),
  layer({ files: ['src/ui/**/*.{ts,tsx}'], layer: 'ui' }),
  layer({
    files: ['src/platform/**/*.{ts,tsx}'],
    ignores: [IFRAME_MESSAGING, DRAFT_STORE, DESKTOP],
    pluginApi: true,
    noConsole: true,
  }),
  layer({
    files: [IFRAME_MESSAGING],
    pluginApi: true,
    noConsole: true,
    allow: ['parentPostMessage'],
  }),
  // The host page origin differs per platform (desktop, web, mobile), so the bridge checks
  // event.source against the parent frame instead of a fixed origin.
  { files: [IFRAME_MESSAGING], rules: { 'sonarjs/post-message': 'off' } },
  layer({ files: [DRAFT_STORE], pluginApi: true, noConsole: true, allow: ['indexedDB'] }),
  layer({ files: [DESKTOP], pluginApi: true, noConsole: true, allow: ['executeNodeScript'] }),
  layer({ files: ['src/*.{ts,tsx}'], pluginApi: true }),

  // Tests relax type strictness only; size and complexity limits below still apply.
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // Size and complexity limits apply everywhere, tests and scripts included.
  {
    files: ALL,
    rules: {
      complexity: ['error', { max: 30, variant: 'classic' }],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
    },
  },
  ...(MAX_LINES_EXCEPTIONS.length > 0
    ? [
        {
          files: MAX_LINES_EXCEPTIONS,
          rules: {
            'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
          },
        },
      ]
    : []),
);
