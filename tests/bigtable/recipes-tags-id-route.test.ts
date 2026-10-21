import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthenticatedJsonRequest } from "./helpers/session.js";

function bodylessRequest(url: string, method: string) {
  return new Request(url, { method, headers: { authorization: "Bearer token" } });
}

const getUserIdFromAuthHeader = vi.fn();
const fromMock = vi.fn();
const rpcMock = vi.fn();

const supabaseAdmin = {
  from: fromMock,
  rpc: rpcMock,
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/services/supabase.js", () => ({
  supabaseAdmin,
}));

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.resetAllMocks();
  getUserIdFromAuthHeader.mockResolvedValue("user-1");
});

describe("PATCH /api/recipes/tags/[id]", () => {
  it("renames the tag via the cascading RPC scoped to the caller", async () => {
    rpcMock.mockResolvedValue({ data: "tag-1", error: null });

    const { PATCH } = await import("../../src/bigtable/routes/recipes.tags._id.js");
    const response = await PATCH(
      buildAuthenticatedJsonRequest("http://localhost/api/recipes/tags/tag-1", { label: "Weeknight" }) as never,
      paramsFor("tag-1"),
    );
    const payload = (await response.json()) as { tag: { label: string; normalized: string } };

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("rename_custom_recipe_tag", {
      p_profile_id: "user-1",
      p_tag_id: "tag-1",
      p_new_label: "WEEKNIGHT",
      p_new_normalized: "weeknight",
    });
    expect(payload.tag).toEqual({ id: "tag-1", label: "WEEKNIGHT", normalized: "weeknight" });
  });

  it("returns 404 when the tag is not owned by the caller", async () => {
    // The RPC returns null when the tag does not belong to p_profile_id.
    rpcMock.mockResolvedValue({ data: null, error: null });

    const { PATCH } = await import("../../src/bigtable/routes/recipes.tags._id.js");
    const response = await PATCH(
      buildAuthenticatedJsonRequest("http://localhost/api/recipes/tags/other-user-tag", { label: "Weeknight" }) as never,
      paramsFor("other-user-tag"),
    );

    expect(response.status).toBe(404);
  });

  it("returns 409 on a name collision", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "23505" } });

    const { PATCH } = await import("../../src/bigtable/routes/recipes.tags._id.js");
    const response = await PATCH(
      buildAuthenticatedJsonRequest("http://localhost/api/recipes/tags/tag-1", { label: "Dinner" }) as never,
      paramsFor("tag-1"),
    );

    expect(response.status).toBe(409);
  });
});

describe("DELETE /api/recipes/tags/[id]", () => {
  it("deletes only the caller's own tag (catalog-only)", async () => {
    const maybeSingleMock = vi.fn().mockResolvedValue({ data: { id: "tag-1" }, error: null });
    const selectMock = vi.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
    const eq2Mock = vi.fn().mockReturnValue({ select: selectMock });
    const eq1Mock = vi.fn().mockReturnValue({ eq: eq2Mock });
    const deleteMock = vi.fn().mockReturnValue({ eq: eq1Mock });
    fromMock.mockReturnValue({ delete: deleteMock });

    const { DELETE } = await import("../../src/bigtable/routes/recipes.tags._id.js");
    const response = await DELETE(
      bodylessRequest("http://localhost/api/recipes/tags/tag-1", "DELETE") as never,
      paramsFor("tag-1"),
    );
    const payload = (await response.json()) as { ok: boolean };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(eq1Mock).toHaveBeenCalledWith("id", "tag-1");
    expect(eq2Mock).toHaveBeenCalledWith("profile_id", "user-1");
  });

  it("returns 404 when deleting a tag the caller does not own", async () => {
    const maybeSingleMock = vi.fn().mockResolvedValue({ data: null, error: null });
    const selectMock = vi.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
    const eq2Mock = vi.fn().mockReturnValue({ select: selectMock });
    const eq1Mock = vi.fn().mockReturnValue({ eq: eq2Mock });
    const deleteMock = vi.fn().mockReturnValue({ eq: eq1Mock });
    fromMock.mockReturnValue({ delete: deleteMock });

    const { DELETE } = await import("../../src/bigtable/routes/recipes.tags._id.js");
    const response = await DELETE(
      bodylessRequest("http://localhost/api/recipes/tags/other-user-tag", "DELETE") as never,
      paramsFor("other-user-tag"),
    );

    expect(response.status).toBe(404);
  });
});
