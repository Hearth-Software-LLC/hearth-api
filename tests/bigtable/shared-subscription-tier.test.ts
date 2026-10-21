import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, eqValue, type QueryCall, type QueryResult } from "./helpers/fake-supabase.js";

let fake: ReturnType<typeof createFakeSupabase>;
const supabaseAdmin = {
  from: (table: string) => fake.client.from(table),
  rpc: (fn: string, args: Record<string, unknown>) => fake.client.rpc(fn, args),
};

vi.mock("../../src/services/supabase.js", () => ({ supabaseAdmin }));

let tiers: Record<string, string> = {};
let organizerOf: Record<string, string> = {};

function respond(call: QueryCall): QueryResult | undefined {
  switch (call.table) {
    case "subscriptions": {
      if (call.op === "insert") return { data: null };
      const id = eqValue(call, "profile_id") as string;
      return { data: tiers[id] ? { tier: tiers[id] } : null };
    }
    case "household_memberships": {
      const id = eqValue(call, "member_id") as string;
      return { data: organizerOf[id] ? { organizer_id: organizerOf[id] } : null };
    }
    case "ai_usage":
      return { data: null };
    default:
      return { data: null };
  }
}

describe("shared subscription tier", () => {
  beforeEach(() => {
    fake = createFakeSupabase(respond);
    tiers = {};
    organizerOf = {};
  });

  it("gives a free member the organizer's Pro tier", async () => {
    tiers = { "organizer-1": "pro" };
    organizerOf = { "kid-7": "organizer-1" };
    const { getUsageStatus } = await import("../../src/bigtable/lib/rate-limit.js");
    const usage = await getUsageStatus("kid-7");
    expect(usage.tier).toBe("pro");
    expect(usage.canMakeRequest).toBe(true);
  });

  it("keeps free when the organizer is free too", async () => {
    tiers = { "organizer-1": "free" };
    organizerOf = { "member-2": "organizer-1" };
    const { getUsageStatus } = await import("../../src/bigtable/lib/rate-limit.js");
    expect((await getUsageStatus("member-2")).tier).toBe("free");
  });

  it("uses someone's own Pro without looking up a household", async () => {
    tiers = { "solo-1": "pro" };
    const { getUsageStatus } = await import("../../src/bigtable/lib/rate-limit.js");
    expect((await getUsageStatus("solo-1")).tier).toBe("pro");
    expect(fake.callsTo("household_memberships")).toHaveLength(0);
  });
});
