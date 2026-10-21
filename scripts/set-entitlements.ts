// Grant or revoke Hearth plans for testing, without buying anything. Hearth Ship's Test Plans
// window runs this with --json; it works on its own from Terminal too.
//
// RevenueCat is the source of truth: this grants or revokes a promotional entitlement there, which
// is what the apps read (HearthPurchases). When the target is a real Hearth account, it then
// copies RevenueCat's active entitlements into `subscriptions` the same way the webhook does, so
// the server, /v1/me/entitlements and household sharing see the change at once.
//
// Targets
//   --email=<email>        a signed-in account (Sign in with Apple relay addresses work too)
//   --profile-id=<uuid>    a signed-in account by Supabase user id (= RevenueCat app user id)
//   --rc-id=<id>           a signed-out install, by its RevenueCat id ('$RCAnonymousID:…'; quote it).
//                          Anonymous ids are per app, so this unlocks that one app on that device.
//                          RevenueCat only, since the server has no profile for it. On Sign in with
//                          Apple, RevenueCat moves the grant to the account and the webhook records it.
//
// Plans: hearth, bigtable, suffice, sated, caloma, hearken (or their keys, e.g. suffice_plus).
//
// Examples
//   npm run entitlements -- --accounts
//   npm run entitlements -- --email=me@example.com --list
//   npm run entitlements -- --email=me@example.com --grant=hearth
//   npm run entitlements -- --profile-id=<uuid> --grant=suffice,sated --days=7
//   npm run entitlements -- --rc-id='$RCAnonymousID:abc123' --grant=caloma
//   npm run entitlements -- --email=me@example.com --revoke=all
//   Add --json for machine-readable output (one JSON object on stdout; notes go to stderr).
//
// Needs SUPABASE_URL, SUPABASE_SECRET_KEY, REVENUECAT_SECRET_API_KEY (a v2 secret key that can
// read and write customers and read entitlements) and REVENUECAT_PROJECT_ID.

import { parseArgs } from "node:util";

import {
  ENTITLEMENT_KEYS,
  normalizeEntitlementKey,
  subscriptionEntitlements,
  tierFromEntitlements,
} from "../src/services/subscriptions.js";
import type { EntitlementKey, EntitlementMap } from "../src/services/subscriptions.js";
import { ensureProfileForAccount } from "../src/services/profiles.js";
import { fetchRevenueCatEntitlements } from "../src/services/revenuecat-entitlements.js";
import { supabaseAdmin } from "../src/services/supabase.js";

// The dashboard URL shows a project's ID without the "proj" the v2 API wants; accept either.
const rawProjectId = process.env.REVENUECAT_PROJECT_ID?.trim();
if (rawProjectId && /^[0-9a-f]{8}$/i.test(rawProjectId)) process.env.REVENUECAT_PROJECT_ID = `proj${rawProjectId}`;

const NO_EXPIRY_MS = 253402300799000; // 9999-12-31, RevenueCat's "never"
const NEVER_YEAR = 9000; // expiries past this count as never

let jsonMode = false;
/** Human output; goes to stderr in --json mode so stdout holds only the JSON. */
function say(text: string): void {
  if (jsonMode) console.error(text);
  else console.log(text);
}

function usage(): never {
  console.log(`Usage: npm run entitlements -- <target> <action> [options]
         npm run entitlements -- --accounts [--find=<text>]
  target:  --email=<email> | --profile-id=<uuid> | --rc-id='$RCAnonymousID:…'
  action:  --list | --grant=<plans> | --revoke=<plans|all>   (grant and revoke can be combined)
  plans:   hearth, bigtable, suffice, sated, caloma, hearken (comma-separated)
  options: --days=<n> | --expires-at=<iso>   (grants only; default never expires)
           --dry-run   --json`);
  process.exit(0);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePlans(raw: string | undefined, allowAll: boolean): EntitlementKey[] {
  if (!raw) return [];
  if (allowAll && raw.trim().toLowerCase() === "all") return [...ENTITLEMENT_KEYS];
  return raw.split(",").map((part) => {
    const word = part.trim().toLowerCase();
    const key = normalizeEntitlementKey(word.endsWith("_plus") ? word : `${word}_plus`);
    if (!key || !(ENTITLEMENT_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Unknown plan: ${part}. Use: hearth, bigtable, suffice, sated, caloma, hearken`);
    }
    return key;
  });
}

/** Expiry as ISO, or null for never (RevenueCat's year-9999 "never" included). */
function cleanExpiry(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).getUTCFullYear() >= NEVER_YEAR) return null;
  return new Date(ms).toISOString();
}

// MARK: RevenueCat

const rc = {
  key: "",
  project: "",
  base: (process.env.REVENUECAT_API_BASE_URL?.trim() || "https://api.revenuecat.com").replace(/\/$/, ""),
};

async function rcRequest(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  return fetch(`${rc.base}/v2/projects/${encodeURIComponent(rc.project)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${rc.key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
}

async function rcFail(what: string, response: Response): Promise<never> {
  const details = await response.text().catch(() => "");
  let message = details;
  try {
    const parsed = JSON.parse(details) as { message?: unknown };
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // not JSON; keep the raw text
  }
  const hint = response.status === 403
    ? " In RevenueCat, edit this secret key's permissions: Customer information read & write, Project configuration read."
    : "";
  throw new Error(`RevenueCat ${what} failed (HTTP ${response.status}): ${message}.${hint}`);
}

type RcEntitlement = { id: string; lookupKey: string; key: EntitlementKey | null };

/** Every entitlement in the project, with the Hearth key its lookup key stands for. */
async function rcEntitlements(): Promise<RcEntitlement[]> {
  const response = await rcRequest("GET", "/entitlements?limit=100");
  if (!response.ok) await rcFail("listing entitlements", response);
  const body = (await response.json()) as { items?: Array<{ id?: string; lookup_key?: string }> };
  return (body.items ?? [])
    .filter((item): item is { id: string; lookup_key: string } => !!item.id && !!item.lookup_key)
    .map((item) => ({ id: item.id, lookupKey: item.lookup_key, key: normalizeEntitlementKey(item.lookup_key) }));
}

async function customerExists(appUserId: string): Promise<boolean> {
  const lookup = await rcRequest("GET", `/customers/${encodeURIComponent(appUserId)}`);
  if (lookup.ok) return true;
  if (lookup.status !== 404) await rcFail("customer lookup", lookup);
  return false;
}

async function ensureCustomer(appUserId: string): Promise<void> {
  if (await customerExists(appUserId)) return;
  if (appUserId.startsWith("$RCAnonymousID:")) {
    throw new Error(`RevenueCat has no customer ${appUserId}. Open the app once on that device, then copy its RevenueCat ID again.`);
  }
  const create = await rcRequest("POST", "/customers", { id: appUserId });
  if (!create.ok && create.status !== 409) await rcFail("customer create", create);
}

type Purchase = { key: EntitlementKey; store: string | null; environment: string | null; willRenew: boolean };

function entitlementIdsOf(item: Record<string, unknown>): string[] {
  const list = item.entitlements as { items?: Array<{ id?: unknown }> } | Array<{ id?: unknown }> | undefined;
  const items = Array.isArray(list) ? list : list?.items ?? [];
  return items.map((e) => e.id).filter((id): id is string => typeof id === "string");
}

/** Plans that come from a real purchase (subscription or one-time), not a promotional grant. */
async function rcPurchases(appUserId: string, entitlements: RcEntitlement[]): Promise<Purchase[]> {
  const keyById = new Map(entitlements.map((e) => [e.id, e.key]));
  const found: Purchase[] = [];
  for (const path of ["subscriptions", "purchases"]) {
    const response = await rcRequest("GET", `/customers/${encodeURIComponent(appUserId)}/${path}?limit=100`);
    if (response.status === 404) continue;
    if (!response.ok) await rcFail(`listing ${path}`, response);
    const body = (await response.json()) as { items?: Array<Record<string, unknown>> };
    for (const item of body.items ?? []) {
      const active = path === "subscriptions" ? item.gives_access === true : item.status !== "refunded";
      // Promotional grants can show up here too; only store purchases count as bought.
      if (!active || item.store === "promotional") continue;
      for (const id of entitlementIdsOf(item)) {
        const key = keyById.get(id);
        if (!key || found.some((p) => p.key === key)) continue;
        found.push({
          key,
          store: typeof item.store === "string" ? item.store : null,
          environment: typeof item.environment === "string" ? item.environment : null,
          willRenew: item.auto_renewal_status === "will_renew",
        });
      }
    }
  }
  return found;
}

// MARK: Supabase

type AuthUser = {
  id: string;
  email?: string | null;
  is_anonymous?: boolean;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
  identities?: Array<{ provider?: string }> | null;
};

async function allAuthUsers(): Promise<AuthUser[]> {
  const users: AuthUser[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      const hint = /invalid api key/i.test(error.message)
        ? " (SUPABASE_SECRET_KEY doesn't belong to the project in SUPABASE_URL, or isn't its secret/service_role key)"
        : "";
      throw new Error(`Listing auth users failed: ${error.message}${hint}`);
    }
    users.push(...(data.users as AuthUser[]));
    if (data.users.length < 200) break;
  }
  return users;
}

async function profileIdForEmail(email: string): Promise<string> {
  const wanted = email.trim().toLowerCase();
  const match = (await allAuthUsers()).find((user) => user.email?.trim().toLowerCase() === wanted);
  if (!match) throw new Error(`No account with email ${email}`);
  return match.id;
}

async function profileRow(profileId: string): Promise<{ id: string; display_name: string | null } | null> {
  const { data, error } = await supabaseAdmin.from("profiles").select("id, display_name").eq("id", profileId).maybeSingle();
  if (error) throw new Error(`Profile lookup failed: ${error.message}`);
  return (data as { id: string; display_name: string | null } | null) ?? null;
}

function signedInWithApple(user: AuthUser): boolean {
  const providers = user.app_metadata?.providers;
  return (user.identities ?? []).some((i) => i.provider === "apple")
    || (Array.isArray(providers) && providers.includes("apple"))
    || user.app_metadata?.provider === "apple";
}

function nameOf(user: AuthUser, displayName: string | null | undefined): string {
  const meta = user.user_metadata ?? {};
  const candidates = [displayName, meta.full_name, meta.name, user.email];
  const found = candidates.find((c): c is string => typeof c === "string" && c.trim().length > 0);
  return found?.trim() ?? "Unnamed account";
}

/** Active plans in a subscriptions row, as key -> expiry (null = never). */
function storedPlans(row: unknown): Record<string, string | null> {
  const plans: Record<string, string | null> = {};
  for (const entry of subscriptionEntitlements(row as Parameters<typeof subscriptionEntitlements>[0])) {
    plans[entry.id] = cleanExpiry(entry.expiresAt);
  }
  return plans;
}

/** The same write the RevenueCat webhook makes. */
async function recordInSupabase(profileId: string, entitlements: EntitlementMap): Promise<void> {
  const expiries = Object.values(entitlements);
  const expiresAt = expiries.length === 0 || expiries.includes(null)
    ? null
    : expiries.reduce((a, b) => (Date.parse(b as string) > Date.parse(a as string) ? b : a));
  const { error } = await supabaseAdmin.from("subscriptions").upsert(
    {
      profile_id: profileId,
      tier: tierFromEntitlements(entitlements),
      entitlements,
      revenuecat_user_id: profileId,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "profile_id" },
  );
  if (error) throw new Error(`subscriptions upsert failed: ${error.message}`);
}

/** Who someone shares plans with on the server (household_memberships). */
async function householdOf(profileId: string): Promise<{ organizerId: string | null; memberIds: string[] }> {
  const asMember = await supabaseAdmin.from("household_memberships").select("organizer_id").eq("member_id", profileId).maybeSingle();
  if (asMember.error) throw new Error(`Household lookup failed: ${asMember.error.message}`);
  const organizerId = (asMember.data as { organizer_id?: string } | null)?.organizer_id ?? null;
  if (organizerId && organizerId !== profileId) return { organizerId, memberIds: [] };
  const asOrganizer = await supabaseAdmin.from("household_memberships").select("member_id").eq("organizer_id", profileId);
  if (asOrganizer.error) throw new Error(`Household lookup failed: ${asOrganizer.error.message}`);
  const memberIds = ((asOrganizer.data ?? []) as Array<{ member_id: string }>).map((r) => r.member_id).filter((id) => id !== profileId);
  return { organizerId: null, memberIds };
}

// MARK: Accounts (--accounts)

type AccountJSON = {
  id: string;
  name: string;
  email: string | null;
  apple: boolean;
  hasProfile: boolean;
  role: "organizer" | "member" | "solo";
  organizerId: string | null;
  organizerName: string | null;
  householdSize: number;
  plans: Record<string, string | null>;
};

async function listAccounts(find: string | undefined): Promise<AccountJSON[]> {
  const users = (await allAuthUsers()).filter((u) => !u.is_anonymous);
  const [profiles, subs, memberships] = await Promise.all([
    supabaseAdmin.from("profiles").select("id, display_name"),
    supabaseAdmin.from("subscriptions").select("profile_id, tier, entitlements, expires_at"),
    supabaseAdmin.from("household_memberships").select("member_id, organizer_id"),
  ]);
  for (const result of [profiles, subs, memberships]) {
    if (result.error) throw new Error(`Loading accounts failed: ${result.error.message}`);
  }
  const profileById = new Map(((profiles.data ?? []) as Array<{ id: string; display_name: string | null }>).map((p) => [p.id, p]));
  const subById = new Map(((subs.data ?? []) as Array<{ profile_id: string }>).map((s) => [s.profile_id, s]));
  const links = ((memberships.data ?? []) as Array<{ member_id: string; organizer_id: string }>).filter((m) => m.member_id !== m.organizer_id);
  const organizerOf = new Map(links.map((m) => [m.member_id, m.organizer_id]));
  const memberCount = new Map<string, number>();
  for (const m of links) memberCount.set(m.organizer_id, (memberCount.get(m.organizer_id) ?? 0) + 1);

  const names = new Map(users.map((u) => [u.id, nameOf(u, profileById.get(u.id)?.display_name)]));
  const needle = find?.trim().toLowerCase();

  return users
    .map((u): AccountJSON => {
      const organizerId = organizerOf.get(u.id) ?? null;
      const members = memberCount.get(u.id) ?? 0;
      const role = organizerId ? "member" : members > 0 ? "organizer" : "solo";
      return {
        id: u.id,
        name: names.get(u.id) ?? "Unnamed account",
        email: u.email ?? null,
        apple: signedInWithApple(u),
        hasProfile: profileById.has(u.id),
        role,
        organizerId,
        organizerName: organizerId ? names.get(organizerId) ?? null : null,
        householdSize: role === "organizer" ? members + 1 : role === "member" ? (memberCount.get(organizerId as string) ?? 0) + 1 : 1,
        plans: storedPlans(subById.get(u.id) ?? null),
      };
    })
    .filter((a) => !needle || [a.name, a.email ?? "", a.id].some((field) => field.toLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// MARK: One customer's plans

type PlanJSON = {
  key: EntitlementKey;
  state: "off" | "granted" | "bought";
  expiresAt: string | null;
  store: string | null;
  environment: string | null;
  willRenew: boolean;
};

type DetailJSON = {
  appUserId: string;
  profileId: string | null;
  kind: "account" | "install";
  customerExists: boolean;
  plans: PlanJSON[];
  household: { organizerId: string; organizerName: string; plans: Record<string, string | null> } | null;
  householdSize: number;
  savedToServer: boolean;
};

async function detail(
  appUserId: string,
  profileId: string | null,
  entitlements: RcEntitlement[],
  savedToServer: boolean,
): Promise<DetailJSON> {
  const exists = await customerExists(appUserId);
  const active = exists ? await fetchRevenueCatEntitlements(appUserId) : {};
  const purchases = exists ? await rcPurchases(appUserId, entitlements) : [];

  const plans: PlanJSON[] = ENTITLEMENT_KEYS.map((key) => {
    if (!(key in active)) return { key, state: "off", expiresAt: null, store: null, environment: null, willRenew: false };
    const bought = purchases.find((p) => p.key === key);
    return {
      key,
      state: bought ? "bought" : "granted",
      expiresAt: cleanExpiry(active[key]),
      store: bought?.store ?? null,
      environment: bought?.environment ?? null,
      willRenew: bought?.willRenew ?? false,
    };
  });

  let household: DetailJSON["household"] = null;
  let householdSize = 1;
  if (profileId) {
    const { organizerId, memberIds } = await householdOf(profileId);
    if (organizerId) {
      const [sub, users, organizerProfile] = await Promise.all([
        supabaseAdmin.from("subscriptions").select("tier, entitlements, expires_at").eq("profile_id", organizerId).maybeSingle(),
        supabaseAdmin.auth.admin.getUserById(organizerId),
        profileRow(organizerId),
      ]);
      const organizerUser = (users.data?.user ?? { id: organizerId }) as AuthUser;
      household = {
        organizerId,
        organizerName: nameOf(organizerUser, organizerProfile?.display_name),
        plans: storedPlans(sub.data ?? null),
      };
      const { memberIds: siblings } = await householdOf(organizerId);
      householdSize = siblings.length + 1;
    } else {
      householdSize = memberIds.length + 1;
    }
  }

  return { appUserId, profileId, kind: profileId ? "account" : "install", customerExists: exists, plans, household, householdSize, savedToServer };
}

function describe(d: DetailJSON): string {
  const on = d.plans.filter((p) => p.state !== "off");
  const lines = on.map((p) => `  ${p.key.padEnd(14)} ${p.state.padEnd(8)} ${p.expiresAt ?? "never expires"}${p.store ? ` (${p.store})` : ""}`);
  if (d.household) {
    for (const [key, expiry] of Object.entries(d.household.plans)) {
      lines.push(`  ${key.padEnd(14)} household ${expiry ?? "never expires"} (from ${d.household.organizerName})`);
    }
  }
  return lines.length ? lines.join("\n") : "  (none)";
}

// MARK: Main

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      "profile-id": { type: "string" },
      "rc-id": { type: "string" },
      grant: { type: "string" },
      revoke: { type: "string" },
      list: { type: "boolean", default: false },
      accounts: { type: "boolean", default: false },
      find: { type: "string" },
      days: { type: "string" },
      "expires-at": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) usage();
  jsonMode = values.json;

  if (values.accounts || values.find !== undefined) {
    const accounts = await listAccounts(values.find);
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify({ accounts })}\n`);
    } else {
      for (const a of accounts) {
        const plans = Object.keys(a.plans).join(", ") || "free";
        say(`${a.name.padEnd(28)} ${(a.email ?? "").padEnd(36)} ${a.id}  ${plans}`);
      }
    }
    return;
  }

  const selectors = [values.email, values["profile-id"], values["rc-id"]].filter(Boolean);
  if (selectors.length !== 1) throw new Error("Give exactly one of --email, --profile-id or --rc-id");

  const grants = parsePlans(values.grant, false);
  const revokes = parsePlans(values.revoke, true).filter((key) => !grants.includes(key));
  if (grants.length === 0 && revokes.length === 0 && !values.list && !jsonMode) {
    throw new Error("Nothing to do: give --grant, --revoke or --list");
  }

  let expiresMs = NO_EXPIRY_MS;
  if (values.days && values["expires-at"]) throw new Error("Use --days or --expires-at, not both");
  if (values.days) {
    const days = Number(values.days);
    if (!(days > 0)) throw new Error("--days must be a positive number");
    expiresMs = Date.now() + days * 86_400_000;
  } else if (values["expires-at"]) {
    expiresMs = Date.parse(values["expires-at"]);
    if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) throw new Error("--expires-at must be a future ISO date");
  }

  rc.key = required("REVENUECAT_SECRET_API_KEY");
  rc.project = required("REVENUECAT_PROJECT_ID");

  // Who: a Hearth account (profile id = RevenueCat app user id) or a signed-out install.
  let appUserId: string;
  let profileId: string | null = null;
  if (values["rc-id"]) {
    appUserId = values["rc-id"].trim();
  } else {
    profileId = values["profile-id"]?.trim() || (await profileIdForEmail(values.email as string));
    appUserId = profileId;
    if (!(await profileRow(profileId)) && !(await ensureProfileForAccount(profileId))) {
      say(`Note: ${profileId} isn't a signed-in Hearth account (an anonymous session?), so only RevenueCat is changed.`);
      profileId = null;
    }
  }

  const entitlements = await rcEntitlements();
  const before = await detail(appUserId, profileId, entitlements, false);
  say(`Target: ${appUserId}${profileId ? " (Hearth account)" : " (RevenueCat only)"}`);
  say(`Before:\n${describe(before)}`);
  if (grants.length) say(`Grant:  ${grants.join(", ")} until ${expiresMs === NO_EXPIRY_MS ? "never" : new Date(expiresMs).toISOString()}`);
  if (revokes.length) say(`Revoke: ${revokes.join(", ")}`);

  if (values["dry-run"] || (grants.length === 0 && revokes.length === 0)) {
    if (values["dry-run"]) say("Dry run: nothing changed.");
    if (jsonMode) process.stdout.write(`${JSON.stringify(before)}\n`);
    return;
  }

  await ensureCustomer(appUserId);
  const actions = `/customers/${encodeURIComponent(appUserId)}/actions`;

  for (const key of grants) {
    const target = entitlements.find((e) => e.lookupKey === key) ?? entitlements.find((e) => e.key === key);
    if (!target) throw new Error(`RevenueCat project has no entitlement with lookup key ${key}`);
    const response = await rcRequest("POST", `${actions}/grant_entitlement`, { entitlement_id: target.id, expires_at: expiresMs });
    if (!response.ok && response.status !== 409) await rcFail(`granting ${key}`, response);
  }
  for (const key of revokes) {
    // Every entitlement that stands for this plan, so older "BigTable Pro" grants go too.
    for (const target of entitlements.filter((e) => e.key === key)) {
      const response = await rcRequest("POST", `${actions}/revoke_granted_entitlement`, { entitlement_id: target.id });
      // Revoking something that was never granted (or was bought, not granted) isn't an error here.
      if (!response.ok && ![400, 404, 409, 422].includes(response.status)) await rcFail(`revoking ${key}`, response);
    }
  }

  let saved = false;
  if (profileId) {
    await recordInSupabase(profileId, await fetchRevenueCatEntitlements(appUserId));
    saved = true;
  }
  const after = await detail(appUserId, profileId, entitlements, saved);
  say(`After:\n${describe(after)}`);
  if (saved) say("Saved to subscriptions.");
  say("Done. The app picks it up on its next refresh (bring it to the foreground, or relaunch; RevenueCat caches for up to 5 minutes).");
  if (jsonMode) process.stdout.write(`${JSON.stringify(after)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  } else {
    console.error(`set-entitlements: ${message}`);
    console.error("Run with --help for usage.");
  }
  process.exitCode = 1;
});
