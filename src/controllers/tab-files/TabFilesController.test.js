import { LitElement, html as litHtml } from 'lit';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../test/fixture.js';
import { TabFilesController } from './TabFilesController.js';
import { projectController } from '../../services/project-controller.js';
import { closeAllTabs, closeTab, openTab } from '../../stores/editor.js';
import { $workspace } from '../../stores/workspace.js';

/** @typedef {import('../../models/types.js').EditorTab} EditorTab */

class FilesHost extends LitElement {
  files = new TabFilesController(this);

  render() {
    return litHtml``;
  }
}
customElements.define('test-tab-files-host', FilesHost);

const PATH = '/p/.brama/agents.json';

/**
 * Polls until `pred` holds; fails after 2s.
 * @param {() => boolean} pred
 */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * The watcher reports changes.
 * @param {{ added?: string[], removed?: string[], modified?: string[] }} changes Root-relative paths.
 */
function report({ added = [], removed = [], modified = [] }) {
  const detail = { rootId: 'r', dirs: [], added, removed, modified, git: false };
  projectController.dispatchEvent(new CustomEvent('fs-change', { detail }));
}

/** The watcher reports the file changed. */
function changedOnDisk() {
  report({ modified: ['.brama/agents.json'] });
}

describe('TabFilesController', () => {
  /** @type {Record<string, string>} */
  let disk;
  /** @type {string[]} */
  let writes;
  /** @type {Promise<void> | null} Reads wait for it while set. */
  let readGate;
  /** @type {string | null} Reads fail with it while set. */
  let readError;

  beforeEach(() => {
    disk = { [PATH]: '{}' };
    writes = [];
    readGate = null;
    readError = null;
    mockIPC(async (cmd, args) => {
      const { path, content } = /** @type {{ path: string, content: string }} */ (args);
      if (cmd === 'read_file') {
        await readGate;
        if (readError) throw new Error(readError);
        if (!(path in disk)) throw new Error(`${path}: not found`);
        return disk[path];
      }
      if (cmd === 'write_file') {
        disk[path] = content;
        writes.push(content);
      }
      return null;
    });
    $workspace.set({ path: '/p', name: 'p', rootId: 'r' });
  });

  afterEach(() => {
    closeAllTabs();
    $workspace.set(null);
    clearMocks();
  });

  /** A host with the agents.json tab open and edited. */
  async function edited() {
    const host = /** @type {FilesHost} */ (await fixture(html`<test-tab-files-host></test-tab-files-host>`));
    const { files } = host;
    openTab(PATH);
    const tab = () => /** @type {EditorTab} */ (files.tabs.find((t) => t.id === PATH));
    await until(() => tab()?.loaded);
    files.edit(PATH, '{ "mine": 1 }');
    return { files, tab };
  }

  it('marks an edited tab whose file changed on disk, and saves over it only when told', async () => {
    const { files, tab } = await edited();
    disk[PATH] = '{ "theirs": 1 }';
    changedOnDisk();
    await until(() => tab().changedOnDisk);
    expect(await files.save(PATH)).to.equal(false);
    expect(writes).to.deep.equal([]);
    expect(await files.save(PATH, { force: true })).to.equal(true);
    expect(writes).to.deep.equal(['{ "mine": 1 }']);
    expect(tab()).to.include({ content: '{ "mine": 1 }', draft: null, changedOnDisk: false });
  });

  it('takes its own save for no change on disk', async () => {
    const { files, tab } = await edited();
    expect(await files.save(PATH)).to.equal(true);
    files.edit(PATH, '{ "mine": 2 }');
    changedOnDisk();
    await new Promise((r) => setTimeout(r, 50));
    expect(tab().changedOnDisk).to.equal(false);
  });

  it('checks the disk at save time, before the watcher says anything', async () => {
    const { files, tab } = await edited();
    disk[PATH] = '{ "theirs": 1 }';
    expect(await files.save(PATH)).to.equal(false);
    expect(writes).to.deep.equal([]);
    expect(tab().changedOnDisk).to.equal(true);
  });

  it('reloads the file from disk, dropping the edits', async () => {
    const { files, tab } = await edited();
    disk[PATH] = '{ "theirs": 1 }';
    changedOnDisk();
    await until(() => tab().changedOnDisk);
    files.reload(PATH);
    await until(() => tab().content === '{ "theirs": 1 }');
    expect(tab()).to.include({ draft: null, changedOnDisk: false });
  });

  it('keeps edits typed while a reload reads, and asks before saving them over the file', async () => {
    const { files, tab } = await edited();
    disk[PATH] = '{ "theirs": 1 }';
    changedOnDisk();
    await until(() => tab().changedOnDisk);
    /** @type {() => void} */
    let release = () => {};
    readGate = new Promise((r) => (release = r));
    files.reload(PATH);
    files.edit(PATH, '{ "mine": 2 }');
    release();
    await until(() => tab().loaded);
    expect(tab()).to.include({ content: '{}', draft: '{ "mine": 2 }', changedOnDisk: true });
    expect(await files.save(PATH)).to.equal(false);
    expect(writes).to.deep.equal([]);
  });

  it('takes a save that lands while another save checks the disk for no change on disk', async () => {
    const { files, tab } = await edited();
    let reads = 0;
    mockIPC(async (cmd, args) => {
      const { path, content } = /** @type {{ path: string, content: string }} */ (args);
      if (cmd === 'read_file') {
        // The second save's check reads only after the first save wrote.
        if (++reads === 2) await until(() => writes.length > 0);
        return disk[path];
      }
      if (cmd === 'write_file') {
        disk[path] = content;
        writes.push(content);
      }
      return null;
    });
    const first = files.save(PATH);
    const second = files.save(PATH);
    expect(await first).to.equal(true);
    expect(await second).to.equal(true);
    expect(writes).to.deep.equal(['{ "mine": 1 }']);
    expect(tab()).to.include({ content: '{ "mine": 1 }', draft: null, changedOnDisk: false });
  });

  it("asks before saving over a file it can't read", async () => {
    const { files, tab } = await edited();
    readError = `${PATH}: stream did not contain valid UTF-8`;
    expect(await files.save(PATH)).to.equal(false);
    expect(writes).to.deep.equal([]);
    expect(tab().changedOnDisk).to.equal(true);
  });

  describe('switching projects', () => {
    const away = () => $workspace.set({ path: '/q', name: 'q', rootId: 'r2' });
    const back = () => $workspace.set({ path: '/p', name: 'p', rootId: 'r' });

    it('keeps unsaved edits while another project is shown', async () => {
      const { files, tab } = await edited();
      away();
      expect(files.tabs.find((t) => t.id === PATH)).to.equal(undefined);
      back();
      await until(() => tab()?.loaded);
      expect(tab()).to.include({ draft: '{ "mine": 1 }', changedOnDisk: false });
    });

    it('marks kept edits whose file changed meanwhile', async () => {
      const { files, tab } = await edited();
      away();
      disk[PATH] = '{ "theirs": 1 }';
      back();
      await until(() => tab()?.loaded);
      expect(tab()).to.include({ content: '{}', draft: '{ "mine": 1 }', changedOnDisk: true });
      expect(await files.save(PATH)).to.equal(false);
    });

    it('drops the edits of a closed tab', async () => {
      const { tab } = await edited();
      closeTab(PATH);
      openTab(PATH);
      await until(() => tab()?.loaded);
      expect(tab().draft).to.equal(null);
    });
  });

  describe('a file deleted on disk', () => {
    const REL = '.brama/agents.json';

    function deleted() {
      delete disk[PATH];
      report({ removed: [REL] });
    }

    it('keeps showing the file and its edits, marked deleted', async () => {
      const { tab } = await edited();
      deleted();
      expect(tab()).to.include({ error: '', content: '{}', draft: '{ "mine": 1 }', deletedOnDisk: true });
    });

    it('saves the edits without asking, creating the file again', async () => {
      const { files, tab } = await edited();
      deleted();
      expect(await files.save(PATH)).to.equal(true);
      expect(disk[PATH]).to.equal('{ "mine": 1 }');
      expect(tab()).to.include({ draft: null, deletedOnDisk: false });
    });

    it('saves an unedited file again too', async () => {
      const { files, tab } = await edited();
      files.edit(PATH, '{}');
      deleted();
      expect(await files.save(PATH)).to.equal(true);
      expect(disk[PATH]).to.equal('{}');
      expect(tab().deletedOnDisk).to.equal(false);
    });

    it('shows the edits as before when the file is created again, marked when it differs', async () => {
      const { files, tab } = await edited();
      deleted();
      disk[PATH] = '{ "theirs": 1 }';
      report({ added: [REL] });
      await until(() => tab().changedOnDisk);
      expect(tab()).to.include({ deletedOnDisk: false, content: '{}', draft: '{ "mine": 1 }' });
      expect(await files.save(PATH)).to.equal(false);
    });

    it('unmarks it when the same file is created again', async () => {
      const { tab } = await edited();
      deleted();
      disk[PATH] = '{}';
      report({ added: [REL] });
      await new Promise((r) => setTimeout(r, 50));
      expect(tab()).to.include({ deletedOnDisk: false, draft: '{ "mine": 1 }', changedOnDisk: false });
    });
  });
});
