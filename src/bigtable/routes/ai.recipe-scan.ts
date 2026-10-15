import { NextResponse } from "../next-shim.js";

import { scanRecipeDocumentImage, RecipeScanError } from "../lib/ai-recipe-scan.js";
import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { serverError } from "../lib/server-error.js";

type JsonObject = Record<string, unknown>;

type ScanImage = {
  dataBase64: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
};

type ScanRecipePayload = {
  images: ScanImage[];
};

const MAX_IMAGES = 8;
const MAX_IMAGE_BASE64_LENGTH = 8_000_000;
const MAX_TOTAL_BASE64_LENGTH = 24_000_000;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function normalizeImage(raw: unknown): ScanImage {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("each image must be an object");
  }

  const { dataBase64: dataBase64Raw, mimeType: mimeTypeRaw } = raw as JsonObject;

  if (typeof dataBase64Raw !== "string" || !dataBase64Raw.trim()) {
    throw new Error("dataBase64 is required");
  }

  if (typeof mimeTypeRaw !== "string") {
    throw new Error("mimeType is required");
  }

  const mimeType = mimeTypeRaw.trim().toLowerCase();
  if (mimeType !== "image/jpeg" && mimeType !== "image/png" && mimeType !== "image/webp") {
    throw new Error("mimeType must be image/jpeg, image/png, or image/webp");
  }

  if (dataBase64Raw.length > MAX_IMAGE_BASE64_LENGTH) {
    throw new Error("Image payload is too large");
  }

  return { dataBase64: dataBase64Raw.trim(), mimeType };
}

function normalizePayload(payload: JsonObject): ScanRecipePayload {
  // Prefer the multi-image shape (tiled tall screenshots); fall back to the
  // legacy single-image shape for older app builds still on { dataBase64 }.
  const rawImages = Array.isArray(payload.images)
    ? payload.images
    : payload.dataBase64 !== undefined
      ? [{ dataBase64: payload.dataBase64, mimeType: payload.mimeType }]
      : null;

  if (!rawImages || rawImages.length === 0) {
    throw new Error("images is required");
  }

  if (rawImages.length > MAX_IMAGES) {
    throw new Error(`A maximum of ${MAX_IMAGES} images is allowed`);
  }

  const images = rawImages.map(normalizeImage);

  const totalLength = images.reduce((sum, image) => sum + image.dataBase64.length, 0);
  if (totalLength > MAX_TOTAL_BASE64_LENGTH) {
    throw new Error("Image payload is too large");
  }

  return { images };
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

  let normalized: ScanRecipePayload;
  try {
    normalized = normalizePayload(payload);
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Invalid payload");
  }

  try {
    const scanned = await scanRecipeDocumentImage(normalized);
    return NextResponse.json(scanned);
  } catch (error) {
    if (error instanceof RecipeScanError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
        },
        { status: error.status }
      );
    }

    return serverError("POST /api/ai/recipe-scan failed", "Failed to scan recipe document", error);
  }
}
