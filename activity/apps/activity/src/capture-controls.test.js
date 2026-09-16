import { expect, it } from 'vitest';
import { applyCaptureControls, DEFAULT_AUDIO_TITLE, LIVE_AUDIO_TITLE } from './capture-controls.js';

const element = (extra = {}) => ({ hidden: false, disabled: false, textContent: '', title: '', ...extra });
const controls = () => ({ start: element(), stop: element(), switch: element(), audio: element({ title: DEFAULT_AUDIO_TITLE }) });

it('makes the audio choice read as fixed while a live is running', () => {
  const value = controls();
  applyCaptureControls(value, { live: true });
  expect(value.start.hidden).toBe(true);
  expect(value.stop.hidden).toBe(false);
  expect(value.switch.hidden).toBe(false);
  expect(value.audio.disabled).toBe(true);
  expect(value.audio.title).toBe(LIVE_AUDIO_TITLE);
  expect(value.audio.title).toMatch(/encerre a transmissão/i);
});

it('restores every control when the live stops', () => {
  const value = controls();
  applyCaptureControls(value, { live: true });
  applyCaptureControls(value, { live: false });
  expect(value.start.hidden).toBe(false);
  expect(value.start.disabled).toBe(false);
  expect(value.stop.hidden).toBe(true);
  expect(value.switch.hidden).toBe(true);
  expect(value.audio.disabled).toBe(false);
  expect(value.audio.title).toBe(DEFAULT_AUDIO_TITLE);
});

it('locks only the source switch while a capture change is being applied', () => {
  const value = controls();
  applyCaptureControls(value, { live: true, switching: true });
  expect(value.switch.disabled).toBe(true);
  expect(value.stop.disabled).toBe(false);
  applyCaptureControls(value, { live: true, switching: false });
  expect(value.switch.disabled).toBe(false);
});

it('keeps the start button disabled while a start is still in flight', () => {
  const value = controls();
  applyCaptureControls(value, { live: false, starting: true });
  expect(value.start.disabled).toBe(true);
  expect(value.start.hidden).toBe(false);
  expect(value.audio.disabled).toBe(false);
});
