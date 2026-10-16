import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

describe('Universal Links for the Plaid OAuth return', () => {
  it('serves apple-app-site-association for the configured apps', async () => {
    const response = await createApp().request('/.well-known/apple-app-site-association');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(await response.json()).toEqual({
      applinks: {
        details: [{
          appIDs: ['BH8R3BX5WF.com.stephenwarren.suffice'],
          components: [{ '/': '/plaid/*', comment: 'Plaid OAuth return' }],
        }],
      },
    });
  });

  it('lists several apps from APPLE_APP_IDS', async () => {
    const config = readConfig({ APPLE_APP_IDS: 'BH8R3BX5WF.com.stephenwarren.suffice, BH8R3BX5WF.com.stephenwarren.bigtable' });
    const response = await createApp({ config }).request('/.well-known/apple-app-site-association');
    const body = await response.json() as { applinks: { details: { appIDs: string[] }[] } };
    expect(body.applinks.details[0]?.appIDs).toEqual([
      'BH8R3BX5WF.com.stephenwarren.suffice',
      'BH8R3BX5WF.com.stephenwarren.bigtable',
    ]);
  });

  it('rejects malformed app IDs at startup', () => {
    expect(() => readConfig({ APPLE_APP_IDS: 'com.stephenwarren.suffice' })).toThrow(/APPLE_APP_IDS/);
  });

  it('answers the OAuth return address with a page, without auth', async () => {
    for (const path of ['/plaid/oauth', '/plaid/oauth/anything']) {
      const response = await createApp().request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');
      expect(await response.text()).toContain('Go back to the app');
    }
  });
});
