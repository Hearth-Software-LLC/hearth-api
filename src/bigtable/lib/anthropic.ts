const ANTHROPIC_REQUEST_TIMEOUT_MS = 15_000;
const ANTHROPIC_API_VERSION = process.env.ANTHROPIC_API_VERSION?.trim() || "2023-06-01";
const ANTHROPIC_BETA_HEADER = process.env.ANTHROPIC_BETA?.trim() || "";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function fetchAnthropicMessages(
  apiKey: string,
  payload: Record<string, unknown>
): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, ANTHROPIC_REQUEST_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
    };

    if (ANTHROPIC_BETA_HEADER) {
      headers["anthropic-beta"] = ANTHROPIC_BETA_HEADER;
    }

    return await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      return null;
    }

    return null;
  } finally {
    clearTimeout(timeout);
  }
}