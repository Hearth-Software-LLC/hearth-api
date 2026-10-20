import { fetchAnthropicMessages } from "./anthropic.js";

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5-20251001";

export type ScannedRecipeFields = {
  title: string | null;
  ingredients: string[];
  instructions: string[];
};

export class RecipeScanError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 502) {
    super(message);
    this.name = "RecipeScanError";
    this.code = code;
    this.status = status;
  }
}

/** Anthropic's error type from a failed response ("invalid_request_error"), or "unknown". Never the message. */
async function upstreamErrorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { type?: unknown } } | null;
    const type = body?.error?.type;
    return typeof type === "string" && /^[a-z_]{1,64}$/.test(type) ? type : "unknown";
  } catch {
    return "unknown";
  }
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  return text.slice(firstBrace, lastBrace + 1);
}

function normalizeLines(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeShape(payload: unknown): ScannedRecipeFields | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const source = payload as Record<string, unknown>;
  const titleRaw = source.title;
  const title = typeof titleRaw === "string" && titleRaw.trim() ? titleRaw.trim().slice(0, 160) : null;
  const ingredients = normalizeLines(source.ingredients, 80);
  const instructions = normalizeLines(source.instructions, 80);

  if (!title && ingredients.length === 0 && instructions.length === 0) {
    return null;
  }

  return {
    title,
    ingredients,
    instructions,
  };
}

export type ScanImage = {
  dataBase64: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
};

export async function scanRecipeDocumentImage(input: {
  images: ScanImage[];
}): Promise<ScannedRecipeFields> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new RecipeScanError("Recipe scan AI is not configured", "AI_NOT_CONFIGURED", 503);
  }

  if (input.images.length === 0) {
    throw new RecipeScanError("No image data provided", "AI_INVALID_INPUT", 400);
  }

  const isMultiImage = input.images.length > 1;
  const prompt = [
    isMultiImage
      ? "These images are consecutive vertical slices of a single tall screenshot, in order from top to bottom. Treat them as one continuous page and extract the single main recipe spanning across them."
      : "Extract the single main recipe from this image.",
    "Return strict JSON only with this exact shape:",
    '{"title":"...","ingredients":["..."],"instructions":["..."]}',
    "Rules:",
    "- The image may be a screenshot of a web page or app that also contains unrelated elements: site navigation, ads, banners, video players, 'most popular' or 'you may also like' or 'you'll also love' suggested-recipe lists, reader comments, star ratings, reviews, and nutrition facts. Ignore all of those and extract ONLY the one main recipe the page is about.",
    "- Use the main recipe's own title. Never use the title of a related, suggested, or advertised recipe.",
    "- Only include ingredients from the main recipe's ingredient list, and steps from its directions/method. Do not include nutrition facts, ratings, reviews, comments, or ad copy in any field.",
    isMultiImage
      ? "- An ingredient or step may be split across the boundary between two slices; reconstruct it as one entry and do not duplicate items that appear at a slice edge."
      : null,
    "- Keep ingredients as concise ingredient lines.",
    "- Keep instructions as ordered action steps without numbering (no '1.' or '1)' prefixes).",
    "- If a field is unreadable, return an empty string/array for that field.",
    "- Do not include markdown fences or any commentary.",
  ].filter((line): line is string => Boolean(line)).join("\n");

  const response = await fetchAnthropicMessages(apiKey, {
    model: ANTHROPIC_MODEL,
    max_tokens: 1200,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...input.images.map((image) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: image.mimeType,
              data: image.dataBase64,
            },
          })),
        ],
      },
    ],
  });

  if (!response) {
    throw new RecipeScanError("Recipe scan request timed out or is unavailable", "AI_UNAVAILABLE", 504);
  }

  if (!response.ok) {
    // Log the status and Anthropic's short error type (e.g. "invalid_request_error") so image
    // rejections stay diagnosable, but never the body: it can quote the request back.
    console.error("Recipe scan upstream error", { status: response.status, code: await upstreamErrorCode(response) });
    throw new RecipeScanError(
      `Recipe scan failed with upstream status ${response.status}`,
      "AI_UPSTREAM_ERROR",
      502
    );
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };

  const text = payload.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new RecipeScanError("Recipe scan returned an empty response", "AI_EMPTY_RESPONSE", 502);
  }

  const json = extractJsonObject(text);
  if (!json) {
    throw new RecipeScanError("Recipe scan returned malformed JSON", "AI_INVALID_JSON", 502);
  }

  try {
    const parsed = JSON.parse(json) as unknown;
    const normalized = normalizeShape(parsed);
    if (!normalized) {
      throw new RecipeScanError("Recipe scan returned an invalid shape", "AI_INVALID_SHAPE", 502);
    }
    return normalized;
  } catch {
    throw new RecipeScanError("Recipe scan returned malformed JSON", "AI_INVALID_JSON", 502);
  }
}
