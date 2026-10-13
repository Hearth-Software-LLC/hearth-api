import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const server = serve({ fetch: createApp().fetch, hostname: '127.0.0.1', port }, (info) => {
  console.info(`Lifestyle API listening at http://127.0.0.1:${info.port}`);
});

process.once('SIGINT', () => server.close());
process.once('SIGTERM', () => server.close());