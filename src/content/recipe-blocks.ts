import { z } from 'zod';
import { blockId } from './hearken-blocks.js';

/**
 * BigTable's recipe blocks: an ingredient list (amount, unit, name, note) and numbered steps. A
 * recipe collection's sections are recipes; BigTable's installer turns each one into a recipe in
 * the user's kitchen (amount → amount, unit → measurementType, steps → instructions).
 *
 * Drafts may hold half-written rows (an ingredient without a name, an empty step) so the editor
 * can save as the author types; the publish checks (`recipeIssues`) make a published recipe
 * complete. Kept apart from model.ts like hearken-blocks.ts; nothing here imports model.ts.
 */

/**
 * BigTable's measurement values, exactly as its recipes store them in `measurementType`: the
 * Expo app's MEASUREMENT_OPTIONS (`lib/recipe-ingredients.ts`), ported to the iOS app as
 * `Ingredients.measurements` (BigTable/Models/Ingredients.swift), in the picker's order. "No unit"
 * is null here (the picker's "—", stored as an empty value).
 */
export const MEASUREMENTS = [
  { value: 'each', label: 'Each', short: 'ea' },
  { value: 'cup', label: 'Cup', short: 'c' },
  { value: 'cups', label: 'Cups', short: 'c' },
  { value: 'tsp', label: 'Teaspoon', short: 'tsp' },
  { value: 'tbsp', label: 'Tablespoon', short: 'tbsp' },
  { value: 'floz', label: 'Fluid Ounce', short: 'fl oz' },
  { value: 'g', label: 'Gram', short: 'g' },
  { value: 'mg', label: 'Milligram', short: 'mg' },
  { value: 'kg', label: 'Kilogram', short: 'kg' },
  { value: 'oz', label: 'Ounce', short: 'oz' },
  { value: 'lb', label: 'Pound', short: 'lb' },
  { value: 'ml', label: 'Milliliter', short: 'ml' },
  { value: 'l', label: 'Liter', short: 'l' },
  { value: 'pt', label: 'Pint', short: 'pt' },
  { value: 'qt', label: 'Quart', short: 'qt' },
  { value: 'gal', label: 'Gallon', short: 'gal' },
  { value: 'pinch', label: 'Pinch', short: 'pn' },
  { value: 'dash', label: 'Dash', short: 'ds' },
  { value: 'packet', label: 'Packet', short: 'pkt' },
  { value: 'bunch', label: 'Bunch', short: 'bnch' },
  { value: 'sprig', label: 'Sprig', short: 'sprg' },
  { value: 'stalk', label: 'Stalk', short: 'stk' },
  { value: 'clove', label: 'Clove', short: 'clv' },
  { value: 'head', label: 'Head', short: 'hd' },
  { value: 'can', label: 'Can', short: 'can' },
  { value: 'jar', label: 'Jar', short: 'jar' },
  { value: 'bottle', label: 'Bottle', short: 'btl' },
  { value: 'fillet', label: 'Fillet', short: 'flt' },
  { value: 'slice', label: 'Slice', short: 'slc' },
  { value: 'piece', label: 'Piece', short: 'pc' },
] as const;
export const MEASUREMENT_VALUES = MEASUREMENTS.map((measurement) => measurement.value) as unknown as readonly [typeof MEASUREMENTS[number]['value'], ...typeof MEASUREMENTS[number]['value'][]];
export type Measurement = typeof MEASUREMENT_VALUES[number];

export const INGREDIENTS_MAX = 60;
export const STEPS_MAX = 40;

const text = (max: number) => z.string().max(max).default('');
/** No unit: null. An empty string (the picker's "—") is read as null. */
const unit = z.preprocess((value) => (value === '' ? null : value), z.enum(MEASUREMENT_VALUES).nullable()).default(null);

export const ingredientSchema = z.object({
  id: blockId,
  /** Null: no amount ("salt, to taste"). */
  amount: z.number().min(0).max(100_000).nullable().default(null),
  unit,
  name: text(120),
  /** "finely chopped"; BigTable appends it to the name after a comma. */
  note: text(120),
}).strict();

export const ingredientsBlockSchema = z.object({
  id: blockId, type: z.literal('ingredients'),
  /** A group, like "For the sauce". Empty for none. */
  title: text(60),
  items: z.array(ingredientSchema).max(INGREDIENTS_MAX).default([]),
}).strict();

export const stepsBlockSchema = z.object({
  id: blockId, type: z.literal('steps'),
  title: text(60),
  items: z.array(z.object({ id: blockId, text: text(600) }).strict()).max(STEPS_MAX).default([]),
}).strict();

export type IngredientsBlock = z.infer<typeof ingredientsBlockSchema>;
export type StepsBlock = z.infer<typeof stepsBlockSchema>;

type AnyBlock = { id: string; type: string } & Record<string, unknown>;

/**
 * What a recipe (one section of a recipe collection) is missing before it can be published: an
 * ingredients block with an item, a steps block with an item, every row filled in, servings over
 * zero, and its image. `servings`: the section's servings value, or undefined when the type has no
 * servings field. `image`: whether its image field is set and uploaded, or null when the type has
 * no image field (the caller knows which field that is and whether the upload finished).
 */
export function recipeIssues(blocks: AnyBlock[], options: { servings?: unknown; hasServings: boolean; image: boolean | null }): string[] {
  const issues: string[] = [];
  const ingredients = blocks.filter((block) => block.type === 'ingredients') as unknown as IngredientsBlock[];
  const steps = blocks.filter((block) => block.type === 'steps') as unknown as StepsBlock[];
  if (!ingredients.some((block) => block.items.length > 0)) issues.push('no ingredients');
  else if (ingredients.some((block) => block.items.some((item) => !item.name.trim()))) issues.push('an ingredient without a name');
  if (!steps.some((block) => block.items.length > 0)) issues.push('no steps');
  else if (steps.some((block) => block.items.some((item) => !item.text.trim()))) issues.push('an empty step');
  const { servings } = options;
  if (options.hasServings && !(typeof servings === 'number' && Number.isFinite(servings) && servings > 0)) issues.push('servings must be more than 0');
  if (options.image === false) issues.push('no image');
  return issues;
}
