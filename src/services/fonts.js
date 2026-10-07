import { listFonts } from './ipc.js';
import { $systemFonts } from '../stores/fonts.js';

/** @type {Promise<void> | null} */
let loading = null;

/** Lists the installed fonts into `$systemFonts`, once per window; a failure lets the next call retry. */
export function loadSystemFonts() {
  loading ??= listFonts()
    .then((fonts) => $systemFonts.set(fonts.sort((a, b) => a.family.localeCompare(b.family))))
    .catch((err) => {
      loading = null;
      console.error('Brama: listing fonts failed', err);
    });
  return loading;
}
