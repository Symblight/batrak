import { expect } from '@esm-bundle/chai';
import { Bytes } from '../bytes.js';

describe('Bytes', () => {
  it('coerces to the plain number for comparisons', () => {
    const maxUpload = 1024;
    expect(Number(new Bytes(2048)) > maxUpload).to.equal(true);
    expect(+new Bytes(512)).to.equal(512);
  });

  it('coerces to a formatted string for display', () => {
    expect(`${new Bytes(512)}`).to.equal('512.0 B');
    expect(`${new Bytes(1536)}`).to.equal('1.5 KB');
    expect(`${new Bytes(5 * 1024 ** 2)}`).to.equal('5.0 MB');
  });

  it('stops at GB', () => {
    expect(`${new Bytes(2048 * 1024 ** 3)}`).to.equal('2048.0 GB');
  });

  it('is equal by value', () => {
    expect(new Bytes(10).equals(new Bytes(10))).to.equal(true);
    expect(new Bytes(10).equals(new Bytes(11))).to.equal(false);
  });
});
