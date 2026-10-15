import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAnthropicMessages } from "../../src/bigtable/lib/anthropic.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fetchAnthropicMessages", () => {
  it("returns null when the request is aborted by the timeout", async () => {
    vi.useFakeTimers();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise((_, reject) => {
        const signal = init?.signal;
        if (!signal) {
          return;
        }

        signal.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      }) as Promise<Response>;
    }) as typeof fetch);

    const request = fetchAnthropicMessages("test-key", { model: "claude-3-5-haiku-latest" });
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(request).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null when fetch fails with a non-abort error", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Network failed"));

    const response = await fetchAnthropicMessages("test-key", { model: "claude-3-5-haiku-latest" });

    expect(response).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});