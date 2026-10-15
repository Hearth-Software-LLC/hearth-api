type JsonLike = Record<string, unknown>;

type RequestOptions = {
  method?: string;
  authorization?: string | null;
  headers?: Record<string, string>;
};

export function buildJsonRequest(url: string, payload: JsonLike = {}, options: RequestOptions = {}) {
  const method = options.method ?? "POST";
  const headers = new Headers({
    "content-type": "application/json",
    ...(options.headers ?? {}),
  });

  if (options.authorization) {
    headers.set("authorization", options.authorization);
  }

  return new Request(url, {
    method,
    headers,
    body: JSON.stringify(payload),
  });
}

export function buildAuthenticatedJsonRequest(
  url: string,
  payload: JsonLike = {},
  token = "token",
  options: Omit<RequestOptions, "authorization"> = {}
) {
  return buildJsonRequest(url, payload, {
    ...options,
    authorization: `Bearer ${token}`,
  });
}

export function buildUnauthenticatedJsonRequest(
  url: string,
  payload: JsonLike = {},
  options: Omit<RequestOptions, "authorization"> = {}
) {
  return buildJsonRequest(url, payload, options);
}

export function buildAuthHeader(token = "token") {
  return `Bearer ${token}`;
}
