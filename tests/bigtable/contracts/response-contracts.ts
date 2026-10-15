import { expect } from "vitest";

export function assertErrorResponse(payload: unknown) {
  expect(payload).toBeTypeOf("object");
  expect(payload).not.toBeNull();
  expect((payload as { error?: unknown }).error).toEqual(expect.any(String));
}

export function assertLimitReachedResponse(payload: unknown) {
  assertErrorResponse(payload);
  const response = payload as {
    code?: unknown;
    requestsUsed?: unknown;
    requestsLimit?: unknown;
    requestedCredits?: unknown;
  };
  expect(response.code).toBe("LIMIT_REACHED");
  expect(response.requestsUsed).toEqual(expect.any(Number));
  expect(response.requestsLimit).toEqual(expect.any(Number));
  expect(response.requestedCredits).toEqual(expect.any(Number));
}

export function assertUsageResponse(payload: unknown) {
  expect(payload).toBeTypeOf("object");
  expect(payload).not.toBeNull();

  const response = payload as {
    usage?: {
      tier?: unknown;
      requestsUsed?: unknown;
      requestsLimit?: unknown;
    };
  };

  expect(response.usage).toBeTypeOf("object");
  expect(response.usage?.tier).toEqual(expect.any(String));
  expect(response.usage?.requestsUsed).toEqual(expect.any(Number));
  expect(response.usage?.requestsLimit).toEqual(expect.any(Number));
}

export function assertWebhookDuplicateResponse(payload: unknown) {
  expect(payload).toBeTypeOf("object");
  expect(payload).not.toBeNull();

  const response = payload as {
    ok?: unknown;
    duplicate?: unknown;
  };

  expect(response.ok).toBe(true);
  expect(response.duplicate).toBe(true);
}
