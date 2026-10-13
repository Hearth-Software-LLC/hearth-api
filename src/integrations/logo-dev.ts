export function logoUrl(key: string, domain: string, size: number, format: 'png' | 'webp') {
  const url = new URL(`https://img.logo.dev/${domain}`);
  url.searchParams.set('token', key);
  url.searchParams.set('size', String(size));
  url.searchParams.set('format', format);
  url.searchParams.set('fallback', '404');
  return url.toString();
}