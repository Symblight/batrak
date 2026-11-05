import { expect } from '@esm-bundle/chai';

describe('$project', () => {
  afterEach(() => {
    localStorage.removeItem('brama:workspace');
    localStorage.removeItem('brama:project');
  });

  it('reads the folder stored under the old key once and moves it to brama:project', async () => {
    // Arrange
    localStorage.removeItem('brama:project');
    localStorage.setItem('brama:workspace', JSON.stringify({ path: '/p/app', name: 'app' }));

    // Act: a fresh module instance, as on launch
    const { $project } = await import(`../project.js?launch=${Date.now()}`);

    // Assert
    expect($project.get()).to.deep.equal({ path: '/p/app', name: 'app', rootId: null });
    expect(JSON.parse(localStorage.getItem('brama:project') ?? 'null')).to.deep.equal({ path: '/p/app', name: 'app' });
    expect(localStorage.getItem('brama:workspace'), 'the old key is gone').to.equal(null);
  });
});
