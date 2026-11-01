import { LitElement, html as litHtml } from 'lit';
import { ChxCommandPicker } from '@symblight/chat/composer';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { FileMentionsController } from '../FileMentionsController.js';

/** @typedef {import('../../../hooks/search/types.js').QuickOpenItem} QuickOpenItem */

/** A fake `@` picker that records what the controller does to it. */
function fakePicker() {
  /** @type {string[]} */
  const calls = [];
  /** @type {string[][]} */
  const listed = [];
  return {
    calls,
    listed,
    clearOptions: () => calls.push('clear'),
    addOptions: (/** @type {DocumentFragment} */ fragment) => {
      calls.push('add');
      listed.push([...fragment.children].map((c) => c.getAttribute('value') ?? ''));
    },
  };
}

class MentionsHost extends LitElement {
  picker = fakePicker();
  /** @type {readonly QuickOpenItem[]} */
  options = [];
  /** @type {(string | null)[]} */
  queries = [];
  focused = 0;
  mentions = new FileMentionsController(this, {
    picker: () => /** @type {never} */ (this.picker),
    composer: () => /** @type {never} */ ({ focus: () => this.focused++ }),
    options: () => this.options,
    onQuery: (query) => this.queries.push(query),
  });

  render() {
    return litHtml``;
  }
}
customElements.define('test-file-mentions-host', MentionsHost);

/** @param {string} path */
const entry = (path) => /** @type {QuickOpenItem} */ ({ path, name: path.split('/').pop() ?? path, isDir: false, indices: [] });

/**
 * @param {MentionsHost} host
 * @param {string | null} value
 */
function query(host, value) {
  const event = new CustomEvent('chx-command-query', { detail: { value } });
  Object.defineProperty(event, 'target', { value: host.picker });
  host.mentions.onQuery(event);
}

/** @param {string} path @param {boolean} [browse] */
function option(path, browse = false, kind = '') {
  const item = document.createElement('div');
  item.setAttribute('value', path);
  if (browse) item.dataset.browse = '';
  if (kind) item.dataset.kind = kind;
  return /** @type {import('../FileMentionsController.js').MenuItemElement} */ (/** @type {unknown} */ (item));
}

describe('FileMentionsController', () => {
  /** @type {MentionsHost} */
  let host;

  beforeEach(async () => {
    host = /** @type {MentionsHost} */ (await fixture(html`<test-file-mentions-host></test-file-mentions-host>`));
  });

  it('offers "Files and Folders" for a bare @, searches once a name is typed, and drops the search when @ goes', () => {
    query(host, '');
    expect(host.queries, 'a bare @ searches nothing').to.deep.equal([null]);
    expect(host.picker.calls).to.deep.equal(['clear', 'add']);
    expect(host.picker.listed[0], 'the browse step').to.deep.equal(['']);
    query(host, 'ap');
    expect(host.queries.at(-1)).to.equal('ap');
    query(host, null);
    expect(host.queries.at(-1), 'dropped').to.equal(null);
    expect(host.picker.calls.at(-1), 'no browse step without an @').to.equal('clear');
  });

  it('searches an empty query once "Files and Folders" is picked, keeping focus in the composer', () => {
    query(host, '');
    host.mentions.resolve(option('', true));
    expect(host.queries.at(-1), 'now a bare @ searches').to.equal('');
    expect(host.focused).to.equal(1);
    query(host, null);
    query(host, '');
    expect(host.queries.at(-1), 'the pick lasted for that @ only').to.equal(null);
  });

  it('lists a new answer only while searching, at most 50', async () => {
    host.options = [entry('a.js')];
    host.requestUpdate();
    await host.updateComplete;
    expect(host.picker.listed, 'not searching: nothing listed').to.deep.equal([]);

    query(host, 'a');
    host.options = Array.from({ length: 60 }, (_, i) => entry(`f${i}.js`));
    host.requestUpdate();
    await host.updateComplete;
    expect(host.picker.listed.at(-1)).to.have.length(50);
    const count = host.picker.listed.length;
    host.requestUpdate();
    await host.updateComplete;
    expect(host.picker.listed, 'the same answer is not listed again').to.have.length(count);
  });

  it('turns a pick into a chip with its name and path, a folder when the picked option was one', () => {
    /** @type {HTMLElement[]} */
    const chips = [];
    const picked = (/** @type {string} */ value) =>
      host.mentions.onPicked(new CustomEvent('chx-command-picked', { detail: { value, setChip: (/** @type {HTMLElement} */ chip) => chips.push(chip) } }));
    const original = ChxCommandPicker.prototype.resolve;
    ChxCommandPicker.prototype.resolve = () => {};
    try {
      host.mentions.resolve(option('src/app.js'));
      picked('src/app.js');
      host.mentions.resolve(option('src', false, 'folder'));
      picked('src');
    } finally {
      ChxCommandPicker.prototype.resolve = original;
    }
    expect(chips.map((c) => [c.textContent?.trim(), c.dataset.path, c.dataset.kind])).to.deep.equal([
      ['app.js', 'src/app.js', undefined],
      ['src', 'src', 'folder'],
    ]);
  });
});
