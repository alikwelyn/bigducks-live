// Source changes keep the published transport, capability and room identity intact.
export function updateStreamSource(member, message) {
  if (member.role !== 'publisher' || !member.stream || message.type !== 'source-update') return null;
  const media = (value) => {
    const result = {};
    for (const key of ['width', 'height', 'fps']) {
      if (Number.isFinite(value?.[key]) && value[key] > 0 && value[key] <= (key === 'fps' ? 240 : 16384)) result[key] = value[key];
    }
    if (typeof value?.codec === 'string' && value.codec.length < 40) result.codec = value.codec;
    if (value?.audioConfig === null) result.audioConfig = null;
    else if (value?.audioConfig?.codec === 'opus') result.audioConfig = { codec: 'opus', sampleRate: 48000, numberOfChannels: value.audioConfig.numberOfChannels === 1 ? 1 : 2 };
    return result;
  };
  const update = { ...media(message), waiting: message.waiting === true };
  // A WebRTC publication must remain WebRTC even when a relay encoder exists.
  delete update.codec;
  if (message.relayMedia) {
    update.relayMedia = media(message.relayMedia);
    if (member.stream.transport !== 'sfu') Object.assign(update, update.relayMedia);
  }
  Object.assign(member.stream, update);
  return { ...update, type: 'source-update', slot: member.slot };
}
