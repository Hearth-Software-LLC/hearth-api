/** A Logo.dev CDN URL for a company's domain. `fallback=404` so a missing logo is a 404, not a monogram. */
export function logoUrl(key: string, domain: string, size: number, format: 'png' | 'webp') {
  const url = new URL(`https://img.logo.dev/${domain}`);
  url.searchParams.set('token', key);
  url.searchParams.set('size', String(size));
  url.searchParams.set('format', format);
  url.searchParams.set('fallback', '404');
  return url.toString();
}

/**
 * A Logo.dev CDN URL for a brand by name ("Chipotle"). Logo.dev picks the closest-named brand,
 * so callers should use this only for names known to be brands (a matched restaurant chain),
 * never for arbitrary place names, which can resolve to an unrelated company.
 */
export function logoNameUrl(key: string, name: string, size: number, format: 'png' | 'webp') {
  const url = new URL(`https://img.logo.dev/name/${encodeURIComponent(name)}`);
  url.searchParams.set('token', key);
  url.searchParams.set('size', String(size));
  url.searchParams.set('format', format);
  url.searchParams.set('fallback', '404');
  return url.toString();
}
