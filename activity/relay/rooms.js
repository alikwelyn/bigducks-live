export class RoomRegistry {
  constructor({ maxViewers = 25 } = {}) {
    this.rooms = new Map();
    this.maxViewers = maxViewers;
  }

  get(id) { return this.rooms.get(id); }

  join(roomId, role, id, socket = null) {
    if (!roomId || !id || !['publisher', 'viewer'].includes(role)) throw new Error('invalid room member');
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { id: roomId, publisher: null, viewers: new Map() };
      this.rooms.set(roomId, room);
    }
    if (role === 'publisher') {
      if (room.publisher && room.publisher.id !== id) throw new Error('room already has a publisher');
      room.publisher = { id, socket };
      return room.publisher;
    }
    if (room.viewers.size >= this.maxViewers && !room.viewers.has(id)) throw new Error('viewer limit reached');
    const viewer = room.viewers.get(id) ?? { id, socket, watched: new Set() };
    viewer.socket = socket;
    room.viewers.set(id, viewer);
    return viewer;
  }

  watch(roomId, viewerId, slot) {
    const room = this.rooms.get(roomId);
    const viewer = room?.viewers.get(viewerId);
    if (!viewer || !Number.isInteger(slot) || slot < 0 || slot > 255) throw new Error('invalid viewer or slot');
    viewer.watched.add(slot);
  }

  unwatch(roomId, viewerId, slot) {
    this.rooms.get(roomId)?.viewers.get(viewerId)?.watched.delete(slot);
  }

  viewersFor(roomId, slot = null) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.viewers.values()]
      .filter((viewer) => slot === null ? viewer.watched.size > 0 : viewer.watched.has(slot))
      .map(({ id, socket, watched }) => ({ id, socket, slot: slot === null ? [...watched][0] : slot }));
  }

  leave(member) {
    for (const [roomId, room] of this.rooms) {
      if (room.publisher?.id === member.id) room.publisher = null;
      room.viewers.delete(member.id);
      if (!room.publisher && room.viewers.size === 0) this.rooms.delete(roomId);
    }
  }
}
