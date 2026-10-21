import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, eqValue, type QueryCall, type QueryResult } from "./helpers/fake-supabase.js";

let fake: ReturnType<typeof createFakeSupabase>;
// Hoisted with vi.mock, ahead of the imports below; `fake` is read only when a query runs.
const supabaseAdmin = vi.hoisted(() => ({
  from: (table: string) => fake.client.from(table),
  rpc: (fn: string, args: Record<string, unknown>) => fake.client.rpc(fn, args),
}));

vi.mock("../../src/services/supabase.js", () => ({ supabaseAdmin }));

import {
  activeEntitlements,
  appAccess,
  applyEventToEntitlements,
  effectiveEntitlements,
  hasAppAccess,
  normalizeEntitlementKey,
  tierFromEntitlements,
} from "../../src/services/subscriptions.js";

const now = new Date("2026-10-19T12:00:00Z");
const future = "2026-11-19T12:00:00.000Z";
const past = "2026-09-19T12:00:00.000Z";

let rows: Record<string, Record<string, unknown>> = {};
let organizerOf: Record<string, string> = {};

function respond(call: QueryCall): QueryResult | undefined {
  if (call.table === "subscriptions") {
    if (call.op === "insert") return { data: null };
    return { data: rows[eqValue(call, "profile_id") as string] ?? null };
  }
  if (call.table === "household_memberships") {
    const id = eqValue(call, "member_id") as string;
    return { data: organizerOf[id] ? { organizer_id: organizerOf[id] } : null };
  }
  return { data: null };
}

beforeEach(() => {
  fake = createFakeSupabase(respond);
  rows = {};
  organizerOf = {};
});

describe("entitlement mapping", () => {
  it("normalizes known keys and legacy BigTable names, and drops unknown ones", () => {
    expect(normalizeEntitlementKey("hearth_plus")).toBe("hearth_plus");
    expect(normalizeEntitlementKey("bigtable_plus")).toBe("bigtable_plus");
    expect(normalizeEntitlementKey("BigTable Pro")).toBe("bigtable_plus");
    expect(normalizeEntitlementKey("bigtable_pro")).toBe("bigtable_plus");
    expect(normalizeEntitlementKey("Suffice_Plus")).toBe("suffice_plus");
    expect(normalizeEntitlementKey("pantry")).toBe("bigtable_plus");
    expect(normalizeEntitlementKey("family")).toBe("bigtable_plus");
    expect(normalizeEntitlementKey("hearken_tips")).toBeNull();
  });

  it("keeps entitlements that never expire or haven't yet, and drops expired ones", () => {
    const active = activeEntitlements(
      { suffice_plus: future, hearth_plus: null, sated_plus: past, junk: future, caloma_plus: "not a date" } as never,
      now
    );
    expect(active).toEqual([
      { id: "hearth_plus", expiresAt: null },
      { id: "suffice_plus", expiresAt: future },
    ]);
  });

  it("unlocks an app with its own plan or Hearth+", () => {
    expect(hasAppAccess([{ id: "suffice_plus" }], "suffice")).toBe(true);
    expect(hasAppAccess([{ id: "suffice_plus" }], "sated")).toBe(false);
    expect(appAccess([{ id: "hearth_plus" }])).toEqual({
      bigtable: true, suffice: true, sated: true, caloma: true, hearken: true,
    });
    expect(appAccess([{ id: "bigtable_plus" }])).toEqual({
      bigtable: true, suffice: false, sated: false, caloma: false, hearken: false,
    });
  });

  it("derives tier from BigTable Pro or Hearth+", () => {
    expect(tierFromEntitlements({ "bigtable_plus": future }, now)).toBe("pro");
    expect(tierFromEntitlements({ hearth_plus: null }, now)).toBe("pro");
    expect(tierFromEntitlements({ suffice_plus: future }, now)).toBe("free");
    expect(tierFromEntitlements({ "bigtable_plus": past }, now)).toBe("free");
  });

  it("applies webhook events when RevenueCat's API is unavailable", () => {
    const purchase = { type: "INITIAL_PURCHASE", entitlement_ids: ["sated_plus"], product_id: "x", expires_at: future };
    const map = applyEventToEntitlements({ suffice_plus: future }, purchase);
    expect(map).toEqual({ suffice_plus: future, sated_plus: future });
    expect(applyEventToEntitlements(map, { ...purchase, type: "EXPIRATION" })).toEqual({ suffice_plus: future });
    expect(applyEventToEntitlements(map, { ...purchase, type: "CANCELLATION" })).toEqual(map);
    // Legacy product ID with no entitlement IDs still means BigTable Pro.
    expect(applyEventToEntitlements({}, {
      type: "RENEWAL", entitlement_ids: [], product_id: "com.stephenwarren.bigtable.pro.monthly", expires_at: future,
    })).toEqual({ "bigtable_plus": future });
  });
});

describe("effective entitlements", () => {
  it("adds the household organizer's entitlements, marked household", async () => {
    rows = {
      "kid-1": { tier: "free", entitlements: { caloma_plus: future } },
      "organizer-1": { tier: "pro", entitlements: { hearth_plus: null, caloma_plus: future, sated_plus: past } },
    };
    organizerOf = { "kid-1": "organizer-1" };
    expect(await effectiveEntitlements("kid-1", now)).toEqual([
      { id: "hearth_plus", expiresAt: null, source: "household" },
      { id: "caloma_plus", expiresAt: future, source: "own" },
    ]);
  });

  it("counts a legacy paid tier without entitlements as BigTable Pro", async () => {
    rows = { "solo-1": { tier: "family", entitlements: {}, expires_at: future } };
    expect(await effectiveEntitlements("solo-1", now)).toEqual([
      { id: "bigtable_plus", expiresAt: future, source: "own" },
    ]);
  });

  it("is empty with no subscription and no household", async () => {
    expect(await effectiveEntitlements("nobody", now)).toEqual([]);
  });
});

describe("effectiveTier with Hearth+", () => {
  it("gives a member Pro when the organizer has Hearth+ only", async () => {
    rows = {
      "member-1": { tier: "free", entitlements: {} },
      "organizer-1": { tier: "free", entitlements: { hearth_plus: null } },
    };
    organizerOf = { "member-1": "organizer-1" };
    const { getUsageStatus } = await import("../../src/bigtable/lib/rate-limit.js");
    expect((await getUsageStatus("member-1")).tier).toBe("pro");
  });

  it("gives Pro for someone's own Hearth+", async () => {
    rows = { "solo-2": { tier: "free", entitlements: { hearth_plus: "2099-01-01T00:00:00.000Z" } } };
    const { getUsageStatus } = await import("../../src/bigtable/lib/rate-limit.js");
    expect((await getUsageStatus("solo-2")).tier).toBe("pro");
    expect(fake.callsTo("household_memberships")).toHaveLength(0);
  });

  it("does not count other apps' plans as Pro", async () => {
    rows = { "solo-3": { tier: "free", entitlements: { suffice_plus: "2099-01-01T00:00:00.000Z" } } };
    const { getUsageStatus } = await import("../../src/bigtable/lib/rate-limit.js");
    expect((await getUsageStatus("solo-3")).tier).toBe("free");
  });
});
