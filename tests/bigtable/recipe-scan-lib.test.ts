import { afterEach, describe, expect, it, vi } from "vitest";

import { RecipeScanError, scanRecipeDocumentImage } from "../../src/bigtable/lib/ai-recipe-scan.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("scanRecipeDocumentImage upstream errors", () => {
  it("logs the status and Anthropic's error type, never the response body", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "Grandma Rose's secret lasagna: 2 cups ricotta..." },
    }), { status: 400, headers: { "Content-Type": "application/json" } }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(scanRecipeDocumentImage({ images: [{ mimeType: "image/jpeg", dataBase64: "AAAA" }] }))
      .rejects.toBeInstanceOf(RecipeScanError);

    expect(logged).toHaveBeenCalledWith("Recipe scan upstream error", { status: 400, code: "invalid_request_error" });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("lasagna");
  });

  it("logs an unknown code for a body that isn't Anthropic's error JSON", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>gateway says: private stuff</html>", { status: 502 }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(scanRecipeDocumentImage({ images: [{ mimeType: "image/jpeg", dataBase64: "AAAA" }] }))
      .rejects.toBeInstanceOf(RecipeScanError);

    expect(logged).toHaveBeenCalledWith("Recipe scan upstream error", { status: 502, code: "unknown" });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("private stuff");
  });
});
