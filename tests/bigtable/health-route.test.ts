import { beforeEach, describe, expect, it, vi } from "vitest";

const fromMock = vi.fn();
const supabaseAdmin = {
  from: fromMock,
};

vi.mock("../../src/bigtable/lib/supabase.js", () => ({
  supabaseAdmin,
}));

function createHealthTableMock(shouldFail: boolean) {
  return {
    select: vi.fn(() => ({
      limit: vi.fn(async () => ({
        error: shouldFail ? { message: "database unavailable" } : null,
      })),
    })),
  };
}

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.REVENUECAT_WEBHOOK_SECRET = "test-revenuecat-secret";
  });

  it("returns ok when the database check succeeds", async () => {
    fromMock.mockReturnValue(createHealthTableMock(false));

    const { GET } = await import("../../src/bigtable/routes/health.js");
    const response = await GET();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.dependency).toBe("database");
  });

  it("returns 503 when the database check fails", async () => {
    fromMock.mockReturnValue(createHealthTableMock(true));

    const { GET } = await import("../../src/bigtable/routes/health.js");
    const response = await GET();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(body.status).toBe("error");
    expect(body.dependency).toBe("runtime");
  });
});