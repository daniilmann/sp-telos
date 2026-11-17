// Packs dist/ into sp-telos.zip from a closed list of files and verifies the result.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ZIP_FILES, checkFileSet, checkManifest, parseImageVersion } from './bundle-checks.mjs';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
const zip = join(root, 'sp-telos.zip');
const MAX_ZIP_BYTES = 10 * 1024 * 1024;

function fail(problems) {
  if (problems.length === 0) return;
  for (const p of problems) console.error(`ERROR: ${p}`);
  process.exit(1);
}

fail(checkFileSet(readdirSync(dist).sort()));

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const imageVersion = parseImageVersion(readFileSync(join(root, 'server/supersync-image'), 'utf8'));
fail(checkManifest(manifest, { version: pkg.version, imageVersion }));

if (process.env.GITHUB_REF_TYPE === 'tag') {
  const tag = process.env.GITHUB_REF_NAME ?? '';
  fail(
    tag === `v${pkg.version}` ? [] : [`tag ${tag} does not match package version ${pkg.version}`],
  );
}

rmSync(zip, { force: true });
execFileSync('/usr/bin/zip', ['-X', '-q', '-j', zip, ...ZIP_FILES.map((f) => join(dist, f))]);

const listed = execFileSync('/usr/bin/unzip', ['-Z1', zip], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
fail(checkFileSet(listed));
fail(listed.includes('manifest.json') ? [] : ['manifest.json is not at the ZIP root']);
fail(statSync(zip).size > MAX_ZIP_BYTES ? ['sp-telos.zip is larger than 10 MB'] : []);

const sha = createHash('sha256').update(readFileSync(zip)).digest('hex');
console.log(`sp-telos.zip ${String(statSync(zip).size)} bytes, sha256 ${sha}`);
