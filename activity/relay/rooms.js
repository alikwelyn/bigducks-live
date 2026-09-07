export class RoomRegistry {
  constructor({ maxViewers = 25, maxPublishers = 3 } = {}) {
    this.rooms = new Map();
    this.maxViewers = maxViewers;
    this.maxPublishers = maxPublishers;
  }

  get(id) { return this.rooms.get(id); }

  join(roomId, role, id, socket = null, name = '') {
    if (!roomId || !id || !['publisher', 'viewer'].includes(role)) throw new Error('invalid room member');
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { id: roomId, publishers: new Map(), viewers: new Map() };
      this.rooms.set(roomId, room);
    }
    if (role === 'publisher') {
      const existing = room.publishers.get(id);
      if (existing) { existing.socket = socket; return existing; }
      if (room.publishers.size >= this.maxPublishers) throw new Error('publisher limit reached');
      const used = new Set([...room.publishers.values()].map((publisher) => publisher.slot));
      const slot = Array.from({ length: this.maxPublishers }, (_, index) => index).find((candidate) => !used.has(candidate));
      const publisher = { id, role, name: name || id, socket, slot, stream: null };
      room.publishers.set(id, publisher);
      return publisher;
    }
    if (room.viewers.size >= this.maxViewers && !room.viewers.has(id)) throw new Error('viewer limit reached');
    const viewer = room.viewers.get(id) ?? { id, role, socket, watched: new Set() };
    viewer.socket = socket;
    room.viewers.set(id, viewer);
    return viewer;
  }

  publisherForSlot(roomId, slot) {
    return [...(this.rooms.get(roomId)?.publishers.values() ?? [])].find((publisher) => publisher.slot === slot);
  }

  watch(roomId, viewerId, slot) {
    const room = this.rooms.get(roomId);
    const viewer = room?.viewers.get(viewerId);
    if (!viewer || !Number.isInteger(slot) || slot < 0 || slot > 255) throw new Error('invalid viewer or slot');
    viewer.watched.clear();
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
      if (member.role === 'publisher') room.publishers.delete(member.id);
      if (member.role === 'viewer') room.viewers.delete(member.id);
      if (room.publishers.size === 0 && room.viewers.size === 0) this.rooms.delete(roomId);
    }
  }
}
