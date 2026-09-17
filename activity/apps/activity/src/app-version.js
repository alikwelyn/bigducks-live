// One place that fills every version label, so the value always comes from the
// running server instead of drifting between builds.
export function applyVersion(root, version) {
  const label = typeof version === 'string' && version ? `v${version.replace(/^v/, '')}` : '';
  const nodes = root?.querySelectorAll?.('[data-app-version]') ?? [];
  for (const node of nodes) node.textContent = label;
  return label;
}

export async function fetchVersion({ fetchImpl = globalThis.fetch, apiBase = '' } = {}) {
  try {
    const response = await fetchImpl(`${apiBase}/api/config`);
    if (!response.ok) return '';
    return String((await response.json())?.version || '');
  } catch { return ''; }
}
