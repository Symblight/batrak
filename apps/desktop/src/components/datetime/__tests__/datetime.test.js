import { expect, fixture, html } from '../../../../test/fixture.js';
import '../datetime.js';

const NOW = Date.parse('2026-03-10T12:00:00Z');
const ago = (/** @type {number} */ ms) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;

/** @param {Element} el */
const text = (el) => el.textContent?.trim() ?? '';

/** @param {string | number | null} value */
const compact = async (value) =>
  text(await fixture(html`<acp-datetime .value=${value} .now=${NOW} format="compact"></acp-datetime>`));

describe('acp-datetime', () => {
  it('renders into itself a <time> with the machine-readable time, and nothing without a value', async () => {
    const el = await fixture(html`<acp-datetime .value=${'2026-03-10T09:05:00Z'}></acp-datetime>`);
    expect(el.shadowRoot === null, 'no shadow root').to.equal(true);
    expect(el.querySelector('time')?.getAttribute('datetime')).to.equal('2026-03-10T09:05:00.000Z');
    const empty = await fixture(html`<acp-datetime></acp-datetime>`);
    expect(empty.querySelector('time') === null).to.equal(true);
    expect(text(empty)).to.equal('');
  });

  describe('compact', () => {
    it('says now for under a minute or a time not in the past, then counts minutes, hours and days, rounding down', async () => {
      const cases = [
        [ago(30_000), 'now'],
        [new Date(NOW + 5 * MINUTE).toISOString(), 'now'],
        ['not a date', 'now'],
        [ago(12 * MINUTE + 59_000), '12m'],
        [ago(59 * MINUTE), '59m'],
        [ago(60 * MINUTE), '1h'],
        [ago(23 * 60 * MINUTE), '23h'],
        [ago(24 * 60 * MINUTE), '1d'],
        [ago(75 * 24 * 60 * MINUTE), '75d'],
      ];
      for (const [value, expected] of cases) expect(await compact(value), String(value)).to.equal(expected);
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
});
