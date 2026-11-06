import { expect } from '@esm-bundle/chai';
import { codeOf } from '../keys.js';
import { shortcuts } from '../shortcuts.js';

/**
 * A keydown's keys and modifiers; every modifier up unless given.
 * @param {string} key
 * @param {string} code
 * @param {Partial<{ metaKey: boolean, ctrlKey: boolean, altKey: boolean, shiftKey: boolean }>} [mods]
 */
const press = (key, code, mods = {}) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe('shortcuts', () => {
  it('writes each hint the way its platform does', () => {
    const cases = [
      // [id, platform, hint]
      ['searchInFiles', 'mac', '⇧⌘F'],
      ['searchInFiles', 'windows', 'Ctrl+Shift+F'],
      ['searchInFiles', 'linux', 'Ctrl+Shift+F'],
      ['quickOpen', 'mac', '⌘P'],
      ['commit', 'mac', '⌘↵'],
      ['commit', 'windows', 'Ctrl+↵'],
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
      ['focusSelectionActions', 'mac', '⌥F10'],
      ['focusSelectionActions', 'linux', 'Alt+F10'],
      // A row per platform
      ['settings', 'mac', '⌘,'],
      ['settings', 'windows', 'Ctrl+,'],
      // Workspaces
      ['openWorkspaces', 'mac', '⇧⌘O'],
      ['openWorkspaces', 'linux', 'Ctrl+Shift+O'],
      ['workspace1', 'mac', '⌥⌘1'],
      ['workspace9', 'windows', 'Ctrl+Shift+9'],
      ['nextWaitingWorkspace', 'mac', '⇧⌘J'],
      ['nextWaitingWorkspace', 'windows', 'Ctrl+Shift+J'],
      ['newWorkspace', 'mac', '⌘N'],
      ['newWorkspace', 'linux', 'Ctrl+N'],
      ['newChat', 'mac', '⇧⌘N'],
      ['newChat', 'windows', 'Ctrl+Shift+N'],
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
      ['focusSelectionActions', 'mac', 'Alt+F10'],
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

  it('matches a key by its letter when Latin, else by position, with exactly the modifiers asked', () => {
    const meta = { metaKey: true };
    const ctrl = { ctrlKey: true };
    const cases = [
      // [id, platform, event, matches, why]
      ['quickOpen', 'mac', press('p', 'KeyP', meta), true, 'Mod is ⌘ on macOS'],
      ['quickOpen', 'mac', press('p', 'KeyP', ctrl), false, '⌃ is not Mod on macOS'],
      ['quickOpen', 'mac', press('p', 'KeyP', { ...meta, ...ctrl }), false, 'an extra ⌃'],
      ['quickOpen', 'windows', press('p', 'KeyP', ctrl), true, 'Mod is Ctrl on Windows'],
      ['quickOpen', 'linux', press('p', 'KeyP', ctrl), true, 'Mod is Ctrl on Linux'],
      ['quickOpen', 'windows', press('p', 'KeyP', meta), false, 'the Windows key is not Mod'],
      ['quickOpen', 'linux', press('p', 'KeyP', { ...meta, ...ctrl }), false, 'Super held with Ctrl'],
      ['quickOpen', 'mac', press('P', 'KeyP', { ...meta, shiftKey: true }), false, 'an extra Shift'],
      ['quickOpen', 'windows', press('з', 'KeyP', ctrl), true, 'a non-Latin layout: by position'],
      ['quickOpen', 'mac', press('p', 'KeyR', meta), true, 'Dvorak: by the letter on the key'],
      ['quickOpen', 'mac', press('r', 'KeyP', meta), false, 'Dvorak: another letter at P'],
      ['searchInFiles', 'linux', press('F', 'KeyF', { ...ctrl, shiftKey: true }), true, 'Shift gives an upper-case key'],
      ['wholeWord', 'mac', press('∑', 'KeyW', { altKey: true }), true, '⌥ changes the key on macOS'],
      ['wholeWord', 'windows', press('w', 'KeyW', { altKey: true, ctrlKey: true }), false, 'AltGr is Ctrl+Alt'],
      ['newTerminal', 'mac', press('^', 'Backquote', ctrl), true, 'not a letter: by position only'],
      ['newTerminal', 'windows', press('`', 'IntlBackslash', ctrl), false, 'a backquote elsewhere on the board'],
      ['settings', 'mac', press(',', 'Comma', meta), false, 'the native menu has ⌘, on macOS'],
      ['settings', 'windows', press(',', 'Comma', ctrl), true, 'Ctrl+, on Windows'],
    ];
    for (const [id, platform, event, expected, why] of cases) {
      // Act + Assert
      expect(shortcuts.matches(/** @type {any} */ (id), /** @type {any} */ (event), /** @type {any} */ (platform)), `${id} on ${platform}: ${why}`).to.equal(expected);
    }
  });

  it('takes a chord’s second key with or without Mod, not with Shift or Alt', () => {
    const cases = [
      // [event, matches]
      [press('v', 'KeyV'), true],
      [press('v', 'KeyV', { metaKey: true }), true],
      [press('м', 'KeyV'), true],
      [press('V', 'KeyV', { shiftKey: true }), false],
      [press('√', 'KeyV', { altKey: true }), false],
      [press('x', 'KeyX'), false],
    ];
    for (const [event, expected] of cases) {
      // Act + Assert
      expect(shortcuts.matchesThen('markdownSplit', /** @type {any} */ (event), 'mac'), JSON.stringify(event)).to.equal(expected);
    }
    expect(shortcuts.matchesThen('quickOpen', press('v', 'KeyV'), 'mac'), 'not a chord').to.equal(false);
  });

  it('keeps every first stroke named, unique and off the combos the OS, the menu or the terminal need', () => {
    /** @type {Record<string, [RegExp, string, string?][]>} Hints no row may take on each platform, with why (and the one row allowed). */
    const reserved = {
      mac: [
        [/^(⌘Q|⌘H|⌥⌘H|⌘W|⌥⌘W|⌘M|⌃⌘F)$/, 'the default menu: quit, hide, close, minimize, full screen'],
        [/^(⌘Z|⇧⌘Z|⌘X|⌘C|⌘V|⌘A)$/, 'the Edit menu'],
        [/^⇧⌘[345]$/, 'screenshots'],
      ],
      windows: [],
      linux: [],
    };
    for (const platform of ['windows', 'linux']) {
      reserved[platform] = [
        [/^Ctrl\+[A-EG-JLMQRT-Z]$/, 'the shell’s keys in the terminal (P, O, S, F, K, N are the app’s on purpose)'],
        [/^Ctrl\+Shift\+C$/, 'the terminal’s copy'],
        // Only for a markdown tab, in the main column; no terminal has the focus then.
        [/^Ctrl\+Shift\+V$/, 'the terminal’s paste', 'markdownPreview'],
        [/^Ctrl\+Alt\+/, 'AltGr on Windows; GNOME’s Ctrl+Alt+T and Ctrl+Alt+arrows'],
        [/^Alt\+F4$/, 'closes the window'],
      ];
    }
    for (const platform of /** @type {const} */ (['mac', 'windows', 'linux'])) {
      /** @type {Map<string, string>} */
      const taken = new Map();
      for (const id of shortcuts.ids) {
        // Act
        const [first, then] = shortcuts.hint(id, platform).split(' ');
        const key = platform === 'mac' ? first.replace(/^[⌃⌥⇧⌘]+/, '') : first.split('+').pop();
        // Assert
        const where = `${id} (${first}) on ${platform}`;
        expect(codeOf(/** @type {string} */ (key)), `${where}: its key has a code`).to.not.equal(null);
        if (then) expect(codeOf(then), `${where}: its second key has a code`).to.not.equal(null);
        expect(taken.get(first), `${where}: taken by another row`).to.equal(undefined);
        taken.set(first, id);
        for (const [combo, why, allowed] of reserved[platform]) {
          if (id !== allowed) expect(combo.test(first), `${where}: ${why}`).to.equal(false);
        }
      }
    }
  });
});
