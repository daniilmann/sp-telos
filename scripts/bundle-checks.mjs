// Pure checks shared by build.mjs and pack.mjs. Each returns a list of problems; empty means OK.
import { Linter } from 'eslint';

/**
 * Plugin API methods that change host data or host state. They may appear only in plugin.js,
 * never in the iframe bundle. Taken from the PluginAPI interface of @super-productivity/plugin-api;
 * build.mjs fails if a name disappears from the installed type definitions.
 */
export const WRITE_METHODS = [
  'persistDataSynced',
  'addTask',
  'updateTask',
  'deleteTask',
  'reorderTasks',
  'batchUpdateForProject',
  'addProject',
  'updateProject',
  'deleteProject',
  'addTag',
  'updateTag',
  'setCounter',
  'incrementCounter',
  'decrementCounter',
  'deleteCounter',
  'startTracking',
  'stopTracking',
  'dispatchAction',
  'setSecret',
  'deleteSecret',
  'clearOAuthToken',
];

export const ZIP_FILES = [
  'manifest.json',
  'plugin.js',
  'index.html',
  'LICENSE',
  'THIRD_PARTY_NOTICES.txt',
];

export const FORBIDDEN_MANIFEST_KEYS = [
  'permissions',
  'allowedHosts',
  'dataSharing',
  'nodeExecution',
];

const TEST_ONLY_NAME = /\.(test|spec)\.|^(fakes|fixtures|__mocks__)$/;

/**
 * Parses bundle code as an ES2020 classic script and forbids dynamic import().
 * @param {string} name
 * @param {string} code
 * @returns {string[]}
 */
export function checkScriptSyntax(name, code) {
  const linter = new Linter({ configType: 'flat' });
  const messages = linter.verify(
    code,
    [
      {
        files: ['**/*.js'],
        languageOptions: { ecmaVersion: 2020, sourceType: 'script' },
        rules: { 'no-restricted-syntax': ['error', 'ImportExpression'] },
      },
    ],
    `${name}.js`,
  );
  return messages.map(
    (m) =>
      `${name}: ${m.fatal ? 'parse error' : (m.ruleId ?? 'error')} at ${String(m.line)}:${String(m.column)}: ${m.message}`,
  );
}

/**
 * @param {string} code
 * @param {readonly string[]} methods
 * @returns {string[]} method names found as whole words
 */
export function findWriteMethods(code, methods = WRITE_METHODS) {
  return methods.filter((m) => new RegExp(`\\b${m}\\b`).test(code));
}

/**
 * @param {string} typeDefinitions contents of the plugin-api types.d.ts
 * @param {readonly string[]} methods
 * @returns {string[]} listed methods that the type definitions do not declare
 */
export function findUnknownMethods(typeDefinitions, methods = WRITE_METHODS) {
  return methods.filter((m) => !new RegExp(`\\b${m}\\??(<[^>]*>)?\\(`).test(typeDefinitions));
}

/**
 * @param {readonly string[]} inputs metafile input paths relative to the repo root
 * @returns {string[]}
 */
export function checkBundleInputs(inputs) {
  return inputs
    .filter((p) => !p.startsWith('src/') && !p.startsWith('node_modules/preact/'))
    .map((p) => `bundle input outside src/ and preact: ${p}`);
}

/**
 * @param {readonly string[]} paths file and directory paths under src/, relative to src/
 * @returns {string[]}
 */
export function checkNoTestOnlyFiles(paths) {
  return paths
    .filter((p) => p.split('/').some((part) => TEST_ONLY_NAME.test(part)))
    .map((p) => `test-only file in src/: ${p}`);
}

/**
 * @param {string} template
 * @returns {string[]}
 */
export function checkTemplate(template) {
  return /\s(src|href)\s*=/i.test(template) ? ['index.template.html references files or URLs'] : [];
}

/**
 * @param {string} imageRef contents of server/supersync-image
 * @returns {string | null} version without the leading v
 */
export function parseImageVersion(imageRef) {
  const match = /:v(\d+\.\d+\.\d+)(@|\s|$)/.exec(imageRef.trim());
  return match?.[1] ?? null;
}

/**
 * @param {Record<string, unknown>} manifest
 * @param {{ version: string, imageVersion: string | null }} expected
 * @returns {string[]}
 */
export function checkManifest(manifest, expected) {
  const problems = FORBIDDEN_MANIFEST_KEYS.filter((k) => k in manifest).map(
    (k) => `manifest has forbidden key ${k}`,
  );
  if (manifest['id'] !== 'sp-telos') problems.push('manifest id must be sp-telos');
  if (manifest['version'] !== expected.version)
    problems.push('manifest version != package version');
  if (expected.imageVersion === null) problems.push('cannot read version from server image');
  else if (manifest['minSupVersion'] !== expected.imageVersion)
    problems.push(`minSupVersion must equal server image version ${expected.imageVersion}`);
  return problems;
}

/**
 * @param {readonly string[]} present
 * @returns {string[]}
 */
export function checkFileSet(present) {
  const extra = present.filter((f) => !ZIP_FILES.includes(f));
  const missing = ZIP_FILES.filter((f) => !present.includes(f));
  return [
    ...extra.map((f) => `unexpected file: ${f}`),
    ...missing.map((f) => `missing file: ${f}`),
  ];
}
