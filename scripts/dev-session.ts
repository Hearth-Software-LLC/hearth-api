// A session for one Hearth account, for Hearth Ship to call hearth-api as that account (the
// Social tab's Write with Claude and platform logos). Hearth Ship runs this with the same
// .env.hearth-production keys as Test Plans, and keeps the session in the Keychain.
//
//   npm run dev-session -- --profile-id=<uuid>      sign in as that account
//   npm run dev-session -- --email=<email>          the same, by email (Apple relay addresses work)
//   npm run dev-session -- --refresh=<token>        a fresh session from a refresh token
//
// Prints one JSON object: { accessToken, refreshToken, expiresAt, userId, email }, or { error }.
// It makes a one-time magic link with the secret key and redeems it at once, so nothing is
// emailed. Anyone who can run this already holds the project's secret key; it grants nothing more.
//
// Needs SUPABASE_URL and SUPABASE_SECRET_KEY.

import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import type { Session } from "@supabase/supabase-js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function client() {
  const key = process.env.SUPABASE_SECRET_KEY?.trim() || required("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(required("SUPABASE_URL"), key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function print(session: Session) {
  process.stdout.write(`${JSON.stringify({
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at ?? Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600),
    userId: session.user.id,
    email: session.user.email ?? null,
  })}\n`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "profile-id": { type: "string" },
      email: { type: "string" },
      refresh: { type: "string" },
    },
  });

  if (values.refresh) {
    const { data, error } = await client().auth.refreshSession({ refresh_token: values.refresh });
    if (error || !data.session) throw new Error(`Refreshing the session failed: ${error?.message ?? "no session"}`);
    return print(data.session);
  }

  const admin = client();
  let email = values.email?.trim();
  if (!email && values["profile-id"]) {
    const { data, error } = await admin.auth.admin.getUserById(values["profile-id"].trim());
    if (error || !data.user) throw new Error(`No account with id ${values["profile-id"]}`);
    email = data.user.email ?? undefined;
  }
  if (!email) throw new Error("Give --profile-id, --email or --refresh");

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) throw new Error(`Making a sign-in link failed: ${linkError?.message ?? "no token"}`);

  const { data, error } = await client().auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
  if (error || !data.session) throw new Error(`Signing in failed: ${error?.message ?? "no session"}`);
  print(data.session);
}

main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exit(1);
});
