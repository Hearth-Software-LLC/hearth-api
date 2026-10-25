import { createHash } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Sql } from 'postgres';
import type { ApiEnvironment } from '../contracts/common.js';
import { errorSchema } from '../contracts/common.js';
import { ApiError } from '../errors.js';
import type { ApnsEnvironment, ApnsSender } from '../integrations/apns.js';
import type { VerifyToken } from '../middleware/auth.js';
import type { EntitlementSource } from '../services/entitlements.js';

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
export type IntercomDevice = {
  device: string;
  /** PushKit (VoIP) token: wakes the device for a call. */
  token: string;
  environment: ApnsEnvironment;
  /** Ordinary notification token, for broadcasts. */
  alertToken?: string | undefined;
};

/**
 * Hearth+ on the device's account, which lets the whole household call away from home.
 * `undefined`: not signed in this time (keep what was known); `null`: signed in without it;
 * `'forever'`: a plan that doesn't expire; otherwise when it does (ISO date).
 */
export type PlusUntil = string | 'forever' | null | undefined;

export type IntercomStore = {
  /** Saves the device's token in the room, and forgets the token anywhere else. */
  register(room: string, device: IntercomDevice, plus?: PlusUntil): Promise<void>;
  /** Some device in the room has Hearth+ right now. */
  hasPlus(room: string): Promise<boolean>;
  devices(room: string, ids: string[]): Promise<IntercomDevice[]>;
  forget(room: string, devices: string[]): Promise<void>;
  /** Their notification tokens stopped working (the VoIP one may still be good). */
  forgetAlerts(room: string, devices: string[]): Promise<void>;
  /** Whether any device has registered in the room (a real household). */
  hasRoom(room: string): Promise<boolean>;
};

export type IceServer = { urls: string[]; username?: string; credential?: string };

/** Makes short-lived TURN credentials (Cloudflare Realtime TURN). */
export type TurnIssuer = (ttlSeconds: number) => Promise<IceServer[]>;

export type CalomaIntercomDependencies = {
  store?: IntercomStore | undefined;
  apns?: ApnsSender | undefined;
  topic: string;
  /** Caloma's own bundle id, for ordinary notifications (broadcasts). */
  alertTopic: string;
  /** TURN for calls away from home. Without it, devices get STUN only (most home networks connect). */
  turn?: TurnIssuer | undefined;
  /** For a signed-in device's Hearth+ (optional bearer token on registration). */
  verifyToken?: VerifyToken | undefined;
  entitlements?: EntitlementSource | undefined;
};

/** Always handed out: finds a device's public address, free, no credentials. */
export const stunServers: IceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
const ICE_TTL_SECONDS = 12 * 60 * 60;

/** Cloudflare's TURN key API. Port 53 is left out: it's blocked often enough to slow calls down. */
export function createCloudflareTurn(keyId: string, apiToken: string, fetcher: typeof fetch): TurnIssuer {
  return async (ttl) => {
    const response = await fetcher(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`TURN credentials failed: ${response.status}`);
    const body = await response.json() as { iceServers?: IceServer[] | IceServer };
    const servers = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
    return servers
      .map((server) => {
        const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => !/:53(\?|$)/.test(url));
        return { ...server, urls };
      })
      .filter((server) => server.urls.length > 0);
  };
}

const uuid = z.string().uuid();
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'a base64url 32-byte secret');
const environment = z.enum(['sandbox', 'production']);

const registerBody = z.object({
  secret,
  device: uuid,
  token: z.string().regex(/^[0-9a-fA-F]{64,200}$/),
  alertToken: z.string().regex(/^[0-9a-fA-F]{64,200}$/).optional(),
  environment,
}).openapi('CalomaIntercomDevice');

const iceBody = z.object({ secret }).openapi('CalomaIntercomIceRequest');

const iceServerSchema = z.object({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional(),
});

const broadcastBody = z.object({
  secret,
  call: uuid,
  from: uuid,
  name: z.string().trim().min(1).max(60),
  to: z.array(uuid).min(1).max(16),
}).openapi('CalomaIntercomBroadcast');

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
  /** Hearth+ on the account behind an optional bearer token (own or from their household). */
  async function plusFor(header: string | undefined): Promise<PlusUntil> {
    const { verifyToken, entitlements } = dependencies;
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token || !verifyToken || !entitlements) return undefined;
    try {
      const identity = await verifyToken(token);
      const userId = typeof identity === 'string' ? identity : identity.isAnonymous ? undefined : identity.userId;
      if (!userId) return undefined;
      const plan = (await entitlements(userId)).find((entry) => entry.id === 'hearth_plus');
      if (!plan) return null;
      return plan.expiresAt ?? 'forever';
    } catch {
      // A stale token or a lookup that failed: say nothing, rather than take Hearth+ away.
      return undefined;
    }
  }

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
    const plus = await plusFor(context.req.header('Authorization'));
    await store.register(roomFor(body.secret), {
      device: body.device.toLowerCase(),
      token: body.token.toLowerCase(),
      environment: body.environment,
      alertToken: body.alertToken?.toLowerCase(),
    }, plus);
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
    // Counts only, for "the phone never rang": was it registered, and did Apple take the push?
    console.info('Caloma intercom ring', {
      asked: targets.length, registered: devices.length,
      sent: results.filter((result) => result === 'sent').length,
      gone: gone.length, failed: results.filter((result) => result === 'failed').length,
    });
    return context.json({ woken: devices.filter((_, index) => results[index] === 'sent').map((device) => device.device) }, 200);
  });

  app.openapi(createRoute({
    method: 'post',
    path: '/caloma/intercom/ice',
    tags: ['Caloma'],
    summary: 'Network servers for a call away from home: STUN, and short-lived TURN credentials',
    request: { body: { content: { 'application/json': { schema: iceBody } }, required: true } },
    responses: {
      200: {
        description: 'ICE servers for WebRTC, good for `ttl` seconds',
        content: { 'application/json': { schema: z.object({ iceServers: z.array(iceServerSchema), ttl: z.number(), awayCalls: z.boolean() }) } },
      },
      403: { description: 'Not a registered household', content: { 'application/json': { schema: errorSchema } } },
      ...errors,
    },
  }), async (context) => {
    const { store, turn } = dependencies;
    if (!store) throw unavailable();
    const body = context.req.valid('json');
    const room = roomFor(body.secret);
    if (!(await store.hasRoom(room))) {
      throw new ApiError(403, 'INTERCOM_UNKNOWN_HOUSEHOLD', 'No devices are registered for this household');
    }
    // Calls away from home (the relay channel and TURN, which costs per GB) are Hearth+.
    const awayCalls = await store.hasPlus(room);
    if (!awayCalls || !turn) return context.json({ iceServers: stunServers, ttl: ICE_TTL_SECONDS, awayCalls }, 200);
    try {
      const servers = await turn(ICE_TTL_SECONDS);
      return context.json({ iceServers: servers.length > 0 ? servers : stunServers, ttl: ICE_TTL_SECONDS, awayCalls }, 200);
    } catch (error) {
      console.error('Caloma TURN credentials failed', { message: error instanceof Error ? error.message : String(error) });
      // STUN alone still connects most calls.
      return context.json({ iceServers: stunServers, ttl: 10 * 60, awayCalls }, 200);
    }
  });

  app.openapi(createRoute({
    method: 'post',
    path: '/caloma/intercom/broadcast',
    tags: ['Caloma'],
    summary: 'Tell household devices that aren\'t on the network that someone is broadcasting',
    request: { body: { content: { 'application/json': { schema: broadcastBody } }, required: true } },
    responses: {
      200: {
        description: 'Which of the devices were told',
        content: { 'application/json': { schema: z.object({ notified: z.array(z.string()) }) } },
      },
      ...errors,
    },
  }), async (context) => {
    const { store, apns, alertTopic } = dependencies;
    if (!store || !apns) throw unavailable();
    const body = context.req.valid('json');
    const room = roomFor(body.secret);
    const from = body.from.toLowerCase();
    const targets = [...new Set(body.to.map((id) => id.toLowerCase()))].filter((id) => id !== from);
    const devices = (targets.length > 0 ? await store.devices(room, targets) : []).filter((device) => device.alertToken);
    const results = await apns(devices.map((device) => ({
      token: device.alertToken!,
      environment: device.environment,
      topic: alertTopic,
      // Only worth seeing while it's on.
      expiresIn: 120,
      collapseId: body.call,
      payload: {
        aps: {
          alert: { title: body.name, body: 'Broadcasting on the intercom. Open Caloma to listen.' },
          sound: 'default',
          'thread-id': 'intercom',
        },
        intercom: { broadcast: body.call, from },
      },
    })));
    const gone = devices.filter((_, index) => results[index] === 'gone').map((device) => device.device);
    if (gone.length > 0) await store.forgetAlerts(room, gone);
    return context.json({ notified: devices.filter((_, index) => results[index] === 'sent').map((device) => device.device) }, 200);
  });
}

/** Rows in `caloma_intercom_devices` (supabase/migrations/20261023120000_caloma_intercom_devices.sql). */
export function createIntercomStore(sql: Sql): IntercomStore {
  return {
    async register(room, device, plus) {
      const keepPlus = plus === undefined;
      const plusUntil = plus === 'forever' ? 'infinity' : plus ?? null;
      await sql.begin(async (transaction) => {
        await transaction`delete from public.caloma_intercom_devices where token = ${device.token} and room <> ${room}`;
        await transaction`
          insert into public.caloma_intercom_devices (room, device_id, token, environment, alert_token, plus_until, updated_at)
          values (${room}, ${device.device}, ${device.token}, ${device.environment}, ${device.alertToken ?? null}, ${plusUntil}::timestamptz, now())
          on conflict (room, device_id) do update
            set token = excluded.token, environment = excluded.environment,
                alert_token = coalesce(excluded.alert_token, caloma_intercom_devices.alert_token),
                plus_until = case when ${keepPlus} then caloma_intercom_devices.plus_until else excluded.plus_until end,
                updated_at = now()`;
      });
    },
    async hasPlus(room) {
      const rows = await sql`select 1 from public.caloma_intercom_devices where room = ${room} and plus_until > now() limit 1`;
      return rows.length > 0;
    },
    async devices(room, ids) {
      const rows = await sql<{ device_id: string; token: string; environment: ApnsEnvironment; alert_token: string | null }[]>`
        select device_id, token, environment, alert_token from public.caloma_intercom_devices
        where room = ${room} and device_id = any(${ids}::uuid[])`;
      return rows.map((row) => ({
        device: row.device_id, token: row.token, environment: row.environment, alertToken: row.alert_token ?? undefined,
      }));
    },
    async forget(room, devices) {
      await sql`delete from public.caloma_intercom_devices where room = ${room} and device_id = any(${devices}::uuid[])`;
    },
    async hasRoom(room) {
      const rows = await sql`select 1 from public.caloma_intercom_devices where room = ${room} limit 1`;
      return rows.length > 0;
    },
    async forgetAlerts(room, devices) {
      await sql`update public.caloma_intercom_devices set alert_token = null where room = ${room} and device_id = any(${devices}::uuid[])`;
    },
  };
}
