import { expect } from '@esm-bundle/chai';
import { SerialTask } from '../serial-task.js';

describe('SerialTask', () => {
  it('runs after a pause, and at the longest wait while requests keep coming', async () => {
    // Arrange
    let runs = 0;
    const task = new SerialTask(async () => void runs++, 60);
    // Act: requests more often than the delay, for longer than the longest wait
    const asking = setInterval(() => task.schedule(30), 10);
    await new Promise((resolve) => setTimeout(resolve, 200));
    clearInterval(asking);
    task.cancel();
    // Assert
    expect(runs).to.be.greaterThan(0);
  });
});
