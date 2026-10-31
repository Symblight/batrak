import { expect } from '@esm-bundle/chai';
import { imageTypeOf } from '../image-types.js';

describe('imageTypeOf', () => {
  it('names the format and its MIME type by extension, in any case', () => {
    expect(imageTypeOf('/p/a.png')).to.deep.equal({ label: 'PNG', mime: 'image/png' });
    expect(imageTypeOf('/p/b.JPG')).to.deep.equal({ label: 'JPEG', mime: 'image/jpeg' });
    expect(imageTypeOf('/p/c.jpeg')).to.deep.equal({ label: 'JPEG', mime: 'image/jpeg' });
    expect(imageTypeOf('/p/d.svg')).to.deep.equal({ label: 'SVG', mime: 'image/svg+xml' });
    expect(imageTypeOf('/p/e.ico')).to.deep.equal({ label: 'ICO', mime: 'image/x-icon' });
  });

  it('falls back to the extension, with no MIME type, for anything else', () => {
    expect(imageTypeOf('/p/f.heic')).to.deep.equal({ label: 'HEIC', mime: '' });
    expect(imageTypeOf('/p/noext')).to.deep.equal({ label: '', mime: '' });
  });
});
