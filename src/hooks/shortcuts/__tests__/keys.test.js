import { expect } from '@esm-bundle/chai';
import { codeOf, comboOf } from '../keys.js';

describe('shortcut keys', () => {
  it('resolves a row to the combo of each platform', () => {
    const plain = { mod: true, key: 'P' };
    const mac = { mod: true, alt: true, key: '1' };
    const other = { ctrl: true, shift: true, key: '1' };
    const cases = [
      // [row, platform, combo]
      [plain, 'mac', plain],
      [plain, 'windows', plain],
      [plain, 'linux', plain],
      [{ mac, other }, 'mac', mac],
      [{ mac, other }, 'windows', other],
      [{ mac, other }, 'linux', other],
    ];
    for (const [row, platform, combo] of cases) {
      // Act + Assert
      expect(comboOf(/** @type {any} */ (row), /** @type {any} */ (platform)), `${JSON.stringify(row)} on ${platform}`).to.equal(combo);
    }
  });

  it('names the physical key of each key label', () => {
    const cases = [
      // [key, code]
      ['P', 'KeyP'],
      ['1', 'Digit1'],
      ['F10', 'F10'],
      ['`', 'Backquote'],
      [',', 'Comma'],
      ['§', null],
    ];
    for (const [key, code] of cases) {
      // Act + Assert
      expect(codeOf(/** @type {string} */ (key)), key ?? '').to.equal(code);
    }
  });
});
