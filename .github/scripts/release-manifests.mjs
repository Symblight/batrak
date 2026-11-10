// Writes a release's latest.json, the desktop updater's manifest (docs/specs/app-update.md §3.5).
//   node release-manifests.mjs <tag> <owner/repo> <sig-dir> <asset-names-file> <out-dir>

import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The updater's key and the suffix of its bundle: only macOS is released. */
const DESKTOP = [
  ['darwin-aarch64', '_aarch64.app.tar.gz'],
  ['darwin-x86_64', '_x64.app.tar.gz'],
];

/**
 * @typedef {{ url: string, signature: string }} Platform
 * @typedef {{ version: string, pub_date: string, platforms: Record<string, Platform> }} Manifest
 */

/**
 * The manifest, or in `missing` what stops it being complete.
 *
 * @param {{ tag: string, repo: string, assets: string[], signatures: Record<string, string>, pubDate: string }} release
 *   `signatures` maps a `.sig` file's name to its contents.
 * @returns {{ missing: string[], latest: Manifest }}
 */
export function buildManifest({ tag, repo, assets, signatures, pubDate }) {
  /** @type {string[]} */
  const missing = [];

  /** @param {string} name @returns {Platform} */
  function platform(name) {
    const signature = signatures[`${name}.sig`]?.trim();
    if (!signature) missing.push(`${name}.sig`);
    // The final URL, not a draft's browser_download_url: that can be an untagged-… one that dies on publish.
    const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
    return { url, signature: signature ?? '' };
  }

  const platforms = DESKTOP.map(([key, suffix]) => {
    const found = assets.filter((name) => name.endsWith(suffix));
    const wanted = `for ${key} in latest.json (*${suffix})`;
    if (found.length === 0) missing.push(`the asset ${wanted}`);
    if (found.length > 1) missing.push(`one asset ${wanted}: found ${found.join(', ')}`);
    return [key, found.length === 1 ? platform(found[0]) : undefined];
  });

  const latest = { version: tag.replace(/^v/, ''), pub_date: pubDate, platforms: Object.fromEntries(platforms) };
  return { missing, latest };
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

  const { missing, latest } = buildManifest({ tag, repo, assets, signatures, pubDate });
  if (missing.length > 0) {
    console.error(`The release ${tag} is incomplete. Missing:\n${missing.map((item) => `  - ${item}`).join('\n')}`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
