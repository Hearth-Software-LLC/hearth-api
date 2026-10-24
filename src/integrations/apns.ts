import { connect } from 'node:http2';
import type { ClientHttp2Session } from 'node:http2';
import { SignJWT, importPKCS8 } from 'jose';
import type { CryptoKey } from 'jose';

/**
 * Apple Push Notification service, token-based (.p8) authentication over HTTP/2.
 *
 * Sends straight to Apple, not through Expo, so native apps register their raw device token.
 * One sender serves every Hearth app: the topic (bundle id) is chosen per message.
 */
export type ApnsEnvironment = 'sandbox' | 'production';

export type ApnsMessage = {
  token: string;
  environment: ApnsEnvironment;
  topic: string;
  payload: Record<string, unknown>;
  /** Notifications with the same id replace each other on the device. */
  collapseId?: string;
  /**
   * `voip` wakes an app through PushKit to show a CallKit call (its topic ends in `.voip`).
   * Defaults to `alert`.
   */
  pushType?: 'alert' | 'voip';
  /** Seconds until Apple stops trying to deliver it; 0 means now or never. */
  expiresIn?: number;
};

/** `gone`: the token will never work again, so its owner should stop sending to it. */
export type ApnsResult = 'sent' | 'gone' | 'failed';

export type ApnsSender = (messages: ApnsMessage[]) => Promise<ApnsResult[]>;

export type ApnsCredentials = { keyId: string; teamId: string; privateKey: string };

const hosts: Record<ApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};
/** Apple accepts a provider token for an hour and refuses refreshes more often than every 20 minutes. */
const TOKEN_LIFETIME_MS = 45 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

export function createApnsSender(credentials: ApnsCredentials): ApnsSender {
  let key: Promise<CryptoKey> | undefined;
  let cached: { jwt: string; issuedAt: number } | undefined;

  async function providerToken() {
    if (cached && Date.now() - cached.issuedAt < TOKEN_LIFETIME_MS) return cached.jwt;
    key ??= importPKCS8(credentials.privateKey.replace(/\\n/g, '\n'), 'ES256');
    const issuedAt = Date.now();
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: credentials.keyId })
      .setIssuer(credentials.teamId)
      .setIssuedAt(Math.floor(issuedAt / 1000))
      .sign(await key);
    cached = { jwt, issuedAt };
    return jwt;
  }

  function send(session: ClientHttp2Session, message: ApnsMessage, jwt: string): Promise<ApnsResult> {
    return new Promise((resolve) => {
      const headers: Record<string, string> = {
        ':method': 'POST',
        ':path': `/3/device/${message.token}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': message.topic,
        'apns-push-type': message.pushType ?? 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      };
      if (message.expiresIn !== undefined) {
        headers['apns-expiration'] = String(message.expiresIn === 0 ? 0 : Math.floor(Date.now() / 1000) + message.expiresIn);
      }
      if (message.collapseId) headers['apns-collapse-id'] = message.collapseId.slice(0, 64);
      const request = session.request(headers);
      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        console.warn('APNs push timed out', { topic: message.topic, environment: message.environment });
        request.close();
        resolve('failed');
      });
      let status = 0;
      let body = '';
      request.on('response', (response) => { status = Number(response[':status']); });
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        if (status === 200) return resolve('sent');
        let reason = '';
        try { reason = (JSON.parse(body) as { reason?: string }).reason ?? ''; } catch { /* no body */ }
        // Why Apple refused it (never the token): TopicDisallowed, BadDeviceToken, InvalidProviderToken…
        console.warn('APNs refused a push', {
          status, reason, topic: message.topic, pushType: message.pushType ?? 'alert', environment: message.environment,
        });
        resolve(status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'DeviceTokenNotForTopic'
          ? 'gone' : 'failed');
      });
      request.on('error', (error) => {
        console.warn('APNs push failed', { topic: message.topic, environment: message.environment, message: error.message });
        resolve('failed');
      });
      request.end(JSON.stringify(message.payload));
    });
  }

  return async (messages) => {
    if (messages.length === 0) return [];
    let jwt: string;
    try { jwt = await providerToken(); } catch { return messages.map(() => 'failed'); }
    const results: ApnsResult[] = new Array(messages.length).fill('failed');
    for (const environment of ['production', 'sandbox'] as const) {
      const indexes = messages.flatMap((message, index) => (message.environment === environment ? [index] : []));
      if (indexes.length === 0) continue;
      let session: ClientHttp2Session;
      try {
        session = connect(hosts[environment]);
      } catch {
        continue;
      }
      session.on('error', () => { /* each request resolves 'failed' on its own */ });
      try {
        const sent = await Promise.all(indexes.map((index) => send(session, messages[index]!, jwt)));
        sent.forEach((result, position) => { results[indexes[position]!] = result; });
      } finally {
        session.close();
      }
    }
    return results;
  };
}
