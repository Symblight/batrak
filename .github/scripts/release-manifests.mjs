// Writes a release's latest.json and batrak-cli.json (docs/specs/app-update.md §3.5).
//   node release-manifests.mjs <tag> <owner/repo> <sig-dir> <asset-names-file> <out-dir>

import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = [
  ['darwin-aarch64', '_aarch64.app.tar.gz'],
  ['darwin-x86_64', '_x64.app.tar.gz'],
  ['windows-x86_64', '-setup.exe'],
  ['windows-x86_64-nsis', '-setup.exe'],
  ['windows-x86_64-msi', '.msi'],
  ['linux-x86_64', '.AppImage'],
  ['linux-x86_64-appimage', '.AppImage'],
];

const CLI = [
  ['darwin-aarch64', 'batrak-aarch64-apple-darwin'],
  ['darwin-x86_64', 'batrak-x86_64-apple-darwin'],
  ['linux-x86_64', 'batrak-x86_64-unknown-linux-gnu'],
  ['linux-aarch64', 'batrak-aarch64-unknown-linux-gnu'],
  ['windows-x86_64', 'batrak-x86_64-pc-windows-msvc.exe'],
];

/**
 * @typedef {{ url: string, signature: string }} Platform
 * @typedef {{ version: string, pub_date: string, platforms: Record<string, Platform> }} Manifest
 */

/**
 * The manifests, or in `missing` what stops them being complete.
 *
 * @param {{ tag: string, repo: string, assets: string[], signatures: Record<string, string>, pubDate: string }} release
 *   `signatures` maps a `.sig` file's name to its contents.
 * @returns {{ missing: string[], latest: Manifest, cli: Manifest }}
 */
export function buildManifests({ tag, repo, assets, signatures, pubDate }) {
  /** @type {Set<string>} */
  const missing = new Set();

  /** @param {string} name @returns {Platform} */
  function platform(name) {
    const signature = signatures[`${name}.sig`]?.trim();
    if (!signature) missing.add(`${name}.sig`);
    // The final URL, not a draft's browser_download_url: that can be an untagged-… one that dies on publish.
    const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
    return { url, signature: signature ?? '' };
  }

  /** @param {Array<[string, Platform | undefined]>} entries @returns {Manifest} */
  const manifest = (entries) => ({
    version: tag.replace(/^v/, ''),
    pub_date: pubDate,
    platforms: Object.fromEntries(entries),
  });

  const latest = manifest(
    DESKTOP.map(([key, suffix]) => {
      const found = assets.filter((name) => name.endsWith(suffix));
      const wanted = `for ${key} in latest.json (*${suffix})`;
      if (found.length === 0) missing.add(`the asset ${wanted}`);
      if (found.length > 1) missing.add(`one asset ${wanted}: found ${found.join(', ')}`);
      return [key, found.length === 1 ? platform(found[0]) : undefined];
    }),
  );

  const cli = manifest(
    CLI.map(([key, name]) => {
      if (assets.includes(name)) return [key, platform(name)];
      missing.add(name);
      return [key, undefined];
    }),
  );

  return { missing: [...missing], latest, cli };
}

function main() {
  const [tag, repo, sigDir, assetsFile, outDir] = process.argv.slice(2);
  if (!outDir) {
    console.error('usage: release-manifests.mjs <tag> <owner/repo> <sig-dir> <asset-names-file> <out-dir>');
    process.exit(2);
  }

  const assets = readFileSync(assetsFile, 'utf8').split(/\r?\n/).filter(Boolean);
  const signatures = Object.fromEntries(
    readdirSync(sigDir).map((name) => [name, readFileSync(join(sigDir, name), 'utf8')]),
  );
  const pubDate = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const { missing, latest, cli } = buildManifests({ tag, repo, assets, signatures, pubDate });
  if (missing.length > 0) {
    console.error(`The release ${tag} is incomplete. Missing:\n${missing.map((item) => `  - ${item}`).join('\n')}`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  writeFileSync(join(outDir, 'batrak-cli.json'), `${JSON.stringify(cli, null, 2)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
