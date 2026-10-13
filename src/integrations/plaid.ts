import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import type { LinkTokenCreateRequest } from 'plaid';
import { z } from 'zod';
import type { Config } from '../config.js';
import { ApiError } from '../errors.js';

export type CreateLinkToken = (request: LinkTokenCreateRequest, signal: AbortSignal) => Promise<unknown>;

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

export function createPlaidLinkClient(config: Config): CreateLinkToken | undefined {
  if (!config.PLAID_CLIENT_ID || !config.PLAID_SECRET) return undefined;
  const basePath = PlaidEnvironments[config.PLAID_ENV];
  if (!basePath) throw new ApiError(503, 'PROVIDER_CONFIGURATION_ERROR', 'Plaid is not available');
  const client = new PlaidApi(new Configuration({
    basePath,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': config.PLAID_CLIENT_ID,
        'PLAID-SECRET': config.PLAID_SECRET,
        'Plaid-Version': '2020-09-14',
      },
      timeout: 8000,
      maxRedirects: 0,
      maxContentLength: 65_536,
      maxBodyLength: 16_384,
    },
  }));
  return async (request, signal) => (await client.linkTokenCreate(request, { signal })).data;
}

export async function createLinkToken(config: Config, userId: string, client: CreateLinkToken) {
  if (!config.PLAID_PRODUCTS || !config.PLAID_REDIRECT_URI) {
    throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Plaid is not configured');
  }
  const signal = AbortSignal.timeout(8000);
  try {
    const result = await client({
      user: { client_user_id: userId },
      client_name: config.PLAID_CLIENT_NAME,
      products: config.PLAID_PRODUCTS,
      country_codes: config.PLAID_COUNTRY_CODES,
      language: 'en',
      redirect_uri: config.PLAID_REDIRECT_URI,
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
    if (error instanceof ApiError) throw error;
    const failure = failureSchema.safeParse(error);
    const code = failure.success ? failure.data.code : undefined;
    const response = failure.success ? failure.data.response : undefined;
    if (signal.aborted || code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      throw new ApiError(504, 'UPSTREAM_TIMEOUT', 'Plaid did not respond in time');
    }
    if (response?.status === 429 || response?.data?.error_type === 'RATE_LIMIT_EXCEEDED') {
      throw new ApiError(503, 'PROVIDER_QUOTA_EXCEEDED', 'Plaid request quota is exhausted', 60);
    }
    if (response?.status === 401 || response?.status === 403 || response?.data?.error_code === 'INVALID_API_KEYS') {
      throw new ApiError(503, 'PROVIDER_CONFIGURATION_ERROR', 'Plaid is not available');
    }
    throw new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'Plaid is temporarily unavailable');
  }
}