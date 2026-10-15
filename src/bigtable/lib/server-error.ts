import { NextResponse } from "../next-shim.js";

export function serverError(route: string, fallbackMessage: string, error: unknown) {
  console.error(route, error);
  return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}