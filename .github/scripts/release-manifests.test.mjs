import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildManifest } from './release-manifests.mjs';

const script = fileURLToPath(new URL('./release-manifests.mjs', import.meta.url));

const COMPLETE = ['Batrak_aarch64.app.tar.gz', 'Batrak_x64.app.tar.gz'];
const url = (name) => `https://github.com/Symblight/batrak/releases/download/v0.2.0/${name}`;

/** Every asset with a signature whose contents name it. */
function signed(assets) {
  return Object.fromEntries(assets.map((name) => [`${name}.sig`, `sig of ${name}`]));
}

function build(assets = COMPLETE, signatures = signed(assets)) {
  return buildManifest({
    tag: 'v0.2.0',
    repo: 'Symblight/batrak',
    assets,
    signatures,
    pubDate: '2026-11-07T10:00:00Z',
  });
}

test('a complete release gives latest.json with both macOS updater keys', () => {
  const { missing, latest } = build();

  assert.deepEqual(missing, []);
  const entry = (name) => ({ url: url(name), signature: `sig of ${name}` });
  assert.deepEqual(latest, {
    version: '0.2.0',
    pub_date: '2026-11-07T10:00:00Z',
    platforms: {
      'darwin-aarch64': entry('Batrak_aarch64.app.tar.gz'),
      'darwin-x86_64': entry('Batrak_x64.app.tar.gz'),
    },
  });
});

test('a signature is trimmed', () => {
  const { latest } = build(COMPLETE, { ...signed(COMPLETE), 'Batrak_aarch64.app.tar.gz.sig': '  abc\n' });

  assert.equal(latest.platforms['darwin-aarch64'].signature, 'abc');
});

test('a name is percent-encoded in its URL', () => {
  const assets = ['Batrak 1_aarch64.app.tar.gz', 'Batrak_x64.app.tar.gz'];

  const { latest } = build(assets);

  assert.equal(latest.platforms['darwin-aarch64'].url, url('Batrak%201_aarch64.app.tar.gz'));
});

test('.dmg files and their signatures are ignored', () => {
  const extra = ['Batrak_0.2.0_aarch64.dmg', 'Batrak_0.2.0_x64.dmg'];

  const { missing, latest } = build([...COMPLETE, ...extra, ...extra.map((name) => `${name}.sig`)]);

  assert.deepEqual(missing, []);
  assert.equal(Object.keys(latest.platforms).length, 2);
});

test('a signature file does not count as the asset it signs', () => {
  const { missing } = build(['Batrak_aarch64.app.tar.gz', 'Batrak_x64.app.tar.gz.sig']);

  assert.deepEqual(missing, ['the asset for darwin-x86_64 in latest.json (*_x64.app.tar.gz)']);
});

test('a release with no updater bundles names everything missing', () => {
  const { missing } = build(['Batrak_0.2.3_aarch64.dmg', 'Batrak_0.2.3_x64.dmg'], {});

  assert.deepEqual(missing, [
    'the asset for darwin-aarch64 in latest.json (*_aarch64.app.tar.gz)',
    'the asset for darwin-x86_64 in latest.json (*_x64.app.tar.gz)',
  ]);
});

test('a missing or empty signature is named', () => {
  const signatures = signed(COMPLETE);
  delete signatures['Batrak_aarch64.app.tar.gz.sig'];
  signatures['Batrak_x64.app.tar.gz.sig'] = ' \n';

  const { missing } = build(COMPLETE, signatures);

  assert.deepEqual(missing, ['Batrak_aarch64.app.tar.gz.sig', 'Batrak_x64.app.tar.gz.sig']);
});

test('two assets for one key are refused rather than picked from', () => {
  const { missing } = build([...COMPLETE, 'Old_x64.app.tar.gz']);

  assert.deepEqual(missing, [
    'one asset for darwin-x86_64 in latest.json (*_x64.app.tar.gz): found Batrak_x64.app.tar.gz, Old_x64.app.tar.gz',
  ]);
});

function workspace(assets, signatures) {
  const dir = mkdtempSync(join(tmpdir(), 'release-manifests-'));
  const sigs = join(dir, 'sigs');
  mkdirSync(sigs);
  for (const [name, text] of Object.entries(signatures)) writeFileSync(join(sigs, name), text);
  const list = join(dir, 'assets.txt');
  writeFileSync(list, `${assets.join('\n')}\n`);
  return { sigs, list, out: join(dir, 'out') };
}

test('the command writes latest.json, and nothing else', () => {
  const { sigs, list, out } = workspace(COMPLETE, signed(COMPLETE));

  execFileSync('node', [script, 'v0.2.0', 'Symblight/batrak', sigs, list, out], { stdio: 'pipe' });

  const latest = JSON.parse(readFileSync(join(out, 'latest.json'), 'utf8'));
  assert.equal(latest.version, '0.2.0');
  assert.match(latest.pub_date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.throws(() => readFileSync(join(out, 'batrak-cli.json')));
});

test('the command exits non-zero, names what is missing and writes nothing', () => {
  const assets = ['Batrak_aarch64.app.tar.gz'];
  const { sigs, list, out } = workspace(assets, signed(assets));

  const run = spawnSync('node', [script, 'v0.2.0', 'Symblight/batrak', sigs, list, out], { encoding: 'utf8' });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /darwin-x86_64/);
  assert.throws(() => readFileSync(join(out, 'latest.json')));
});
