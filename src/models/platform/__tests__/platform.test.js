import { expect } from '@esm-bundle/chai';
import { platformOf } from '../platform.js';

describe('platformOf', () => {
  it('tells macOS, Windows and Linux apart by the user agent', () => {
    expect(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')).to.equal('mac');
    expect(platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/120.0')).to.equal('windows');
    expect(platformOf('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15')).to.equal('linux');
  });
});
