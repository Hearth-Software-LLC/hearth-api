import { NextRequest, NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { getMembershipContext } from "../lib/household.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../lib/supabase.js";

type GrocerySource = "anthropic" | "fallback" | "manual";

type GroceryItem = {
  id: string;
  name: string;
  quantity: string;
  meals: string[];
  bulk: boolean;
};

type GrocerySection = {
  name: string;
  icon: string;
  items: GroceryItem[];
};

type SnapshotRecord = {
  id: string;
  generated_at: string;
  item_count: number | string;
  estimated_cost: number | string;
  source: string;
  sections: unknown;
  checks: unknown;
  is_active: boolean;
};

type SaveSnapshotPayload = {
  id?: unknown;
  sections?: unknown;
  checks?: unknown;
  estimatedCost?: unknown;
  source?: unknown;
  makeActive?: unknown;
};

const MAX_GROCERY_QUANTITY_LENGTH = 240;

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function badRequestResponse(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function notFoundResponse(message: string) {
  return NextResponse.json({ error: message }, { status: 404 });
}

function parseChecks(value: unknown): Record<string, boolean> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("checks must be an object keyed by item id");
  }

  const checks: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      continue;
    }
    if (normalizedKey.length > 120) {
      throw new Error("check item ids must be 120 characters or fewer");
    }
    checks[normalizedKey] = Boolean(entry);
  }

  return checks;
}

function parseMeals(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .slice(0, 20);
}

function parseSections(value: unknown): GrocerySection[] {
  if (!Array.isArray(value)) {
    throw new Error("sections must be an array");
  }

  const sections = value
    .map((sectionValue) => {
      if (typeof sectionValue !== "object" || sectionValue === null || Array.isArray(sectionValue)) {
        return null;
      }

      const nameRaw = (sectionValue as { name?: unknown }).name;
      const iconRaw = (sectionValue as { icon?: unknown }).icon;
      const itemsRaw = (sectionValue as { items?: unknown }).items;

      const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
      const icon = typeof iconRaw === "string" ? iconRaw.trim() : "";
      if (!name) {
        return null;
      }
      if (name.length > 80) {
        throw new Error("section names must be 80 characters or fewer");
      }
      if (icon.length > 16) {
        throw new Error("section icons must be 16 characters or fewer");
      }
      if (!Array.isArray(itemsRaw)) {
        throw new Error("section items must be an array");
      }

      const items = itemsRaw
        .map((itemValue) => {
          if (typeof itemValue !== "object" || itemValue === null || Array.isArray(itemValue)) {
            return null;
          }

          const idRaw = (itemValue as { id?: unknown }).id;
          const nameValue = (itemValue as { name?: unknown }).name;
          const quantityRaw = (itemValue as { quantity?: unknown }).quantity;
          const mealsRaw = (itemValue as { meals?: unknown }).meals;
          const bulkRaw = (itemValue as { bulk?: unknown }).bulk;

          const id = typeof idRaw === "string" ? idRaw.trim() : "";
          const itemName = typeof nameValue === "string" ? nameValue.trim() : "";
          const quantity = typeof quantityRaw === "string" ? quantityRaw.trim() : "";

          if (!id || !itemName) {
            return null;
          }
          if (id.length > 120) {
            throw new Error("item ids must be 120 characters or fewer");
          }
          if (itemName.length > 120) {
            throw new Error("item names must be 120 characters or fewer");
          }
          if (quantity.length > MAX_GROCERY_QUANTITY_LENGTH) {
            throw new Error(`item quantities must be ${MAX_GROCERY_QUANTITY_LENGTH} characters or fewer`);
          }

          return {
            id,
            name: itemName,
            quantity,
            meals: parseMeals(mealsRaw),
            bulk: Boolean(bulkRaw),
          } satisfies GroceryItem;
        })
        .filter((entry): entry is GroceryItem => entry !== null)
        .slice(0, 500);

      return {
        name,
        icon,
        items,
      } satisfies GrocerySection;
    })
    .filter((entry): entry is GrocerySection => entry !== null)
    .slice(0, 50);

  return sections;
}

function parseEstimatedCost(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error("estimatedCost must be a non-negative number");
  }

  return Math.round(numeric * 100) / 100;
}

function parseSource(value: unknown): GrocerySource | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "anthropic" || normalized === "fallback" || normalized === "manual") {
    return normalized;
  }

  throw new Error("source must be anthropic, fallback, or manual");
}

function parseSnapshotRecord(row: SnapshotRecord) {
  const estimatedCost = parseEstimatedCost(row.estimated_cost);
  const sections = parseSections(row.sections);
  const checks = parseChecks(row.checks);
  const source = parseSource(row.source) ?? "manual";
  const itemCount = Number(row.item_count);

  return {
    id: row.id,
    generatedAtIso: row.generated_at,
    itemCount: Number.isFinite(itemCount) && itemCount >= 0 ? itemCount : sections.reduce((sum, section) => sum + section.items.length, 0),
    estimatedCost,
    source,
    sections,
    checks,
  };
}

export async function GET(request: NextRequest) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return unauthorizedResponse();
  }

  try {
    const membership = await getMembershipContext(userId);
    const effectiveUserId = membership.organizerProfileId;

    const result = await supabaseAdmin
      .from("grocery_snapshots")
      .select("id, generated_at, item_count, estimated_cost, source, sections, checks, is_active")
      .eq("user_id", effectiveUserId)
      .order("generated_at", { ascending: false })
      .limit(5);

    if (result.error) {
      throw new Error(result.error.message);
    }

    const snapshots = (result.data ?? []).map((row) => parseSnapshotRecord(row as SnapshotRecord));
    const activeSnapshot = (result.data ?? []).find((row) => row.is_active);

    return NextResponse.json({
      snapshots,
      activeSnapshotId: activeSnapshot?.id ?? snapshots[0]?.id ?? null,
    });
  } catch (error) {
    return serverError("GET /api/grocery/snapshots failed", "Failed to load grocery snapshots", error);
  }
}

export async function PUT(request: NextRequest) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return unauthorizedResponse();
  }

  let payload: SaveSnapshotPayload;
  try {
    payload = (await request.json()) as SaveSnapshotPayload;
  } catch {
    return badRequestResponse("Request body must be valid JSON");
  }

  const normalizedId = typeof payload.id === "string" && payload.id.trim() ? payload.id.trim() : null;

  try {
    const membership = await getMembershipContext(userId);
    const effectiveUserId = membership.organizerProfileId;

    if (membership.role === "member") {
      let checks: Record<string, boolean>;
      try {
        checks = parseChecks(payload.checks);
      } catch (error) {
        return badRequestResponse(error instanceof Error ? error.message : "Invalid request body");
      }

      if (!normalizedId) {
        return NextResponse.json(
          { error: "Members can only update checklist state on an existing grocery snapshot" },
          { status: 403 }
        );
      }

      const disallowedMutation = payload.sections !== undefined
        || payload.estimatedCost !== undefined
        || payload.source !== undefined
        || payload.makeActive !== undefined;

      if (disallowedMutation) {
        return NextResponse.json(
          { error: "Members can only update checklist state on an existing grocery snapshot" },
          { status: 403 }
        );
      }

      const checksOnlyUpdateResult = await supabaseAdmin
        .from("grocery_snapshots")
        .update({
          checks,
          updated_at: new Date().toISOString(),
        })
        .eq("id", normalizedId)
        .eq("user_id", effectiveUserId)
        .select("id, generated_at, item_count, estimated_cost, source, sections, checks, is_active")
        .maybeSingle();

      if (checksOnlyUpdateResult.error) {
        throw new Error(checksOnlyUpdateResult.error.message);
      }
      if (!checksOnlyUpdateResult.data) {
        return notFoundResponse("Grocery snapshot not found");
      }

      return NextResponse.json({ snapshot: parseSnapshotRecord(checksOnlyUpdateResult.data as SnapshotRecord) });
    }

    let sections: GrocerySection[];
    let checks: Record<string, boolean>;
    let estimatedCost: number;
    let source: GrocerySource | undefined;
    let makeActive = true;

    try {
      sections = parseSections(payload.sections);
      checks = parseChecks(payload.checks);
      estimatedCost = parseEstimatedCost(payload.estimatedCost);
      source = parseSource(payload.source);
      makeActive = payload.makeActive === undefined ? true : Boolean(payload.makeActive);
    } catch (error) {
      return badRequestResponse(error instanceof Error ? error.message : "Invalid request body");
    }

    const itemCount = sections.reduce((sum, section) => sum + section.items.length, 0);

    if (makeActive) {
      const deactivateQuery = supabaseAdmin
        .from("grocery_snapshots")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("user_id", effectiveUserId);

      const deactivateResult = normalizedId
        ? await deactivateQuery.neq("id", normalizedId)
        : await deactivateQuery;

      if (deactivateResult.error) {
        throw new Error(deactivateResult.error.message);
      }
    }

    if (normalizedId) {
      const updatePayload: {
        sections: GrocerySection[];
        checks: Record<string, boolean>;
        item_count: number;
        estimated_cost: number;
        updated_at: string;
        is_active: boolean;
        source?: GrocerySource;
      } = {
        sections,
        checks,
        item_count: itemCount,
        estimated_cost: estimatedCost,
        updated_at: new Date().toISOString(),
        is_active: makeActive,
      };
      if (source) {
        updatePayload.source = source;
      }

      const updateResult = await supabaseAdmin
        .from("grocery_snapshots")
        .update(updatePayload)
        .eq("id", normalizedId)
        .eq("user_id", effectiveUserId)
        .select("id, generated_at, item_count, estimated_cost, source, sections, checks, is_active")
        .maybeSingle();

      if (updateResult.error) {
        throw new Error(updateResult.error.message);
      }
      if (!updateResult.data) {
        return notFoundResponse("Grocery snapshot not found");
      }

      return NextResponse.json({ snapshot: parseSnapshotRecord(updateResult.data as SnapshotRecord) });
    }

    const insertResult = await supabaseAdmin
      .from("grocery_snapshots")
      .insert({
        user_id: effectiveUserId,
        sections,
        checks,
        item_count: itemCount,
        estimated_cost: estimatedCost,
        source: source ?? "manual",
        is_active: makeActive,
      })
      .select("id, generated_at, item_count, estimated_cost, source, sections, checks, is_active")
      .single();

    if (insertResult.error) {
      throw new Error(insertResult.error.message);
    }

    return NextResponse.json({ snapshot: parseSnapshotRecord(insertResult.data as SnapshotRecord) });
  } catch (error) {
    return serverError("PUT /api/grocery/snapshots failed", "Failed to save grocery snapshot", error);
  }
}
