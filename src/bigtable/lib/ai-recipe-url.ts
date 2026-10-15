import { createRecipeFromTranscript, filterSupportedTags, type AudioRecipeFields } from "./ai-recipe-audio.js";

const PAGE_FETCH_TIMEOUT_MS = 12_000;
const MAX_PAGE_BYTES = 5_000_000;
// Keep the text we forward to the model within the transcript route's accepted size.
const MAX_EXTRACTED_TEXT_LENGTH = 12_000;
const FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export type UrlRecipeFields = AudioRecipeFields;

export class RecipeUrlError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 502) {
    super(message);
    this.name = "RecipeUrlError";
    this.code = code;
    this.status = status;
  }
}

// Blocks obvious SSRF targets: loopback, link-local, private ranges, and
// hostnames that are not a public web address. DNS is not resolved here, so this
// is a best-effort guard against the common cases.
function assertPublicHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new RecipeUrlError("That doesn't look like a valid link.", "INVALID_URL", 400);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RecipeUrlError("Only http and https links are supported.", "INVALID_URL", 400);
  }

  const host = parsed.hostname.toLowerCase();

  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new RecipeUrlError("That link can't be reached.", "BLOCKED_URL", 400);
  }

  // IPv4 literal in a private/loopback/link-local range.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    const isPrivate =
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
    if (isPrivate) {
      throw new RecipeUrlError("That link can't be reached.", "BLOCKED_URL", 400);
    }
  }

  // IPv6 loopback / unique-local / link-local literals.
  if (host.includes(":") && (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80"))) {
    throw new RecipeUrlError("That link can't be reached.", "BLOCKED_URL", 400);
  }

  return parsed;
}

async function fetchPageHtml(url: URL): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": FETCH_USER_AGENT,
        // Look as much like a real browser navigation as possible so sites that
        // only sniff request headers (rather than the source IP) let us through.
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
      },
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof Error && error.name === "AbortError") {
      throw new RecipeUrlError("That page took too long to load.", "PAGE_TIMEOUT", 504);
    }
    throw new RecipeUrlError("We couldn't reach that page.", "PAGE_UNREACHABLE", 502);
  }

  clearTimeout(timeout);

  if (!response.ok) {
    // Bot-protection / paywall responses: the site is refusing automated
    // fetches, not failing. Tell the user plainly and point them elsewhere.
    if ([401, 402, 403, 406, 429, 451].includes(response.status)) {
      throw new RecipeUrlError(
        "That site doesn't allow importing recipes automatically. Try the Upload Photo option with a screenshot of the recipe instead.",
        "SITE_BLOCKED",
        422,
      );
    }
    throw new RecipeUrlError(`That page returned an error (status ${response.status}).`, "PAGE_ERROR", 502);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !contentType.includes("text/html") && !contentType.includes("xhtml") && !contentType.includes("text/plain")) {
    throw new RecipeUrlError("That link doesn't point to a readable recipe page.", "UNSUPPORTED_CONTENT", 400);
  }

  const html = await response.text();
  if (html.length > MAX_PAGE_BYTES) {
    return html.slice(0, MAX_PAGE_BYTES);
  }
  return html;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}

// Reduces an HTML document to readable text for the model fallback path.
function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const text = decodeHtmlEntities(
    withoutNoise
      .replace(/<(p|div|li|br|h[1-6]|tr|section|article)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );

  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_EXTRACTED_TEXT_LENGTH);
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => asStringArray(entry));
  }
  return [];
}

// Flattens schema.org instruction shapes (string, HowToStep, HowToSection) into
// ordered, plain-text steps.
function flattenInstructions(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) {
    return [];
  }

  const steps: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) {
        steps.push(trimmed);
      }
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const type = typeof record["@type"] === "string" ? (record["@type"] as string) : "";
      if (type.includes("HowToSection") && record.itemListElement) {
        steps.push(...flattenInstructions(record.itemListElement));
        continue;
      }
      const text = record.text ?? record.name;
      if (typeof text === "string" && text.trim()) {
        steps.push(text.trim());
      }
    }
  }
  return steps;
}

function parseServingsFromYield(value: unknown): number | null {
  const candidates = Array.isArray(value) ? value : [value];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      const rounded = Math.round(candidate);
      if (rounded >= 1 && rounded <= 50) {
        return rounded;
      }
    }
    if (typeof candidate === "string") {
      const match = candidate.match(/\d+/);
      if (match) {
        const parsed = Number.parseInt(match[0], 10);
        if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 50) {
          return parsed;
        }
      }
    }
  }
  return null;
}

// Walks parsed JSON-LD looking for a Recipe node (objects can be nested under
// @graph or arrays).
function findRecipeNode(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findRecipeNode(entry);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!node || typeof node !== "object") {
    return null;
  }
  const record = node as Record<string, unknown>;
  const type = record["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((entry) => typeof entry === "string" && entry.toLowerCase() === "recipe")) {
    return record;
  }
  if (record["@graph"]) {
    return findRecipeNode(record["@graph"]);
  }
  return null;
}

function buildFieldsFromJsonLd(html: string): AudioRecipeFields | null {
  const scriptMatches = html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);

  for (const match of scriptMatches) {
    const raw = match[1]?.trim();
    if (!raw) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const recipe = findRecipeNode(parsed);
    if (!recipe) {
      continue;
    }

    const nameRaw = recipe.name;
    const title = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim().slice(0, 160) : null;
    const descriptionRaw = recipe.description;
    const description = typeof descriptionRaw === "string" && descriptionRaw.trim()
      ? decodeHtmlEntities(descriptionRaw.trim()).slice(0, 450)
      : null;
    const ingredients = asStringArray(recipe.recipeIngredient).map((line) => decodeHtmlEntities(line)).slice(0, 80);
    const instructions = flattenInstructions(recipe.recipeInstructions).map((line) => decodeHtmlEntities(line)).slice(0, 80);
    const baseServings = parseServingsFromYield(recipe.recipeYield);
    const tags = filterSupportedTags([
      ...asStringArray(recipe.keywords),
      ...asStringArray(recipe.recipeCategory),
      ...asStringArray(recipe.recipeCuisine),
    ].map((entry) => entry.toLowerCase()));

    // Only trust structured data when it actually carries the recipe body.
    if (ingredients.length === 0 || instructions.length === 0) {
      continue;
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
    };
  }

  return null;
}

export async function importRecipeFromUrl(rawUrl: string): Promise<AudioRecipeFields> {
  const url = assertPublicHttpUrl(rawUrl.trim());
  const html = await fetchPageHtml(url);

  // Prefer deterministic schema.org metadata; most recipe sites embed it.
  const structured = buildFieldsFromJsonLd(html);
  if (structured) {
    return structured;
  }

  // Fall back to extracting the readable page text and letting the model parse it.
  const text = htmlToText(html);
  if (text.trim().length < 40) {
    throw new RecipeUrlError("We couldn't read a recipe from that page.", "NO_CONTENT", 422);
  }

  return createRecipeFromTranscript(text);
}
