export const PROFILES = [
  { name: '720p30', width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
  { name: '720p60', width: 1280, height: 720, fps: 60, bitrate: 4_000_000 },
  { name: '1080p30', width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 },
  { name: '1080p60', width: 1920, height: 1080, fps: 60, bitrate: 9_000_000 },
];

export function profileFor(name) {
  return PROFILES.find((profile) => profile.name === name) ?? PROFILES[0];
}

export function chooseAdaptiveProfile(current, { loss = 0, rtt = 0, encodeQueue = 0, healthyForMs = 0 } = {}) {
  const index = Math.max(0, PROFILES.findIndex((profile) => profile.name === current));
  const unhealthy = loss >= 0.08 || rtt >= 350 || encodeQueue >= 2;
  if (unhealthy) {
    const severe = loss >= 0.1 || rtt >= 500 || encodeQueue >= 3;
    return PROFILES[Math.max(0, index - (severe ? 2 : 1))].name;
  }
  if (healthyForMs >= 10_000 && loss < 0.02 && rtt < 180 && encodeQueue === 0) return PROFILES[Math.min(PROFILES.length - 1, index + 1)].name;
  return PROFILES[index].name;
}
