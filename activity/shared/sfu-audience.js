// Kept separate from relay subscriptions so SFU viewers never receive duplicate media.
export function updateSfuAudience(member, control) {
  if (member.role !== 'viewer') return false;
  if (control.type === 'sfu-watch') {
    if (!Number.isInteger(control.slot) || control.slot < 0 || control.slot > 255) throw new Error('invalid stream slot');
    member.sfuSlot = control.slot;
    return true;
  }
  if ((control.type === 'unwatch' && member.sfuSlot === control.slot) || ['watch', 'fallback-want'].includes(control.type)) {
    member.sfuSlot = null;
    return true;
  }
  return false;
}

export function updateAudience(member, control) {
  const sfuChanged = updateSfuAudience(member, control);
  if (member.role !== 'viewer') return false;
  if (['sfu-watch', 'watch', 'fallback-want', 'rtc-want'].includes(control.type)) {
    if (!Number.isInteger(control.slot) || control.slot < 0 || control.slot > 255) throw new Error('invalid stream slot');
    member.audienceSlot = control.slot;
    return true;
  }
  if (control.type === 'unwatch' && member.audienceSlot === control.slot) {
    member.audienceSlot = null;
    return true;
  }
  return sfuChanged;
}

export function audienceFor(members, slot) {
  const unique = new Map();
  for (const member of members) {
    if (member.audienceSlot !== slot) continue;
    const id = member.user || member.id;
    unique.set(id, { id, name: member.name || id, avatar: member.avatar || '' });
  }
  return [...unique.values()];
}

export function clearAudience(member, slot) {
  if (member.audienceSlot === slot) member.audienceSlot = null;
  if (member.sfuSlot === slot) member.sfuSlot = null;
}
