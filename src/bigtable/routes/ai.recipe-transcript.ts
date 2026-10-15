import { NextResponse } from "../next-shim.js";

import { createRecipeFromTranscript, RecipeAudioError } from "../lib/ai-recipe-audio.js";
import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { serverError } from "../lib/server-error.js";

type JsonObject = Record<string, unknown>;

type RecipeTranscriptPayload = {
  transcript: string;
};

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function normalizePayload(payload: JsonObject): RecipeTranscriptPayload {
  const transcriptRaw = payload.transcript;

  if (typeof transcriptRaw !== "string" || !transcriptRaw.trim()) {
    throw new Error("transcript is required");
  }

  const transcript = transcriptRaw.trim();
  if (transcript.length > 12_000) {
    throw new Error("transcript is too large");
  }

  return { transcript };
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

  let normalized: RecipeTranscriptPayload;
  try {
    normalized = normalizePayload(payload);
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Invalid payload");
  }

  try {
    const generated = await createRecipeFromTranscript(normalized.transcript);
    return NextResponse.json(generated);
  } catch (error) {
    if (error instanceof RecipeAudioError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
        },
        { status: error.status },
      );
    }

    return serverError("POST /api/ai/recipe-transcript failed", "Failed to create recipe from transcript", error);
  }
}
