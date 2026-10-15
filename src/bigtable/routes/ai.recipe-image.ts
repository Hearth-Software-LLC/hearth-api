import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { generateGeminiImage } from "../lib/gemini.js";
import { serverError } from "../lib/server-error.js";

type JsonObject = Record<string, unknown>;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function buildPrompt(payload: JsonObject) {
  const titleRaw = payload.title;
  if (typeof titleRaw !== "string" || !titleRaw.trim()) {
    throw new Error("title is required");
  }

  const descriptionRaw = payload.description;
  const description = typeof descriptionRaw === "string" && descriptionRaw.trim() ? descriptionRaw.trim() : "";

  const tagsRaw = payload.tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    : [];

  const ingredientsRaw = payload.ingredients;
  const ingredients = Array.isArray(ingredientsRaw)
    ? ingredientsRaw
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    : [];

  const instructionsRaw = payload.instructions;
  const instructions = Array.isArray(instructionsRaw)
    ? instructionsRaw
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    : [];

  if (ingredients.length === 0 || instructions.length === 0) {
    throw new Error("ingredients and instructions are required");
  }

  const promptParts = [
    "Create a realistic, appetizing recipe hero photo that accurately matches the provided recipe.",
    "No text overlays, no labels, no logos, no watermarks.",
    "Framing: close-up plated dish, natural lighting, shallow depth of field, styled food photography.",
    `Recipe title: ${titleRaw.trim()}`,
    "Ingredients:",
    ...ingredients.map((ingredient, index) => `${index + 1}. ${ingredient}`),
    "Instructions:",
    ...instructions.map((step, index) => `${index + 1}. ${step}`),
  ];

  if (tags.length > 0) {
    promptParts.push(`Tags: ${tags.join(", ")}`);
  }

  if (description) {
    promptParts.push(`Recipe description: ${description}`);
  }

  return promptParts.join("\n");
}

export async function POST(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: JsonObject;
  try {
    payload = (await request.json()) as JsonObject;
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  let prompt: string;
  try {
    prompt = buildPrompt(payload);
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Invalid payload");
  }

  try {
    const generated = await generateGeminiImage(prompt);
    return NextResponse.json({
      dataBase64: generated.dataBase64,
      mimeType: generated.mimeType,
      model: generated.model,
    });
  } catch (error) {
    return serverError("POST /api/ai/recipe-image failed", error instanceof Error ? error.message : "Failed to generate recipe image", error);
  }
}
