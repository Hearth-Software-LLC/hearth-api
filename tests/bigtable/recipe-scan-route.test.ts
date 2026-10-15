import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthenticatedJsonRequest, buildUnauthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const scanRecipeDocumentImage = vi.fn();

class RecipeScanError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status = 502) {
    super(message);
    this.name = "RecipeScanError";
    this.code = code;
    this.status = status;
  }
}

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/bigtable/lib/ai-recipe-scan.js", () => ({
  scanRecipeDocumentImage,
  RecipeScanError,
}));

beforeEach(() => {
  vi.resetAllMocks();
  getUserIdFromAuthHeader.mockResolvedValue("user-1");
  scanRecipeDocumentImage.mockResolvedValue({ title: "Pulled Pork", ingredients: ["pork"], instructions: ["cook"] });
});

async function postScan(request: Request) {
  const { POST } = await import("../../src/bigtable/routes/ai.recipe-scan.js");
  return POST(request as never);
}

describe("POST /api/ai/recipe-scan", () => {
  it("rejects unauthenticated requests", async () => {
    getUserIdFromAuthHeader.mockResolvedValue(null);
    const response = await postScan(
      buildUnauthenticatedJsonRequest("http://localhost/api/ai/recipe-scan", { images: [{ dataBase64: "abc", mimeType: "image/jpeg" }] }),
    );
    expect(response.status).toBe(401);
    expect(scanRecipeDocumentImage).not.toHaveBeenCalled();
  });

  it("rejects a payload with neither images nor dataBase64", async () => {
    const response = await postScan(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/recipe-scan", {}),
    );
    expect(response.status).toBe(400);
    expect(scanRecipeDocumentImage).not.toHaveBeenCalled();
  });

  it("passes a multi-image (tiled) payload through to the scanner", async () => {
    const images = [
      { dataBase64: "tile1", mimeType: "image/jpeg" },
      { dataBase64: "tile2", mimeType: "image/jpeg" },
    ];
    const response = await postScan(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/recipe-scan", { images }),
    );
    expect(response.status).toBe(200);
    expect(scanRecipeDocumentImage).toHaveBeenCalledWith({ images });
    expect(await response.json()).toEqual({ title: "Pulled Pork", ingredients: ["pork"], instructions: ["cook"] });
  });

  it("accepts the legacy single-image shape and normalizes it to an images array", async () => {
    const response = await postScan(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/recipe-scan", { dataBase64: "legacy", mimeType: "image/png" }),
    );
    expect(response.status).toBe(200);
    expect(scanRecipeDocumentImage).toHaveBeenCalledWith({ images: [{ dataBase64: "legacy", mimeType: "image/png" }] });
  });

  it("rejects an unsupported mime type", async () => {
    const response = await postScan(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/recipe-scan", { images: [{ dataBase64: "abc", mimeType: "image/gif" }] }),
    );
    expect(response.status).toBe(400);
    expect(scanRecipeDocumentImage).not.toHaveBeenCalled();
  });

  it("rejects more than the maximum number of images", async () => {
    const images = Array.from({ length: 9 }, (_, i) => ({ dataBase64: `t${i}`, mimeType: "image/jpeg" }));
    const response = await postScan(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/recipe-scan", { images }),
    );
    expect(response.status).toBe(400);
    expect(scanRecipeDocumentImage).not.toHaveBeenCalled();
  });

  it("maps RecipeScanError to its status and code", async () => {
    scanRecipeDocumentImage.mockRejectedValue(new RecipeScanError("Recipe scan failed with upstream status 400", "AI_UPSTREAM_ERROR", 502));
    const response = await postScan(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/recipe-scan", { images: [{ dataBase64: "abc", mimeType: "image/jpeg" }] }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Recipe scan failed with upstream status 400", code: "AI_UPSTREAM_ERROR" });
  });
});
