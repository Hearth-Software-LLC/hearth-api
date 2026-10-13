/**
 * Reads a JSON body without trusting the provider: the declared length and the bytes
 * actually received are both capped, and anything that isn't JSON is rejected. `invalid`
 * makes the error each adapter wants to report.
 */
export async function readBoundedJson(response: Response, maxBytes: number, invalid: () => Error): Promise<unknown> {
  if (Number(response.headers.get('Content-Length')) > maxBytes || !response.body) {
    await response.body?.cancel();
    throw invalid();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw invalid();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw invalid();
  }
}

/** Waits `ms` milliseconds, plus up to half again at random so retries don't line up. */
export function jitteredDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms + Math.random() * ms * 0.5));
}
