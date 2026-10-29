import { createHash, createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { ApiError } from '../errors.js';

/**
 * Which Hearth apps exist: the repos in the Hearth-Software-LLC organization that have a
 * `hearth-app.json` at their root, read through a GitHub App installed on the organization with
 * read-only Contents and Metadata. Only hearth-api holds the App's key.
 *
 * hearth-app.json:
 *   { "key": "sated", "name": "Sated", "accent": "#16778A", "icon": "Sated/Assets.xcassets/AppIcon.appiconset/icon.png",
 *     "appStoreId": "1234567890", "bundleId": "com.stephenwarren.sated" }
 */

export const appFileSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(60),
  accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().trim().min(1).max(300).optional(),
  appStoreId: z.string().regex(/^\d{5,15}$/).optional(),
  bundleId: z.string().regex(/^[A-Za-z0-9.-]{3,155}$/).optional(),
});

export type StudioApp = Omit<z.infer<typeof appFileSchema>, 'icon'> & {
  /** The icon's path in the repo. */
  iconPath: string | null;
  repo: string;
  defaultBranch: string;
  icon: { bytes: Uint8Array; sha256: string; contentType: 'image/png' | 'image/jpeg' | 'image/webp' } | null;
};

export type GitHubApps = { list: () => Promise<StudioApp[]> };

export type GitHubSettings = { appId: string; privateKey: string; org: string };

export function createGitHubApps(settings: GitHubSettings, fetcher: typeof fetch = fetch, now: () => number = Date.now): GitHubApps {
  const key = createPrivateKey(settings.privateKey.replace(/\\n/g, '\n'));
  let token: { value: string; expiresAt: number } | undefined;
  let cached: { at: number; apps: StudioApp[] } | undefined;

  async function call(path: string, init: { method?: string; auth: string; accept?: string } ): Promise<Response> {
    try {
      return await fetcher(`https://api.github.com${path}`, {
        method: init.method ?? 'GET',
        headers: { Authorization: init.auth, Accept: init.accept ?? 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hearth-api' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ApiError(503, 'GITHUB_UNAVAILABLE', 'GitHub could not be reached');
    }
  }

  async function installationToken(): Promise<string> {
    if (token && token.expiresAt - 60_000 > now()) return token.value;
    const seconds = Math.floor(now() / 1000);
    const jwt = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(seconds - 60).setExpirationTime(seconds + 540).setIssuer(settings.appId).sign(key);
    const auth = `Bearer ${jwt}`;
    const installation = await call(`/orgs/${encodeURIComponent(settings.org)}/installation`, { auth });
    if (!installation.ok) throw new ApiError(503, 'GITHUB_UNAVAILABLE', `The GitHub App isn’t installed on ${settings.org} (${installation.status})`);
    const { id } = await installation.json() as { id: number };
    const created = await call(`/app/installations/${id}/access_tokens`, { method: 'POST', auth });
    if (!created.ok) throw new ApiError(503, 'GITHUB_UNAVAILABLE', `GitHub refused the App’s token (${created.status})`);
    const body = await created.json() as { token: string; expires_at: string };
    token = { value: body.token, expiresAt: Date.parse(body.expires_at) };
    return token.value;
  }

  async function raw(repo: string, path: string, auth: string): Promise<Response> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return call(`/repos/${repo}/contents/${encoded}`, { auth, accept: 'application/vnd.github.raw+json' });
  }

  return {
    async list() {
      if (cached && now() - cached.at < 10 * 60_000) return cached.apps;
      const auth = `token ${await installationToken()}`;
      const repos: { full_name: string; default_branch: string; archived: boolean }[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const response = await call(`/installation/repositories?per_page=100&page=${page}`, { auth });
        if (!response.ok) throw new ApiError(503, 'GITHUB_UNAVAILABLE', `Listing repositories failed (${response.status})`);
        const body = await response.json() as { repositories: typeof repos };
        repos.push(...body.repositories);
        if (body.repositories.length < 100) break;
      }
      const apps: StudioApp[] = [];
      for (const repo of repos.filter((entry) => !entry.archived)) {
        const file = await raw(repo.full_name, 'hearth-app.json', auth);
        if (file.status === 404 || !file.ok) continue;
        const parsed = appFileSchema.safeParse(await file.json().catch(() => null));
        if (!parsed.success) continue;
        const { icon: iconPath, ...meta } = parsed.data;
        let icon: StudioApp['icon'] = null;
        if (iconPath) {
          const image = await raw(repo.full_name, iconPath, auth);
          if (image.ok) {
            const bytes = new Uint8Array(await image.arrayBuffer());
            const lower = iconPath.toLowerCase();
            const contentType = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : lower.endsWith('.webp') ? 'image/webp' : 'image/png';
            if (bytes.byteLength > 0 && bytes.byteLength < 5_000_000) {
              icon = { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), contentType };
            }
          }
        }
        apps.push({ ...meta, iconPath: iconPath ?? null, repo: repo.full_name, defaultBranch: repo.default_branch, icon });
      }
      apps.sort((a, b) => a.name.localeCompare(b.name));
      cached = { at: now(), apps };
      return apps;
    },
  };
}
