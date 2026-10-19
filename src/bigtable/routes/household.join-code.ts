import { randomBytes } from "node:crypto";

import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { getMembershipContext } from "../lib/household.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../lib/supabase.js";

// A household's join code: the organizer shares it (link or QR) and whoever enters it joins the
// household and shares the organizer's subscription. Replaces the invitation flow for new builds.

type JsonObject = Record<string, unknown>;

/** 18 random bytes as base64url: 24 URL-safe characters, 144 bits. */
export function generateJoinCode(): string {
  return randomBytes(18).toString("base64url");
}

export async function POST(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: JsonObject = {};
  try {
    const parsed = (await request.json()) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      body = parsed as JsonObject;
    }
  } catch {
    body = {};
  }

  if (body.rotate !== undefined && typeof body.rotate !== "boolean") {
    return NextResponse.json({ error: "rotate must be a boolean" }, { status: 400 });
  }
  const rotate = body.rotate === true;

  try {
    const membership = await getMembershipContext(userId);
    if (membership.role === "member") {
      return NextResponse.json(
        { error: "You're a member of another household. Leave it before sharing your own." },
        { status: 409 }
      );
    }
  } catch (error) {
    return serverError("POST /household/join-code membership lookup failed", "Failed to get join code", error);
  }

  if (!rotate) {
    const existingResult = await supabaseAdmin
      .from("bigtable_join_codes")
      .select("code")
      .eq("organizer_id", userId)
      .maybeSingle();

    if (existingResult.error) {
      return serverError("POST /household/join-code lookup failed", "Failed to get join code", existingResult.error);
    }

    if (typeof existingResult.data?.code === "string" && existingResult.data.code) {
      return NextResponse.json({ code: existingResult.data.code });
    }
  }

  const code = generateJoinCode();
  const upsertResult = await supabaseAdmin
    .from("bigtable_join_codes")
    .upsert(
      { organizer_id: userId, code, created_at: new Date().toISOString() },
      { onConflict: "organizer_id" }
    );

  if (upsertResult.error) {
    return serverError("POST /household/join-code upsert failed", "Failed to get join code", upsertResult.error);
  }

  return NextResponse.json({ code });
}
