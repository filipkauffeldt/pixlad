import { describe, expect, it } from 'vitest';
import { PhotoQueue } from '../src/main/photo-queue';

function setup(ids: string[] = ['a', 'b']) {
  const photos = new Map(ids.map((id) => [id, { path: `/photos/${id}.jpg` }]));
  const opened: string[] = [];
  const queue = new PhotoQueue(
    (id) => photos.get(id),
    async (path) => {
      opened.push(path);
    },
  );
  return { queue, photos, opened };
}

function deferred() {
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  return { done, release };
}

describe('PhotoQueue', () => {
  it('runs jobs one after another, in the order they were queued', async () => {
    const { queue } = setup();
    const log: string[] = [];
    const gate = deferred();
    queue.want('a');
    const first = queue.run('a', async () => {
      log.push('first starts');
      await gate.done;
      log.push('first ends');
    });
    const second = queue.run('a', async () => {
      log.push('second');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['first starts']);
    gate.release();
    await Promise.all([first, second]);
    expect(log).toEqual(['first starts', 'first ends', 'second']);
  });

  it('returns what the job returns', async () => {
    const { queue } = setup();
    queue.want('a');
    await expect(queue.run('a', async () => 42)).resolves.toBe(42);
  });

  it('rejects a job for a photo that a later want superseded, without opening it', async () => {
    const { queue, opened } = setup();
    const gate = deferred();
    queue.want('a');
    const a = queue.run('a', () => gate.done);
    queue.want('b');
    const b = queue.run('b', async () => 'b');
    queue.want('a');
    gate.release();
    await a;
    await expect(b).rejects.toThrow('another photo was opened meanwhile');
    expect(opened).toEqual(['/photos/a.jpg']);
  });

  it('opens the photo in the worker only when the open photo changes', async () => {
    const { queue, opened } = setup();
    queue.want('a');
    await queue.run('a', async () => undefined);
    await queue.run('a', async () => undefined);
    queue.want('b');
    await queue.run('b', async () => undefined);
    await queue.run('b', async () => undefined);
    queue.want('a');
    await queue.run('a', async () => undefined);
    expect(opened).toEqual(['/photos/a.jpg', '/photos/b.jpg', '/photos/a.jpg']);
  });

  it('opens the photo again after it was invalidated', async () => {
    const { queue, opened } = setup();
    queue.want('a');
    await queue.run('a', async () => undefined);
    queue.invalidate('b');
    await queue.run('a', async () => undefined);
    expect(opened).toHaveLength(1);
    queue.invalidate('a');
    await queue.run('a', async () => undefined);
    expect(opened).toEqual(['/photos/a.jpg', '/photos/a.jpg']);
  });

  it('does not let a rejected job block the next one', async () => {
    const { queue } = setup();
    queue.want('a');
    const failing = queue.run('a', async () => {
      throw new Error('boom');
    });
    const next = queue.run('a', async () => 'fine');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('fine');
  });

  it('does not let a failed open block the next job', async () => {
    const photos = new Map([['a', { path: '/photos/a.jpg' }]]);
    let attempts = 0;
    const queue = new PhotoQueue(
      (id) => photos.get(id),
      async () => {
        if (++attempts === 1) throw new Error('cannot decode');
      },
    );
    queue.want('a');
    await expect(queue.run('a', async () => 'x')).rejects.toThrow('cannot decode');
    await expect(queue.run('a', async () => 'y')).resolves.toBe('y');
    expect(attempts).toBe(2);
  });

  it('rejects a photo that is no longer in the session', async () => {
    const { queue, photos, opened } = setup();
    queue.want('a');
    photos.delete('a');
    await expect(queue.run('a', async () => 'x')).rejects.toThrow(
      'that photo is no longer in the session',
    );
    expect(opened).toEqual([]);
  });
});
