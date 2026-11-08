import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildManifests } from './release-manifests.mjs';

const script = fileURLToPath(new URL('./release-manifests.mjs', import.meta.url));

const DESKTOP = [
  'Batrak_aarch64.app.tar.gz',
  'Batrak_x64.app.tar.gz',
  'Batrak_0.2.0_x64-setup.exe',
  'Batrak_0.2.0_x64_en-US.msi',
  'Batrak_0.2.0_amd64.AppImage',
];
const CLI = [
  'batrak-aarch64-apple-darwin',
  'batrak-x86_64-apple-darwin',
  'batrak-x86_64-unknown-linux-gnu',
  'batrak-aarch64-unknown-linux-gnu',
  'batrak-x86_64-pc-windows-msvc.exe',
];
const COMPLETE = [...DESKTOP, ...CLI];
const url = (name) => `https://github.com/Symblight/batrak/releases/download/v0.2.0/${name}`;

/** Every asset with a signature whose contents name it. */
function signed(assets) {
  return Object.fromEntries(assets.map((name) => [`${name}.sig`, `sig of ${name}`]));
}

function build(assets = COMPLETE, signatures = signed(assets)) {
  return buildManifests({
    tag: 'v0.2.0',
    repo: 'Symblight/batrak',
    assets,
    signatures,
    pubDate: '2026-11-07T10:00:00Z',
  });
}

test('a complete release gives latest.json with every updater key', () => {
  const { missing, latest } = build();

  assert.deepEqual(missing, []);
  const entry = (name) => ({ url: url(name), signature: `sig of ${name}` });
  assert.deepEqual(latest, {
    version: '0.2.0',
    pub_date: '2026-11-07T10:00:00Z',
    platforms: {
      'darwin-aarch64': entry('Batrak_aarch64.app.tar.gz'),
      'darwin-x86_64': entry('Batrak_x64.app.tar.gz'),
      'windows-x86_64': entry('Batrak_0.2.0_x64-setup.exe'),
      'windows-x86_64-nsis': entry('Batrak_0.2.0_x64-setup.exe'),
      'windows-x86_64-msi': entry('Batrak_0.2.0_x64_en-US.msi'),
      'linux-x86_64': entry('Batrak_0.2.0_amd64.AppImage'),
      'linux-x86_64-appimage': entry('Batrak_0.2.0_amd64.AppImage'),
    },
  });
});

test('a complete release gives batrak-cli.json with the five binaries', () => {
  const { cli } = build();

  const entry = (name) => ({ url: url(name), signature: `sig of ${name}` });
  assert.deepEqual(cli, {
    version: '0.2.0',
    pub_date: '2026-11-07T10:00:00Z',
    platforms: {
      'darwin-aarch64': entry('batrak-aarch64-apple-darwin'),
      'darwin-x86_64': entry('batrak-x86_64-apple-darwin'),
      'linux-x86_64': entry('batrak-x86_64-unknown-linux-gnu'),
      'linux-aarch64': entry('batrak-aarch64-unknown-linux-gnu'),
      'windows-x86_64': entry('batrak-x86_64-pc-windows-msvc.exe'),
    },
  });
});

test('a signature is trimmed', () => {
  const { latest } = build(COMPLETE, { ...signed(COMPLETE), 'Batrak_aarch64.app.tar.gz.sig': '  abc\n' });

  assert.equal(latest.platforms['darwin-aarch64'].signature, 'abc');
});

test('a name is percent-encoded in its URL', () => {
  const assets = COMPLETE.map((name) => (name.endsWith('.msi') ? 'Batrak 0.2.0.msi' : name));

  const { latest } = build(assets);

  assert.equal(latest.platforms['windows-x86_64-msi'].url, url('Batrak%200.2.0.msi'));
});

test('.deb, .rpm, .dmg and their signatures are ignored', () => {
  const extra = ['Batrak_0.2.0_amd64.deb', 'Batrak-0.2.0-1.x86_64.rpm', 'Batrak_0.2.0_aarch64.dmg', 'Batrak_0.2.0_x64.dmg'];

  const { missing, latest } = build([...COMPLETE, ...extra, ...extra.map((name) => `${name}.sig`)]);

  assert.deepEqual(missing, []);
  assert.equal(Object.keys(latest.platforms).length, 7);
});

test('a signature file does not count as the asset it signs', () => {
  const assets = COMPLETE.filter((name) => !name.endsWith('.msi'));

  const { missing } = build([...assets, 'Batrak_0.2.0_x64_en-US.msi.sig']);

  assert.deepEqual(missing, ['the asset for windows-x86_64-msi in latest.json (*.msi)']);
});

test('v0.1.0, which has no signatures or CLI, names everything missing', () => {
  const { missing } = build(
    [...DESKTOP, 'Batrak_0.1.0_universal.dmg', 'Batrak_0.1.0_amd64.deb', 'Batrak-0.1.0-1.x86_64.rpm'],
    {},
  );

  assert.deepEqual(missing, [
    ...DESKTOP.map((name) => `${name}.sig`),
    ...CLI,
  ]);
});

test('a missing or empty signature is named once, though two keys share its asset', () => {
  const signatures = signed(COMPLETE);
  delete signatures['Batrak_0.2.0_x64-setup.exe.sig'];
  signatures['batrak-x86_64-apple-darwin.sig'] = ' \n';

  const { missing } = build(COMPLETE, signatures);

  assert.deepEqual(missing, ['Batrak_0.2.0_x64-setup.exe.sig', 'batrak-x86_64-apple-darwin.sig']);
});

test('two assets for one key are refused rather than picked from', () => {
  const { missing } = build([...COMPLETE, 'Batrak_0.1.9_x64_en-US.msi']);

  assert.deepEqual(missing, [
    'one asset for windows-x86_64-msi in latest.json (*.msi): found Batrak_0.2.0_x64_en-US.msi, Batrak_0.1.9_x64_en-US.msi',
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

test('the command writes both manifests', () => {
  const { sigs, list, out } = workspace(COMPLETE, signed(COMPLETE));

  execFileSync('node', [script, 'v0.2.0', 'Symblight/batrak', sigs, list, out], { stdio: 'pipe' });

  const latest = JSON.parse(readFileSync(join(out, 'latest.json'), 'utf8'));
  const cli = JSON.parse(readFileSync(join(out, 'batrak-cli.json'), 'utf8'));
  assert.equal(latest.version, '0.2.0');
  assert.equal(cli.platforms['linux-aarch64'].signature, 'sig of batrak-aarch64-unknown-linux-gnu');
  assert.match(latest.pub_date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test('the command exits non-zero, names what is missing and writes nothing', () => {
  const assets = COMPLETE.filter((name) => name !== 'batrak-x86_64-apple-darwin');
  const { sigs, list, out } = workspace(assets, signed(assets));

  const run = spawnSync('node', [script, 'v0.2.0', 'Symblight/batrak', sigs, list, out], { encoding: 'utf8' });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /batrak-x86_64-apple-darwin/);
  assert.throws(() => readFileSync(join(out, 'latest.json')));
});
