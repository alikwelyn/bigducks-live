import { describe, expect, it } from 'vitest';
import { RoomRegistry } from './rooms.js';

describe('room registry', () => {
  it('isolates rooms and requires explicit watch opt-in', () => {
    const rooms = new RoomRegistry({ maxViewers: 2 });
    const publisher = rooms.join('a', 'publisher', 'pub');
    const viewer = rooms.join('a', 'viewer', 'view');
    rooms.join('b', 'viewer', 'other');
    expect(rooms.viewersFor('a')).toEqual([]);
    rooms.watch('a', 'view', 0);
    expect(rooms.viewersFor('a')).toMatchObject([{ id: 'view', slot: 0 }]);
    expect(rooms.viewersFor('b')).toEqual([]);
    rooms.leave(publisher);
    rooms.leave(viewer);
    expect(rooms.get('a')).toBeUndefined();
  });

  it('allows at most three simultaneous publishers with distinct slots', () => {
    const rooms = new RoomRegistry({ maxPublishers: 3 });
    expect(rooms.join('a', 'publisher', 'one').slot).toBe(0);
    expect(rooms.join('a', 'publisher', 'two').slot).toBe(1);
    expect(rooms.join('a', 'publisher', 'three').slot).toBe(2);
    expect(() => rooms.join('a', 'publisher', 'four')).toThrow(/publisher limit/i);
  });

  it('watches only one stream at a time', () => {
    const rooms = new RoomRegistry();
    rooms.join('a', 'viewer', 'viewer');
    rooms.watch('a', 'viewer', 0);
    rooms.watch('a', 'viewer', 2);
    expect(rooms.viewersFor('a', 0)).toEqual([]);
    expect(rooms.viewersFor('a', 2)).toMatchObject([{ id: 'viewer', slot: 2 }]);
  });

  it('enforces viewer limits and removes empty rooms', () => {
    const rooms = new RoomRegistry({ maxViewers: 1 });
    const publisher = rooms.join('a', 'publisher', 'pub');
    const viewer = rooms.join('a', 'viewer', 'one');
    expect(() => rooms.join('a', 'viewer', 'two')).toThrow(/limit/i);
    rooms.leave(publisher);
    rooms.leave(viewer);
    expect(rooms.get('a')).toBeUndefined();
  });
});
