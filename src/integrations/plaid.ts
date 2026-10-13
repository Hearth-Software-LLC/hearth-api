import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import type { LinkTokenCreateRequest } from 'plaid';
import { z } from 'zod';
import type { Config } from '../config.js';
import { ApiError } from '../errors.js';

export type CreateLinkToken = (request: LinkTokenCreateRequest, signal: AbortSignal) => Promise<unknown>;

/**
 * The Plaid calls behind a connection's lifecycle. Results are `unknown` on purpose: every
 * response is validated before use, the same as Link tokens.
 */
export type PlaidDataClient = {
  exchangePublicToken: (publicToken: string, signal: AbortSignal) => Promise<unknown>;
  getAccounts: (accessToken: string, signal: AbortSignal) => Promise<unknown>;
  getInstitution: (institutionId: string, countryCodes: Config['PLAID_COUNTRY_CODES'], signal: AbortSignal) => Promise<unknown>;
  syncTransactions: (accessToken: string, cursor: string | undefined, signal: AbortSignal) => Promise<unknown>;
  removeItem: (accessToken: string, signal: AbortSignal) => Promise<unknown>;
};

const tokenSchema = z.object({
  link_token: z.string().min(1).max(4096),
  expiration: z.iso.datetime({ offset: true }),
  request_id: z.string().min(1).max(256),
});
const failureSchema = z.object({
  code: z.string().optional(),
  response: z.object({
    status: z.number(),
    data: z.object({
      error_type: z.string().optional(),
      error_code: z.string().optional(),
    }).optional(),
  }).optional(),
});

/** Plaid errors that mean the person has to sign in to their bank again (update mode). */
const reauthCodes = new Set(['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT', 'INSUFFICIENT_CREDENTIALS']);

function plaidApi(config: Config): PlaidApi | undefined {
  if (!config.PLAID_CLIENT_ID || !config.PLAID_SECRET) return undefined;
  const basePath = PlaidEnvironments[config.PLAID_ENV];
  if (!basePath) throw new ApiError(503, 'PROVIDER_CONFIGURATION_ERROR', 'Plaid is not available');
  return new PlaidApi(new Configuration({
    basePath,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': config.PLAID_CLIENT_ID,
        'PLAID-SECRET': config.PLAID_SECRET,
        'Plaid-Version': '2020-09-14',
      },
      timeout: 8000,
      maxRedirects: 0,
      // A page of synced transactions (100 at most) fits comfortably.
      maxContentLength: 2_097_152,
      maxBodyLength: 16_384,
    },
  }));
}

export function createPlaidLinkClient(config: Config): CreateLinkToken | undefined {
  const client = plaidApi(config);
  if (!client) return undefined;
  return async (request, signal) => (await client.linkTokenCreate(request, { signal })).data;
}

export function createPlaidDataClient(config: Config): PlaidDataClient | undefined {
  const client = plaidApi(config);
  if (!client) return undefined;
  return {
    exchangePublicToken: async (publicToken, signal) =>
      (await client.itemPublicTokenExchange({ public_token: publicToken }, { signal })).data,
    getAccounts: async (accessToken, signal) =>
      (await client.accountsGet({ access_token: accessToken }, { signal })).data,
    getInstitution: async (institutionId, countryCodes, signal) =>
      (await client.institutionsGetById({
        institution_id: institutionId, country_codes: countryCodes,
        // Adds the bank's website, for its logo.
        options: { include_optional_metadata: true },
      }, { signal })).data,
    syncTransactions: async (accessToken, cursor, signal) =>
      (await client.transactionsSync({ access_token: accessToken, ...(cursor ? { cursor } : {}), count: 100 }, { signal })).data,
    removeItem: async (accessToken, signal) =>
      (await client.itemRemove({ access_token: accessToken }, { signal })).data,
  };
}

/**
 * A Link token for a new connection, or, with an access token, for update mode (the person
 * signs in to a bank that needs it again). The redirect URI is only sent when configured;
 * it's needed only for OAuth banks.
 */
export async function createLinkToken(config: Config, userId: string, client: CreateLinkToken, accessToken?: string) {
  if (!config.PLAID_PRODUCTS) {
    throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Plaid is not configured');
  }
  const signal = AbortSignal.timeout(8000);
  try {
    const result = await client({
      user: { client_user_id: userId },
      client_name: config.PLAID_CLIENT_NAME,
      ...(accessToken ? { access_token: accessToken } : { products: config.PLAID_PRODUCTS }),
      country_codes: config.PLAID_COUNTRY_CODES,
      language: 'en',
      ...(config.PLAID_REDIRECT_URI ? { redirect_uri: config.PLAID_REDIRECT_URI } : {}),
    }, signal);
    const parsed = tokenSchema.safeParse(result);
    if (!parsed.success || Date.parse(parsed.data.expiration) <= Date.now()) {
      throw new ApiError(502, 'UPSTREAM_INVALID_RESPONSE', 'Plaid returned an invalid response');
    }
    return {
      linkToken: parsed.data.link_token,
      expiresAt: parsed.data.expiration,
      plaidRequestId: parsed.data.request_id,
    };
  } catch (error) {
    throw plaidFailure(error, signal);
  }
}

/** Turns anything a Plaid call threw into a sanitized ApiError. */
export function plaidFailure(error: unknown, signal: AbortSignal): ApiError {
  if (error instanceof ApiError) return error;
  const failure = failureSchema.safeParse(error);
  const code = failure.success ? failure.data.code : undefined;
  const response = failure.success ? failure.data.response : undefined;
  if (signal.aborted || code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    return new ApiError(504, 'UPSTREAM_TIMEOUT', 'Plaid did not respond in time');
  }
  if (response?.status === 429 || response?.data?.error_type === 'RATE_LIMIT_EXCEEDED') {
    return new ApiError(503, 'PROVIDER_QUOTA_EXCEEDED', 'Plaid request quota is exhausted', 60);
  }
  if (response?.status === 401 || response?.status === 403 || response?.data?.error_code === 'INVALID_API_KEYS') {
    return new ApiError(503, 'PROVIDER_CONFIGURATION_ERROR', 'Plaid is not available');
  }
  const plaidCode = response?.data?.error_code;
  if (plaidCode && reauthCodes.has(plaidCode)) {
    return new ApiError(409, 'CONNECTION_NEEDS_REAUTH', 'The bank needs you to sign in again');
  }
  if (plaidCode === 'INVALID_PUBLIC_TOKEN' || plaidCode === 'INVALID_LINK_TOKEN') {
    return new ApiError(400, 'INVALID_REQUEST', 'The bank connection expired; try connecting again');
  }
  if (plaidCode === 'ITEM_NOT_FOUND' || plaidCode === 'INVALID_ACCESS_TOKEN') {
    return new ApiError(404, 'CONNECTION_NOT_FOUND', 'That bank connection no longer exists');
  }
  return new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'Plaid is temporarily unavailable');
}

export function isPlaidCode(error: unknown, codes: string[]): boolean {
  const failure = failureSchema.safeParse(error);
  const code = failure.success ? failure.data.response?.data?.error_code : undefined;
  return code !== undefined && codes.includes(code);
}
