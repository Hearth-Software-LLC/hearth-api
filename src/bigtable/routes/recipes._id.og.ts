import { NextResponse } from "../next-shim.js";
import { supabaseAdmin } from "../lib/supabase.js";

// Public endpoint — no auth required. Only returns data for published recipes.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const recipeId = id.trim();

  if (!recipeId) {
    return NextResponse.json({ error: "Invalid recipe id" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("recipes")
    .select("id, title, description, image_url")
    .eq("id", recipeId)
    .eq("status", "published")
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json({ error: "Recipe not found" }, { status: 404 });
  }

  return NextResponse.json(
    {
      id: data.id,
      title: data.title ?? null,
      description: data.description ?? null,
      imageUrl: data.image_url ?? null,
    },
    {
      headers: {
        // Cache for 5 minutes on CDN — balances freshness with iMessage crawler performance.
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
      },
    },
  );
}
