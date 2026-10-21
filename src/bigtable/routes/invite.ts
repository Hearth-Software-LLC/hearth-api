import { NextRequest, NextResponse } from "../next-shim.js";
import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { supabaseAdmin } from "../../services/supabase.js";
import { serverError } from "../lib/server-error.js";

export const dynamic = "force-dynamic";

// In-memory rate limit: one invite per sender+email per hour.
const recentInvites = new Map<string, number>();

export async function POST(request: NextRequest) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { email } = body as Record<string, unknown>;
  if (typeof email !== "string" || !email.trim()) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  const rateLimitKey = `${userId}:${normalizedEmail}`;
  const lastSent = recentInvites.get(rateLimitKey) ?? 0;
  if (Date.now() - lastSent < 60 * 60 * 1000) {
    return NextResponse.json(
      { error: "You already sent an invite to this address recently. Please wait an hour before trying again." },
      { status: 429 }
    );
  }

  const { error } = await supabaseAdmin.auth.admin.inviteUserByEmail(normalizedEmail, {
    redirectTo: `${process.env.EXPO_PUBLIC_APP_SCHEME ?? "bigtable"}://auth`,
  });

  if (error) {
    const msg = error.message.toLowerCase();
    // Supabase returns an error when the user is already registered — treat
    // silently to avoid leaking whether an email exists in the system.
    if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) {
      recentInvites.set(rateLimitKey, Date.now());
      return NextResponse.json({ ok: true });
    }
    return serverError("POST /api/invite failed", "Failed to send invitation", error);
  }

  recentInvites.set(rateLimitKey, Date.now());
  return NextResponse.json({ ok: true });
}
