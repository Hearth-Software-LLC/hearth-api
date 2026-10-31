import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../errors.js';

/**
 * Resend (resend.com): one-off emails (the waitlist's confirmation), contacts in segments (one
 * per beta app), and broadcasts (the launch email). Any address on a verified domain can send;
 * RESEND_FROM picks it.
 */
export type Resend = {
  send(email: { to: string; subject: string; html: string; text: string }): Promise<{ id: string }>;
  /** Creates the contact, or leaves an existing one as is; then adds it to each segment. */
  addToSegments(email: string, segmentIds: string[]): Promise<{ id: string | null }>;
  removeContact(email: string): Promise<void>;
  /** The segment with this name, made if missing. */
  segment(name: string): Promise<string>;
  broadcast(input: { segmentId: string; name: string; subject: string; html: string }): Promise<{ id: string }>;
};

export function createResend(options: { apiKey: string; from: string; replyTo: string; fetcher?: typeof fetch }): Resend {
  const fetcher = options.fetcher ?? fetch;

  async function call<T>(method: string, path: string, body?: unknown, allow: number[] = []): Promise<{ status: number; json: T }> {
    const response = await fetcher(`https://api.resend.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await response.json().catch(() => ({}))) as T;
    if (!response.ok && !allow.includes(response.status)) {
      const message = (json as { message?: string }).message;
      throw new ApiError(502, 'EMAIL_FAILED', `Resend answered ${response.status}${message ? `: ${message}` : ''}`);
    }
    return { status: response.status, json };
  }

  return {
    async send(email) {
      const { json } = await call<{ id: string }>('POST', '/emails', {
        from: options.from, to: [email.to], reply_to: options.replyTo, subject: email.subject, html: email.html, text: email.text,
      });
      return { id: json.id };
    },

    async addToSegments(email, segmentIds) {
      // 409/422 when the contact already exists: then add it to each segment by email.
      const created = await call<{ id?: string }>('POST', '/contacts', {
        email, unsubscribed: false, segments: segmentIds.map((id) => ({ id })),
      }, [409, 422]);
      if (created.status < 300) return { id: created.json.id ?? null };
      for (const segmentId of segmentIds) {
        await call('POST', `/contacts/${encodeURIComponent(email)}/segments/${encodeURIComponent(segmentId)}`, undefined, [409, 422]);
      }
      return { id: null };
    },

    async removeContact(email) {
      await call('DELETE', `/contacts/${encodeURIComponent(email)}`, undefined, [404]);
    },

    async segment(name) {
      const { json } = await call<{ data?: { id: string; name: string }[] }>('GET', '/segments');
      const found = json.data?.find((entry) => entry.name === name);
      if (found) return found.id;
      const made = await call<{ id: string }>('POST', '/segments', { name });
      return made.json.id;
    },

    async broadcast(input) {
      const { json } = await call<{ id: string }>('POST', '/broadcasts', {
        segment_id: input.segmentId, from: options.from, reply_to: options.replyTo, name: input.name,
        subject: input.subject, html: input.html, send: true,
      });
      return { id: json.id };
    },
  };
}

/**
 * Resend signs webhooks the Svix way: HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<raw body>"
 * with the base64 key after "whsec_", sent as "v1,<base64>" (several, space-separated).
 */
export function verifyResendWebhook(secret: string, headers: { id?: string | undefined; timestamp?: string | undefined; signature?: string | undefined }, body: string, now = Date.now()) {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const seconds = Number(headers.timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${headers.id}.${headers.timestamp}.${body}`).digest();
  return headers.signature.split(' ').some((part) => {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
