import { expect, it } from 'vitest';
import { relayEncoderAction } from './relay-audience.js';

it('stops the relay encoder when the last relay viewer leaves', () => {
  expect(relayEncoderAction({ viewers: 0, running: true })).toBe('stop');
  expect(relayEncoderAction({ viewers: 0, starting: true })).toBe('stop');
});

it('starts it again as soon as someone watches through the relay', () => {
  expect(relayEncoderAction({ viewers: 1, running: false })).toBe('start');
  expect(relayEncoderAction({ viewers: 3, starting: false })).toBe('start');
});

it('leaves a working encoder alone and does nothing when there is no audience', () => {
  expect(relayEncoderAction({ viewers: 2, running: true })).toBe('keep');
  expect(relayEncoderAction({ viewers: 0, running: false })).toBe('keep');
  expect(relayEncoderAction({})).toBe('keep');
});
