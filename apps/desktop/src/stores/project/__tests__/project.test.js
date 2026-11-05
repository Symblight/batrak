import { expect } from '@esm-bundle/chai';

describe('$project', () => {
  afterEach(() => {
    localStorage.removeItem('batrak:workspace');
    localStorage.removeItem('batrak:project');
  });

  it('reads the folder stored under the old key once and moves it to batrak:project', async () => {
    // Arrange
    localStorage.removeItem('batrak:project');
    localStorage.setItem('batrak:workspace', JSON.stringify({ path: '/p/app', name: 'app' }));

    // Act: a fresh module instance, as on launch
    const { $project } = await import(`../project.js?launch=${Date.now()}`);

    // Assert
    expect($project.get()).to.deep.equal({ path: '/p/app', name: 'app', rootId: null });
    expect(JSON.parse(localStorage.getItem('batrak:project') ?? 'null')).to.deep.equal({ path: '/p/app', name: 'app' });
    expect(localStorage.getItem('batrak:workspace'), 'the old key is gone').to.equal(null);
  });
});
