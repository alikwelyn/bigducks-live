import { PROFILES } from '../../../shared/adaptation.js';

// Single source of truth for the capture page's quality selector. The value has
// to be either 'adaptive' or a profile name, and a test enforces that so a label
// can never drift away from what profileFor actually accepts.
export const ADAPTIVE = 'adaptive';

export const QUALITY_OPTIONS = [
  { value: ADAPTIVE, label: 'Automático — recomendado' },
  ...PROFILES.map((profile) => ({ value: profile.name, label: `${profile.height}p / ${profile.fps} FPS${profile.name === '720p30' ? ' (recomendado)' : ''}` })),
];

export function qualityMarkup() {
  return QUALITY_OPTIONS.map(({ value, label }) => `<option value="${value}">${label}</option>`).join('');
}
