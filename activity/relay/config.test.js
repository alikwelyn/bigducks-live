import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = { SESSION_SECRET: 'test-secret-012345678901234567890123' };

describe('relay configuration', () => {
  it('loads SFU credentials only as a complete pair', () => {
    expect(loadConfig({ ...base, CLOUDFLARE_SFU_APP_ID: 'app', CLOUDFLARE_SFU_APP_SECRET: 'secret' })).toMatchObject({ sfuAppId: 'app', sfuAppSecret: 'secret' });
    expect(() => loadConfig({ ...base, CLOUDFLARE_SFU_APP_ID: 'app' })).toThrow(/SFU_APP_ID.*SFU_APP_SECRET/);
  });
});
