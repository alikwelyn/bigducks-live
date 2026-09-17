import { expect, it, vi } from 'vitest';
import { applyVersion, fetchVersion } from './app-version.js';

const root = (nodes) => ({ querySelectorAll: () => nodes });

it('writes the same label to every version slot', () => {
  const nodes = [{ textContent: '' }, { textContent: '' }];
  expect(applyVersion(root(nodes), '0.1.8')).toBe('v0.1.8');
  expect(nodes.map((node) => node.textContent)).toEqual(['v0.1.8', 'v0.1.8']);
});

it('leaves the labels empty when the server has no version to give', () => {
  const nodes = [{ textContent: 'v0.0.0' }];
  expect(applyVersion(root(nodes), '')).toBe('');
  expect(nodes[0].textContent).toBe('');
  expect(() => applyVersion(null, '1.0.0')).not.toThrow();
});

it('never fails the page because the version is unavailable', async () => {
  expect(await fetchVersion({ fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) })).toBe('');
  expect(await fetchVersion({ fetchImpl: vi.fn().mockResolvedValue(new Response('{}', { status: 500 })) })).toBe('');
  expect(await fetchVersion({ fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 })) })).toBe('1.2.3');
});
