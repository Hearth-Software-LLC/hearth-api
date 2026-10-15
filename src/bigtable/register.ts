import { z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ApiEnvironment } from '../contracts/common.js';
import type { VerifyToken } from '../middleware/auth.js';
import { setBigTableTokenVerifier } from './lib/auth.js';
import { bigTableRoutes } from './route-table.js';
import type { BigTableParams, BigTableRoute } from './route-table.js';

const ERROR_CODES: Record<number, string> = {
  400: 'INVALID_REQUEST',
  401: 'UNAUTHORIZED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'RESOURCE_NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  502: 'UPSTREAM_UNAVAILABLE',
  503: 'SERVICE_UNAVAILABLE',
  504: 'UPSTREAM_TIMEOUT',
};

function errorCode(status: number): string {
  return ERROR_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED');
}

// The BigTable handlers answer errors as `{ error: "message", ...extra }`. Rewrite those into
// the API-wide `{ error: { code, message, requestId } }` shape, keeping any extra fields
// (usage details on quota errors, for example) at the top level.
async function normalizeError(response: Response, requestId: string): Promise<Response> {
  if (response.status < 400 || !response.headers.get('content-type')?.includes('application/json')) {
    return response;
  }

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return response;
  }

  const record = body as Record<string, unknown>;
  if (typeof record.error === 'object' && record.error !== null) {
    return response;
  }

  const { error, ...extra } = record;
  const message = typeof error === 'string' && error.trim() ? error : 'Request failed';
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  if (response.status === 401) headers.set('WWW-Authenticate', 'Bearer');
  return new Response(
    JSON.stringify({ ...extra, error: { code: errorCode(response.status), message, requestId } }),
    { status: response.status, headers },
  );
}

function honoPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

function summaryFor(route: BigTableRoute): string {
  return `${route.method} ${route.path.replace('/v1/bigtable/', '')}`;
}

// Next.js prefers static path segments over dynamic ones (/recipes/favorites over
// /recipes/[id]); Hono picks the first matching route. Register static segments first.
function specificityOrder(a: BigTableRoute, b: BigTableRoute): number {
  const left = a.path.split('/');
  const right = b.path.split('/');
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const leftDynamic = left[index]!.startsWith('{');
    const rightDynamic = right[index]!.startsWith('{');
    if (leftDynamic !== rightDynamic) return leftDynamic ? 1 : -1;
  }
  return 0;
}

export function registerBigTable(app: OpenAPIHono<ApiEnvironment>, verifyToken: VerifyToken) {
  setBigTableTokenVerifier(verifyToken);

  for (const route of [...bigTableRoutes].sort(specificityOrder)) {
    const handle = async (context: Context<ApiEnvironment>) => {
      const params = context.req.param() as BigTableParams;
      const requestId = context.get('requestId');
      const response = await normalizeError(
        await route.handler(context.req.raw, { params: Promise.resolve(params) }),
        requestId,
      );
      // Handlers return their own Response, which skips the headers the app middleware set.
      const result = new Response(response.body, response);
      result.headers.set('X-Request-ID', requestId);
      if (!result.headers.has('Cache-Control')) result.headers.set('Cache-Control', 'no-store');
      return result;
    };
    app.on(route.method, honoPath(route.path), handle);

    const paramNames = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '');
    app.openAPIRegistry.registerPath({
      method: route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete',
      path: route.path,
      tags: [route.path.startsWith('/webhooks/') ? 'Webhooks' : 'BigTable'],
      summary: summaryFor(route),
      ...(route.auth ? { security: [{ BearerAuth: [] }] } : {}),
      ...(paramNames.length > 0
        ? { request: { params: z.object(Object.fromEntries(paramNames.map((name) => [name, z.string()]))) } }
        : {}),
      responses: {
        200: { description: 'Success' },
        ...(route.auth ? { 401: { description: 'Missing, invalid or anonymous token' } } : {}),
      },
    });
  }
}

