import { NextResponse } from "../next-shim.js";

import { supabaseAdmin } from "../../services/supabase.js";

export async function GET() {
  const missingDependencies = [] as string[];
  if (!process.env.ANTHROPIC_API_KEY) {
    missingDependencies.push("anthropic");
  }
  if (!process.env.REVENUECAT_WEBHOOK_SECRET) {
    missingDependencies.push("revenuecat_webhook_secret");
  }

  const { error } = await supabaseAdmin.from("profiles").select("id").limit(1);

  if (error || missingDependencies.length > 0) {
    return NextResponse.json(
      {
        status: "error",
        dependency: "runtime",
        missingDependencies,
        error: error ? "Database health check failed" : "Required runtime configuration is missing",
      },
      { status: 503 }
    );
  }

  return NextResponse.json({ status: "ok", dependency: "database", runtime: "ready" });
}
