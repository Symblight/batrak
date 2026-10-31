import { listFonts } from '../ipc/ipc.js';
import { $systemFonts } from '../../stores/fonts/fonts.js';
import { reportError } from '../notices/notices.js';

/** @type {Promise<void> | null} */
let loading = null;

/** Lists the installed fonts into `$systemFonts`, once per window; a failure lets the next call retry. */
export function loadSystemFonts() {
  loading ??= listFonts()
    .then((fonts) => $systemFonts.set(fonts.sort((a, b) => a.family.localeCompare(b.family))))
    .catch((err) => {
      loading = null;
      reportError('Listing fonts failed', err);
    });
  return loading;
}
