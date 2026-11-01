import { LitElement } from 'lit';

/**
 * Base of every view: a presentational element without styles. It renders into itself (light DOM)
 * and takes no box, so what it renders sits in its parent's tree and layout comes from the layout
 * components it composes. A view is never hidden itself: hide the pane it sits in.
 */
export class ViewElement extends LitElement {
  constructor() {
    super();
    // A light-DOM element has no shadow root to adopt a stylesheet into.
    if (new.target.styles) console.warn(`${new.target.name}: static styles are ignored in a view; style a component.`);
  }

  connectedCallback() {
    this.style.display = 'contents';
    super.connectedCallback();
  }

  /** Clears what the page put inside (the splash in `index.html`): Lit appends, it never replaces. */
  createRenderRoot() {
    this.replaceChildren();
    return this;
  }
}
