import { describe, expect, it } from 'vitest';
import { createMetaClient, MetaError } from '../../src/social/meta.js';

type Call = { method: string; path: string; params: URLSearchParams };

/** A Graph API stand-in: answers by "METHOD path", in order when an answer is a list. */
function fakeGraph(answers: Record<string, unknown | unknown[]>) {
  const calls: Call[] = [];
  const queue = new Map(Object.entries(answers).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]));
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const params = method === 'GET' ? url.searchParams : new URLSearchParams(String(init?.body ?? ''));
    const path = url.pathname.replace(/^\/v24\.0\//, '');
    calls.push({ method, path, params });
    const list = queue.get(`${method} ${path}`);
    const answer = list && list.length > 1 ? list.shift() : list?.[0];
    if (answer === undefined) return Response.json({ error: { message: `no answer for ${method} ${path}`, code: 100 } }, { status: 400 });
    if (answer instanceof Response) return answer;
    return Response.json(answer);
  }) as typeof fetch;
  return { fetcher, calls };
}

const settings = { appId: '123456', appSecret: 'secret-secret-secret', version: 'v24.0', redirectUri: 'https://api.hearthapps.com/oauth/meta/callback' };
const page = { platform: 'facebook' as const, externalId: 'page-1', token: 'page-token' };
const insta = { platform: 'instagram' as const, externalId: 'ig-1', token: 'page-token' };
const noWait = async () => undefined;

describe('Meta client', () => {
  it('builds the login link with every scope, or a Login for Business configuration', () => {
    const plain = new URL(createMetaClient(settings).authorizeUrl('state-1'));
    expect(plain.origin + plain.pathname).toBe('https://www.facebook.com/v24.0/dialog/oauth');
    expect(plain.searchParams.get('scope')).toContain('instagram_content_publish');
    expect(plain.searchParams.get('state')).toBe('state-1');
    const business = new URL(createMetaClient({ ...settings, loginConfigId: '987654321' }).authorizeUrl('s'));
    expect(business.searchParams.get('config_id')).toBe('987654321');
    expect(business.searchParams.has('scope')).toBe(false);
  });

  it('exchanges the code for a long-lived token and lists Pages with their Instagram accounts', async () => {
    const graph = fakeGraph({
      'GET oauth/access_token': [{ access_token: 'short' }, { access_token: 'long' }],
      'GET me/accounts': { data: [
        { id: 'page-1', name: 'Sated', access_token: 'pt-1', picture: { data: { url: 'https://x/p.png' } },
          instagram_business_account: { id: 'ig-1', username: 'satedapp', profile_picture_url: 'https://x/i.png' } },
        { id: 'page-2', name: 'No token' },
      ] },
    });
    const client = createMetaClient(settings, graph.fetcher);
    expect(await client.exchangeCode('code-1')).toBe('long');
    expect(graph.calls[1]!.params.get('fb_exchange_token')).toBe('short');
    const accounts = await client.accounts('long');
    expect(accounts).toEqual([
      { platform: 'facebook', externalId: 'page-1', name: 'Sated', handle: null, avatarUrl: 'https://x/p.png', token: 'pt-1' },
      { platform: 'instagram', externalId: 'ig-1', name: 'satedapp', handle: 'satedapp', avatarUrl: 'https://x/i.png', token: 'pt-1' },
    ]);
    expect(graph.calls[2]!.params.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('publishes an Instagram photo with its first comment', async () => {
    const graph = fakeGraph({
      'POST ig-1/media': { id: 'container-1' },
      'GET container-1': { status_code: 'FINISHED' },
      'POST ig-1/media_publish': { id: 'media-1' },
      'GET media-1': { permalink: 'https://www.instagram.com/p/abc/' },
      'POST media-1/comments': { id: 'comment-1' },
    });
    const result = await createMetaClient(settings, graph.fetcher, noWait).publish(insta, {
      text: 'Dinner, sorted.', link: null, firstComment: '#mealplanning', format: 'feed', media: [{ url: 'https://files/a.jpg', kind: 'image' }],
    });
    expect(result).toEqual({ state: 'published', remoteId: 'media-1', permalink: 'https://www.instagram.com/p/abc/', warning: null });
    expect(graph.calls[0]!.params.get('image_url')).toBe('https://files/a.jpg');
    expect(graph.calls[0]!.params.get('caption')).toBe('Dinner, sorted.');
    expect(graph.calls.at(-1)!.params.get('message')).toBe('#mealplanning');
  });

  it('leaves an Instagram video processing, then finishes it later', async () => {
    const graph = fakeGraph({
      'POST ig-1/media': { id: 'container-2' },
      'GET container-2': [{ status_code: 'IN_PROGRESS' }, { status_code: 'FINISHED' }],
      'POST ig-1/media_publish': { id: 'media-2' },
      'GET media-2': { permalink: 'https://www.instagram.com/reel/xyz/' },
    });
    const client = createMetaClient(settings, graph.fetcher, noWait);
    const input = { text: 'Watch', link: null, firstComment: null, format: 'reel' as const, media: [{ url: 'https://files/v.mp4', kind: 'video' as const }] };
    expect(await client.publish(insta, input, 0)).toEqual({ state: 'processing', containerId: 'container-2' });
    expect(graph.calls[0]!.params.get('media_type')).toBe('REELS');
    expect(await client.resume(insta, 'container-2', null)).toMatchObject({ state: 'published', remoteId: 'media-2' });
  });

  it('fails a container Instagram couldn’t process', async () => {
    const graph = fakeGraph({ 'POST ig-1/media': { id: 'c' }, 'GET c': { status_code: 'ERROR', status: 'Bad format' } });
    await expect(createMetaClient(settings, graph.fetcher, noWait).publish(insta, {
      text: '', link: null, firstComment: null, format: 'feed', media: [{ url: 'https://files/a.jpg', kind: 'image' }],
    })).rejects.toThrow(/Bad format/);
  });

  it('posts several photos to a Page as one post, and a link post with no media', async () => {
    const graph = fakeGraph({
      'POST page-1/photos': [{ id: 'photo-1' }, { id: 'photo-2' }],
      'POST page-1/feed': [{ id: 'page-1_post-1' }, { id: 'page-1_post-2' }],
      'GET page-1_post-1': { permalink_url: 'https://www.facebook.com/x/posts/1' },
      'GET page-1_post-2': { permalink_url: '/x/posts/2' },
    });
    const client = createMetaClient(settings, graph.fetcher, noWait);
    const photos = await client.publish(page, {
      text: 'Two', link: null, firstComment: null, format: 'feed',
      media: [{ url: 'https://files/1.jpg', kind: 'image' }, { url: 'https://files/2.jpg', kind: 'image' }],
    });
    expect(photos).toMatchObject({ state: 'published', remoteId: 'page-1_post-1' });
    const feed = graph.calls.find((call) => call.path === 'page-1/feed')!;
    expect(JSON.parse(feed.params.get('attached_media')!)).toEqual([{ media_fbid: 'photo-1' }, { media_fbid: 'photo-2' }]);
    const link = await client.publish(page, { text: 'Read', link: 'https://hearthapps.com', firstComment: null, format: 'feed', media: [] });
    expect(link).toMatchObject({ remoteId: 'page-1_post-2', permalink: 'https://www.facebook.com/x/posts/2' });
  });

  it('keeps the post when only the first comment fails', async () => {
    const graph = fakeGraph({
      'POST page-1/feed': { id: 'p_1' }, 'GET p_1': {},
      'POST p_1/comments': Response.json({ error: { message: 'Comments are off', code: 10 } }, { status: 400 }),
    });
    const result = await createMetaClient(settings, graph.fetcher).publish(page, { text: 'Hi', link: null, firstComment: 'First!', format: 'feed', media: [] });
    expect(result).toMatchObject({ state: 'published', warning: expect.stringContaining('Comments are off') });
  });

  it('marks an expired token as an auth error', async () => {
    const graph = fakeGraph({ 'POST page-1/feed': Response.json({ error: { message: 'Session has expired', code: 190, type: 'OAuthException' } }, { status: 400 }) });
    const error = await createMetaClient(settings, graph.fetcher).publish(page, { text: 'Hi', link: null, firstComment: null, format: 'feed', media: [] }).catch((caught) => caught);
    expect(error).toBeInstanceOf(MetaError);
    expect(error.auth).toBe(true);
  });

  it('reads comments with replies and knows the account’s own', async () => {
    const graph = fakeGraph({ 'GET media-1/comments': { data: [
      { id: 'c1', text: 'Love it', username: 'pat', timestamp: '2026-10-28T10:00:00+0000', like_count: 2,
        replies: { data: [{ id: 'c2', text: 'Thanks!', username: 'satedapp', timestamp: '2026-10-28T11:00:00+0000' }] } },
    ] } });
    const comments = await createMetaClient(settings, graph.fetcher).comments(insta, 'media-1', 'satedapp');
    expect(comments).toEqual([
      { remoteId: 'c1', parentRemoteId: null, author: 'pat', text: 'Love it', likes: 2, at: '2026-10-28T10:00:00.000Z', fromAccount: false },
      { remoteId: 'c2', parentRemoteId: 'c1', author: 'satedapp', text: 'Thanks!', likes: 0, at: '2026-10-28T11:00:00.000Z', fromAccount: true },
    ]);
  });

  it('keeps the numbers Meta still answers and skips retired metrics', async () => {
    const graph = fakeGraph({
      'GET page-1': { followers_count: 1200 },
      'GET page-1/insights': [
        { data: [{ name: 'page_impressions_unique', values: [{ value: 40, end_time: '2026-10-27T07:00:00+0000' }, { value: 55, end_time: '2026-10-28T07:00:00+0000' }] }] },
        Response.json({ error: { message: 'The metric was deprecated', code: 100 } }, { status: 400 }),
        Response.json({ error: { message: 'The metric was deprecated', code: 100 } }, { status: 400 }),
      ],
    });
    const rows = await createMetaClient(settings, graph.fetcher).accountMetrics(page);
    expect(rows.filter((row) => row.metric === 'reach')).toEqual([
      { day: '2026-10-26', metric: 'reach', value: 40 }, { day: '2026-10-27', metric: 'reach', value: 55 },
    ]);
    expect(rows.find((row) => row.metric === 'followers')?.value).toBe(1200);
  });

  it('falls back to one metric at a time for a post', async () => {
    const graph = fakeGraph({
      'GET media-1/insights': [
        Response.json({ error: { message: 'views is not available', code: 100 } }, { status: 400 }),
        { data: [{ name: 'reach', values: [{ value: 300 }] }] },
        Response.json({ error: { message: 'nope', code: 100 } }, { status: 400 }),
        { data: [{ name: 'likes', total_value: { value: 12 } }] },
        Response.json({ error: { message: 'nope', code: 100 } }, { status: 400 }),
        Response.json({ error: { message: 'nope', code: 100 } }, { status: 400 }),
        { data: [{ name: 'saved', values: [{ value: 4 }] }] },
      ],
    });
    expect(await createMetaClient(settings, graph.fetcher).postMetrics(insta, 'media-1')).toEqual([
      { metric: 'reach', value: 300 }, { metric: 'likes', value: 12 }, { metric: 'saves', value: 4 },
    ]);
  });
});
