// Discord hands the Activity the voice channel it is running in, including who is
// actually connected. That is real presence without a bot — it comes from the
// client, so it is for the interface, not for authorisation.
export function rosterNames(voiceStates = []) {
  if (!Array.isArray(voiceStates)) return [];
  const names = [];
  for (const state of voiceStates) {
    const name = state?.nick || state?.user?.global_name || state?.user?.username || state?.user?.id;
    if (typeof name === 'string' && name.trim()) names.push(name.trim());
  }
  return names;
}

export function rosterText(voiceStates = [], max = 6) {
  const names = rosterNames(voiceStates);
  if (!names.length) return '';
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return `No canal (${names.length}): ${shown.join(', ')}${rest > 0 ? ` +${rest}` : ''}`;
}

export async function watchRoster({ sdk, onChange = () => {}, max = 6, fetchChannel } = {}) {
  const channelId = sdk?.channelId;
  if (!channelId || typeof sdk?.commands?.getChannel !== 'function') return () => {};
  const read = fetchChannel ?? ((id) => sdk.commands.getChannel({ channel_id: id }));
  const refresh = async () => {
    try {
      const channel = await read(channelId);
      onChange(rosterText(channel?.voice_states ?? [], max), channel?.voice_states ?? []);
    } catch { /* keep whatever was shown before */ }
  };
  await refresh();
  const handler = () => { void refresh(); };
  try {
    await sdk.subscribe?.('VOICE_STATE_UPDATE', handler);
  } catch { /* presence is optional; media must not depend on it */ }
  return () => { try { void sdk.unsubscribe?.('VOICE_STATE_UPDATE', handler)?.catch?.(() => {}); } catch { /* already gone */ } };
}
