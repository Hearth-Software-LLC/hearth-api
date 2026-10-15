const GEMINI_REQUEST_TIMEOUT_MS = 20_000;

type GeminiGenerateImageResult = {
  mimeType: string;
  dataBase64: string;
  model: string;
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export async function generateGeminiImage(prompt: string): Promise<GeminiGenerateImageResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const model = process.env.GEMINI_RECIPE_IMAGE_MODEL?.trim() || "gemini-2.5-flash-image";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, GEMINI_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
        },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error("Gemini image request timed out");
    }
    throw new Error("Gemini image request failed");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    let detail = "";
    try {
      const json = (await response.json()) as Record<string, unknown>;
      const errorPayload = asRecord(json.error);
      const message = typeof errorPayload?.message === "string" ? errorPayload.message.trim() : "";
      detail = message ? `: ${message}` : "";
    } catch {
      detail = "";
    }
    throw new Error(`Gemini image generation failed (HTTP ${response.status})${detail}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];

  for (const candidate of candidates) {
    const candidateRecord = asRecord(candidate);
    const content = asRecord(candidateRecord?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];

    for (const part of parts) {
      const partRecord = asRecord(part);
      const inlineData = asRecord(partRecord?.inlineData);
      const dataBase64 = typeof inlineData?.data === "string" ? inlineData.data.trim() : "";
      if (!dataBase64) {
        continue;
      }

      const mimeTypeRaw = typeof inlineData?.mimeType === "string" ? inlineData.mimeType.trim() : "";
      const mimeType = mimeTypeRaw || "image/png";
      return {
        mimeType,
        dataBase64,
        model,
      };
    }
  }

  throw new Error("Gemini did not return an image");
}
