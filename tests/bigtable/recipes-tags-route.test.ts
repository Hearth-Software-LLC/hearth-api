import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthenticatedJsonRequest } from "./helpers/session.js";

// GET/DELETE requests must not carry a body, so build them directly.
function bodylessRequest(url: string, method: string, authorized = true) {
  return new Request(url, {
    method,
    headers: authorized ? { authorization: "Bearer token" } : {},
  });
}

const getUserIdFromAuthHeader = vi.fn();
const fromMock = vi.fn();

const supabaseAdmin = {
  from: fromMock,
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/bigtable/lib/supabase.js", () => ({
  supabaseAdmin,
}));

beforeEach(() => {
  vi.resetAllMocks();
  getUserIdFromAuthHeader.mockResolvedValue("user-1");
});

describe("GET /api/recipes/tags", () => {
  it("returns only the authenticated user's tags", async () => {
    const orderMock = vi.fn().mockResolvedValue({
      data: [{ id: "t1", label: "Game Day", normalized: "game day" }],
      error: null,
    });
    const eqMock = vi.fn().mockReturnValue({ order: orderMock });
    const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
    fromMock.mockReturnValue({ select: selectMock });

    const { GET } = await import("../../src/bigtable/routes/recipes.tags.js");
    const response = await GET(bodylessRequest("http://localhost/api/recipes/tags", "GET") as never);
    const payload = (await response.json()) as { tags: Array<{ id: string }> };

    expect(response.status).toBe(200);
    // Scoped to the verified user id, never a body-supplied value.
    expect(eqMock).toHaveBeenCalledWith("profile_id", "user-1");
    expect(payload.tags).toEqual([{ id: "t1", label: "Game Day", normalized: "game day" }]);
  });

  it("rejects unauthenticated requests", async () => {
    getUserIdFromAuthHeader.mockResolvedValue(null);
    const { GET } = await import("../../src/bigtable/routes/recipes.tags.js");
    const response = await GET(bodylessRequest("http://localhost/api/recipes/tags", "GET", false) as never);
    expect(response.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/recipes/tags", () => {
  it("creates a normalized tag scoped to the user", async () => {
    const singleMock = vi.fn().mockResolvedValue({
      data: { id: "t9", label: "Game Day", normalized: "game day" },
      error: null,
    });
    const selectMock = vi.fn().mockReturnValue({ single: singleMock });
    const insertMock = vi.fn().mockReturnValue({ select: selectMock });
    fromMock.mockReturnValue({ insert: insertMock });

    const { POST } = await import("../../src/bigtable/routes/recipes.tags.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/recipes/tags", { label: "  Game   Day  ", profile_id: "attacker" }) as never,
    );
    const payload = (await response.json()) as { tag: { id: string } };

    expect(response.status).toBe(201);
    // profile_id comes from the token; the body value is ignored. Label is uppercased,
    // normalized is lowercased.
    expect(insertMock).toHaveBeenCalledWith({ profile_id: "user-1", label: "GAME DAY", normalized: "game day" });
    expect(payload.tag.id).toBe("t9");
  });

  it("returns the existing tag on a duplicate (idempotent)", async () => {
    const singleMock = vi.fn().mockResolvedValue({ data: null, error: { code: "23505" } });
    const insertSelectMock = vi.fn().mockReturnValue({ single: singleMock });
    const insertMock = vi.fn().mockReturnValue({ select: insertSelectMock });

    const maybeSingleMock = vi.fn().mockResolvedValue({
      data: { id: "existing", label: "Game Day", normalized: "game day" },
      error: null,
    });
    const eq2Mock = vi.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
    const eq1Mock = vi.fn().mockReturnValue({ eq: eq2Mock });
    const dupSelectMock = vi.fn().mockReturnValue({ eq: eq1Mock });

    fromMock.mockReturnValue({ insert: insertMock, select: dupSelectMock });

    const { POST } = await import("../../src/bigtable/routes/recipes.tags.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/recipes/tags", { label: "Game Day" }) as never,
    );
    const payload = (await response.json()) as { tag: { id: string } };

    expect(response.status).toBe(200);
    expect(payload.tag.id).toBe("existing");
  });

  it("rejects an empty label", async () => {
    const { POST } = await import("../../src/bigtable/routes/recipes.tags.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/recipes/tags", { label: "   " }) as never,
    );
    expect(response.status).toBe(400);
    expect(fromMock).not.toHaveBeenCalled();
  });
});
