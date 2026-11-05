import { expect, fixture, html } from '../../../../test/fixture.js';
import '../resize-handle.js';

describe('acp-resize-handle', () => {
  it('on the vertical axis, steps with the up and down arrows and measures the heights of the rows around it', async () => {
    // Arrange
    const wrap = await fixture(html`<div style="display: flex; flex-direction: column; width: 100px; height: 400px">
      <div style="flex: none; height: 300px; min-height: 80px"></div>
      <acp-resize-handle name="panel" axis="y" edge="start" label="Resize panel"></acp-resize-handle>
      <div style="flex: 1; min-height: 60px"></div>
    </div>`);
    const handle = /** @type {HTMLElementTagNameMap['acp-resize-handle']} */ (wrap.querySelector('acp-resize-handle'));
    await handle.updateComplete;
    /** @type {{ name: string, delta?: number, measure?: { width: number, neighborWidth: number, neighborMin: number } }[]} */
    const steps = [];
    handle.addEventListener('acp-resize-step', (e) => steps.push(/** @type {CustomEvent} */ (e).detail));

    // Act: the panel is the row after the handle, so up grows it
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));

    // Assert
    expect(handle.getAttribute('aria-orientation')).to.equal('horizontal');
    expect(steps.map((s) => s.delta), 'left and right belong to the other axis').to.deep.equal([10, -50]);
    expect(steps[0].measure?.width, 'the row after it').to.be.closeTo(Math.round(400 - 300 - handle.getBoundingClientRect().height), 1);
    expect(steps[0].measure?.neighborWidth, 'the row before it').to.equal(300);
    expect(steps[0].measure?.neighborMin).to.equal(80);
  });

  it('on the vertical axis, a drag follows the pointer up and down, and grows the row after it when dragged up', async () => {
    // Arrange
    const handle = /** @type {HTMLElementTagNameMap['acp-resize-handle']} */ (
      await fixture(html`<acp-resize-handle name="panel" axis="y" edge="start"></acp-resize-handle>`)
    );
    // A synthetic pointer is not one the browser can capture.
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = (id) => handle.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: id }));
    /** @type {string[]} */
    const heard = [];
    for (const type of ['acp-resize-start', 'acp-resize', 'acp-resize-end']) {
      handle.addEventListener(type, (e) => heard.push(`${type}:${/** @type {CustomEvent} */ (e).detail.delta ?? ''}`));
    }
    const pointer = (/** @type {string} */ type, /** @type {number} */ y) =>
      handle.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX: 500, clientY: y, bubbles: true }));

    // Act: 30px up (and sideways, which counts for nothing)
    pointer('pointerdown', 100);
    pointer('pointermove', 70);
    pointer('pointerup', 70);

    // Assert
    expect(heard).to.deep.equal(['acp-resize-start:', 'acp-resize:30', 'acp-resize:30', 'acp-resize-end:']);
  });
});
