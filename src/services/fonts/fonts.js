import { app } from '../../hooks/app/app.js';
import { listFonts } from '../ipc/ipc.js';
import { $systemFonts } from '../../stores/fonts/fonts.js';

/** @type {Promise<void> | null} */
let loading = null;

/** Lists the installed fonts into `$systemFonts`, once per window; a failure lets the next call retry. */
export function loadSystemFonts() {
  loading ??= listFonts()
    .then((fonts) => $systemFonts.set(fonts.sort((a, b) => a.family.localeCompare(b.family))))
    .catch((err) => {
      loading = null;
      app.reportError('Listing fonts failed', err);
    });
  return loading;
}
