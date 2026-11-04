import { LitElement, html } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import '../pane/pane.js';
import '../resize-handle/resize-handle.js';
import '../split/split.js';
import { ColumnResizeController } from '../../controllers/resize/ColumnResizeController.js';
import styles from './column-split.css?inline';

/** @typedef {import('../../hooks/settings/types.js').ColumnWidths} ColumnWidths */
/** @typedef {import('../../controllers/resize/ColumnResizeController.js').ResizableColumn} ResizableColumn */

/**
 * One column of the row: its content goes in the slot of its name.
 * @typedef {Object} SplitColumn
 * @property {string} name Slot name, and the name its divider reports.
 * @property {string} [size] Custom property on `:root` with its default width (`tokens.css`); without
 *   one it is a flexible column.
 * @property {string} [minSize] Custom property with its minimum width.
 * @property {string} [maxSize] Custom property with its maximum width.
 * @property {number} [shrink] Its share of the shrinking when the row is too narrow (default 1).
 * @property {'start' | 'end'} [collapse] The side whose gap collapses with it when it is hidden.
 * @property {{ min: number, max: number, partner?: string, label: string, edge?: 'start' | 'end' }} [resize]
 *   Makes it resizable (needs `size`): limits in px, the column across its divider that gives or takes
 *   the width, the divider's name, and which side of the column it sits on (default `end`: after it).
 */

/**
 * @tag acp-column-split
 * @summary The app's row of columns (stacked rows with `direction="column"`, dividers dragged up and down, sizes as heights): a pane for each, its content slotted by name, a divider beside each resizable one, widths dragged inline and reported when they settle. Whatever else is slotted follows the panes.
 * @fires acp-columns-resize `{ widths }` all the widths, when a drag ends, a key steps one or a divider resets
 */
export class AcpColumnSplit extends LitElement {
  static properties = {
    columns: { attribute: false },
    widths: { attribute: false },
    hiddenColumns: { attribute: false },
    fillColumns: { attribute: false },
    direction: { type: String, reflect: true },
    flush: { type: Boolean, reflect: true },
  };

  static styles = styles;

  /** @type {readonly SplitColumn[] | null} */
  #resizableFor = null;
  /** @type {Record<string, ResizableColumn>} */
  #resizable = {};

  #resize = new ColumnResizeController(this, {
    columns: () => this.#resizableColumns(),
    axis: () => this.#axis,
    widths: () => this.widths,
    onCommit: (widths) =>
      this.dispatchEvent(new CustomEvent('acp-columns-resize', { detail: { widths }, bubbles: true, composed: true })),
  });

  constructor() {
    super();
    /** @type {readonly SplitColumn[]} In row order. */
    this.columns = [];
    /** @type {ColumnWidths} Widths set by the user, by column name; the others are at their default. */
    this.widths = {};
    /** @type {readonly string[]} Columns collapsed to nothing, their inline width dropped. */
    this.hiddenColumns = [];
    /** @type {readonly string[]} Columns with no width of their own: they take what the others leave. */
    this.fillColumns = [];
    /** @type {'row' | 'column'} `column`: the panes are stacked rows, and `size`, `minSize` and `maxSize` are heights. */
    this.direction = 'row';
    /** @type {boolean} Without the window's edge padding, for a split inside a pane. */
    this.flush = false;
  }

  /** @returns {'x' | 'y'} Along which the dividers are dragged and the panes sized. */
  get #axis() {
    return this.direction === 'column' ? 'y' : 'x';
  }

  /** The resizable columns as the controller wants them; the same object until `columns` changes. */
  #resizableColumns() {
    if (this.columns !== this.#resizableFor) {
      this.#resizableFor = this.columns;
      this.#resizable = Object.fromEntries(
        this.columns.flatMap(({ name, size, resize }) =>
          resize && size ? [[name, { property: size, min: resize.min, max: resize.max, partner: resize.partner }]] : [],
        ),
      );
    }
    return this.#resizable;
  }

  /**
   * How a pane shares the row (custom properties of `<acp-pane>`), then its dragged size inline: not
   * a custom property on a host, whose change restyles everything below it on every frame of a drag.
   * @param {SplitColumn} column
   * @param {boolean} hidden
   * @param {boolean} fill
   */
  #paneStyle({ name, size, minSize, maxSize, shrink = 1, resize }, hidden, fill) {
    if (fill) return '--acp-pane-flex: 1';
    const dimension = this.#axis === 'y' ? 'height' : 'width';
    const style = [];
    if (size) style.push(`--acp-pane-flex: 0 ${shrink} var(${size})`, `--acp-pane-${dimension}: var(${size})`);
    // Custom properties inherit: without `initial`, a nested pane takes the limits of the pane around it.
    style.push(`--acp-pane-min-${dimension}: ${minSize ? `var(${minSize})` : 'initial'}`);
    style.push(`--acp-pane-max-${dimension}: ${maxSize ? `var(${maxSize})` : 'initial'}`);
    // A hidden column drops its inline width, so its collapse can take it to nothing.
    if (resize && !hidden) style.push(this.#resize.columnStyle(name));
    return style.join('; ');
  }

  /** @param {SplitColumn} column */
  #renderDivider({ name, resize }) {
    const { value, min, max } = this.#resize.column(name);
    return html`<acp-resize-handle
      class="acp-split__handle"
      name=${name}
      edge=${resize?.edge ?? 'end'}
      axis=${this.#axis}
      label=${resize?.label ?? ''}
      .value=${value}
      .min=${min}
      .max=${max}
    ></acp-resize-handle>`;
  }

  render() {
    /** @type {{ key: string, template: unknown }[]} Keyed, so a pane keeps its element (and its collapse animation) as dividers come and go. */
    const items = [];
    for (const column of this.columns) {
      const hidden = this.hiddenColumns.includes(column.name);
      const fill = this.fillColumns.includes(column.name);
      const divider = column.resize && column.size && !hidden && !fill;
      const side = column.resize?.edge ?? 'end';
      if (divider && side === 'start') items.push({ key: `handle:${column.name}`, template: this.#renderDivider(column) });
      items.push({
        key: `pane:${column.name}`,
        template: html`<acp-pane edge=${ifDefined(column.collapse)} style=${this.#paneStyle(column, hidden, fill)} ?hidden=${hidden}>
          <slot name=${column.name}></slot>
        </acp-pane>`,
      });
      if (divider && side === 'end') items.push({ key: `handle:${column.name}`, template: this.#renderDivider(column) });
    }
    return html`<acp-split direction=${this.direction} ?flush=${this.flush}>${repeat(items, (item) => item.key, (item) => item.template)}<slot></slot></acp-split>`;
  }
}

customElements.define('acp-column-split', AcpColumnSplit);
