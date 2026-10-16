import { fetchAnthropicMessages } from "./anthropic.js";

export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5-20251001";

// Must stay in sync with RECIPE_QUICK_FILTERS in apps/mobile/lib/app-constants.ts (minus "All").
export const SUPPORTED_RECIPE_TAGS = [
  "breakfast", "lunch", "dinner", "dessert", "side",
  "beef", "chicken", "seafood", "pork", "lamb",
  "vegetarian", "vegan", "gluten-free", "dairy-free", "kosher", "halal", "high-protein",
  "italian", "mexican", "french", "american", "british", "spanish", "greek",
  "mediterranean", "middle-eastern", "caribbean", "african",
  "indian", "thai", "japanese", "chinese", "vietnamese", "korean", "eastern-european",
] as const;

const SUPPORTED_TAGS_SET = new Set<string>(SUPPORTED_RECIPE_TAGS);
const WHISPER_MODEL = "whisper-1";
const WHISPER_REQUEST_TIMEOUT_MS = 30_000;

type AudioMimeType =
  | "audio/mp4"
  | "audio/m4a"
  | "audio/aac"
  | "audio/mpeg"
  | "audio/mp3"
  | "audio/wav"
  | "audio/x-wav"
  | "audio/webm"
  | "audio/ogg";

export type AudioRecipeFields = {
  isRecipe: boolean;
  title: string | null;
  description: string | null;
  baseServings: number | null;
  tags: string[];
  ingredients: string[];
  instructions: string[];
  failureReason: string | null;
  /** Hands-on prep and cooking time in whole minutes, when known. */
  prepMinutes?: number | null;
  cookMinutes?: number | null;
  difficulty?: "easy" | "medium" | "hard" | null;
};

export class RecipeAudioError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 502) {
    super(message);
    this.name = "RecipeAudioError";
    this.code = code;
    this.status = status;
  }
}

function audioMimeTypeToExtension(mimeType: AudioMimeType): string {
  switch (mimeType) {
    case "audio/m4a": return "m4a";
    case "audio/aac": return "aac";
    case "audio/mpeg":
    case "audio/mp3": return "mp3";
    case "audio/wav":
    case "audio/x-wav": return "wav";
    case "audio/webm": return "webm";
    case "audio/ogg": return "ogg";
    case "audio/mp4": return "mp4";
  }
}

export const RECIPE_JSON_SHAPE =
  '{"isRecipe":true,"title":"...","description":"...","baseServings":4,"prepMinutes":15,"cookMinutes":40,"difficulty":"easy","tags":["..."],"ingredients":["..."],"instructions":["..."],"failureReason":null}';

export const RECIPE_TIMING_RULE =
  "- prepMinutes and cookMinutes are whole minutes (estimate when not stated); difficulty is one of easy, medium, hard.";

function buildRecipeExtractionPrompt(): string {
  return [
    "Analyze this voice note. The user is either describing a recipe or requesting one to be created.",
    "In either case, generate a complete, detailed recipe and return strict JSON only with this exact shape:",
    RECIPE_JSON_SHAPE,
    "Rules:",
    "- A short request (e.g. 'a casserole with chicken, broccoli and cheese') names the key ingredients, not all of them. Write a real, complete recipe a home cook would be proud of: include everything the dish needs, such as aromatics, fats, seasonings, liquids, sauces, binders and toppings.",
    "- When the user describes their own recipe in detail, keep to what they said and only fill obvious gaps.",
    "- If the voice note has nothing to do with food or recipes, return isRecipe=false and a short failureReason. Keep all recipe fields null/empty.",
    "- If the user requests a recipe (e.g. 'make me a recipe for...'), generate a complete recipe that satisfies their request including any dietary or style constraints they mention.",
    "- description should be 1-2 concise sentences.",
    "- baseServings should be an integer between 1 and 50 when present.",
    RECIPE_TIMING_RULE,
    `- tags must only use values from this exact list (lowercase): ${SUPPORTED_RECIPE_TAGS.join(", ")}. Do not invent tags outside this list.`,
    "- ingredients should be concise ingredient lines with amounts.",
    "- instructions should be ordered action steps without numbering (no '1.' or '1)' prefixes).",
    "- Do not include markdown fences or any commentary.",
  ].join("\n");
}

async function transcribeAudioWithWhisper(input: {
  dataBase64: string;
  mimeType: AudioMimeType;
}): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }

  const buffer = Buffer.from(input.dataBase64, "base64");
  const ext = audioMimeTypeToExtension(input.mimeType);
  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: input.mimeType }), `audio.${ext}`);
  formData.append("model", WHISPER_MODEL);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WHISPER_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    return null;
  }

  clearTimeout(timeout);
  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as { text?: string };
  return payload.text?.trim() || null;
}

async function extractRecipeFromTranscriptWithAnthropic(transcript: string): Promise<AudioRecipeFields | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }

  const response = await fetchAnthropicMessages(apiKey, {
    model: ANTHROPIC_MODEL,
    max_tokens: 2500,
    temperature: 0.4,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [buildRecipeExtractionPrompt(), "", "Transcript:", transcript].join("\n"),
          },
        ],
      },
    ],
  });

  if (!response || !response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = payload.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    return null;
  }

  const json = extractJsonObject(text);
  if (!json) {
    return null;
  }

  try {
    const parsed = JSON.parse(json) as unknown;
    return normalizeShape(parsed);
  } catch {
    return null;
  }
}


export function extractJsonObject(text: string): string | null {
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

function normalizeTags(value: unknown): string[] {
  return filterSupportedTags(value);
}

// Reduces an arbitrary list of candidate tag strings to the supported, lowercase
// tag vocabulary. Shared with the URL importer so structured page metadata
// (keywords, recipeCategory, recipeCuisine) maps onto the same tag set.
export function filterSupportedTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const tag of value) {
    if (typeof tag !== "string") {
      continue;
    }
    const normalized = tag.trim().toLowerCase().replace(/[^a-z0-9_\-\s]/g, "");
    if (!normalized || seen.has(normalized) || !SUPPORTED_TAGS_SET.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    tags.push(normalized);
    if (tags.length >= 10) {
      break;
    }
  }

  return tags;
}

function normalizeServings(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.round(value);
    if (rounded >= 1 && rounded <= 50) {
      return rounded;
    }
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 50) {
      return parsed;
    }
  }

  return null;
}

export function normalizeShape(payload: unknown): AudioRecipeFields | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const source = payload as Record<string, unknown>;
  const isRecipe = Boolean(source.isRecipe);
  const titleRaw = source.title;
  const title = typeof titleRaw === "string" && titleRaw.trim() ? titleRaw.trim().slice(0, 160) : null;
  const descriptionRaw = source.description;
  const description = typeof descriptionRaw === "string" && descriptionRaw.trim()
    ? descriptionRaw.trim().slice(0, 450)
    : null;
  const baseServings = normalizeServings(source.baseServings);
  const tags = normalizeTags(source.tags);
  const ingredients = normalizeLines(source.ingredients, 80);
  const instructions = normalizeLines(source.instructions, 80);
  const failureReasonRaw = source.failureReason;
  const failureReason = typeof failureReasonRaw === "string" && failureReasonRaw.trim()
    ? failureReasonRaw.trim().slice(0, 220)
    : null;

  const prepMinutes = normalizeMinutes(source.prepMinutes);
  const cookMinutes = normalizeMinutes(source.cookMinutes);
  const difficulty = normalizeDifficulty(source.difficulty);

  if (!isRecipe) {
    return {
      isRecipe: false,
      title: null,
      description: null,
      baseServings: null,
      tags: [],
      ingredients: [],
      instructions: [],
      failureReason,
    };
  }

  if (!title && !description && !baseServings && tags.length === 0 && ingredients.length === 0 && instructions.length === 0) {
    return null;
  }

  return {
    isRecipe: true,
    title,
    description,
    baseServings,
    tags,
    ingredients,
    instructions,
    failureReason: null,
    prepMinutes,
    cookMinutes,
    difficulty,
  };
}

function normalizeMinutes(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const rounded = Math.round(parsed);
  return rounded >= 1 && rounded <= 2880 ? rounded : null;
}

function normalizeDifficulty(value: unknown): "easy" | "medium" | "hard" | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "easy" || normalized === "medium" || normalized === "hard" ? normalized : null;
}

export async function createRecipeFromAudio(input: {
  dataBase64: string;
  mimeType: AudioMimeType;
}): Promise<AudioRecipeFields> {
  const transcript = await transcribeAudioWithWhisper(input);
  if (!transcript || !transcript.trim()) {
    throw new RecipeAudioError(
      "Audio transcription is unavailable. Configure OPENAI_API_KEY for cloud transcription.",
      "AI_TRANSCRIPTION_UNAVAILABLE",
      503,
    );
  }

  return createRecipeFromTranscript(transcript);
}

export async function createRecipeFromTranscript(transcript: string): Promise<AudioRecipeFields> {
  const normalizedTranscript = transcript.trim();
  if (!normalizedTranscript) {
    throw new RecipeAudioError("Transcript is empty", "INVALID_TRANSCRIPT", 400);
  }

  const result = await extractRecipeFromTranscriptWithAnthropic(normalizedTranscript);
  if (result) {
    return result;
  }

  throw new RecipeAudioError("Failed to create recipe from transcript", "AI_UPSTREAM_ERROR", 502);
}
