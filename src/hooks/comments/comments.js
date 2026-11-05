/** @typedef {HTMLElementTagNameMap['cdx-code-editor']} CdxCodeEditor */

/** The rules about the comments typed in the code editors. */
export const comments = Object.freeze({
  /**
   * The `cdx-code-editor` an event came from, when it sits in `root`. Editor events are composed, so a
   * host also hears those of editors nested in its children's shadow roots (the Changes review's, in
   * the tab view); those are the children's to handle.
   * @param {Event} event
   * @param {Node} root The host's render root.
   * @returns {CdxCodeEditor | null}
   */
  editorOf(event, root) {
    for (const node of event.composedPath()) {
      if (node instanceof HTMLElement && node.localName === 'cdx-code-editor') {
        return node.getRootNode() === root ? /** @type {CdxCodeEditor} */ (node) : null;
      }
    }
    return null;
  },
});
