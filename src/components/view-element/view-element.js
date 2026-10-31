import { LitElement } from 'lit';
import styles from './view-element.css?inline';

/**
 * Base of every view: a presentational element without styles of its own. It only passes its
 * children through (its host takes no box), so layout comes from the layout components it renders.
 */
export class ViewElement extends LitElement {
  static styles = styles;
}
