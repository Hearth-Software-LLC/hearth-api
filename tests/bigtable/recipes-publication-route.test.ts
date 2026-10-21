import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, eqValue, type QueryCall, type QueryResult } from "./helpers/fake-supabase.js";
import { buildAuthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const fanOutRecipePublishNotification = vi.fn();

let fake: ReturnType<typeof createFakeSupabase>;
const supabaseAdmin = {
  from: (table: string) => fake.client.from(table),
  rpc: (fn: string, args: Record<string, unknown>) => fake.client.rpc(fn, args),
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({ getUserIdFromAuthHeader }));
vi.mock("../../src/bigtable/lib/notifications.js", () => ({ fanOutRecipePublishNotification }));
vi.mock("../../src/services/supabase.js", () => ({ supabaseAdmin }));

const RECIPE_ID = "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

const body = {
  title: "Tomato Soup",
  imageUrl: "https://images.example/soup.jpg",
  description: "Cozy",
  tags: ["dinner"],
  ingredients: [
    { name: "Tomatoes", amount: 6, measurementType: "whole" },
    { name: "Salt", amount: 1, measurementType: "tsp" },
  ],
  instructions: ["Simmer", "Blend"],
};

const sameContent = {
  title: "Tomato Soup",
  description: "Cozy",
  imageUrl: "https://images.example/soup.jpg",
  prepMinutes: null,
  cookMinutes: null,
  baseServings: 8,
  difficulty: null,
  tags: ["dinner"],
  instructions: ["Simmer", "Blend"],
  ingredients: [
    { id: "old-1", name: "Salt", amount: 1, measurementType: "tsp", notes: null },
    { id: "old-2", name: "Tomatoes", amount: 6, measurementType: "whole", notes: null },
  ],
};

let existingRecipe: Record<string, unknown> | null = null;
let latestVersion: Record<string, unknown> | null = null;

function respond(call: QueryCall): QueryResult | undefined {
  if (call.table === "recipes" && call.op === "select") {
    return { data: existingRecipe };
  }
  if (call.table === "recipe_ingredients" && call.op === "insert") {
    const rows = call.payload as Array<Record<string, unknown>>;
    return { data: rows.map((row, index) => ({ id: `ing-${index + 1}`, ...row })) };
  }
  if (call.table === "recipe_versions" && call.op === "select") {
    return { data: latestVersion };
  }
  if (call.table === "recipe_versions" && call.op === "insert") {
    return { data: { id: "version-new" } };
  }
  return { data: null };
}

function put(payload: Record<string, unknown> = body) {
  return buildAuthenticatedJsonRequest(`http://localhost/v1/bigtable/recipes/${RECIPE_ID}/publication`, payload, "token", {
    method: "PUT",
  });
}

const params = { params: Promise.resolve({ id: RECIPE_ID }) };

describe("PUT /recipes/:id/publication", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    fanOutRecipePublishNotification.mockResolvedValue(undefined);
    existingRecipe = null;
    latestVersion = null;
    fake = createFakeSupabase(respond);
  });

  it("creates and publishes a new recipe under the client's id", async () => {
    const { PUT } = await import("../../src/bigtable/routes/recipes._id.publication.js");
    const response = await PUT(put(), params);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      recipeId: RECIPE_ID,
      versionId: "version-new",
      versionNumber: 1,
      status: "published",
    });

    const [insert] = fake.callsTo("recipes", "insert");
    expect(insert!.payload).toMatchObject({
      id: RECIPE_ID,
      title: "Tomato Soup",
      image_url: "https://images.example/soup.jpg",
      source_name: "user",
      created_by_profile_id: "user-1",
      status: "draft",
    });

    const [ingredientInsert] = fake.callsTo("recipe_ingredients", "insert");
    expect(ingredientInsert!.payload).toEqual([
      expect.objectContaining({ recipe_id: RECIPE_ID, name: "Tomatoes", amount: 6, measurement_type: "whole", quantity: 6, unit: "whole" }),
      expect.objectContaining({ recipe_id: RECIPE_ID, name: "Salt", amount: 1, measurement_type: "tsp" }),
    ]);

    const [versionInsert] = fake.callsTo("recipe_versions", "insert");
    expect(versionInsert!.payload).toMatchObject({ recipe_id: RECIPE_ID, version_number: 1 });
    expect((versionInsert!.payload as { content: { ingredients: unknown[] } }).content.ingredients).toHaveLength(2);

    const publishUpdate = fake.callsTo("recipes", "update").at(-1)!;
    expect(publishUpdate.payload).toMatchObject({ status: "published", current_version_id: "version-new" });
    expect((publishUpdate.payload as Record<string, unknown>).published_at).toEqual(expect.any(String));

    expect(fanOutRecipePublishNotification).toHaveBeenCalledWith(
      expect.objectContaining({ actorProfileId: "user-1", recipeId: RECIPE_ID, versionId: "version-new", isUpdate: false })
    );
  });

  it("adds a version and notifies an update when a published recipe changes", async () => {
    existingRecipe = {
      id: RECIPE_ID,
      source_name: "user",
      created_by_profile_id: "user-1",
      status: "published",
      published_at: "2026-10-01T00:00:00.000Z",
      current_version_id: "version-1",
    };
    latestVersion = { id: "version-1", version_number: 1, content: { ...sameContent, title: "Old Soup" } };

    const { PUT } = await import("../../src/bigtable/routes/recipes._id.publication.js");
    const response = await PUT(put(), params);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ versionId: "version-new", versionNumber: 2, status: "published" });
    expect(fake.callsTo("recipes", "insert")).toHaveLength(0);
    expect(fake.callsTo("recipe_ingredients", "delete")).toHaveLength(1);
    expect(fake.callsTo("recipe_versions", "insert")[0]!.payload).toMatchObject({ version_number: 2 });

    const publishUpdate = fake.callsTo("recipes", "update").at(-1)!;
    expect(publishUpdate.payload).toEqual({ status: "published", current_version_id: "version-new" });

    expect(fanOutRecipePublishNotification).toHaveBeenCalledWith(expect.objectContaining({ isUpdate: true, versionId: "version-new" }));
  });

  it("keeps the current version when nothing changed", async () => {
    existingRecipe = {
      id: RECIPE_ID,
      source_name: "user",
      created_by_profile_id: "user-1",
      status: "published",
      published_at: "2026-10-01T00:00:00.000Z",
      current_version_id: "version-1",
    };
    latestVersion = { id: "version-1", version_number: 1, content: sameContent };

    const { PUT } = await import("../../src/bigtable/routes/recipes._id.publication.js");
    const response = await PUT(put(), params);

    expect(await response.json()).toMatchObject({ versionId: "version-1", versionNumber: 1 });
    expect(fake.callsTo("recipe_versions", "insert")).toHaveLength(0);
    expect(fanOutRecipePublishNotification).not.toHaveBeenCalled();
  });

  it("refuses a recipe id that belongs to someone else", async () => {
    existingRecipe = {
      id: RECIPE_ID,
      source_name: "user",
      created_by_profile_id: "user-2",
      status: "published",
      published_at: "2026-10-01T00:00:00.000Z",
      current_version_id: "version-1",
    };

    const { PUT } = await import("../../src/bigtable/routes/recipes._id.publication.js");
    const response = await PUT(put(), params);

    expect(response.status).toBe(403);
    expect(fake.calls.filter((call) => call.op !== "select")).toHaveLength(0);
  });

  it("requires an http(s) image", async () => {
    const { PUT } = await import("../../src/bigtable/routes/recipes._id.publication.js");
    const response = await PUT(put({ ...body, imageUrl: "file:///tmp/soup.jpg" }), params);

    expect(response.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("DELETE /recipes/:id/publication", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    existingRecipe = null;
    fake = createFakeSupabase(respond);
  });

  it("unpublishes the caller's recipe and keeps the row", async () => {
    existingRecipe = { id: RECIPE_ID, source_name: "user", created_by_profile_id: "user-1" };
    const { DELETE } = await import("../../src/bigtable/routes/recipes._id.publication.js");
    const response = await DELETE(put({}), params);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, recipeId: RECIPE_ID, status: "unpublished" });
    const [update] = fake.callsTo("recipes", "update");
    expect(update!.payload).toEqual({ status: "unpublished" });
    expect(eqValue(update!, "id")).toBe(RECIPE_ID);
    expect(fake.callsTo("recipes", "delete")).toHaveLength(0);
  });

  it("answers 404 for a recipe the caller doesn't own", async () => {
    existingRecipe = { id: RECIPE_ID, source_name: "user", created_by_profile_id: "user-2" };
    const { DELETE } = await import("../../src/bigtable/routes/recipes._id.publication.js");
    const response = await DELETE(put({}), params);

    expect(response.status).toBe(404);
    expect(fake.callsTo("recipes", "update")).toHaveLength(0);
  });
});
