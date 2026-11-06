import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect } from '@esm-bundle/chai';
import { $commitSelection, $gitChanges, $gitCompare, $gitRepo, $shownChanges, $uncommittedCount, NO_COMPARE, NO_REPO, setCommitSelection } from '../../../stores/git/git.js';
import { $notices } from '../../../stores/notices/notices.js';
import { $project } from '../../../stores/project/project.js';
import { projects } from '../../projects/projects.js';

/** @typedef {import('../types.js').GitFileStatus} GitFileStatus */

/** @type {{ cmd: string, args: Record<string, any> }[]} */
let calls;
/** @type {Record<string, (args: Record<string, any>) => unknown>} Answers by command; others get `null`. */
let answers;
/** @type {(() => void) | null} */
let stop = null;
let counter = 0;
let paths = 0;

const REPO = { branch: 'main', sha: 'a1', detached: false, upstream: null, ahead: 0, behind: 0 };
/** @type {GitFileStatus} */
const FILE = /** @type {GitFileStatus} */ ({ path: 'a.txt', kind: 'modified' });

/**
 * A fresh copy of the hook (its state is module-level), started.
 * @returns {Promise<typeof import('../git.js').git>}
 */
async function started() {
  const { git } = await import(`../git.js?fresh=${++counter}`);
  stop = git.start();
  return git;
}

const sent = (/** @type {string} */ cmd) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);

/** The hook's wait for more changes after one (`REFRESH_DELAY_MS`). */
const DEBOUNCE_MS = 300;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
/** @type {Map<number, () => void>} The hook's debounced reads, fired by `until()` instead of after 300 ms. */
const held = new Map();
let heldId = 1_000_000;
function holdDebounces() {
  globalThis.setTimeout = /** @type {never} */ ((/** @type {() => void} */ fn, /** @type {number} */ ms) => {
    if (ms !== DEBOUNCE_MS) return realSetTimeout(fn, ms);
    held.set(++heldId, fn);
    return heldId;
  });
  globalThis.clearTimeout = /** @type {never} */ ((/** @type {number} */ id) => {
    if (!held.delete(id)) realClearTimeout(id);
  });
}
function releaseDebounces() {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  held.clear();
}

/**
 * Waits for `pred`, firing the debounced reads pending meanwhile (as if their 300 ms had passed).
 * @param {() => boolean} pred
 */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(1500);
    const due = [...held.values()];
    held.clear();
    due.forEach((fn) => fn());
    await new Promise((r) => realSetTimeout(r, 5));
  }
}
/** @param {number} ms */
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));
/** Fires the debounced reads still pending, and lets what they started finish. */
async function settle() {
  [...held.values()].forEach((fn) => fn());
  held.clear();
  await wait(30);
}

/**
 * Opens a project of its own (roots stay open across tests).
 * @returns {Promise<string>} Its root id.
 */
async function open() {
  const path = `/work/${counter}-${++paths}`;
  await projects.activate(path);
  return `root:${path}`;
}

/** @param {string} rootId @param {Partial<{ git: boolean }>} [changes] */
const changed = (rootId, changes = {}) =>
  emit('roots://changed', { rootId, dirs: [], added: [], removed: [], modified: ['a.txt'], git: false, ...changes });

describe('git', () => {
  beforeEach(() => {
    calls = [];
    holdDebounces();
    answers = {
      open_root: ({ path }) => ({ rootId: `root:${path}`, path, name: 'p' }),
      git_head: () => REPO,
      git_status: () => ({ version: 1, unchanged: false, status: { repo: REPO, files: [FILE] } }),
    };
    $project.set(null);
    $gitRepo.set(NO_REPO);
    $gitCompare.set(NO_COMPARE);
    $notices.set([]);
    setCommitSelection([]);
    mockIPC(
      (cmd, args) => {
        const a = /** @type {Record<string, any>} */ (args ?? {});
        calls.push({ cmd, args: a });
        return answers[cmd]?.(a) ?? null;
      },
      { shouldMockEvents: true },
    );
  });
  afterEach(() => {
    releaseDebounces();
    stop?.();
    stop = null;
    clearMocks();
    $project.set(null);
  });

  it('reads the branch when a project opens, once for a burst of changes, and again on focus; it stops when told', async () => {
    // Arrange
    await started();
    const rootId = await open();
    await until(() => $gitRepo.get().repo?.branch === 'main');
    // Act
    await changed(rootId, { git: true });
    await changed(rootId, { git: true });
    await changed('root:elsewhere', { git: true });
    await changed(rootId); // no repository change
    await until(() => sent('git_head').length >= 2);
    await settle();
    const afterBurst = sent('git_head').length;
    window.dispatchEvent(new Event('focus'));
    await until(() => sent('git_head').length === 3);
    stop?.();
    window.dispatchEvent(new Event('focus'));
    await wait(30);
    // Assert
    expect(afterBurst, 'the burst, the other root and the plain change added one read').to.equal(2);
    expect(sent('git_head').length, 'nothing after stop').to.equal(3);
    expect(sent('git_head')[0]).to.deep.equal({ rootId });
  });

  it('scans the changed files only while something watches them, and keeps them when the last watcher stops', async () => {
    // Arrange
    const git = await started();
    const rootId = await open();
    await until(() => sent('git_head').length === 1);
    await wait(30);
    const unwatched = sent('git_status').length;
    // Act
    const first = git.watchChanges();
    const second = git.watchChanges();
    await until(() => $gitChanges.get().loaded);
    await changed(rootId);
    await until(() => sent('git_status').length === 2);
    first();
    first();
    second();
    await changed(rootId);
    await settle();
    // Assert
    expect(unwatched, 'no scan before anyone watches').to.equal(0);
    expect(sent('git_status').length, 'none after the last watcher stopped').to.equal(2);
    expect(sent('git_status')[0]).to.deep.equal({ rootId, since: null, force: false });
    expect($gitChanges.get().files, 'kept').to.deep.equal([FILE]);
    expect($gitChanges.get().loading).to.equal(false);
  });

  it('keeps the same files when the backend says nothing changed, asking with its version; Refresh forces a scan', async () => {
    // Arrange
    const git = await started();
    await open();
    const stopWatching = git.watchChanges();
    await until(() => $gitChanges.get().loaded);
    const before = $gitChanges.get().files;
    answers.git_status = () => ({ version: 1, unchanged: true, status: null });
    // Act
    git.refreshChanges();
    await until(() => sent('git_status').length === 2);
    await until(() => !$gitChanges.get().loading);
    // Assert
    expect(sent('git_status')[1]).to.include({ since: 1, force: true });
    expect($gitChanges.get().files, 'the very same array').to.equal(before);
    stopWatching();
  });

  it('shows why a scan failed, and starts over without a version', async () => {
    // Arrange
    const git = await started();
    await open();
    const stopWatching = git.watchChanges();
    await until(() => $gitChanges.get().loaded);
    answers.git_status = () => {
      throw new Error('git not found');
    };
    git.refreshChanges();
    await until(() => $gitChanges.get().error !== null);
    answers.git_status = () => ({ version: 2, unchanged: false, status: { repo: REPO, files: [FILE] } });
    // Act
    git.refreshChanges();
    await until(() => $gitChanges.get().error === null && $gitChanges.get().files.length === 1);
    // Assert
    expect(sent('git_status').map((a) => a.since), 'after the failure it asks for everything again').to.deep.equal([null, 1, null]);
    stopWatching();
  });

  it('commits the active project’s files, then reads the branch and files again, also when git refuses', async () => {
    // Arrange
    const git = await started();
    const rootId = await open();
    const stopWatching = git.watchChanges();
    await until(() => $gitChanges.get().loaded);
    answers.git_commit = () => ({ sha: 'b2', summary: 'Fix it' });
    await until(() => sent('git_head').length === 1);
    // Act
    const committed = await git.commit(['a.txt'], 'Fix it', false);
    await until(() => sent('git_head').length === 2 && sent('git_status').length === 2);
    answers.git_commit = () => {
      throw new Error('hook failed');
    };
    const failure = await git.commit([], 'again', true).catch((err) => err);
    await until(() => sent('git_head').length === 3 && sent('git_status').length === 3);
    // Assert
    expect(committed).to.deep.equal({ sha: 'b2', summary: 'Fix it' });
    expect(sent('git_commit')[0]).to.deep.equal({ rootId, paths: ['a.txt'], message: 'Fix it', amend: false });
    expect(String(failure)).to.include('hook failed');
    stopWatching();
  });

  it('reverts files in the active project in one call, both sides of a rename, then reads the files again, also when git refuses', async () => {
    // Arrange
    const git = await started();
    const rootId = await open();
    const stopWatching = git.watchChanges();
    await until(() => $gitChanges.get().loaded);
    answers.git_revert_files = () => null;
    // Act
    await git.revertFiles([{ ...FILE, path: 'new.txt', origPath: 'old.txt' }, { ...FILE, path: 'a.txt', origPath: null }]);
    await until(() => sent('git_status').length === 2);
    answers.git_revert_files = () => {
      throw new Error('conflict');
    };
    const failure = await git.revertFiles([FILE]).catch((err) => err);
    await until(() => sent('git_status').length === 3);
    // Assert
    expect(sent('git_revert_files')[0]).to.deep.equal({ rootId, paths: ['new.txt', 'old.txt', 'a.txt'] });
    expect(String(failure)).to.include('conflict');
    stopWatching();
  });

  it('refuses to commit with no project open', async () => {
    // Arrange
    const git = await started();
    // Act
    const failure = await git.commit(['a.txt'], 'x', false).catch((err) => err);
    // Assert
    expect(String(failure)).to.include('No project is open');
    expect(sent('git_commit')).to.deep.equal([]);
  });

  it('shows nothing of the previous project, and gives a project still open back as it was', async () => {
    // Arrange
    const git = await started();
    const a = await open();
    const stopWatching = git.watchChanges();
    await until(() => $gitChanges.get().loaded && $gitRepo.get().repo !== null);
    setCommitSelection(['a.txt']);
    const aFiles = $gitChanges.get().files;
    answers.git_status = () => ({ version: 7, unchanged: false, status: { repo: { ...REPO, branch: 'other' }, files: [] } });
    // Act
    await open();
    const right = { repo: $gitRepo.get().repo, files: $gitChanges.get().files, picked: [...$commitSelection.get()] };
    await until(() => $gitRepo.get().repo?.branch === 'other');
    await projects.activate(a.replace('root:', ''));
    const back = { files: $gitChanges.get().files, picked: [...$commitSelection.get()], branch: $gitRepo.get().repo?.branch };
    // Assert
    expect(right, 'cleared at once').to.deep.equal({ repo: null, files: [], picked: [] });
    expect(back.files, 'its own files, at once').to.equal(aFiles);
    expect(back.picked).to.deep.equal(['a.txt']);
    expect(back.branch).to.equal('main');
    stopWatching();
  });

  it('drops the answer of a scan that was for a project no longer shown', async () => {
    // Arrange
    const git = await started();
    /** @type {((reply: unknown) => void)[]} */
    const answering = [];
    answers.git_status = () => new Promise((resolve) => answering.push(resolve));
    await open();
    const stopWatching = git.watchChanges();
    await until(() => answering.length === 1);
    await open(); // its own scan waits for the first one
    // Act
    answering[0]({ version: 9, unchanged: false, status: { repo: REPO, files: [FILE] } });
    await until(() => answering.length === 2);
    const meanwhile = { files: $gitChanges.get().files, loaded: $gitChanges.get().loaded };
    answering[1]({ version: 3, unchanged: false, status: { repo: REPO, files: [] } });
    await until(() => $gitChanges.get().loaded);
    // Assert
    expect(meanwhile, 'the first project’s files never show under the second').to.deep.equal({ files: [], loaded: false });
    stopWatching();
  });

  it('passes the other git commands their project and path', async () => {
    // Arrange
    const git = await started();
    const list = { local: ['main'], remotes: [{ remote: 'origin', branches: ['origin/main'] }], default: 'origin/main' };
    answers.git_branches = () => list;
    answers.git_last_commit_message = () => 'Fix it';
    answers.git_file_at_head = () => 'text';
    // Act
    const results = [await git.branches('r1'), await git.lastCommitMessage('r1'), await git.fileAtHead('r1', 'src/a.js')];
    // Assert
    expect(results).to.deep.equal([list, 'Fix it', 'text']);
    expect(sent('git_branches')).to.deep.equal([{ rootId: 'r1' }]);
    expect(sent('git_file_at_head')).to.deep.equal([{ rootId: 'r1', path: 'src/a.js' }]);
  });

  it('reads the path it is given at HEAD, whatever the list of changes says: the list may predate HEAD', async () => {
    // Arrange
    const git = await started();
    const rootId = await open();
    $gitChanges.set({ files: [{ ...FILE, path: 'new.js', kind: 'renamed', origPath: 'old.js' }], loaded: true, loading: false, error: null });
    // Act
    await git.fileAtHead(rootId, 'new.js');
    // Assert
    expect(sent('git_file_at_head')).to.deep.equal([{ rootId, path: 'new.js' }]);
  });

  describe('comparing to a branch', () => {
    /** @type {GitFileStatus} */
    const BRANCH_FILE = /** @type {GitFileStatus} */ ({ path: 'b.txt', kind: 'added' });
    const comparison = (/** @type {GitFileStatus[]} */ files = [BRANCH_FILE], base = 'b1') => ({ target: 'main', base, files });

    it('shows the branch’s files and leaves local changes, their count and the picks alone; going back shows local changes', async () => {
      // Arrange
      answers.git_compare = () => comparison();
      const git = await started();
      const rootId = await open();
      const stopWatching = git.watchChanges();
      await until(() => $gitChanges.get().loaded);
      setCommitSelection(['a.txt']);
      // Act
      git.compareTo('main');
      const atOnce = $shownChanges.get();
      await until(() => $gitCompare.get().changes.loaded);
      const compared = { view: $gitCompare.get(), shown: $shownChanges.get().files };
      const local = { files: $gitChanges.get().files, count: $uncommittedCount.get(), picks: [...$commitSelection.get()] };
      git.compareTo(null);
      // Assert
      expect(atOnce, 'no other list under the branch’s name').to.deep.include({ files: [], loaded: false, loading: true });
      expect(sent('git_compare')).to.deep.equal([{ rootId, target: 'main' }]);
      expect(compared.view).to.deep.include({ target: 'main', base: 'b1', refreshError: null });
      expect(compared.shown).to.deep.equal([BRANCH_FILE]);
      expect(local).to.deep.equal({ files: [FILE], count: 1, picks: ['a.txt'] });
      expect($gitCompare.get()).to.equal(NO_COMPARE);
      expect($shownChanges.get().files).to.deep.equal([FILE]);
      expect(sent('git_compare_stop')).to.deep.equal([{ rootId }]);
      stopWatching();
    });

    it('a pick asks at once, even while a refresh is running, and the answer for the old branch is dropped', async () => {
      // Arrange
      /** @type {{ target: string, resolve: (reply: unknown) => void }[]} */
      const asked = [];
      answers.git_compare = ({ target }) => new Promise((resolve) => asked.push({ target, resolve }));
      const git = await started();
      const rootId = await open();
      const stopWatching = git.watchChanges();
      git.compareTo('main');
      asked[0].resolve(comparison());
      await until(() => $gitCompare.get().changes.loaded);
      await changed(rootId);
      await until(() => asked.length === 2);
      // Act
      git.compareTo('other');
      const whileRunning = asked.map((a) => a.target);
      asked[1].resolve(comparison([FILE], 'old'));
      await wait(10);
      const afterOldAnswer = $gitCompare.get().changes.files;
      asked[2].resolve({ target: 'other', base: 'b2', files: [] });
      await until(() => $gitCompare.get().changes.loaded);
      // Assert
      expect(whileRunning).to.deep.equal(['main', 'main', 'other']);
      expect(afterOldAnswer).to.deep.equal([]);
      expect($gitCompare.get()).to.deep.include({ target: 'other', base: 'b2' });
      stopWatching();
    });

    it('a refresh waiting for a pick also waits for the pick after it, rather than stop its scan', async () => {
      // Arrange
      /** @type {{ target: string, resolve: (reply: unknown) => void }[]} */
      const asked = [];
      answers.git_compare = ({ target }) => new Promise((resolve) => asked.push({ target, resolve }));
      const git = await started();
      const rootId = await open();
      const stopWatching = git.watchChanges();
      git.compareTo('a');
      await changed(rootId);
      await settle();
      // Act
      git.compareTo('b');
      asked[0].resolve({ target: 'a', base: 'b1', files: [] });
      await wait(20);
      const whileBRuns = asked.map((a) => a.target);
      asked[1].resolve({ target: 'b', base: 'b2', files: [] });
      await until(() => $gitCompare.get().changes.loaded);
      // Assert
      expect(whileBRuns).to.deep.equal(['a', 'b']);
      stopWatching();
    });

    it('reads again on file changes while watched, one at a time, keeping the same array for the same list', async () => {
      // Arrange
      /** @type {((reply: unknown) => void)[]} */
      const answering = [];
      answers.git_compare = () => new Promise((resolve) => answering.push(resolve));
      const git = await started();
      const rootId = await open();
      const stopWatching = git.watchChanges();
      git.compareTo('main');
      answering[0](comparison());
      await until(() => $gitCompare.get().changes.loaded);
      const { files } = $gitCompare.get().changes;
      // Act
      await changed(rootId);
      await until(() => answering.length === 2);
      await changed(rootId);
      await settle();
      const whileOneRuns = answering.length;
      answering[1](comparison());
      await until(() => answering.length === 3);
      answering[2](comparison());
      await until(() => !$gitCompare.get().changes.loading);
      stopWatching();
      await changed(rootId);
      await settle();
      // Assert
      expect(whileOneRuns, 'refreshes never overlap').to.equal(2);
      expect($gitCompare.get().changes.files).to.equal(files);
      expect(answering.length, 'none once nothing watches').to.equal(3);
    });

    it('a failed refresh keeps the list and says why, until one works; Refresh reads it too', async () => {
      // Arrange
      answers.git_compare = () => comparison();
      const git = await started();
      await open();
      const stopWatching = git.watchChanges();
      git.compareTo('main');
      await until(() => $gitCompare.get().changes.loaded);
      answers.git_compare = () => Promise.reject(new Error('git timed out after 10s'));
      // Act
      git.refreshChanges();
      await until(() => $gitCompare.get().refreshError !== null);
      const failed = $gitCompare.get();
      answers.git_compare = () => comparison();
      git.refreshChanges();
      await until(() => $gitCompare.get().refreshError === null);
      // Assert
      expect(failed.changes.files).to.deep.equal([BRANCH_FILE]);
      expect(failed.changes.error).to.equal(null);
      expect(failed.refreshError).to.contain('timed out');
      stopWatching();
    });

    it('a failed first read says why, and a stopped one keeps what is shown', async () => {
      // Arrange
      answers.git_compare = () => Promise.reject(new Error('main no longer exists'));
      const git = await started();
      await open();
      // Act
      git.compareTo('main');
      await until(() => $gitCompare.get().changes.loaded);
      const failed = $gitCompare.get().changes;
      answers.git_compare = () => comparison();
      git.compareTo('main');
      await until(() => $gitCompare.get().changes.loaded);
      const stopWatching = git.watchChanges();
      answers.git_compare = () => Promise.reject('cancelled');
      git.refreshChanges();
      await until(() => sent('git_compare').length === 3);
      await until(() => !$gitCompare.get().changes.loading);
      // Assert
      expect(failed.error).to.contain('main no longer exists');
      expect(failed.files).to.deep.equal([]);
      expect($gitCompare.get().changes.files).to.deep.equal([BRANCH_FILE]);
      expect($gitCompare.get().refreshError).to.equal(null);
      stopWatching();
    });

    it('asks again when a first read was stopped: a stop for the last comparison may have reached it', async () => {
      // Arrange
      let asked = 0;
      answers.git_compare = () => (++asked === 1 ? Promise.reject('cancelled') : comparison());
      const git = await started();
      await open();
      // Act
      git.compareTo('main');
      await until(() => $gitCompare.get().changes.loaded);
      // Assert
      expect(asked).to.equal(2);
      expect($gitCompare.get().changes.files).to.deep.equal([BRANCH_FILE]);
    });

    it('a stopped first read goes on showing the spinner until it is asked again, never an empty list', async () => {
      // Arrange
      let asked = 0;
      answers.git_compare = () => (++asked === 1 ? Promise.reject('cancelled') : comparison());
      const git = await started();
      await open();
      /** @type {{ loaded: boolean, loading: boolean }[]} */
      const states = [];
      const stop = $gitCompare.listen(({ changes }) => states.push({ loaded: changes.loaded, loading: changes.loading }));
      // Act
      git.compareTo('main');
      await until(() => $gitCompare.get().changes.loaded);
      stop();
      // Assert
      expect(states.filter(({ loaded, loading }) => !loaded && !loading)).to.deep.equal([]);
    });

    it('another project isn’t compared, and one still open gets its comparison back; a late answer stays out', async () => {
      // Arrange
      /** @type {((reply: unknown) => void)[]} */
      const answering = [];
      answers.git_compare = () => comparison();
      const git = await started();
      const a = await open();
      const stopWatching = git.watchChanges();
      git.compareTo('main');
      await until(() => $gitCompare.get().changes.loaded);
      const kept = $gitCompare.get().changes.files;
      // Act
      await open();
      const right = $gitCompare.get();
      answers.git_compare = () => new Promise((resolve) => answering.push(resolve));
      git.compareTo('other');
      await until(() => answering.length === 1);
      await projects.activate(a.replace('root:', ''));
      const back = $gitCompare.get();
      answering[0](comparison([], 'late'));
      await settle();
      // Assert
      expect(right).to.equal(NO_COMPARE);
      expect(back.target).to.equal('main');
      expect(back.changes.files).to.equal(kept);
      expect($gitCompare.get().base, 'the other project’s answer').to.not.equal('late');
      stopWatching();
    });

    it('passes the commit and path to read a file at', async () => {
      // Arrange
      answers.git_file_at_rev = () => 'old text';
      const git = await started();
      // Act
      const text = await git.fileAtRev('r1', 'b1', 'a.txt');
      // Assert
      expect(text).to.equal('old text');
      expect(sent('git_file_at_rev')).to.deep.equal([{ rootId: 'r1', rev: 'b1', path: 'a.txt' }]);
    });
  });
});
