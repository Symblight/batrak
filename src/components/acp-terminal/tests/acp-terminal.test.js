import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-terminal.js';

/** @typedef {import('../acp-terminal.js').AcpTerminal} AcpTerminal */
/** @typedef {import('../../../models/types.js').TerminalInfo} TerminalInfo */
/** @typedef {import('../../../models/types.js').TerminalSink} TerminalSink */

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
  projectPath: '/p',
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
    /** @type {TerminalSink | null} */ sink: null,
  };
  /** @type {import('../../../models/types.js').TerminalConnect} */
  const connect = (_id, size, sink) => {
    calls.connects.push(size);
    calls.sink = sink;
    return {
      write: (data) => calls.writes.push(data),
      resize: (cols, rows) => calls.resizes.push([cols, rows]),
      dispose: () => {},
    };
  };
  return { calls, connect };
}

/**
 * @param {TerminalInfo} [info]
 * @param {number} [width] px
 * @returns {Promise<{ el: AcpTerminal, calls: ReturnType<typeof fakeConnect>['calls'] }>}
 */
async function render(info = running, width = 600) {
  const { calls, connect } = fakeConnect();
  // The DOM renderer, whose rows the tests read.
  const el = /** @type {AcpTerminal} */ (
    await fixture(html`<acp-terminal
      style="display: flex; width: ${width}px; height: 300px"
      terminal-id="t1"
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

describe('acp-terminal', () => {
  // xterm draws nothing while it's out of view: each test's terminal goes once it's done.
  afterEach(() => {
    for (const el of document.querySelectorAll('acp-terminal')) el.parentElement?.remove();
  });

  it('connects at its size and shows the shell’s output', async () => {
    const { el, calls } = await render();
    expect(calls.connects[0].cols).to.be.greaterThan(10);
    await show(calls.sink, 'hello from the shell\r\n');
    await until(() => text(el).includes('hello from the shell'));
  });

  it('connects again with a fresh screen when it is moved, as a tab reorder does', async () => {
    const { el, calls } = await render();
    el.parentElement?.append(el);
    await until(() => calls.connects.length === 2);
    await show(calls.sink, 'still here\r\n');
    await until(() => text(el).includes('still here'));
    input(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, composed: true }));
    expect(calls.writes).to.deep.equal(['\r']);
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

  it('sends what is typed to the shell', async () => {
    const { el, calls } = await render();
    input(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, composed: true }));
    expect(calls.writes).to.deep.equal(['\r']);
  });

  it('reflects dropping, for files dragged over it', async () => {
    const { el } = await render();
    expect(el.hasAttribute('dropping')).to.equal(false);
    el.dropping = true;
    await el.updateComplete;
    expect(el.hasAttribute('dropping')).to.equal(true);
  });

  it('pastes text as a bracketed paste when the program asked for one, and takes focus', async () => {
    const { el, calls } = await render();
    await show(calls.sink, '\x1b[?2004h');
    el.paste('@a.js#L1 Why?\nIt looks unused');
    expect(calls.writes).to.deep.equal(['\x1b[200~@a.js#L1 Why?\rIt looks unused\x1b[201~']);
    expect(el.shadowRoot?.activeElement).to.equal(input(el));
  });

  it('pastes line breaks as spaces when the program takes no bracketed paste, so nothing is sent early', async () => {
    const { el, calls } = await render();
    el.paste('@a.js#L1 Why?\nIt looks unused');
    expect(calls.writes).to.deep.equal(['@a.js#L1 Why? It looks unused']);
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
    window.removeEventListener('keydown', listener);
    expect(calls.writes).to.deep.equal([]);
    expect(reached.map((e) => e.key)).to.deep.equal(['p']);
  });

  it('resizes the shell with its tab', async () => {
    const { el, calls } = await render();
    const before = calls.connects[0].cols;
    el.style.width = '300px';
    await until(() => calls.resizes.length > 0);
    expect(calls.resizes.at(-1)?.[0]).to.be.lessThan(before);
  });

  it('says how the shell ended and offers Restart', async () => {
    const { el, calls } = await render();
    calls.sink?.exit({ code: 2, signal: null });
    el.info = { ...running, status: 'exited', exit: { code: 2, signal: null } };
    await until(() => text(el).includes('[Process exited with code 2]'));
    await el.updateComplete;
    /** @type {Event[]} */
    const restarts = [];
    el.addEventListener('acp-terminal-restart', (e) => restarts.push(e));
    const restart = /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('.acp-terminal__restart'));
    restart.click();
    expect(restarts).to.have.length(1);
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

  it('names the signal that ended the shell', async () => {
    const { el, calls } = await render();
    calls.sink?.exit({ code: null, signal: 'SIGKILL' });
    await until(() => text(el).includes('[Process exited with SIGKILL]'));
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
    /** @type {import('../../../models/types.js').TerminalConnect} */
    const connect = (id, _size, sink) => {
      const link = { id, sink, writes: /** @type {(string | Uint8Array)[]} */ ([]), disposed: false };
      links.push(link);
      return { write: (data) => link.writes.push(data), resize: () => {}, dispose: () => (link.disposed = true) };
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
    /** @type {import('../../../models/types.js').TerminalConnect} */
    const connect = (id, _size, sink) => {
      const link = { id, sink, writes: /** @type {(string | Uint8Array)[]} */ ([]) };
      links.push(link);
      return { write: (data) => link.writes.push(data), resize: () => {}, dispose: () => {} };
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
    expect(chats.map((e) => e.detail)).to.deep.equal([{ terminalId: 't1' }]);
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
