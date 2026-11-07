import { LitElement, html as litHtml } from 'lit';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect, fileBytes, fixture, html } from '../../../../test/fixture.js';
import { TabFilesController } from '../TabFilesController.js';
import { $unsavedFiles, closeAllTabs, closeTab, openTab } from '../../../stores/editor/editor.js';
import { $project } from '../../../stores/project/project.js';
import { $sessions } from '../../../stores/sessions/sessions.js';

/** @typedef {import('../../../hooks/tabs/types.js').EditorTab} EditorTab */

class FilesHost extends LitElement {
  files = new TabFilesController(this);

  render() {
    return litHtml``;
  }
}
customElements.define('test-tab-files-host', FilesHost);

const PATH = '/p/.bt/agents.json';

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
  return emit('roots://changed', { rootId: 'r', dirs: [], added, removed, modified, git: false });
}

/** The watcher reports the file changed. */
function changedOnDisk() {
  return report({ modified: ['.bt/agents.json'] });
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
        return fileBytes(disk[path]);
      }
      if (cmd === 'write_file') {
        disk[path] = content;
        writes.push(content);
      }
      return null;
    }, { shouldMockEvents: true });
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
  });

  afterEach(() => {
    closeAllTabs();
    $sessions.set([]);
    $project.set(null);
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
    await changedOnDisk();
    await until(() => tab().changedOnDisk);
    expect(await files.save(PATH)).to.equal(false);
    expect(writes).to.deep.equal([]);
    expect(await files.save(PATH, { force: true })).to.equal(true);
    expect(writes).to.deep.equal(['{ "mine": 1 }']);
    expect(tab()).to.include({ content: '{ "mine": 1 }', draft: null, changedOnDisk: false });
  });

  it("re-reads a workspace chat's files when its turn ends, not a Main chat's", async () => {
    // Arrange: no watcher reports a workspace's files
    const host = /** @type {FilesHost} */ (await fixture(html`<test-tab-files-host></test-tab-files-host>`));
    openTab(PATH);
    const tab = () => /** @type {EditorTab} */ (host.files.tabs.find((t) => t.id === PATH));
    await until(() => tab()?.loaded);
    /** @param {string | null} workspaceId @param {string} status */
    const chat = (workspaceId, status) => /** @type {import('../../../hooks/sessions/types.js').Session} */ (
      /** @type {unknown} */ ({ id: `s-${workspaceId}`, folder: '/p', workspaceId, status })
    );
    $sessions.set([chat(null, 'working'), chat('w1', 'working')]);
    disk[PATH] = '{ "agent": 1 }';

    // Act: Main's turn ends
    $sessions.set([chat(null, 'idle'), chat('w1', 'working')]);
    await new Promise((r) => setTimeout(r, 50));
    const afterMain = tab().content;
    // Act: the workspace's turn ends
    $sessions.set([chat(null, 'idle'), chat('w1', 'idle')]);
    await until(() => tab().content === '{ "agent": 1 }');

    // Assert
    expect(afterMain).to.equal('{}');
  });

  it('takes its own save for no change on disk', async () => {
    const { files, tab } = await edited();
    expect(await files.save(PATH)).to.equal(true);
    files.edit(PATH, '{ "mine": 2 }');
    await changedOnDisk();
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
    await changedOnDisk();
    await until(() => tab().changedOnDisk);
    files.reload(PATH);
    await until(() => tab().content === '{ "theirs": 1 }');
    expect(tab()).to.include({ draft: null, changedOnDisk: false });
  });

  it('keeps edits typed while a reload reads, and asks before saving them over the file', async () => {
    const { files, tab } = await edited();
    disk[PATH] = '{ "theirs": 1 }';
    await changedOnDisk();
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
        return fileBytes(disk[path]);
      }
      if (cmd === 'write_file') {
        disk[path] = content;
        writes.push(content);
      }
      return null;
    }, { shouldMockEvents: true });
    const first = files.save(PATH);
    const second = files.save(PATH);
    expect(await first).to.equal(true);
    expect(await second).to.equal(true);
    expect(writes).to.deep.equal(['{ "mine": 1 }']);
    expect(tab()).to.include({ content: '{ "mine": 1 }', draft: null, changedOnDisk: false });
  });

  it("asks before saving over a file it can't read", async () => {
    const { files, tab } = await edited();
    readError = `${PATH}: not UTF-8 text`;
    expect(await files.save(PATH)).to.equal(false);
    expect(writes).to.deep.equal([]);
    expect(tab().changedOnDisk).to.equal(true);
  });

  describe('switching projects', () => {
    const away = () => $project.set({ path: '/q', name: 'q', rootId: 'r2' });
    const back = () => $project.set({ path: '/p', name: 'p', rootId: 'r' });

    it('counts unsaved edits while another project is shown, until they are saved or closed', async () => {
      // Arrange
      const { files } = await edited();
      expect($unsavedFiles.get(), 'edited').to.equal(1);

      // Act + Assert: its project isn't shown
      away();
      expect($unsavedFiles.get(), 'away').to.equal(1);

      // Act + Assert: shown again, and saved
      back();
      expect($unsavedFiles.get(), 'back').to.equal(1);
      await files.save(PATH);
      expect($unsavedFiles.get(), 'saved').to.equal(0);

      // Act + Assert: edited again, and closed
      files.edit(PATH, '{ "mine": 2 }');
      expect($unsavedFiles.get(), 'edited again').to.equal(1);
      closeTab(PATH);
      expect($unsavedFiles.get(), 'closed').to.equal(0);
    });

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
    const REL = '.bt/agents.json';

    async function deleted() {
      delete disk[PATH];
      await report({ removed: [REL] });
    }

    it('keeps showing the file and its edits, marked deleted', async () => {
      const { tab } = await edited();
      await deleted();
      expect(tab()).to.include({ error: '', content: '{}', draft: '{ "mine": 1 }', deletedOnDisk: true });
    });

    it('saves the edits without asking, creating the file again', async () => {
      const { files, tab } = await edited();
      await deleted();
      expect(await files.save(PATH)).to.equal(true);
      expect(disk[PATH]).to.equal('{ "mine": 1 }');
      expect(tab()).to.include({ draft: null, deletedOnDisk: false });
    });

    it('saves an unedited file again too', async () => {
      const { files, tab } = await edited();
      files.edit(PATH, '{}');
      await deleted();
      expect(await files.save(PATH)).to.equal(true);
      expect(disk[PATH]).to.equal('{}');
      expect(tab().deletedOnDisk).to.equal(false);
    });

    it('shows the edits as before when the file is created again, marked when it differs', async () => {
      const { files, tab } = await edited();
      await deleted();
      disk[PATH] = '{ "theirs": 1 }';
      await report({ added: [REL] });
      await until(() => tab().changedOnDisk);
      expect(tab()).to.include({ deletedOnDisk: false, content: '{}', draft: '{ "mine": 1 }' });
      expect(await files.save(PATH)).to.equal(false);
    });

    it('unmarks it when the same file is created again', async () => {
      const { tab } = await edited();
      await deleted();
      disk[PATH] = '{}';
      await report({ added: [REL] });
      await new Promise((r) => setTimeout(r, 50));
      expect(tab()).to.include({ deletedOnDisk: false, draft: '{ "mine": 1 }', changedOnDisk: false });
    });
  });
});
