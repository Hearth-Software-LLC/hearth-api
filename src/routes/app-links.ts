import type { OpenAPIHono } from '@hono/zod-openapi';
import type { ApiEnvironment } from '../contracts/common.js';
import type { Config } from '../config.js';

/** Where Plaid sends people back after a bank's own sign-in page (OAuth banks such as Chase). */
export const plaidOAuthPath = '/plaid/oauth';

/**
 * Universal Links for the Hearth iOS apps on this domain.
 *
 * Plaid's iOS SDK needs `PLAID_REDIRECT_URI` to be an HTTPS Universal Link for OAuth banks:
 * after the bank's sign-in, iOS opens the app at that address instead of Safari, and Link picks
 * up where it left off. iOS learns which app owns the address from the
 * `apple-app-site-association` file served here, which must be plain JSON over HTTPS with no
 * redirects. Apps opt in with an `applinks:<this domain>` Associated Domains entitlement.
 */
export function registerAppLinks(app: OpenAPIHono<ApiEnvironment>, config: Config) {
  app.get('/.well-known/apple-app-site-association', (context) => {
    if (config.APPLE_APP_IDS.length === 0) return context.notFound();
    context.header('Cache-Control', 'public, max-age=3600');
    const hearken = config.APPLE_APP_IDS.filter((id) => id.endsWith('.hearken'));
    const suffice = config.APPLE_APP_IDS.filter((id) => id.endsWith('.suffice'));
    return context.json({
      applinks: {
        details: [
          {
            appIDs: config.APPLE_APP_IDS,
            components: [{ '/': '/plaid/*', comment: 'Plaid OAuth return' }],
          },
          ...(hearken.length > 0 ? [{
            appIDs: hearken,
            components: [{ '/': '/hearken/join/*', comment: 'Hearken study group invites' }],
          }] : []),
          ...(suffice.length > 0 ? [{
            appIDs: suffice,
            components: [{ '/': '/suffice/join/*', comment: 'Suffice group budget invites' }],
          }] : []),
          // Each app opens the household invitations made in it (all the apps share one iCloud
          // container, so iOS would otherwise pick any of them for the iCloud link).
          ...config.APPLE_APP_IDS.flatMap((id) => {
            const name = householdAppName(id);
            return name ? [{
              appIDs: [id],
              components: [{ '/': `/${name}/household/*`, comment: `Household invitations made in ${name}` }],
            }] : [];
          }),
        ],
      },
    }, 200);
  });

  // Normally iOS hands this address straight to the app. If it opens in a browser instead
  // (the app isn't installed, or the link was opened by hand), say what to do.
  app.get(plaidOAuthPath, (context) => context.html(returnPage, 200));
  app.get(`${plaidOAuthPath}/*`, (context) => context.html(returnPage, 200));

  // A household invitation opened where the app it came from isn't installed (or in a
  // browser): pass them on to the iCloud invitation inside it, which any Hearth app opens.
  app.get('/:app/household/join', (context) => {
    const app = context.req.param('app');
    if (!householdApps.includes(app)) return context.notFound();
    const share = iCloudShareLink(context.req.query('share'));
    context.header('Cache-Control', 'no-store');
    return context.html(householdPage(appNames[app] ?? 'Hearth', share), 200);
  });
}

/** The Hearth apps whose household invitations open through this domain. */
export const householdApps = ['bigtable', 'caloma', 'hearken', 'sated', 'suffice', 'trove'];

const appNames: Record<string, string> = {
  bigtable: 'BigTable', caloma: 'Caloma', hearken: 'Hearken', sated: 'Sated', suffice: 'Suffice', trove: 'Trove',
};

/** "caloma" for "TEAMID.com.stephenwarren.caloma", when it's a Hearth app. */
export function householdAppName(appID: string): string | undefined {
  const name = appID.split('.').pop()?.toLowerCase();
  return name && householdApps.includes(name) ? name : undefined;
}

/** The invitation's iCloud link, only when it is one (never a redirect to anywhere else). */
export function iCloudShareLink(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const isICloud = host === 'icloud.com' || host.endsWith('.icloud.com');
    return url.protocol === 'https:' && isICloud && url.pathname.startsWith('/share/') ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const escapeHTML = (value: string) => value.replace(/[&<>"']/g, (character) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character
));

const householdPage = (appName: string, share: string | undefined) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join a household on Hearth</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 17px -apple-system, system-ui, sans-serif; margin: 0; min-height: 100vh;
         display: grid; place-items: center; text-align: center; padding: 24px; box-sizing: border-box; }
  h1 { font-size: 24px; margin: 0 0 8px; }
  p { margin: 0 auto 20px; opacity: 0.75; max-width: 22rem; }
  a.button { display: inline-block; padding: 14px 26px; border-radius: 999px; background: #E0284F;
             color: white; font-weight: 600; text-decoration: none; }
</style>
</head>
<body>
<main>
<h1>You're invited to join a household</h1>
${share
    ? `<p>Open this on the iPhone or iPad you use with Hearth. Without ${escapeHTML(appName)}, any Hearth app can take the invitation.</p>
<a class="button" href="${escapeHTML(share)}">Open the Invitation</a>`
    : `<p>This invitation link isn't complete. Ask whoever sent it for a new one.</p>`}
</main>
</body>
</html>`;

const returnPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Back to your app</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 17px -apple-system, system-ui, sans-serif; margin: 0; min-height: 100vh;
         display: grid; place-items: center; text-align: center; padding: 24px; box-sizing: border-box; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { margin: 0; opacity: 0.7; max-width: 22rem; }
</style>
</head>
<body>
<main>
<h1>You're signed in to your bank</h1>
<p>Go back to the app to finish connecting your account.</p>
</main>
</body>
</html>`;
