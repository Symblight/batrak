import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect } from '@esm-bundle/chai';
import { agentsMd } from '../agents-md.js';

describe('agentsMd', () => {
  afterEach(() => clearMocks());

  it('asks the backend about the root and passes on its answer', async () => {
    for (const answer of [true, false]) {
      // Arrange
      /** @type {{ cmd: string, args: unknown }[]} */
      const calls = [];
      mockIPC((cmd, args) => {
        calls.push({ cmd, args });
        return answer;
      });
      // Act
      const needed = await agentsMd.needed('root-1');
      // Assert
      expect(needed).to.equal(answer);
      expect(calls).to.deep.equal([{ cmd: 'needs_agents_md', args: { rootId: 'root-1' } }]);
    }
  });
});
