// Builds two independent es2020 IIFE bundles and a self-contained index.html into dist/.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  checkBundleInputs,
  checkNoTestOnlyFiles,
  checkScriptSyntax,
  checkTemplate,
  findUnknownMethods,
  findWriteMethods,
} from './bundle-checks.mjs';

const root = new URL('..', import.meta.url).pathname;
const src = join(root, 'src');
const out = join(root, 'dist');

function fail(problems) {
  if (problems.length === 0) return;
  for (const p of problems) console.error(`ERROR: ${p}`);
  process.exit(1);
}

const srcEntries = (await readdir(src, { withFileTypes: true, recursive: true }))
  .map((e) => ({ entry: e, path: relative(src, join(e.parentPath, e.name)) }))
  .sort((a, b) => a.path.localeCompare(b.path));
fail(checkNoTestOnlyFiles(srcEntries.map((e) => e.path)));

const hash = createHash('sha256');
for (const { entry, path } of srcEntries) {
  if (entry.isFile()) hash.update(path).update(await readFile(join(src, path)));
}
const buildId = hash.digest('hex').slice(0, 12);

const common = {
  absWorkingDir: root,
  bundle: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  minify: true,
  metafile: true,
  legalComments: 'none',
  charset: 'utf8',
  define: { BUILD_ID: JSON.stringify(buildId) },
  jsx: 'automatic',
  jsxImportSource: 'preact',
  logLevel: 'warning',
};

const plugin = await build({ ...common, entryPoints: ['src/plugin.ts'] });
const ui = await build({ ...common, entryPoints: ['src/ui.tsx'] });
const pluginJs = plugin.outputFiles[0].text;
const uiJs = ui.outputFiles[0].text;

fail(
  checkBundleInputs([...Object.keys(plugin.metafile.inputs), ...Object.keys(ui.metafile.inputs)]),
);
fail([...checkScriptSyntax('plugin.js', pluginJs), ...checkScriptSyntax('ui.js', uiJs)]);

const apiTypes = await readFile(
  join(root, 'node_modules/@super-productivity/plugin-api/dist/types.d.ts'),
  'utf8',
);
fail(findUnknownMethods(apiTypes).map((m) => `write method not in Plugin API types: ${m}`));
fail(findWriteMethods(uiJs).map((m) => `ui.js contains Plugin API write method ${m}`));

const template = await readFile(join(src, 'index.template.html'), 'utf8');
fail(checkTemplate(template));
if (!template.includes('/*JS*/')) fail(['index.template.html has no /*JS*/ placeholder']);
const html = template.replace('/*JS*/', () => uiJs.replace(/<\/script/gi, '<\\/script'));

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(src, 'manifest.json'), 'utf8'));
const preactLicense = await readFile(join(root, 'node_modules/preact/LICENSE'), 'utf8');

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1);
fail(Buffer.byteLength(html) > 1024 * 1024 ? ['index.html is larger than 1 MB'] : []);
fail(Buffer.byteLength(pluginJs) > 5 * 1024 * 1024 ? ['plugin.js is larger than 5 MB'] : []);

await rm(out, { recursive: true, force: true });
await mkdir(out);
await writeFile(join(out, 'plugin.js'), pluginJs);
await writeFile(join(out, 'index.html'), html);
await writeFile(
  join(out, 'manifest.json'),
  `${JSON.stringify({ ...manifest, version: pkg.version }, null, 2)}\n`,
);
await copyFile(join(root, 'LICENSE'), join(out, 'LICENSE'));
await writeFile(
  join(out, 'THIRD_PARTY_NOTICES.txt'),
  `This plugin bundles Preact (https://preactjs.com), MIT License:\n\n${preactLicense}`,
);
console.log(`build ${buildId}: plugin.js ${kb(pluginJs)} KB, index.html ${kb(html)} KB`);
