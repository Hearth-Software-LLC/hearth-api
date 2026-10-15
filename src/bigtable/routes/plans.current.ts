import { NextRequest, NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { getMembershipContext, resolveEffectiveProfileId } from "../lib/household.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { serverError } from "../lib/server-error.js";

const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
const SLOTS = ["breakfast", "lunch", "dinner"] as const;

type DayOfWeek = (typeof DAYS)[number];
type MealSlotType = (typeof SLOTS)[number];
type PlannerMealRole = "entree" | "side" | "dessert" | "other";
type PlannerMealItem = {
  title: string;
  role: PlannerMealRole;
  imageUrl: string | null;
  recipeId?: string | undefined;
  recipeVersionId?: string | undefined;
  source?: "library" | "custom" | "dine_out" | undefined;
  recipeStatus?: "draft" | "published" | "unpublished" | "removed" | undefined;
  currentVersionId?: string | null | undefined;
  hasUpdateAvailable?: boolean | undefined;
};

type PlannerDineOut = {
  label: string;
  name: string | null;
  address: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  logoUrl: string | null;
};

type PlannerSnackItem = {
  offId: string;
  description: string;
  brandOwner?: string;
  imageUrl?: string;
  servingSize?: string;
  calories?: number;
};

type UpdateSlotPayload = {
  weekStart?: string;
  day?: string;
  slot?: string;
  customMeal?: string | null;
  dineOut?: unknown;
  recipeItems?: unknown;
  snackItems?: unknown;
  excludedMembers?: unknown;
  completed?: boolean;
};

const DINE_OUT_PREFIX = "Dine Out: ";

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function badRequestResponse(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function sundayOf(date = new Date()) {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  normalized.setDate(normalized.getDate() - normalized.getDay());
  return normalized.toISOString().slice(0, 10);
}

async function ensureWeeklyPlan(profileId: string, weekStart: string) {
  const existingPlanResult = await supabaseAdmin
    .from("weekly_plans")
    .select("id, week_start")
    .eq("profile_id", profileId)
    .eq("week_start", weekStart)
    .maybeSingle();

  if (existingPlanResult.error) {
    throw new Error(existingPlanResult.error.message);
  }

  if (existingPlanResult.data) {
    return existingPlanResult.data;
  }

  const insertResult = await supabaseAdmin
    .from("weekly_plans")
    .insert({ profile_id: profileId, week_start: weekStart })
    .select("id, week_start")
    .single();

  // Race condition: another concurrent request inserted the row between our
  // select and this insert. Re-fetch rather than surfacing a 500.
  if (insertResult.error?.code === "23505") {
    const retryResult = await supabaseAdmin
      .from("weekly_plans")
      .select("id, week_start")
      .eq("profile_id", profileId)
      .eq("week_start", weekStart)
      .single();

    if (retryResult.error) {
      throw new Error(retryResult.error.message);
    }

    return retryResult.data;
  }

  if (insertResult.error) {
    throw new Error(insertResult.error.message);
  }

  return insertResult.data;
}

async function buildPlanResponse(profileId: string, weekStart: string) {
  const plan = await ensureWeeklyPlan(profileId, weekStart);

  const slotsResult = await supabaseAdmin
    .from("meal_slots")
    .select("id, day, slot, custom_meal, dine_out, recipe_items, snack_items, excluded_members, completed")
    .eq("plan_id", plan.id);

  if (slotsResult.error) {
    throw new Error(slotsResult.error.message);
  }

  const slotIndex = new Map(
    (slotsResult.data ?? []).map((item) => [`${item.day}:${item.slot}`, item])
  );

  const recipeIdentityRows = (slotsResult.data ?? []).flatMap((slot) =>
    parseRecipeItems(slot.recipe_items)
      .map((item) => ({ recipeId: item.recipeId, recipeVersionId: item.recipeVersionId }))
      .filter((item): item is { recipeId: string; recipeVersionId: string } =>
        typeof item.recipeId === "string"
        && item.recipeId.length > 0
        && typeof item.recipeVersionId === "string"
        && item.recipeVersionId.length > 0
      )
  );

  const uniqueRecipeIds = Array.from(new Set(recipeIdentityRows.map((item) => item.recipeId)));
  const recipeMetaById = new Map<string, { status: "draft" | "published" | "unpublished" | "removed"; currentVersionId: string | null }>();

  if (uniqueRecipeIds.length > 0) {
    const { data: recipeMetaRows, error: recipeMetaError } = await supabaseAdmin
      .from("recipes")
      .select("id, status, current_version_id")
      .in("id", uniqueRecipeIds);

    if (recipeMetaError) {
      throw new Error(recipeMetaError.message);
    }

    (recipeMetaRows ?? []).forEach((row) => {
      if (typeof row.id !== "string") {
        return;
      }
      recipeMetaById.set(row.id, {
        status: row.status,
        currentVersionId: row.current_version_id ?? null,
      });
    });
  }

  const days = Object.fromEntries(
    DAYS.map((day) => {
      const perDay = Object.fromEntries(
        SLOTS.map((slot) => {
          const item = slotIndex.get(`${day}:${slot}`);
          const parsedRecipeItems = parseRecipeItems(item?.recipe_items).map((recipeItem) => {
            if (!recipeItem.recipeId || !recipeItem.recipeVersionId) {
              return recipeItem;
            }

            const meta = recipeMetaById.get(recipeItem.recipeId);
            if (!meta) {
              return recipeItem;
            }

            return {
              ...recipeItem,
              recipeStatus: meta.status,
              currentVersionId: meta.currentVersionId,
              hasUpdateAvailable: Boolean(
                meta.currentVersionId
                && recipeItem.recipeVersionId !== meta.currentVersionId
                && meta.status === "published"
              ),
            } satisfies PlannerMealItem;
          });
          const excludedMembers = parseExcludedMembers(item?.excluded_members);
          const dineOut = parseDineOut(item?.dine_out, item?.custom_meal);
          const recipeItems = dineOut ? [] : parsedRecipeItems;
          const customMeal = dineOut ? null : item?.custom_meal ?? null;
          const snackItems = parseSnackItems(item?.snack_items);
          return [slot, {
            id: item?.id ?? null,
            customMeal,
            dineOut,
            recipeItems,
            snackItems,
            excludedMembers,
            completed: item?.completed ?? false,
          }];
        })
      );

      return [day, perDay];
    })
  );

  return {
    planId: plan.id,
    weekStart: plan.week_start,
    days,
  };
}

function parseRecipeItems(value: unknown): PlannerMealItem[] {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry): PlannerMealItem | null => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          return null;
        }

        const titleRaw = (entry as { title?: unknown }).title;
        const roleRaw = (entry as { role?: unknown }).role;
        const imageUrlRaw = (entry as { imageUrl?: unknown }).imageUrl;
        const recipeIdRaw = (entry as { recipeId?: unknown }).recipeId;
        const recipeVersionIdRaw = (entry as { recipeVersionId?: unknown }).recipeVersionId;
        const sourceRaw = (entry as { source?: unknown }).source;
        const title = typeof titleRaw === "string" ? titleRaw.trim() : "";
        const role = roleRaw === "entree" || roleRaw === "side" || roleRaw === "dessert" || roleRaw === "other"
          ? roleRaw
          : "other";
        const imageUrl = typeof imageUrlRaw === "string" ? imageUrlRaw.trim() || null : null;
        const recipeId = typeof recipeIdRaw === "string" ? recipeIdRaw.trim() : "";
        const recipeVersionId = typeof recipeVersionIdRaw === "string" ? recipeVersionIdRaw.trim() : "";
        const source = sourceRaw === "library" || sourceRaw === "custom" || sourceRaw === "dine_out"
          ? sourceRaw
          : undefined;

        if (!title) {
          return null;
        }

        if ((recipeId && !recipeVersionId) || (!recipeId && recipeVersionId)) {
          return null;
        }

        return {
          title,
          role,
          imageUrl,
          ...(recipeId ? { recipeId } : {}),
          ...(recipeVersionId ? { recipeVersionId } : {}),
          source,
        };
      })
      .filter((entry): entry is PlannerMealItem => entry !== null)
      .slice(0, 8);

    if (normalized.length > 0) {
      return normalized;
    }
  }

  return [];
}

function parseLegacyDineOutCustomMeal(value: string | null | undefined): PlannerDineOut | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith(DINE_OUT_PREFIX.toLowerCase())) {
    return null;
  }

  const label = trimmed.slice(DINE_OUT_PREFIX.length).trim();
  if (!label) {
    return null;
  }

  return {
    label,
    name: null,
    address: null,
    phone: null,
    latitude: null,
    longitude: null,
    logoUrl: null,
  };
}

function parseDineOut(value: unknown, legacyCustomMeal?: string | null): PlannerDineOut | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return parseLegacyDineOutCustomMeal(legacyCustomMeal);
  }

  const labelRaw = (value as { label?: unknown }).label;
  const nameRaw = (value as { name?: unknown }).name;
  const addressRaw = (value as { address?: unknown }).address;
  const phoneRaw = (value as { phone?: unknown }).phone;
  const latitudeRaw = (value as { latitude?: unknown }).latitude;
  const longitudeRaw = (value as { longitude?: unknown }).longitude;
  const logoUrlRaw = (value as { logoUrl?: unknown }).logoUrl;

  const label = typeof labelRaw === "string" ? labelRaw.trim() : "";
  const name = typeof nameRaw === "string" ? nameRaw.trim() || null : null;
  const address = typeof addressRaw === "string" ? addressRaw.trim() || null : null;
  const phone = typeof phoneRaw === "string" ? phoneRaw.trim() || null : null;
  const latitude = typeof latitudeRaw === "number" && Number.isFinite(latitudeRaw) ? latitudeRaw : null;
  const longitude = typeof longitudeRaw === "number" && Number.isFinite(longitudeRaw) ? longitudeRaw : null;
  const logoUrl = typeof logoUrlRaw === "string" ? logoUrlRaw.trim() || null : null;

  if (!label) {
    return parseLegacyDineOutCustomMeal(legacyCustomMeal);
  }

  return {
    label,
    name,
    address,
    phone,
    latitude,
    longitude,
    logoUrl,
  };
}

function normalizeDineOut(value: unknown): PlannerDineOut | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dineOut must be an object or null");
  }

  const labelRaw = (value as { label?: unknown }).label;
  const label = typeof labelRaw === "string" ? labelRaw.trim() : "";
  if (!label) {
    throw new Error("dineOut.label is required");
  }
  if (label.length > 160) {
    throw new Error("dineOut.label must be 160 characters or fewer");
  }

  const normalizeNullableText = (raw: unknown, fieldName: string, maxLength: number) => {
    if (raw === undefined || raw === null) {
      return null;
    }
    if (typeof raw !== "string") {
      throw new Error(`dineOut.${fieldName} must be a string`);
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.length > maxLength) {
      throw new Error(`dineOut.${fieldName} must be ${maxLength} characters or fewer`);
    }
    return trimmed;
  };

  const normalizeNullableNumber = (raw: unknown, fieldName: string) => {
    if (raw === undefined || raw === null) {
      return null;
    }
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      throw new Error(`dineOut.${fieldName} must be a number`);
    }
    return raw;
  };

  return {
    label,
    name: normalizeNullableText((value as { name?: unknown }).name, "name", 120),
    address: normalizeNullableText((value as { address?: unknown }).address, "address", 200),
    phone: normalizeNullableText((value as { phone?: unknown }).phone, "phone", 40),
    latitude: normalizeNullableNumber((value as { latitude?: unknown }).latitude, "latitude"),
    longitude: normalizeNullableNumber((value as { longitude?: unknown }).longitude, "longitude"),
    logoUrl: normalizeNullableText((value as { logoUrl?: unknown }).logoUrl, "logoUrl", 400),
  };
}

function parseSnackItems(value: unknown): PlannerSnackItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry): PlannerSnackItem | null => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return null;
      }
      const offIdRaw = (entry as { offId?: unknown }).offId;
      const descriptionRaw = (entry as { description?: unknown }).description;
      if (typeof offIdRaw !== "string" || !offIdRaw.trim()) return null;
      if (typeof descriptionRaw !== "string" || !descriptionRaw.trim()) return null;

      const brandOwnerRaw = (entry as { brandOwner?: unknown }).brandOwner;
      const imageUrlRaw = (entry as { imageUrl?: unknown }).imageUrl;
      const servingSizeRaw = (entry as { servingSize?: unknown }).servingSize;
      const caloriesRaw = (entry as { calories?: unknown }).calories;

      return {
        offId: offIdRaw.trim(),
        description: descriptionRaw.trim(),
        ...(typeof brandOwnerRaw === "string" && brandOwnerRaw.trim() ? { brandOwner: brandOwnerRaw.trim() } : {}),
        ...(typeof imageUrlRaw === "string" && imageUrlRaw.trim() ? { imageUrl: imageUrlRaw.trim() } : {}),
        ...(typeof servingSizeRaw === "string" && servingSizeRaw.trim() ? { servingSize: servingSizeRaw.trim() } : {}),
        ...(typeof caloriesRaw === "number" && Number.isFinite(caloriesRaw) ? { calories: Math.round(caloriesRaw) } : {}),
      };
    })
    .filter((entry): entry is PlannerSnackItem => entry !== null)
    .slice(0, 40);
}

function normalizeSnackItems(value: unknown): PlannerSnackItem[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("snackItems must be an array");
  }

  return value
    .map((entry): PlannerSnackItem | null => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return null;
      }
      const offIdRaw = (entry as { offId?: unknown }).offId;
      const descriptionRaw = (entry as { description?: unknown }).description;
      if (typeof offIdRaw !== "string" || !offIdRaw.trim()) return null;
      if (typeof descriptionRaw !== "string" || !descriptionRaw.trim()) return null;
      if (descriptionRaw.trim().length > 200) {
        throw new Error("snackItems description must be 200 characters or fewer");
      }

      const brandOwnerRaw = (entry as { brandOwner?: unknown }).brandOwner;
      const imageUrlRaw = (entry as { imageUrl?: unknown }).imageUrl;
      const servingSizeRaw = (entry as { servingSize?: unknown }).servingSize;
      const caloriesRaw = (entry as { calories?: unknown }).calories;

      return {
        offId: offIdRaw.trim(),
        description: descriptionRaw.trim(),
        ...(typeof brandOwnerRaw === "string" && brandOwnerRaw.trim() ? { brandOwner: brandOwnerRaw.trim() } : {}),
        ...(typeof imageUrlRaw === "string" && imageUrlRaw.trim() ? { imageUrl: imageUrlRaw.trim() } : {}),
        ...(typeof servingSizeRaw === "string" && servingSizeRaw.trim() ? { servingSize: servingSizeRaw.trim() } : {}),
        ...(typeof caloriesRaw === "number" && Number.isFinite(caloriesRaw) ? { calories: Math.round(caloriesRaw) } : {}),
      };
    })
    .filter((entry): entry is PlannerSnackItem => entry !== null)
    .slice(0, 40);
}

function parseExcludedMembers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeRecipeItems(value: unknown): PlannerMealItem[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .map((entry): PlannerMealItem | null => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return null;
      }

      const titleRaw = (entry as { title?: unknown }).title;
      const roleRaw = (entry as { role?: unknown }).role;
      const imageUrlRaw = (entry as { imageUrl?: unknown }).imageUrl;
      const recipeIdRaw = (entry as { recipeId?: unknown }).recipeId;
      const recipeVersionIdRaw = (entry as { recipeVersionId?: unknown }).recipeVersionId;
      const sourceRaw = (entry as { source?: unknown }).source;
      const title = typeof titleRaw === "string" ? titleRaw.trim() : "";
      if (!title) {
        return null;
      }
      if (title.length > 120) {
        throw new Error("Each recipe item title must be 120 characters or fewer");
      }

      const role = roleRaw === "entree" || roleRaw === "side" || roleRaw === "dessert" || roleRaw === "other"
        ? roleRaw
        : "other";
      const imageUrl = typeof imageUrlRaw === "string" ? imageUrlRaw.trim() || null : null;
      const recipeId = typeof recipeIdRaw === "string" ? recipeIdRaw.trim() : "";
      const recipeVersionId = typeof recipeVersionIdRaw === "string" ? recipeVersionIdRaw.trim() : "";

      if ((recipeId && !recipeVersionId) || (!recipeId && recipeVersionId)) {
        throw new Error("recipeItems recipeId and recipeVersionId must be provided together");
      }

      const source = sourceRaw === undefined
        ? undefined
        : (sourceRaw === "library" || sourceRaw === "custom" || sourceRaw === "dine_out"
          ? sourceRaw
          : null);

      if (source === null) {
        throw new Error("recipeItems source must be library, custom, or dine_out");
      }

      return {
        title,
        role,
        imageUrl,
        ...(recipeId ? { recipeId } : {}),
        ...(recipeVersionId ? { recipeVersionId } : {}),
        source,
      };
    })
    .filter((entry): entry is PlannerMealItem => entry !== null)
    .slice(0, 8);

  return normalized;
}

function normalizeExcludedMembers(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .slice(0, 20);
}

function normalizePayload(payload: UpdateSlotPayload) {
  const day = payload.day?.toLowerCase() as DayOfWeek | undefined;
  const slot = payload.slot?.toLowerCase() as MealSlotType | undefined;

  if (!day || !DAYS.includes(day)) {
    throw new Error("day must be one of monday-sunday");
  }
  if (!slot || !SLOTS.includes(slot)) {
    throw new Error("slot must be one of breakfast, lunch, dinner");
  }

  const hasCustomMeal = payload.customMeal !== undefined;
  const customMeal = hasCustomMeal ? payload.customMeal?.trim() || null : undefined;
  if (customMeal && customMeal.length > 120) {
    throw new Error("customMeal must be 120 characters or fewer");
  }

  const dineOut = normalizeDineOut(payload.dineOut);
  const recipeItems = normalizeRecipeItems(payload.recipeItems);
  const snackItems = normalizeSnackItems(payload.snackItems);
  const excludedMembers = normalizeExcludedMembers(payload.excludedMembers);

  const weekStart = payload.weekStart?.trim() ?? null;
  if (weekStart && !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    throw new Error("weekStart must be YYYY-MM-DD");
  }

  return {
    weekStart,
    day,
    slot,
    customMeal,
    dineOut,
    recipeItems,
    snackItems,
    excludedMembers,
    completed: payload.completed === undefined ? undefined : Boolean(payload.completed),
  };
}

export async function GET(request: NextRequest) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return unauthorizedResponse();
  }

  const weekStart = new URL(request.url).searchParams.get("weekStart") ?? sundayOf();

  try {
    const effectiveProfileId = await resolveEffectiveProfileId(userId);
    const result = await buildPlanResponse(effectiveProfileId, weekStart);
    return NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=10" } });
  } catch (error) {
    return serverError("GET /api/plans/current failed", "Failed to load plan", error);
  }
}

export async function PUT(request: NextRequest) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return unauthorizedResponse();
  }

  try {
    const membership = await getMembershipContext(userId);
    if (membership.role === "member") {
      const permissionsResult = await supabaseAdmin
        .from("household_member_permissions")
        .select("can_manage_meal_plan")
        .eq("member_id", userId)
        .maybeSingle();

      if (!permissionsResult.data?.can_manage_meal_plan) {
        return NextResponse.json({ error: "You don't have permission to edit the meal plan" }, { status: 403 });
      }
    }
  } catch (error) {
    return serverError("PUT /api/plans/current membership lookup failed", "Failed to update plan", error);
  }

  let payload: UpdateSlotPayload;
  try {
    payload = (await request.json()) as UpdateSlotPayload;
  } catch {
    return badRequestResponse("Request body must be valid JSON");
  }

  let normalized: ReturnType<typeof normalizePayload>;
  try {
    normalized = normalizePayload(payload);
  } catch (error) {
    return badRequestResponse(error instanceof Error ? error.message : "Invalid request body");
  }

  const weekStart = normalized.weekStart ?? sundayOf();

  try {
    const plan = await ensureWeeklyPlan(userId, weekStart);

    const existingSlotResult = await supabaseAdmin
      .from("meal_slots")
      .select("custom_meal, dine_out, recipe_items, snack_items, excluded_members, completed")
      .eq("plan_id", plan.id)
      .eq("day", normalized.day)
      .eq("slot", normalized.slot)
      .maybeSingle();

    if (existingSlotResult.error) {
      throw new Error(existingSlotResult.error.message);
    }

    const existingSlot = existingSlotResult.data;
    const existingDineOut = parseDineOut(existingSlot?.dine_out, existingSlot?.custom_meal ?? null);
    const dineOut = normalized.dineOut !== undefined ? normalized.dineOut : existingDineOut;
    const recipeItems = dineOut
      ? []
      : normalized.recipeItems ?? parseRecipeItems(existingSlot?.recipe_items);
    const customMeal = dineOut
      ? null
      : (normalized.customMeal !== undefined
        ? normalized.customMeal
        : recipeItems[0]?.title ?? existingSlot?.custom_meal ?? null);
    const snackItems = normalized.snackItems ?? parseSnackItems(existingSlot?.snack_items);
    const excludedMembers = normalized.excludedMembers
      ?? parseExcludedMembers(existingSlot?.excluded_members);
    const completed = normalized.completed ?? existingSlot?.completed ?? false;

    const updateResult = await supabaseAdmin
      .from("meal_slots")
      .upsert(
        {
          plan_id: plan.id,
          day: normalized.day,
          slot: normalized.slot,
          custom_meal: customMeal,
          dine_out: dineOut,
          recipe_items: recipeItems,
          snack_items: snackItems,
          excluded_members: excludedMembers,
          completed,
        },
        { onConflict: "plan_id,day,slot" }
      )
      .select("id")
      .single();

    if (updateResult.error) {
      throw new Error(updateResult.error.message);
    }

    return NextResponse.json({
      day: normalized.day,
      slot: normalized.slot,
      weekStart,
      planId: plan.id,
      slotData: {
        id: updateResult.data.id ?? null,
        customMeal,
        dineOut: dineOut ?? null,
        recipeItems,
        snackItems,
        excludedMembers,
        completed,
      },
    });
  } catch (error) {
    return serverError("PUT /api/plans/current failed", "Failed to update plan", error);
  }
}
