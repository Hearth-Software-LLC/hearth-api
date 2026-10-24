import { createHash } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Sql } from 'postgres';
import type { ApiEnvironment } from '../contracts/common.js';
import { errorSchema } from '../contracts/common.js';
import { ApiError } from '../errors.js';
import type { ApnsEnvironment, ApnsSender } from '../integrations/apns.js';

/**
 * Caloma's intercom wake-up relay.
 *
 * Intercom calls go straight between devices on the home network. A locked or backgrounded
 * phone isn't listening, so the caller asks this relay to wake it with a VoIP push; the phone
 * shows the call with CallKit and then connects on the network as usual. Nothing about the call
 * itself passes through here.
 *
 * No sign-in: a household's devices share a secret derived from the household's iCloud key, and
 * the relay only ever stores its SHA-256 (the "room"). Knowing the room lets a device wake the
 * other devices in it, and nothing else.
 */
export type IntercomDevice = { device: string; token: string; environment: ApnsEnvironment };

export type IntercomStore = {
  /** Saves the device's token in the room, and forgets the token anywhere else. */
  register(room: string, device: IntercomDevice): Promise<void>;
  devices(room: string, ids: string[]): Promise<IntercomDevice[]>;
  forget(room: string, devices: string[]): Promise<void>;
};

export type CalomaIntercomDependencies = {
  store?: IntercomStore | undefined;
  apns?: ApnsSender | undefined;
  topic: string;
};

const uuid = z.string().uuid();
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'a base64url 32-byte secret');
const environment = z.enum(['sandbox', 'production']);

const registerBody = z.object({
  secret,
  device: uuid,
  token: z.string().regex(/^[0-9a-fA-F]{64,200}$/),
  environment,
}).openapi('CalomaIntercomDevice');

const ringBody = z.object({
  secret,
  call: uuid,
  from: uuid,
  name: z.string().trim().min(1).max(60),
  video: z.boolean(),
  to: z.array(uuid).min(1).max(8),
}).openapi('CalomaIntercomRing');

export function roomFor(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function registerCalomaIntercom(app: OpenAPIHono<ApiEnvironment>, dependencies: CalomaIntercomDependencies) {
  const unavailable = () => new ApiError(503, 'INTERCOM_UNAVAILABLE', 'The intercom relay is not configured');
  const errors = {
    400: { description: 'Invalid request', content: { 'application/json': { schema: errorSchema } } },
    503: { description: 'Relay not configured', content: { 'application/json': { schema: errorSchema } } },
  };

  app.openapi(createRoute({
    method: 'post',
    path: '/caloma/intercom/devices',
    tags: ['Caloma'],
    summary: 'Save a device\'s VoIP push token so intercom calls can wake it',
    request: { body: { content: { 'application/json': { schema: registerBody } }, required: true } },
    responses: { 204: { description: 'Saved' }, ...errors },
  }), async (context) => {
    const { store } = dependencies;
    if (!store) throw unavailable();
    const body = context.req.valid('json');
    await store.register(roomFor(body.secret), {
      device: body.device.toLowerCase(), token: body.token.toLowerCase(), environment: body.environment,
    });
    return context.body(null, 204);
  });

  app.openapi(createRoute({
    method: 'post',
    path: '/caloma/intercom/ring',
    tags: ['Caloma'],
    summary: 'Wake household devices for an intercom call',
    request: { body: { content: { 'application/json': { schema: ringBody } }, required: true } },
    responses: {
      200: {
        description: 'Which of the devices were woken',
        content: { 'application/json': { schema: z.object({ woken: z.array(z.string()) }) } },
      },
      ...errors,
    },
  }), async (context) => {
    const { store, apns, topic } = dependencies;
    if (!store || !apns) throw unavailable();
    const body = context.req.valid('json');
    const room = roomFor(body.secret);
    const from = body.from.toLowerCase();
    const targets = [...new Set(body.to.map((id) => id.toLowerCase()))].filter((id) => id !== from);
    const devices = targets.length > 0 ? await store.devices(room, targets) : [];
    const results = await apns(devices.map((device) => ({
      token: device.token,
      environment: device.environment,
      topic,
      pushType: 'voip' as const,
      // A ring nobody gets within half a minute is a missed call, not one to show later.
      expiresIn: 0,
      collapseId: body.call,
      payload: { intercom: { call: body.call, from, name: body.name, video: body.video } },
    })));
    const gone = devices.filter((_, index) => results[index] === 'gone').map((device) => device.device);
    if (gone.length > 0) await store.forget(room, gone);
    return context.json({ woken: devices.filter((_, index) => results[index] === 'sent').map((device) => device.device) }, 200);
  });
}

/** Rows in `caloma_intercom_devices` (supabase/migrations/20261023120000_caloma_intercom_devices.sql). */
export function createIntercomStore(sql: Sql): IntercomStore {
  return {
    async register(room, device) {
      await sql.begin(async (transaction) => {
        await transaction`delete from public.caloma_intercom_devices where token = ${device.token} and room <> ${room}`;
        await transaction`
          insert into public.caloma_intercom_devices (room, device_id, token, environment, updated_at)
          values (${room}, ${device.device}, ${device.token}, ${device.environment}, now())
          on conflict (room, device_id) do update
            set token = excluded.token, environment = excluded.environment, updated_at = now()`;
      });
    },
    async devices(room, ids) {
      const rows = await sql<{ device_id: string; token: string; environment: ApnsEnvironment }[]>`
        select device_id, token, environment from public.caloma_intercom_devices
        where room = ${room} and device_id = any(${ids}::uuid[])`;
      return rows.map((row) => ({ device: row.device_id, token: row.token, environment: row.environment }));
    },
    async forget(room, devices) {
      await sql`delete from public.caloma_intercom_devices where room = ${room} and device_id = any(${devices}::uuid[])`;
    },
  };
}
