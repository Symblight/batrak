import { expect } from '@esm-bundle/chai';
import { imageType } from '../image-type.js';

describe('imageType.of', () => {
  it('names the format and its MIME type by extension, in any case', () => {
    expect(imageType.of('/p/a.png')).to.deep.equal({ label: 'PNG', mime: 'image/png' });
    expect(imageType.of('/p/b.JPG')).to.deep.equal({ label: 'JPEG', mime: 'image/jpeg' });
    expect(imageType.of('/p/c.jpeg')).to.deep.equal({ label: 'JPEG', mime: 'image/jpeg' });
    expect(imageType.of('/p/d.svg')).to.deep.equal({ label: 'SVG', mime: 'image/svg+xml' });
    expect(imageType.of('/p/e.ico')).to.deep.equal({ label: 'ICO', mime: 'image/x-icon' });
  });

  it('falls back to the extension, with no MIME type, for anything else', () => {
    expect(imageType.of('/p/f.heic')).to.deep.equal({ label: 'HEIC', mime: '' });
    expect(imageType.of('/p/noext')).to.deep.equal({ label: '', mime: '' });
  });
});
