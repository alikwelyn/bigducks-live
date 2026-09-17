import { expect, it, vi } from 'vitest';
import { activityLogMessage, reportToActivityLog } from './activity-log.js';

it('prefixes the message with the code the interface shows', () => {
  expect(activityLogMessage(0x5, 'relay parou de entregar quadros')).toBe('0x5 relay parou de entregar quadros');
  expect(activityLogMessage(undefined, 'sem codigo')).toBe('sem codigo');
  expect(activityLogMessage(0xc, '')).toBe('0xC');
  expect(activityLogMessage(0x1, 'x'.repeat(500)).length).toBe(400);
});

it('reports to Discord and never lets logging break the app', () => {
  const captureLog = vi.fn().mockResolvedValue(null);
  reportToActivityLog({ commands: { captureLog } }, 0x3, 'SFU não conectou');
  expect(captureLog).toHaveBeenCalledWith({ level: 'error', message: '0x3 SFU não conectou' });
  const throwing = vi.fn(() => { throw new Error('rpc down'); });
  expect(() => reportToActivityLog({ commands: { captureLog: throwing } }, 0x3, 'x')).not.toThrow();
  expect(() => reportToActivityLog(null, 0x3, 'x')).not.toThrow();
  const rejecting = vi.fn().mockRejectedValue(new Error('rpc down'));
  expect(() => reportToActivityLog({ commands: { captureLog: rejecting } }, 0x3, 'x')).not.toThrow();
});
