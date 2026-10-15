// Minimal stand-ins for the parts of `next/server` the BigTable handlers were written against,
// so the ported handlers stay plain Web `Request` -> `Response` functions.
export class NextResponse extends Response {
  static override json(body: unknown, init?: ResponseInit): Response {
    return Response.json(body, init);
  }
}

export const NextRequest = Request;
export type NextRequest = Request;
