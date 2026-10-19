import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, type QueryCall, type QueryResult } from "./helpers/fake-supabase.js";

const getUserIdFromAuthHeader = vi.fn();

let fake: ReturnType<typeof createFakeSupabase>;
const supabaseAdmin = {
  from: (table: string) => fake.client.from(table),
  rpc: (fn: string, args: Record<string, unknown>) => fake.client.rpc(fn, args),
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({ getUserIdFromAuthHeader }));
vi.mock("../../src/bigtable/lib/supabase.js", () => ({ supabaseAdmin }));

let displayNameRows: Array<{ id: string; display_name: string | null }> = [];
let displayNameError: { message: string } | null = null;

function respond(call: QueryCall): QueryResult | undefined {
  switch (call.table) {
    case "profiles":
      if (call.columns === "id, display_name") {
        return { data: displayNameError ? null : displayNameRows, error: displayNameError };
      }
      return {
        data: { id: "cook-1", household_name: "Warren Household", avatar_url: null, created_at: "2026-01-01T00:00:00.000Z", social_profile_visible: true },
      };
    case "household_memberships":
    case "blocks":
      return { data: null };
    case "household_members":
      return { data: call.filters.some((filter) => filter.args[0] === "profile_id") ? { name: "Steve", avatar_url: null } : null };
    case "follows":
      return { data: null, count: 0 };
    case "recipes":
      return { data: [] };
    default:
      throw new Error(`Unexpected table ${call.table}`);
  }
}

function request() {
  return new Request("http://localhost/v1/bigtable/profiles/cook-1/public", { headers: { authorization: "Bearer token" } });
}

describe("public display name", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getUserIdFromAuthHeader.mockResolvedValue("viewer-1");
    displayNameRows = [];
    displayNameError = null;
    fake = createFakeSupabase(respond);
  });

  it("is preferred over the first household member's name", async () => {
    displayNameRows = [{ id: "cook-1", display_name: "The Warren Kitchen" }];
    const { GET } = await import("../../src/bigtable/routes/profiles._id.public.js");
    const response = await GET(request(), { params: Promise.resolve({ id: "cook-1" }) });
    const payload = (await response.json()) as { profile: { profileName: string } };

    expect(response.status).toBe(200);
    expect(payload.profile.profileName).toBe("The Warren Kitchen");
  });

  it("falls back to the household member, and survives the column not existing yet", async () => {
    displayNameError = { message: 'column profiles.display_name does not exist' };
    const { GET } = await import("../../src/bigtable/routes/profiles._id.public.js");
    const response = await GET(request(), { params: Promise.resolve({ id: "cook-1" }) });
    const payload = (await response.json()) as { profile: { profileName: string } };

    expect(response.status).toBe(200);
    expect(payload.profile.profileName).toBe("Steve");
  });
});
