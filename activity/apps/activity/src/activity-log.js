import { codeLabel } from './diagnostic-code.js';

// Sends the same short code the interface shows to Discord's own Activity log, so
// when someone reports "deu 0x5" there is context on the platform side too.
export function activityLogMessage(code, message) {
  const label = codeLabel(code);
  const text = String(message ?? '').trim();
  if (!label) return text.slice(0, 400);
  return (text ? `${label} ${text}` : label).slice(0, 400);
}

export function reportToActivityLog(sdk, code, message, { level = 'error' } = {}) {
  const text = activityLogMessage(code, message);
  try {
    const result = sdk?.commands?.captureLog?.({ level, message: text });
    void result?.catch?.(() => {});
  } catch { /* logging must never break the stream */ }
  return text;
}
