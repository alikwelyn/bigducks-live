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

  it('enforces viewer limits and removes empty rooms', () => {
    const rooms = new RoomRegistry({ maxViewers: 1 });
    const publisher = rooms.join('a', 'publisher', 'pub');
    rooms.join('a', 'viewer', 'one');
    expect(() => rooms.join('a', 'viewer', 'two')).toThrow(/limit/i);
    rooms.leave(publisher);
    rooms.leave({ id: 'one' });
    expect(rooms.get('a')).toBeUndefined();
  });
});
