import { expect } from '@esm-bundle/chai';
import { SerialTask } from '../serial-task.js';

/** A task whose runs end when told to, and the runs it started. */
function heldTask() {
  /** @type {{ isCurrent: () => boolean, finish: () => void }[]} */
  const runs = [];
  const task = new SerialTask((isCurrent) => new Promise((finish) => runs.push({ isCurrent, finish })));
  return { task, runs };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 10));

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

  it('a superseded run is dead: a new one starts beside it, and its end neither frees the new one nor runs it again', async () => {
    // Arrange
    const { task, runs } = heldTask();
    task.run();
    // Act
    task.supersede();
    task.run();
    const startedAtOnce = runs.length;
    const oldIsCurrent = runs[0].isCurrent();
    task.schedule(0);
    await pause();
    runs[0].finish();
    await pause();
    const afterOldEnded = runs.length;
    task.schedule(0);
    await pause();
    const askedWhileNewRuns = runs.length;
    runs[1].finish();
    await pause();
    // Assert
    expect(startedAtOnce).to.equal(2);
    expect(oldIsCurrent).to.equal(false);
    expect(runs[1].isCurrent()).to.equal(true);
    expect(afterOldEnded, 'the old end runs nothing').to.equal(2);
    expect(askedWhileNewRuns, 'the new one still counts as running').to.equal(2);
    expect(runs.length, 'the request waited for the new one').to.equal(3);
  });

  it('superseding drops every pending run and starts none; cancelling leaves a running one current', async () => {
    // Arrange
    const { task, runs } = heldTask();
    task.run();
    task.schedule(0);
    await pause();
    task.schedule(0);
    // Act
    task.cancel();
    const currentAfterCancel = runs[0].isCurrent();
    task.schedule(0);
    await pause();
    task.schedule(0);
    task.supersede();
    runs[0].finish();
    await pause();
    // Assert
    expect(currentAfterCancel).to.equal(true);
    expect(runs.length).to.equal(1);
    expect(runs[0].isCurrent()).to.equal(false);
  });
});
