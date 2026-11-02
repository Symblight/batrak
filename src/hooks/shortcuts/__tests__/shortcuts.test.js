import { expect } from '@esm-bundle/chai';
import { shortcuts } from '../shortcuts.js';

describe('shortcuts', () => {
  it('writes each hint the way its platform does', () => {
    const cases = [
      // [id, platform, hint]
      ['searchInFiles', 'mac', '⇧⌘F'],
      ['searchInFiles', 'windows', 'Ctrl+Shift+F'],
      ['searchInFiles', 'linux', 'Ctrl+Shift+F'],
      ['quickOpen', 'mac', '⌘P'],
      ['quickOpen', 'linux', 'Ctrl+P'],
      ['newTerminal', 'mac', '⌃`'],
      ['newTerminal', 'windows', 'Ctrl+`'],
      ['matchCase', 'mac', '⌥C'],
      ['matchCase', 'windows', 'Alt+C'],
      ['markdownPreview', 'mac', '⇧⌘V'],
      ['markdownPreview', 'linux', 'Ctrl+Shift+V'],
      // A chord: the second key follows the first.
      ['markdownSplit', 'mac', '⌘K V'],
      ['markdownSplit', 'windows', 'Ctrl+K V'],
    ];
    for (const [id, platform, hint] of cases) {
      // Act + Assert
      expect(shortcuts.hint(/** @type {any} */ (id), /** @type {any} */ (platform)), `${id} on ${platform}`).to.equal(hint);
    }
  });

  it('writes aria-keyshortcuts with the modifier the platform really uses', () => {
    const cases = [
      ['save', 'mac', 'Meta+S'],
      ['save', 'windows', 'Control+S'],
      ['toggleSessionView', 'mac', 'Meta+Shift+T'],
      ['toggleSessionView', 'linux', 'Control+Shift+T'],
      ['newTerminal', 'mac', 'Control+`'],
      ['wholeWord', 'mac', 'Alt+W'],
    ];
    for (const [id, platform, value] of cases) {
      // Act + Assert
      expect(shortcuts.aria(/** @type {any} */ (id), /** @type {any} */ (platform)), `${id} on ${platform}`).to.equal(value);
    }
  });

  it('adds a hint to a label', () => {
    // Act + Assert
    expect(shortcuts.labelled('Search', 'searchInFiles', 'mac')).to.equal('Search (⇧⌘F)');
    expect(shortcuts.labelled('Match case', 'matchCase', 'windows')).to.equal('Match case (Alt+C)');
    // A family of shortcuts that differ in their key
    expect(shortcuts.group(['matchCase', 'wholeWord', 'regex'], 'windows')).to.equal('Alt+C/W/R');
    expect(shortcuts.group(['matchCase', 'wholeWord', 'regex'], 'mac')).to.equal('⌥C/W/R');
  });
});
