import { expect, it } from 'vitest';
import { profileFor } from '../../../shared/adaptation.js';
import { ADAPTIVE, QUALITY_OPTIONS, qualityMarkup } from './quality-options.js';

it('only offers choices that the profile lookup actually understands', () => {
  expect(QUALITY_OPTIONS.length).toBeGreaterThan(1);
  for (const { value } of QUALITY_OPTIONS) {
    if (value === ADAPTIVE) continue;
    expect(profileFor(value).name).toBe(value);
  }
});

it('does not fall back to a default profile for a mislabelled option', () => {
  // profileFor() silently returns the first profile for an unknown name, so the
  // option values are what has to be checked, not the lookup result.
  expect(profileFor('nao-existe').name).toBe('720p30');
  expect(QUALITY_OPTIONS.map(({ value }) => value)).not.toContain('nao-existe');
});

it('renders every option into the selector markup', () => {
  const markup = qualityMarkup();
  for (const { value } of QUALITY_OPTIONS) expect(markup).toContain(`value="${value}"`);
});
