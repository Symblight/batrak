import { expect, fixture, html } from '../../../../test/fixture.js';
import { TERMINAL_PALETTE } from '../../../stores/settings/rules.js';
import '../terminal.js';

/** @typedef {import('../terminal.js').AcpTerminal} AcpTerminal */
/** @typedef {import('../../../hooks/terminals/types.js').TerminalInfo} TerminalInfo */
/** @typedef {import('../../../hooks/terminals/types.js').TerminalSink} TerminalSink */

/** @param {() => boolean} done */
async function until(done) {
  for (let i = 0; i < 150 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(done()).to.equal(true);
}

/** @type {TerminalInfo} */
const running = {
  cwd: '/p',
  fallback: '/p',
  label: 'zsh — p',
  title: null,
  folder: '/p', projectPath: '/p',
  status: 'running',
  exit: null,
  error: null,
  login: null,
};

/** A `connect` that records what the view does with the shell. */
function fakeConnect() {
  const calls = {
    /** @type {{ cols: number, rows: number }[]} */ connects: [],
    /** @type {(string | Uint8Array)[]} */ writes: [],
    /** @type {[number, number][]} */ resizes: [],
    clears: 0,
    /** @type {TerminalSink | null} */ sink: null,
  };
  /** @type {import('../../../hooks/terminals/types.js').TerminalConnect} */
  const connect = (_id, size, sink) => {
    calls.connects.push(size);
    calls.sink = sink;
    return {
      write: (data) => calls.writes.push(data),
      resize: (cols, rows) => calls.resizes.push([cols, rows]),
      clear: () => calls.clears++,
      dispose: () => {},
    };
  };
  return { calls, connect };
}

let rendered = 0;

/**
 * @param {TerminalInfo} [info]
 * @param {number} [width] px
 * @returns {Promise<{ el: AcpTerminal, calls: ReturnType<typeof fakeConnect>['calls'] }>}
 */
async function render(info = running, width = 600) {
  const { calls, connect } = fakeConnect();
  // The DOM renderer, whose rows the tests read. An id of its own: a table's next terminal is another, not this one moved.
  const el = /** @type {AcpTerminal} */ (
    await fixture(html`<acp-terminal
      style="display: flex; width: ${width}px; height: 300px"
      terminal-id=${`t${++rendered}`}
      .connect=${connect}
      .info=${info}
      .gpu=${false}
    ></acp-terminal>`)
  );
  await until(() => calls.sink !== null);
  return { el, calls };
}

/**
 * @param {TerminalSink | null} sink
 * @param {string} text
 * @returns {Promise<void>} Drawn.
 */
const show = (sink, text) => new Promise((resolve) => sink?.output(new TextEncoder().encode(text), resolve));

/** @param {AcpTerminal} el */
const text = (el) => el.shadowRoot?.querySelector('.xterm-rows')?.textContent ?? '';

/** @param {AcpTerminal} el */
const input = (el) => /** @type {HTMLTextAreaElement} */ (el.shadowRoot?.querySelector('textarea'));

/**
 * Hovers a row's first cell, then clicks it, as xterm's link detection needs.
 * @param {AcpTerminal} el
 * @param {number} row
 * @param {MouseEventInit} modifier
 * @param {number} [left] px into the row.
 */
async function clickCell(el, row, modifier, left = 2) {
  const screen = /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('.xterm-screen'));
  const rows = /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('.xterm-rows')?.children[row]);
  const box = rows.getBoundingClientRect();
  const init = { clientX: box.left + left, clientY: box.top + box.height / 2, bubbles: true, composed: true, ...modifier };
  screen.dispatchEvent(new MouseEvent('mousemove', init));
  await new Promise((resolve) => setTimeout(resolve, 30));
  screen.dispatchEvent(new MouseEvent('mousedown', { ...init, button: 0 }));
  screen.dispatchEvent(new MouseEvent('mouseup', { ...init, button: 0 }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('acp-terminal', () => {
  it('opens a file named in the output, from the shell’s folder and at its line, on the platform’s modifier click', async () => {
    // Arrange
    const { el, calls } = await render({ ...running, cwd: '/p' }, 300);
    el.platform = 'mac';
    /** @type {unknown[]} */
    const opened = [];
    el.addEventListener('acp-file-open', (e) => opened.push(/** @type {CustomEvent} */ (e).detail));
    await show(calls.sink, 'src/a.js:12\r\n/q/b.js\r\n');
    // Long enough to wrap: its second row opens it too.
    await show(calls.sink, `src/${'long/'.repeat(12)}c.js:3\r\n`);
    // Act
    await clickCell(el, 0, {});
    // Assert
    expect(opened, 'no modifier').to.deep.equal([]);
    // Act
    await clickCell(el, 0, { metaKey: true });
    await clickCell(el, 1, { metaKey: true });
    await clickCell(el, 3, { metaKey: true });
    // Assert
    expect(opened).to.deep.equal([
      { path: '/p/src/a.js', line: 12 },
      { path: '/q/b.js', line: null },
      { path: `/p/src/${'long/'.repeat(12)}c.js`, line: 3 },
    ]);
  });

  it('opens a link, written out or as OSC 8, only on the platform’s modifier click, and never asks through a browser dialog', async () => {
    // Arrange
    const { el, calls } = await render();
    /** @type {string[]} */
    const opened = [];
    el.addEventListener('acp-link-open', (e) => opened.push(/** @type {CustomEvent<{ url: string }>} */ (e).detail.url));
    const { confirm } = window;
    let dialogs = 0;
    window.confirm = () => (dialogs++, false);
    await show(calls.sink, '\x1b]8;;https://a.test/osc8\x07label\x1b]8;;\x07\r\nhttps://a.test/plain\r\n');
    const links = [
      { row: 0, url: 'https://a.test/osc8' },
      { row: 1, url: 'https://a.test/plain' },
    ];
    const clicks = [
      { platform: 'mac', modifier: { metaKey: true }, opens: true },
      { platform: 'mac', modifier: { ctrlKey: true }, opens: false },
      { platform: 'mac', modifier: {}, opens: false },
      { platform: 'windows', modifier: { ctrlKey: true }, opens: true },
      { platform: 'windows', modifier: { metaKey: true }, opens: false },
      { platform: 'linux', modifier: {}, opens: false },
    ];
    try {
      for (const { row, url } of links) {
        for (const { platform, modifier, opens } of clicks) {
          opened.length = 0;
          el.platform = /** @type {import('../../../hooks/app/types.js').Platform} */ (platform);
          // Act
          await clickCell(el, row, modifier);
          // Assert
          expect(opened, `${url} ${platform} ${JSON.stringify(modifier)}`).to.deep.equal(opens ? [url] : []);
        }
      }
      expect(dialogs, 'no browser dialog').to.equal(0);
    } finally {
      window.confirm = confirm;
    }
  });

  it('connects at its size, shows the shell’s output and sends what is typed', async () => {
    const { el, calls } = await render();
    expect(calls.connects[0].cols).to.be.greaterThan(10);
    await show(calls.sink, 'hello from the shell\r\n');
    await until(() => text(el).includes('hello from the shell'));
    input(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, composed: true }));
    expect(calls.writes).to.deep.equal(['\r']);
  });

  it('keeps its screen and shell when moved, as a tab reorder does, and lets go only once removed', async () => {
    // Arrange
    /** @type {string[]} */
    const disposed = [];
    /** @type {TerminalSink | null} */
    let sink = null;
    let connects = 0;
    /** @type {import('../../../hooks/terminals/types.js').TerminalConnect} */
    const connect = (_id, _size, s) => {
      connects++;
      sink = s;
      return { write: () => {}, resize: () => {}, clear: () => {}, dispose: () => disposed.push(_id) };
    };
    const el = /** @type {AcpTerminal} */ (
      await fixture(html`<acp-terminal style="display: flex; width: 600px; height: 300px" terminal-id="t1" .connect=${connect} .info=${running} .gpu=${false}></acp-terminal>`)
    );
    await until(() => connects === 1);
    await show(sink, 'kept through the move\r\n');
    const parent = /** @type {HTMLElement} */ (el.parentElement);
    // Act
    parent.append(el);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Assert
    expect(connects, 'not connected again').to.equal(1);
    expect(disposed).to.deep.equal([]);
    expect(text(el)).to.include('kept through the move');
    // Act
    el.remove();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Assert
    expect(disposed).to.deep.equal(['t1']);
  });

  it('hands its screen and shell to a new element of the same terminal, whichever comes first, as a tab moved to the editor does', async () => {
    for (const order of ['new first', 'old removed first']) {
      // Arrange
      const { calls, connect } = fakeConnect();
      let disposed = 0;
      /** @type {import('../../../hooks/terminals/types.js').TerminalConnect} */
      const counting = (id, size, sink) => ({ ...connect(id, size, sink), dispose: () => disposed++ });
      const make = () => html`<acp-terminal style="display: flex; width: 500px; height: 300px" terminal-id="moving" .connect=${counting} .info=${running} .gpu=${false}></acp-terminal>`;
      const old = /** @type {AcpTerminal} */ (await fixture(make()));
      await until(() => calls.sink !== null);
      await show(calls.sink, 'kept through the move\r\n');
      // Act
      if (order === 'old removed first') old.remove();
      const moved = /** @type {AcpTerminal} */ (await fixture(make()));
      if (order === 'new first') old.remove();
      await new Promise((resolve) => setTimeout(resolve, 60));
      // Assert
      expect(calls.connects.length, `${order}: not connected again`).to.equal(1);
      expect(disposed, `${order}: its stream stays`).to.equal(0);
      expect(text(moved), order).to.include('kept through the move');
      // Act: the shell's still its own, and what it prints lands here
      input(moved).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, composed: true }));
      await show(calls.sink, 'after the move\r\n');
      await until(() => text(moved).includes('after the move'));
      // Assert
      expect(calls.writes, order).to.deep.equal(['\r']);
      // Act
      moved.remove();
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Assert
      expect(disposed, `${order}: let go with its last element`).to.equal(1);
    }
  });

  it('sends a mouse report far right as bytes, not as text', async () => {
    const { el, calls } = await render(running, 1400);
    expect(calls.connects[0].cols).to.be.greaterThan(100);
    await show(calls.sink, '\x1b[?9h'); // X10 mouse reports
    const screen = /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('.xterm-screen'));
    const box = screen.getBoundingClientRect();
    const at = { clientX: box.right - 5, clientY: box.top + 5, button: 0, buttons: 1, bubbles: true, composed: true };
    screen.dispatchEvent(new MouseEvent('mousedown', at));
    screen.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
    const report = calls.writes.find((w) => w instanceof Uint8Array);
    expect(report).to.be.instanceOf(Uint8Array);
    // ESC [ M, button, then column and row past 32: the column is past 127.
    expect([...(/** @type {Uint8Array} */ (report)).slice(0, 4)]).to.deep.equal([0x1b, 0x5b, 0x4d, 32]);
    expect(/** @type {Uint8Array} */ (report)[4]).to.be.greaterThan(127);
  });

  it('reflects dropping, for files dragged over it', async () => {
    const { el } = await render();
    expect(el.hasAttribute('dropping')).to.equal(false);
    el.dropping = true;
    await el.updateComplete;
    expect(el.hasAttribute('dropping')).to.equal(true);
  });

  it('pastes as a bracketed paste when the program asked for one, else with line breaks as spaces, and takes focus', async () => {
    const cases = [
      ['bracketed', '\x1b[?2004h', '\x1b[200~@a.js#L1 Why?\rIt looks unused\x1b[201~'],
      ['plain', '', '@a.js#L1 Why? It looks unused'],
    ];
    for (const [why, mode, written] of cases) {
      const { el, calls } = await render();
      if (mode) await show(calls.sink, mode);
      el.paste('@a.js#L1 \x1bWhy?\nIt looks unused');
      expect(calls.writes, why).to.deep.equal([written]);
      expect(el.shadowRoot?.activeElement, `${why}: focused`).to.equal(input(el));
    }
  });

  it('sends what the user pastes without ESC, and asks first when its lines would each run', async () => {
    const cases = [
      { why: 'a bracketed paste cannot end itself', mode: '\x1b[?2004h', text: 'a\x1b[201~\nrm -rf x\n', written: ['\x1b[200~a[201~\rrm -rf x\r\x1b[201~'], asked: [] },
      { why: 'one plain line', mode: '', text: 'ls\x1b[0m', written: ['ls[0m'], asked: [] },
      { why: 'plain lines wait for the answer', mode: '', text: 'ls\nrm x', written: [], asked: ['ls\nrm x'] },
      { why: 'a lone carriage return runs too', mode: '', text: 'rm x\r', written: [], asked: ['rm x\r'] },
    ];
    for (const { why, mode, text: pasted, written, asked } of cases) {
      // Arrange
      const { el, calls } = await render();
      if (mode) await show(calls.sink, mode);
      /** @type {string[]} */
      const heard = [];
      el.addEventListener('acp-terminal-paste-lines', (e) => heard.push(/** @type {CustomEvent<{ text: string }>} */ (e).detail.text));
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', pasted);
      // Act
      input(el).dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, composed: true, cancelable: true }));
      // Assert
      expect(calls.writes, why).to.deep.equal(written);
      expect(heard, why).to.deep.equal(asked);
    }
  });

  it('sends lines the user agreed to as lines, without ESC, and takes focus', async () => {
    // Arrange
    const { el, calls } = await render();
    // Act
    el.pasteLines('ls\x1b[0m\nrm x');
    // Assert
    expect(calls.writes).to.deep.equal(['ls[0m\rrm x']);
    expect(el.shadowRoot?.activeElement).to.equal(input(el));
  });

  it('gives a wide character two cells, where programs expect it', async () => {
    // Arrange
    const { calls } = await render();
    // Act: what's drawn, then the program asks where the cursor is
    await show(calls.sink, '😀\x1b[6n');
    // Assert
    expect(calls.writes).to.deep.equal(['\x1b[1;3R']);
  });

  it('takes the keyboard only when asked, waiting until it is shown', async () => {
    // Arrange
    const { el } = await render();
    const settled = () => new Promise((resolve) => setTimeout(resolve, 50));
    const focused = () => el.shadowRoot?.activeElement === input(el);
    await settled();
    expect(focused(), 'not for appearing').to.equal(false);
    // Act
    el.style.display = 'none';
    await settled();
    el.style.display = 'flex';
    await settled();
    // Assert
    expect(focused(), 'not for being shown again').to.equal(false);
    // Act
    el.style.display = 'none';
    await settled();
    el.focus();
    el.style.display = 'flex';
    await settled();
    // Assert
    expect(focused(), 'asked while hidden').to.equal(true);
  });

  it('keeps text readable on a background the program chose', async () => {
    // Arrange: dark default text, as in a light theme
    const { el, calls } = await render();
    const palette = { ...TERMINAL_PALETTE, foreground: '#111111', black: '#000000' };
    el.colors = { light: palette, dark: palette };
    await el.updateComplete;
    // Act: a program paints a black background, leaving the text the default color
    await show(calls.sink, '\x1b[40mon black\x1b[0m');
    await until(() => text(el).includes('on black'));
    // Assert
    const cell = /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('.xterm-rows span'));
    expect(cell.style.color, 'drawn lighter than the default text').to.not.equal('');
  });

  describe('find', () => {
    const bar = (/** @type {AcpTerminal} */ el) => el.shadowRoot?.querySelector('acp-terminal-find') ?? null;
    const count = (/** @type {AcpTerminal} */ el) => bar(el)?.shadowRoot?.querySelector('.acp-terminal-find__count')?.textContent?.trim();
    const press = (/** @type {AcpTerminal} */ el, /** @type {KeyboardEventInit} */ key) =>
      input(el).dispatchEvent(new KeyboardEvent('keydown', { keyCode: 70, code: 'KeyF', key: 'f', bubbles: true, composed: true, ...key }));
    /** @param {AcpTerminal} el @param {string} value */
    function type(el, value) {
      bar(el)?.dispatchEvent(new CustomEvent('acp-search-bar-input', { detail: { value }, bubbles: true, composed: true }));
    }

    it('opens on the platform’s key, and the shell gets no key for it', async () => {
      for (const [platform, key] of /** @type {const} */ ([['mac', { metaKey: true }], ['windows', { ctrlKey: true }], ['linux', { ctrlKey: true }]])) {
        // Arrange
        const { el, calls } = await render();
        el.platform = platform;
        // Act
        press(el, key);
        await el.updateComplete;
        // Assert
        expect(bar(el), platform).to.not.equal(null);
        expect(calls.writes, platform).to.deep.equal([]);
      }
    });

    it('counts matches in the scrollback, moves between them, and closes back to the shell', async () => {
      // Arrange
      const { el, calls } = await render();
      el.platform = 'mac';
      await show(calls.sink, 'needle one\r\nhay\r\nneedle two\r\n');
      press(el, { metaKey: true });
      await el.updateComplete;
      const keydown = (/** @type {KeyboardEventInit} */ key) => bar(el)?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, ...key }));
      // Act + Assert
      type(el, 'needle');
      await until(() => count(el) === '1 of 2');
      keydown({ key: 'Enter' });
      await until(() => count(el) === '2 of 2');
      keydown({ key: 'Enter', shiftKey: true });
      await until(() => count(el) === '1 of 2');
      type(el, 'nothing like it');
      await until(() => count(el) === 'No results');
      keydown({ key: 'Escape' });
      await el.updateComplete;
      expect(bar(el), 'closed').to.equal(null);
      expect(el.shadowRoot?.activeElement, 'back to the shell').to.equal(input(el));
    });

    it('takes the match options, and says when a regular expression is invalid', async () => {
      // Arrange
      const { el, calls } = await render();
      el.platform = 'mac';
      await show(calls.sink, 'Needle needle\r\n');
      press(el, { metaKey: true });
      await el.updateComplete;
      const toggle = (/** @type {string} */ option) => bar(el)?.dispatchEvent(new CustomEvent('acp-search-option-toggle', { detail: { option }, bubbles: true, composed: true }));
      const searchBar = () => /** @type {HTMLElementTagNameMap['acp-search-bar']} */ (bar(el)?.shadowRoot?.querySelector('acp-search-bar'));
      // Act + Assert
      type(el, 'needle');
      await until(() => count(el) === '1 of 2');
      toggle('caseSensitive');
      await until(() => count(el) === '1 of 1');
      toggle('caseSensitive');
      toggle('regex');
      type(el, '(');
      await until(() => searchBar().invalid);
      expect(count(el), 'no count for it').to.equal('');
      type(el, 'n.+e needle');
      await until(() => count(el) === 'No results' || count(el) === '1 of 1');
      expect(searchBar().invalid).to.equal(false);
    });
  });

  it('takes ⌥ as Meta when asked, so the shell gets ESC and the key', async () => {
    // Arrange
    const { el, calls } = await render();
    el.platform = 'mac';
    const press = () => input(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', keyCode: 66, altKey: true, bubbles: true, composed: true }));
    // xterm tells a Mac by the browser it runs in, not by our `platform`; elsewhere Alt always is Meta.
    const composes = navigator.platform.startsWith('Mac');
    // Act
    press();
    // Assert
    expect(calls.writes, 'by default').to.deep.equal(composes ? [] : ['\x1bb']);
    calls.writes.length = 0;
    // Act
    el.optionMeta = true;
    await el.updateComplete;
    press();
    // Assert
    expect(calls.writes, 'asked').to.deep.equal(['\x1bb']);
  });

  it('keeps a paste until its shell is connected', async () => {
    const { calls, connect } = fakeConnect();
    const el = /** @type {AcpTerminal} */ (
      await fixture(html`<acp-terminal style="display: flex; width: 600px; height: 300px" terminal-id="t1" .info=${running} .gpu=${false}></acp-terminal>`)
    );
    el.paste('@a.js#L1 ');
    el.connect = connect;
    el.style.width = '601px';
    await until(() => calls.sink !== null);
    expect(calls.writes).to.deep.equal(['@a.js#L1 ']);
  });

  it('on a Mac, ⌘K clears the screen and what the shell keeps to replay', async () => {
    // Arrange
    const { el, calls } = await render();
    el.platform = 'mac';
    await show(calls.sink, 'old output\r\n');
    // Act
    input(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', keyCode: 75, metaKey: true, bubbles: true, composed: true }));
    // Assert
    expect(calls.clears).to.equal(1);
    await until(() => !text(el).includes('old output'));
  });

  it('on Windows, Ctrl+V pastes and Ctrl+C copies a selection, else interrupts; elsewhere both are the shell’s', async () => {
    const key = (/** @type {AcpTerminal} */ el, /** @type {string} */ letter) =>
      input(el).dispatchEvent(new KeyboardEvent('keydown', { key: letter, code: `Key${letter.toUpperCase()}`, keyCode: letter.toUpperCase().charCodeAt(0), ctrlKey: true, bubbles: true, composed: true }));
    const cases = [
      { platform: 'windows', paste: [], copy: [], copied: ['word'] },
      { platform: 'linux', paste: ['\x16'], copy: ['\x03'], copied: [] },
    ];
    for (const { platform, paste, copy, copied } of cases) {
      // Arrange
      const { el, calls } = await render();
      el.platform = /** @type {import('../../../hooks/app/types.js').Platform} */ (platform);
      /** @type {string[]} */
      const heard = [];
      el.addEventListener('acp-terminal-copy', (e) => heard.push(/** @type {CustomEvent<{ text: string }>} */ (e).detail.text));
      await show(calls.sink, 'word\r\n');
      await until(() => text(el).includes('word'));
      const row = /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('.xterm-rows')?.children[0]);
      const box = row.getBoundingClientRect();
      const at = { clientX: box.left + 3, clientY: box.top + box.height / 2, button: 0, bubbles: true, composed: true };
      const screen = /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('.xterm-screen'));
      // Act
      key(el, 'v');
      // Assert
      expect(calls.writes, `${platform}: Ctrl+V`).to.deep.equal(paste);
      calls.writes.length = 0;
      // Act: a double click selects the word
      screen.dispatchEvent(new MouseEvent('mousedown', { ...at, detail: 2 }));
      screen.dispatchEvent(new MouseEvent('mouseup', { ...at, detail: 2 }));
      key(el, 'c');
      // Assert
      expect(calls.writes, `${platform}: Ctrl+C on a selection`).to.deep.equal(copy);
      expect(heard, platform).to.deep.equal(copied);
      calls.writes.length = 0;
      // Act: with none selected it interrupts
      key(el, 'c');
      // Assert
      expect(calls.writes, `${platform}: Ctrl+C with no selection`).to.deep.equal(['\x03']);
    }
  });

  describe('its menu', () => {
    const menu = (/** @type {AcpTerminal} */ el) => /** @type {HTMLElementTagNameMap['md-menu']} */ (el.shadowRoot?.querySelector('.acp-terminal__menu'));
    const item = (/** @type {AcpTerminal} */ el, /** @type {string} */ value) => /** @type {HTMLElementTagNameMap['md-menu-item']} */ (menu(el).querySelector(`[value="${value}"]`));
    const rightClick = (/** @type {AcpTerminal} */ el, /** @type {MouseEventInit} */ init = {}) =>
      el.shadowRoot?.querySelector('.xterm-screen')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, button: 2, clientX: 40, clientY: 40, ...init }));
    const pick = (/** @type {AcpTerminal} */ el, /** @type {string} */ value) => menu(el).dispatchEvent(new CustomEvent('select', { detail: { value } }));

    it('opens on a right click, with Copy only for a selection, and does what is picked', async () => {
      // Arrange
      const { el, calls } = await render();
      /** @type {unknown[]} */
      const heard = [];
      for (const type of ['acp-terminal-copy', 'acp-terminal-paste-request']) el.addEventListener(type, (e) => heard.push([type, /** @type {CustomEvent} */ (e).detail]));
      await show(calls.sink, 'hello\r\n');
      // Act
      rightClick(el);
      await until(() => menu(el).open);
      // Assert
      expect(item(el, 'copy').disabled, 'nothing selected').to.equal(true);
      // Act
      pick(el, 'paste');
      pick(el, 'select-all');
      await el.updateComplete;
      // Assert
      expect(item(el, 'copy').disabled, 'all selected').to.equal(false);
      // Act
      pick(el, 'copy');
      pick(el, 'clear');
      pick(el, 'find');
      await el.updateComplete;
      // Assert
      expect(heard.map((h) => /** @type {unknown[]} */ (h)[0])).to.deep.equal(['acp-terminal-paste-request', 'acp-terminal-copy']);
      expect(/** @type {{ text: string }} */ (/** @type {unknown[]} */ (heard[1])[1]).text).to.include('hello');
      expect(calls.clears, 'clear').to.equal(1);
      expect(el.shadowRoot?.querySelector('acp-terminal-find'), 'find').to.not.equal(null);
    });

    it('leaves a right click to a program that follows the mouse, unless Shift is held', async () => {
      // Arrange
      const { el, calls } = await render();
      await show(calls.sink, '\x1b[?1000h');
      // Act
      rightClick(el);
      await new Promise((resolve) => setTimeout(resolve, 30));
      // Assert
      expect(menu(el).open, 'the program’s').to.equal(false);
      // Act
      rightClick(el, { shiftKey: true });
      // Assert
      await until(() => menu(el).open);
    });
  });

  it('on Linux, Ctrl+Shift+V asks for the clipboard, which the webview doesn’t paste by itself', async () => {
    for (const [platform, asked] of /** @type {const} */ ([['linux', 1], ['windows', 0]])) {
      // Arrange
      const { el, calls } = await render();
      el.platform = platform;
      let requests = 0;
      el.addEventListener('acp-terminal-paste-request', () => requests++);
      // Act
      input(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'V', code: 'KeyV', keyCode: 86, ctrlKey: true, shiftKey: true, bubbles: true, composed: true }));
      // Assert
      expect(requests, platform).to.equal(asked);
      expect(calls.writes, platform).to.deep.equal([]);
    }
  });

  it('pastes what its view read as the user would, asking first for lines that would run', async () => {
    // Arrange
    const { el, calls } = await render();
    /** @type {string[]} */
    const asked = [];
    el.addEventListener('acp-terminal-paste-lines', (e) => asked.push(/** @type {CustomEvent<{ text: string }>} */ (e).detail.text));
    // Act
    el.pasteAsUser('ls\x1b[0m');
    el.pasteAsUser('a\nb');
    // Assert
    expect(calls.writes).to.deep.equal(['ls[0m']);
    expect(asked).to.deep.equal(['a\nb']);
  });

  it('leaves the app’s shortcuts to the app', async () => {
    const { el, calls } = await render();
    /** @type {KeyboardEvent[]} */
    const reached = [];
    const listener = (/** @type {KeyboardEvent} */ e) => reached.push(e);
    window.addEventListener('keydown', listener);
    const mac = navigator.platform.startsWith('Mac');
    input(el).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', keyCode: 80, metaKey: mac, ctrlKey: !mac, bubbles: true, composed: true }),
    );
    // New Terminal by position: Ctrl+^ on a German layout (keyCode 220, which xterm would send as Ctrl+\).
    input(el).dispatchEvent(new KeyboardEvent('keydown', { key: '^', code: 'Backquote', keyCode: 220, ctrlKey: true, bubbles: true, composed: true }));
    window.removeEventListener('keydown', listener);
    expect(calls.writes).to.deep.equal([]);
    expect(reached.map((e) => e.key)).to.deep.equal(['p', '^']);
  });

  it('on Windows and Linux leaves the workspace shortcuts to the app, Ctrl+N to the shell', async () => {
    for (const platform of /** @type {const} */ (['windows', 'linux'])) {
      // Arrange
      const { el, calls } = await render();
      el.platform = platform;
      /** @type {string[]} */
      const reached = [];
      const listener = (/** @type {KeyboardEvent} */ e) => reached.push(e.code);
      window.addEventListener('keydown', listener);
      // Act
      for (const [key, code, keyCode, shiftKey] of /** @type {const} */ ([
        ['O', 'KeyO', 79, true],
        ['J', 'KeyJ', 74, true],
        ['N', 'KeyN', 78, true],
        ['!', 'Digit1', 49, true],
        // xterm sends Ctrl+@ (US Ctrl+Shift+2) as NUL.
        ['@', 'Digit2', 50, true],
        ['n', 'KeyN', 78, false],
      ])) {
        input(el).dispatchEvent(new KeyboardEvent('keydown', { key, code, keyCode, ctrlKey: true, shiftKey, bubbles: true, composed: true }));
      }
      window.removeEventListener('keydown', listener);
      // Assert
      expect(reached, `${platform}: reach the app`).to.deep.equal(['KeyO', 'KeyJ', 'KeyN', 'Digit1', 'Digit2']);
      expect(calls.writes, `${platform}: Ctrl+N is the shell's`).to.deep.equal(['\x0e']);
      el.remove();
    }
  });

  it('tells the shell its size once, after a drag settles', async () => {
    // Arrange
    const { el, calls } = await render();
    // Act: widths as a drag goes through them, a frame or so apart
    for (const width of [560, 520, 480, 440]) {
      el.style.width = `${width}px`;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await until(() => calls.resizes.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Assert
    expect(calls.resizes.length, JSON.stringify(calls.resizes)).to.equal(1);
    expect(calls.resizes[0][0], 'the last width').to.be.lessThan(calls.connects[0].cols);
  });

  it('holds a WebGL context only while it is shown', async () => {
    // Arrange
    /** @type {HTMLCanvasElement[]} */
    const contexts = [];
    const { getContext } = HTMLCanvasElement.prototype;
    HTMLCanvasElement.prototype.getContext = /** @type {typeof getContext} */ (
      /** @this {HTMLCanvasElement} */
      function spy(/** @type {string} */ type, /** @type {CanvasRenderingContext2DSettings} */ options) {
        const context = getContext.call(this, type, options);
        if (type === 'webgl2' && context) contexts.push(this);
        return context;
      }
    );
    const held = () => contexts.filter((canvas) => canvas.isConnected).length;
    try {
      const { calls, connect } = fakeConnect();
      const el = /** @type {AcpTerminal} */ (
        await fixture(html`<acp-terminal style="display: flex; width: 600px; height: 300px" terminal-id="t1" .connect=${connect} .info=${running}></acp-terminal>`)
      );
      await until(() => calls.sink !== null);
      // Assert
      expect(held(), 'shown').to.equal(1);
      // Act
      el.style.display = 'none';
      // Assert
      await until(() => held() === 0);
      // Act
      el.style.display = 'flex';
      // Assert
      await until(() => held() === 1);
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
    }
  });

  it('resizes the shell with its tab', async () => {
    const { el, calls } = await render();
    const before = calls.connects[0].cols;
    el.style.width = '300px';
    await until(() => calls.resizes.length > 0);
    expect(calls.resizes.at(-1)?.[0]).to.be.lessThan(before);
  });

  it('says how the shell ended, by exit code or by signal, and offers Restart', async () => {
    const cases = [
      { exit: { code: 2, signal: null }, message: '[Process exited with code 2]' },
      { exit: { code: null, signal: 'SIGKILL' }, message: '[Process exited with SIGKILL]' },
    ];
    for (const { exit, message } of cases) {
      const { el, calls } = await render();
      calls.sink?.exit(exit);
      el.info = { ...running, status: 'exited', exit };
      await until(() => text(el).includes(message));
      await el.updateComplete;
      /** @type {Event[]} */
      const restarts = [];
      el.addEventListener('acp-terminal-restart', (e) => restarts.push(e));
      /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('.acp-terminal__restart')).click();
      expect(restarts, message).to.have.length(1);
    }
  });

  it("offers no Restart for a sign-in's login: the sign-in runs it again", async () => {
    const login = { ...running, login: 'copilot login' };
    const { el, calls } = await render(login);
    calls.sink?.exit({ code: 1, signal: null });
    el.info = { ...login, status: 'exited', exit: { code: 1, signal: null } };
    await until(() => text(el).includes('[Process exited with code 1]'));
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('.acp-terminal__restart')).to.equal(null);
  });

  it('shows why the shell didn’t start, with Restart', async () => {
    const { calls, connect } = fakeConnect();
    const el = /** @type {AcpTerminal} */ (
      await fixture(html`<acp-terminal
        style="display: flex; width: 600px; height: 300px"
        terminal-id="t1"
        .connect=${connect}
        .info=${{ ...running, status: 'failed', error: 'Couldn’t start zsh: gone' }}
      ></acp-terminal>`)
    );
    await until(() => calls.sink !== null);
    expect(el.shadowRoot?.querySelector('.acp-terminal__error')?.textContent).to.include('Couldn’t start zsh: gone');
    expect(el.shadowRoot?.querySelector('.acp-terminal__restart')).to.not.equal(null);
  });

  it('follows a new terminal id: drops the old link and screen, and connects the new terminal', async () => {
    /** @type {{ id: string, sink: TerminalSink, writes: (string | Uint8Array)[], disposed: boolean }[]} */
    const links = [];
    /** @type {import('../../../hooks/terminals/types.js').TerminalConnect} */
    const connect = (id, _size, sink) => {
      const link = { id, sink, writes: /** @type {(string | Uint8Array)[]} */ ([]), disposed: false };
      links.push(link);
      return { write: (data) => link.writes.push(data), resize: () => {}, clear: () => {}, dispose: () => (link.disposed = true) };
    };
    const el = /** @type {AcpTerminal} */ (
      await fixture(html`<acp-terminal
        style="display: flex; width: 600px; height: 300px"
        terminal-id="t1"
        .connect=${connect}
        .info=${running}
        .gpu=${false}
      ></acp-terminal>`)
    );
    await until(() => links.length === 1);
    await show(links[0].sink, 'old session');
    await until(() => text(el).includes('old session'));

    el.terminalId = 't2';
    await until(() => links.length === 2);
    expect(links.map((l) => l.id)).to.deep.equal(['t1', 't2']);
    expect(links[0].disposed, 'the old link goes').to.equal(true);
    expect(text(el), "the old terminal's screen goes").not.to.include('old session');
    await show(links[1].sink, 'new session');
    await until(() => text(el).includes('new session'));
    input(el).dispatchEvent(new InputEvent('input', { data: 'x', inputType: 'insertText', bubbles: true }));
    el.paste('typed');
    await until(() => links[1].writes.length > 0);
    expect(links[0].writes, 'nothing goes to the old terminal').to.deep.equal([]);
  });

  it("never draws the old terminal's output on the new one, nor sends the new one's paste to the old", async () => {
    /** @type {{ id: string, sink: TerminalSink, writes: (string | Uint8Array)[] }[]} */
    const links = [];
    /** @type {import('../../../hooks/terminals/types.js').TerminalConnect} */
    const connect = (id, _size, sink) => {
      const link = { id, sink, writes: /** @type {(string | Uint8Array)[]} */ ([]) };
      links.push(link);
      return { write: (data) => link.writes.push(data), resize: () => {}, clear: () => {}, dispose: () => {} };
    };
    const el = /** @type {AcpTerminal} */ (
      await fixture(html`<acp-terminal
        style="display: flex; width: 600px; height: 300px"
        terminal-id="t1"
        .connect=${connect}
        .info=${running}
        .gpu=${false}
      ></acp-terminal>`)
    );
    await until(() => links.length === 1);
    // Output still queued in xterm when the next session shows, and a paste meant for that session.
    links[0].sink.output(new TextEncoder().encode('late old output'), () => {});
    el.terminalId = 't2';
    el.paste('for the new one');
    await until(() => links.length === 2);
    await show(links[1].sink, 'new session');
    await until(() => text(el).includes('new session'));
    expect(text(el)).not.to.include('late old output');
    await until(() => links[1].writes.length > 0);
    expect(links[0].writes, 'nothing typed into the old terminal').to.deep.equal([]);
  });

  it("offers Continue in chat next to Restart once a session's CLI ended", async () => {
    const { el, calls } = await render();
    el.chatFallback = true;
    calls.sink?.exit({ code: 0, signal: null });
    el.info = { ...running, status: 'exited', exit: { code: 0, signal: null }, sessionId: 's1' };
    await el.updateComplete;
    /** @type {CustomEvent[]} */
    const chats = [];
    el.addEventListener('acp-terminal-chat', (e) => chats.push(/** @type {CustomEvent} */ (e)));
    /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('.acp-terminal__chat')).click();
    expect(chats.map((e) => e.detail)).to.deep.equal([{ terminalId: el.terminalId }]);
    expect(el.shadowRoot?.querySelector('.acp-terminal__restart')).to.not.equal(null);
  });

  it("says how much waits for a session's ended CLI: it goes in on Restart or Continue in chat", async () => {
    const { el, calls } = await render();
    el.chatFallback = true;
    calls.sink?.exit({ code: 0, signal: null });
    el.info = { ...running, status: 'exited', exit: { code: 0, signal: null }, sessionId: 's1' };
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('.acp-terminal__waiting'), 'nothing waits').to.equal(null);
    el.waiting = 2;
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('.acp-terminal__waiting')?.textContent?.trim()).to.equal('2 waiting to be sent');
    el.waiting = 1;
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('.acp-terminal__waiting')?.textContent?.trim()).to.equal('1 waiting to be sent');
  });
});
