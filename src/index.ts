import { Hono } from 'hono';
import { createApp } from './app.js';

const app = new Hono().mount('/', createApp().fetch);

export default app;