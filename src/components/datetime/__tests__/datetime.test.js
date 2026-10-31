import { expect, fixture, html } from '../../../../test/fixture.js';
import '../datetime.js';

const NOW = Date.parse('2026-03-10T12:00:00Z');
const ago = (/** @type {number} */ ms) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;

/** @param {Element} el */
const text = (el) => el.shadowRoot?.textContent?.trim() ?? '';

/** @param {string | number | null} value */
const compact = async (value) =>
  text(await fixture(html`<acp-datetime .value=${value} .now=${NOW} format="compact"></acp-datetime>`));

describe('acp-datetime', () => {
  describe('compact', () => {
    it('says now for under a minute, and for a time that is not in the past', async () => {
      expect(await compact(ago(30_000))).to.equal('now');
      expect(await compact(new Date(NOW + 5 * MINUTE).toISOString())).to.equal('now');
      expect(await compact('not a date')).to.equal('now');
    });

    it('counts minutes, then hours, then days, rounding down', async () => {
      expect(await compact(ago(12 * MINUTE + 59_000))).to.equal('12m');
      expect(await compact(ago(59 * MINUTE))).to.equal('59m');
      expect(await compact(ago(60 * MINUTE))).to.equal('1h');
      expect(await compact(ago(23 * 60 * MINUTE))).to.equal('23h');
      expect(await compact(ago(24 * 60 * MINUTE))).to.equal('1d');
      expect(await compact(ago(75 * 24 * 60 * MINUTE))).to.equal('75d');
    });

    it('takes the time to count from as `now`, the current time without it', async () => {
      const el = await fixture(html`<acp-datetime .value=${ago(3 * 60 * MINUTE)} .now=${NOW} format="compact"></acp-datetime>`);
      expect(text(el)).to.equal('3h');
      el.now = NOW + 2 * 60 * MINUTE;
      await el.updateComplete;
      expect(text(el)).to.equal('5h');
      const live = await fixture(html`<acp-datetime .value=${new Date().toISOString()} format="compact"></acp-datetime>`);
      expect(text(live)).to.equal('now');
    });
  });

  describe('medium', () => {
    it('shows the date and time in the reader’s locale, from an ISO string or milliseconds', async () => {
      const iso = '2026-03-10T09:05:00Z';
      const expected = new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      expect(text(await fixture(html`<acp-datetime .value=${iso} format="medium"></acp-datetime>`))).to.equal(expected);
      expect(text(await fixture(html`<acp-datetime .value=${Date.parse(iso)}></acp-datetime>`))).to.equal(expected);
    });
  });

  it('marks the machine-readable time, and shows nothing without one', async () => {
    const el = await fixture(html`<acp-datetime .value=${'2026-03-10T09:05:00Z'}></acp-datetime>`);
    expect(el.shadowRoot?.querySelector('time')?.getAttribute('datetime')).to.equal('2026-03-10T09:05:00.000Z');
    const empty = await fixture(html`<acp-datetime></acp-datetime>`);
    expect(empty.shadowRoot?.querySelector('time')).to.equal(null);
    expect(text(empty)).to.equal('');
  });
});
