import { NextRequest, NextResponse } from "../next-shim.js";

import { applyEventToEntitlements, parseEntitlementMap, tierFromEntitlements } from "../../services/subscriptions.js";
import type { EntitlementMap } from "../../services/subscriptions.js";
import { extractRevenueCatEvent, verifyRevenueCatAuthorizationHeader } from "../../services/revenuecat.js";
import { fetchRevenueCatEntitlements } from "../../services/revenuecat-entitlements.js";
import { ensureProfileForAccount } from "../../services/profiles.js";
import { supabaseAdmin } from "../../services/supabase.js";
import { serverError } from "../lib/server-error.js";

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ error: "REVENUECAT_WEBHOOK_SECRET is not configured" }, { status: 500 });
  }

  const authorization = request.headers.get("authorization");
  if (!verifyRevenueCatAuthorizationHeader(authorization, webhookSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rawBody = "";
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: "Request body must be text" }, { status: 400 });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  let event: ReturnType<typeof extractRevenueCatEvent>;
  try {
    event = extractRevenueCatEvent(parsedBody as Record<string, unknown>);
  } catch (error) {
    console.error("POST /api/webhooks/revenuecat invalid payload", error);
    return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });
  }

  const existingEvent = await supabaseAdmin
    .from("revenuecat_webhook_events")
    .select("event_id")
    .eq("event_id", event.id)
    .maybeSingle();

  if (existingEvent.error) {
    return serverError(
      "POST /api/webhooks/revenuecat existing event lookup failed",
      "Failed to process webhook",
      existingEvent.error
    );
  }

  if (existingEvent.data) {
    return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
  }

  let profileLookup = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("id", event.app_user_id)
    .maybeSingle();

  // A Hearth account that never saved a profile (it signed in from an app other than BigTable)
  // still gets its plans recorded: create the profile, then look again.
  if (!profileLookup.error && !profileLookup.data && (await ensureProfileForAccount(event.app_user_id))) {
    profileLookup = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("id", event.app_user_id)
      .maybeSingle();
  }

  if (profileLookup.error) {
    return serverError(
      "POST /api/webhooks/revenuecat profile lookup failed",
      "Failed to process webhook",
      profileLookup.error
    );
  }

  if (!profileLookup.data) {
    const orphanInsert = await supabaseAdmin.from("revenuecat_webhook_events").insert({
      event_id: event.id,
      event_type: event.type,
      profile_id: null,
      payload: parsedBody,
    });

    if (orphanInsert.error) {
      return serverError(
        "POST /api/webhooks/revenuecat orphan insert failed",
        "Failed to process webhook",
        orphanInsert.error
      );
    }

    return NextResponse.json({ ok: true, ignored: true }, { status: 202 });
  }

  // Refresh the customer's whole entitlement set from RevenueCat. If its API can't be reached,
  // apply this event to what's stored instead.
  let entitlements: EntitlementMap;
  try {
    entitlements = await fetchRevenueCatEntitlements(event.app_user_id);
  } catch (refreshError) {
    console.warn(
      "POST /api/webhooks/revenuecat entitlement refresh failed; applying the event instead",
      refreshError instanceof Error ? refreshError.message : refreshError
    );
    const stored = await supabaseAdmin
      .from("subscriptions")
      .select("entitlements")
      .eq("profile_id", profileLookup.data.id)
      .maybeSingle();
    if (stored.error) {
      return serverError(
        "POST /api/webhooks/revenuecat stored entitlements lookup failed",
        "Failed to process webhook",
        stored.error
      );
    }
    entitlements = applyEventToEntitlements(parseEntitlementMap(stored.data?.entitlements), event);
  }

  const subscriptionUpsert = await supabaseAdmin.from("subscriptions").upsert(
    {
      profile_id: profileLookup.data.id,
      // BigTable's AI limits read `tier`: Pro while BigTable Plus or Hearth+ is active.
      tier: tierFromEntitlements(entitlements),
      entitlements,
      revenuecat_user_id: event.app_user_id,
      expires_at: event.expires_at,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "profile_id" }
  );

  if (subscriptionUpsert.error) {
    return serverError(
      "POST /api/webhooks/revenuecat subscription upsert failed",
      "Failed to process webhook",
      subscriptionUpsert.error
    );
  }

  const eventInsert = await supabaseAdmin.from("revenuecat_webhook_events").insert({
    event_id: event.id,
    event_type: event.type,
    profile_id: profileLookup.data.id,
    payload: parsedBody,
  });

  if (eventInsert.error) {
    return serverError(
      "POST /api/webhooks/revenuecat event insert failed",
      "Failed to process webhook",
      eventInsert.error
    );
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
