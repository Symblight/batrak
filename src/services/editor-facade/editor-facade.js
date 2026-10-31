/**
 * Contract between the app and a code editor implementation.
 * Contract only: no implementation here.
 *
 * @typedef {Object} EditorFacade
 * @property {(path: string, content: string) => void} open Show a file.
 * @property {() => string} getValue Current document text.
 * @property {(value: string) => void} setValue Replace document text.
 * @property {(readOnly: boolean) => void} setReadOnly Toggle editing.
 * @property {(listener: (value: string) => void) => (() => void)} onChange
 *   Subscribe to edits; returns an unsubscribe function.
 * @property {() => void} destroy Release resources.
 */

export {};
