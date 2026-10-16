import { fetchAnthropicMessages } from "./anthropic.js";
import {
  ANTHROPIC_MODEL,
  RECIPE_JSON_SHAPE,
  RECIPE_TIMING_RULE,
  RecipeAudioError,
  SUPPORTED_RECIPE_TAGS,
  extractJsonObject,
  normalizeShape,
  type AudioRecipeFields,
} from "./ai-recipe-audio.js";

/** The changed recipe, plus a short reply telling the cook what changed. */
export type RefinedRecipeFields = AudioRecipeFields & { reply: string };

function buildRefinePrompt(recipe: string, request: string): string {
  const hasRecipe = recipe.trim().length > 0;
  return [
    "You help a busy parent with a family recipe in a meal-planning app for large families.",
    hasRecipe
      ? "Apply the change they ask for to the recipe below and return the whole updated recipe."
      : "There's no recipe yet. Write a complete one from what they ask for.",
    "Return strict JSON only with this exact shape (the recipe fields plus a reply):",
    RECIPE_JSON_SHAPE.replace(/}$/, ',"reply":"..."}'),
    "Rules:",
    "- Keep everything they didn't ask to change as it was: the same wording, amounts and order.",
    "- When the number of servings changes, scale every ingredient amount and adjust times or pan sizes when needed.",
    "- When an ingredient is swapped or removed, update every step that mentions it.",
    "- When they ask for a recipe from a few key ingredients, write a complete recipe: include everything the dish needs, such as aromatics, fats, seasonings, liquids, sauces and toppings.",
    "- baseServings is an integer between 1 and 50.",
    RECIPE_TIMING_RULE,
    `- tags must only use values from this exact list (lowercase): ${SUPPORTED_RECIPE_TAGS.join(", ")}. Keep the existing tags unless the change calls for adding or removing one.`,
    "- ingredients are concise lines with the amount first, like \"2 cups beef broth\".",
    "- instructions are ordered action steps without numbering.",
    "- reply is one or two short, friendly sentences telling them what you changed (or what you made). No greeting.",
    "- If the request has nothing to do with the recipe or cooking, return the recipe unchanged with isRecipe=true and say in the reply what kinds of changes you can make. Only set isRecipe=false when there's no recipe and the request isn't about food.",
    "- Do not include markdown fences or any commentary.",
    "",
    hasRecipe ? `The recipe:\n${recipe.trim()}` : "",
    "",
    `What they asked: ${request.trim()}`,
  ].join("\n");
}

export async function refineRecipe(recipe: string, request: string): Promise<RefinedRecipeFields> {
  if (!request.trim()) {
    throw new RecipeAudioError("Request is empty", "INVALID_REQUEST", 400);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new RecipeAudioError("Recipe AI is unavailable", "AI_UNAVAILABLE", 503);
  }

  const response = await fetchAnthropicMessages(apiKey, {
    model: ANTHROPIC_MODEL,
    max_tokens: 2500,
    temperature: 0.3,
    messages: [{ role: "user", content: [{ type: "text", text: buildRefinePrompt(recipe, request) }] }],
  });

  if (response?.ok) {
    const payload = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = payload.content?.find((item) => item.type === "text")?.text;
    const json = text ? extractJsonObject(text) : null;
    if (json) {
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>;
        const fields = normalizeShape(parsed);
        if (fields) {
          const replyRaw = parsed.reply;
          const reply = typeof replyRaw === "string" && replyRaw.trim()
            ? replyRaw.trim().slice(0, 400)
            : "Done. Here's the updated recipe.";
          return { ...fields, reply };
        }
      } catch {
        // Falls through to the upstream error.
      }
    }
  }

  throw new RecipeAudioError("Failed to change the recipe", "AI_UPSTREAM_ERROR", 502);
}
