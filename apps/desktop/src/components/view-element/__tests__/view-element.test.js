import { css, html } from 'lit';
import { expect, fixture } from '../../../../test/fixture.js';
import { ViewElement } from '../view-element.js';

class TestView extends ViewElement {
  render() {
    return html`<span id="own">rendered</span>`;
  }
}
customElements.define('test-view-element', TestView);

describe('ViewElement', () => {
  it('renders into itself, with no shadow root', async () => {
    const el = await fixture(html`<test-view-element></test-view-element>`);
    expect(el.shadowRoot === null, 'no shadow root').to.equal(true);
    expect(el.querySelector('#own')?.textContent).to.equal('rendered');
  });

  it('takes no box of its own, so what it renders sits where it does', async () => {
    const el = await fixture(html`<test-view-element></test-view-element>`);
    expect(el.style.display).to.equal('contents');
  });

  it('clears what the page put inside it, like a splash, before it renders', async () => {
    const el = await fixture(html`<test-view-element><img id="splash" alt="" /></test-view-element>`);
    expect(el.querySelector('#splash') === null, 'the splash is gone').to.equal(true);
    expect(el.children.length).to.equal(1);
  });

  it('warns about styles, which a light-DOM element cannot have', () => {
    const warn = console.warn;
    /** @type {unknown[][]} */
    const warned = [];
    console.warn = (...args) => warned.push(args);
    try {
      class Styled extends ViewElement {
        static styles = css`:host { color: red; }`;
      }
      customElements.define('test-styled-view-element', Styled);
      new Styled();
    } finally {
      console.warn = warn;
    }
    expect(warned.length).to.equal(1);
    expect(String(warned[0][0])).to.contain('static styles');
  });
});
