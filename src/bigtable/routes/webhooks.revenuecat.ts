import { NextRequest, NextResponse } from "../next-shim.js";

import {
  deriveTierFromRevenueCat,
  extractRevenueCatEvent,
  verifyRevenueCatAuthorizationHeader,
} from "../lib/revenuecat.js";
import { supabaseAdmin } from "../lib/supabase.js";
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

  const profileLookup = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("id", event.app_user_id)
    .maybeSingle();

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

  const projectedTier = deriveTierFromRevenueCat(event);

  const subscriptionUpsert = await supabaseAdmin.from("subscriptions").upsert(
    {
      profile_id: profileLookup.data.id,
      tier: projectedTier,
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
