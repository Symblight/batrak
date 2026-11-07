import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect } from '@esm-bundle/chai';
import { $about } from '../../../stores/about/about.js';
import { $notices } from '../../../stores/notices/notices.js';
import { app } from '../app.js';

/** @typedef {import('../../settings/types.js').AboutInfo} AboutInfo */

/** @type {AboutInfo} */
const ABOUT = { version: '1.2.3', os: 'macOS', arch: 'aarch64', logDir: '/logs', updatesEnabled: true };

/** @param {() => boolean} pred */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('app', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;
  beforeEach(() => {
    calls = [];
    $notices.set([]);
    $about.set(null);
  });
  afterEach(() => clearMocks());

  describe('platform', () => {
    it('is told from the user agent: macOS, Windows or Linux', () => {
      expect(app.platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')).to.equal('mac');
      expect(app.platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/120.0')).to.equal('windows');
      expect(app.platformOf('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15')).to.equal('linux');
    });

    it('is that of this page, and names what reveals a file there', () => {
      expect(app.platform).to.equal(app.platformOf(navigator.userAgent));
      expect(app.revealLabel).to.equal(
        { mac: 'Show in Finder', windows: 'Show in Explorer', linux: 'Show in File Manager' }[app.platform],
      );
    });
  });

  describe('about', () => {
    it('lists the rows of About in display order', () => {
      expect(app.aboutRows(ABOUT)).to.deep.equal([
        ['Version', '1.2.3'],
        ['OS', 'macOS aarch64'],
        ['Logs', '/logs'],
      ]);
      expect(app.aboutRows({ ...ABOUT, logDir: null })[2]).to.deep.equal(['Logs', 'unknown']);
    });

    it('reads the versions once, and tries again after a failure', async () => {
      let failing = true;
      mockIPC((cmd) => {
        calls.push({ cmd, args: {} });
        if (cmd === 'about') {
          if (failing) throw new Error('no backend');
          return ABOUT;
        }
        return null;
      });
      await app.loadAbout();
      expect($about.get()).to.equal(null);
      failing = false;
      await app.loadAbout();
      await app.loadAbout();
      expect($about.get()).to.deep.equal(ABOUT);
      expect(calls.filter((c) => c.cmd === 'about').length).to.equal(2);
    });
  });

  describe('logging', () => {
    it('writes a line to the app log with its level', async () => {
      mockIPC((cmd, args) => {
        calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args) });
        return null;
      });
      app.log('info', 'opened a folder');
      await until(() => calls.length > 0);
      expect(calls[0]).to.deep.equal({ cmd: 'write_log', args: { level: 'info', message: 'opened a folder' } });
    });

    it('never throws when the write fails, so logging an error cannot raise another', async () => {
      mockIPC(() => {
        throw new Error('no backend');
      });
      expect(() => app.log('error', 'x')).not.to.throw();
      await new Promise((r) => setTimeout(r, 20));
    });

    it('reports a failed action: logged as a warning and shown as an error', async () => {
      mockIPC((cmd, args) => {
        calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args) });
        return null;
      });
      app.reportError('Opening folder failed', new Error('denied'));
      await until(() => calls.length > 0);
      expect(calls[0].args).to.deep.equal({ level: 'warn', message: 'Opening folder failed: denied' });
      expect($notices.get().map((n) => [n.level, n.message])).to.deep.equal([['error', 'Opening folder failed: denied']]);
      app.reportError('Saving failed', 'disk full');
      expect($notices.get().at(-1)?.message).to.equal('Saving failed: disk full');
    });
  });

  describe('copy', () => {
    /** @type {typeof navigator.clipboard.writeText} */
    let original;
    beforeEach(() => {
      original = navigator.clipboard.writeText;
      mockIPC(() => null);
    });
    afterEach(() => {
      navigator.clipboard.writeText = original;
    });

    it('puts text on the clipboard', async () => {
      /** @type {string[]} */
      const written = [];
      navigator.clipboard.writeText = async (text) => void written.push(text);
      app.copy('/p/a.js', 'Copying the path failed');
      expect(written).to.deep.equal(['/p/a.js']);
    });

    it('says what failed when it cannot', async () => {
      navigator.clipboard.writeText = async () => {
        throw new Error('blocked');
      };
      app.copy('x', 'Copying the path failed');
      await until(() => $notices.get().length > 0);
      expect($notices.get()[0].message).to.equal('Copying the path failed: blocked');
    });
  });

  describe('init', () => {
    it('shows the backend’s own warnings and errors as notices', async () => {
      mockIPC(() => null, { shouldMockEvents: true });
      app.init();
      await new Promise((r) => setTimeout(r, 20));
      await emit('app://notice', { level: 'warn', message: 'agent crashed' });
      await until(() => $notices.get().length > 0);
      expect($notices.get().map((n) => [n.level, n.message])).to.deep.equal([['warn', 'agent crashed']]);
    });
  });
});
