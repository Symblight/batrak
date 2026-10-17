import { ReactiveElement } from 'lit';
import shadowStyles from './shadow.css?inline';

/** @typedef {import('lit').CSSResultGroup} CSSResultGroup */
/** @typedef {import('lit').CSSResultOrNative} CSSResultOrNative */

/**
 * Puts `shadow.css` first in every Lit element's styles, the libraries' included (they share our
 * `lit`): one place for what every shadow root needs, like thin scrollbars and menu density.
 * Imported before any element is defined, since a class's styles are finalized at `define()`.
 */
const Base = /** @type {{ finalizeStyles: (styles?: CSSResultGroup) => CSSResultOrNative[] }} */ (
  /** @type {unknown} */ (ReactiveElement)
);
const finalizeStyles = Base.finalizeStyles;
Base.finalizeStyles = function (styles) {
  // The loader makes every `?inline` stylesheet one CSSResult.
  return [/** @type {CSSResultOrNative} */ (shadowStyles), ...finalizeStyles.call(this, styles)];
};
