import { NextResponse } from "../next-shim.js";

import { createRecipeFromAudio, RecipeAudioError } from "../lib/ai-recipe-audio.js";
import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { serverError } from "../lib/server-error.js";

type JsonObject = Record<string, unknown>;

type RecipeAudioPayload = {
  dataBase64: string;
  mimeType:
    | "audio/mp4"
    | "audio/m4a"
    | "audio/aac"
    | "audio/mpeg"
    | "audio/mp3"
    | "audio/wav"
    | "audio/x-wav"
    | "audio/webm"
    | "audio/ogg";
};

type AudioMimeType = RecipeAudioPayload["mimeType"];

const SUPPORTED_AUDIO_MIME_TYPES = new Set<string>([
  "audio/mp4",
  "audio/m4a",
  "audio/aac",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
]);

function isSupportedAudioMimeType(value: string): value is AudioMimeType {
  return SUPPORTED_AUDIO_MIME_TYPES.has(value);
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function normalizePayload(payload: JsonObject): RecipeAudioPayload {
  const dataBase64Raw = payload.dataBase64;
  const mimeTypeRaw = payload.mimeType;

  if (typeof dataBase64Raw !== "string" || !dataBase64Raw.trim()) {
    throw new Error("dataBase64 is required");
  }

  if (typeof mimeTypeRaw !== "string") {
    throw new Error("mimeType is required");
  }

  const mimeType = mimeTypeRaw.trim().toLowerCase();
  if (!isSupportedAudioMimeType(mimeType)) {
    throw new Error("mimeType must be a supported audio content type");
  }

  if (dataBase64Raw.length > 20_000_000) {
    throw new Error("Audio payload is too large");
  }

  return {
    dataBase64: dataBase64Raw.trim(),
    mimeType,
  };
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

  let normalized: RecipeAudioPayload;
  try {
    normalized = normalizePayload(payload);
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Invalid payload");
  }

  try {
    const generated = await createRecipeFromAudio(normalized);
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

    return serverError("POST /api/ai/recipe-audio failed", "Failed to create recipe from audio", error);
  }
}
