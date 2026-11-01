import { expect } from '@esm-bundle/chai';
import { comments } from '../comments.js';

/**
 * A host whose shadow root holds an editor, directly or inside a nested child's shadow root; the
 * event the editor fires, as the host hears it.
 * @param {{ nested: boolean }} options
 */
function hear({ nested }) {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  let inner = root;
  if (nested) {
    const child = document.createElement('div');
    root.append(child);
    inner = child.attachShadow({ mode: 'open' });
  }
  const editor = document.createElement('cdx-code-editor');
  inner.append(editor);
  document.body.append(host);
  /** @type {{ found: Element | null, editor: Element, root: ShadowRoot }} */
  const heard = { found: null, editor, root };
  host.addEventListener('thing', (e) => (heard.found = comments.editorOf(e, root)));
  editor.dispatchEvent(new Event('thing', { composed: true, bubbles: true }));
  host.remove();
  return heard;
}

describe('comments', () => {
  it('finds the editor an event came from, when it sits in the host’s own root', () => {
    const { found, editor } = hear({ nested: false });
    expect(found === editor, 'the editor').to.equal(true);
  });

  it('leaves the events of an editor nested in a child’s root to the child', () => {
    expect(hear({ nested: true }).found === null, 'none').to.equal(true);
  });

  it('finds nothing for an event that did not come from an editor', () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    root.append(button);
    document.body.append(host);
    /** @type {unknown} */
    let found = 'unset';
    host.addEventListener('thing', (e) => (found = comments.editorOf(e, root)));
    button.dispatchEvent(new Event('thing', { composed: true, bubbles: true }));
    host.remove();
    expect(found).to.equal(null);
  });
});
