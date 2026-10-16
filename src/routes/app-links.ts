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
    return context.json({
      applinks: {
        details: [{
          appIDs: config.APPLE_APP_IDS,
          components: [{ '/': '/plaid/*', comment: 'Plaid OAuth return' }],
        }],
      },
    }, 200);
  });

  // Normally iOS hands this address straight to the app. If it opens in a browser instead
  // (the app isn't installed, or the link was opened by hand), say what to do.
  app.get(plaidOAuthPath, (context) => context.html(returnPage, 200));
  app.get(`${plaidOAuthPath}/*`, (context) => context.html(returnPage, 200));
}

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
