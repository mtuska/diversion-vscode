import { describe, it, expect } from 'vitest';
import { Semaphore } from '../../src/util/semaphore.js';

describe('Semaphore', () => {
  it('caps concurrent runs at the configured capacity', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;

    const work = (ms: number) => sem.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
    });

    await Promise.all([work(20), work(20), work(20), work(20), work(20)]);
    expect(peak).toBe(2);
  });

  it('drains the queue when capacity is increased mid-flight', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 4; i++) {
      tasks.push(sem.run(async () => {
        order.push(i);
        await new Promise((r) => setTimeout(r, 10));
      }));
    }
    // Bumping capacity should let queued tasks fan out instead of running 1×1.
    sem.setCapacity(4);
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3]);
    const stats = sem.stats();
    expect(stats.inFlight).toBe(0);
    expect(stats.queued).toBe(0);
  });

  it('releases the slot if the wrapped fn throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // Next call must run, proving the slot was released.
    const v = await sem.run(async () => 42);
    expect(v).toBe(42);
  });
});
