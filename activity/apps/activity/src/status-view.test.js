import { expect, it, vi } from 'vitest';
import { createStatusView } from './status-view.js';

const element = () => ({ textContent: '', dataset: {}, setAttribute: vi.fn() });

it('announces changes and exposes the state for styling', () => {
  const node = element();
  const status = createStatusView(node);
  expect(node.setAttribute).toHaveBeenCalledWith('role', 'status');
  expect(node.setAttribute).toHaveBeenCalledWith('aria-live', 'polite');
  status.set('Conectando…');
  expect(node.textContent).toBe('Conectando…');
  expect(node.dataset.state).toBe('info');
  status.set('Falhou', 'error');
  expect(node.dataset.state).toBe('error');
  expect(status.state).toBe('error');
});

it('refuses to be built without an element instead of failing later', () => {
  expect(() => createStatusView(null)).toThrow(/status element/i);
});
