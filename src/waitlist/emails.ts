/**
 * The waitlist's two emails: the confirmation after a sign-up, and the launch email. Made for
 * Apple Mail first (light and dark, through color-scheme and a dark-mode media query), and plain
 * enough to hold up in Gmail and Outlook, which ignore the media query and show the light design.
 * Images come from the website (hearthapps.com/assets/img/email/<app>.png, 144 px).
 */

export type EmailApp = { key: string; name: string };

/** Each app's button color: its darker "ink" shade, so white text on it passes contrast. */
const INK: Record<string, string> = {
  bigtable: '#C0391F', suffice: '#167A52', sated: '#B44A06', caloma: '#C21E43',
  hearken: '#0060D6', trove: '#0F7A9C', ember: '#B8470F',
};
const HEARTH_INK = '#1C1C1E';
/** The lighter shade for the small line above the headline in Dark Mode. */
const DARK: Record<string, string> = {
  bigtable: '#FF7A5C', suffice: '#3DD68C', sated: '#FFA04D', caloma: '#FF6B8A',
  hearken: '#5AAEFF', trove: '#6FD6F2', ember: '#FFA066',
};
const FONT = `-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Helvetica,Arial,sans-serif`;
export const CONFIRM_DAYS = 7;

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const listOf = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

function layout(input: {
  site: string; preheader: string; title: string; header: string; body: string; footerNote: string; unsubscribe?: boolean;
  /** Dark Mode colors for the eyebrow, and for a button that isn't in an app's color. */
  darkAccent: string; neutralButton: boolean;
}) {
  const site = input.site.replace(/\/+$/, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(input.title)}</title>
<style>
  body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; }
  a { text-decoration: none; }
  @media (prefers-color-scheme: dark) {
    .page { background: #000000 !important; }
    .card { background: #1C1C1E !important; }
    .text { color: #F2F2F7 !important; }
    .muted { color: #98989D !important; }
    .rule { border-color: #38383A !important; }
    .foot { color: #8E8E93 !important; }
    .foot a { color: #8E8E93 !important; }
    .eyebrow { color: ${input.darkAccent} !important; }${input.neutralButton ? `
    .button, .button a { background: #F2F2F7 !important; color: #1C1C1E !important; }` : ''}
  }
  @media (max-width: 480px) {
    .card-pad { padding: 28px 22px !important; }
    .headline { font-size: 24px !important; }
  }
</style>
</head>
<body class="page" style="margin:0;padding:0;background:#F2F2F7">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(input.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="page" style="background:#F2F2F7">
<tr><td align="center" style="padding:40px 16px 32px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px">
  <tr><td class="card card-pad" style="background:#FFFFFF;border-radius:24px;padding:36px 32px;font-family:${FONT}">
    ${input.header}
    ${input.body}
  </td></tr>
  <tr><td align="center" style="padding:24px 12px 0;font-family:${FONT}">
    <a href="${escapeHtml(site)}"><img src="${escapeHtml(site)}/assets/img/email/hearth.png" width="28" height="28" alt="Hearth" style="display:block;border:0;width:28px;height:28px;margin:0 auto 10px"></a>
    <p class="foot" style="margin:0;font-size:12px;line-height:1.6;color:#8A8A8E">${input.footerNote}</p>
    <p class="foot" style="margin:4px 0 0;font-size:12px;line-height:1.6;color:#8A8A8E">Hearth Software LLC · <a href="${escapeHtml(site)}" style="color:#8A8A8E;text-decoration:underline">hearthapps.com</a>${input.unsubscribe ? ` · <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#8A8A8E;text-decoration:underline">Unsubscribe</a>` : ''}</p>
  </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

/** The app icons (one large, or a row of smaller ones) and the small line above the headline. */
function header(site: string, apps: EmailApp[], eyebrow: string, color: string) {
  const base = site.replace(/\/+$/, '');
  const size = apps.length === 1 ? 64 : 48;
  const icons = apps.slice(0, 6).map((app) =>
    `<img src="${escapeHtml(base)}/assets/img/email/${escapeHtml(app.key)}.png" width="${size}" height="${size}" alt="${escapeHtml(app.name)}" style="display:inline-block;border:0;width:${size}px;height:${size}px;margin:0 8px 0 0">`).join('');
  return `<div style="margin:0 0 22px;line-height:0">${icons}</div>
    <p class="eyebrow" style="margin:0 0 8px;font-size:13px;line-height:1.3;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${color}">${escapeHtml(eyebrow)}</p>`;
}

function button(href: string, label: string, color: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0"><tr>
      <td class="button" style="border-radius:999px;background:${color}">
        <a href="${escapeHtml(href)}" style="display:inline-block;padding:15px 30px;border-radius:999px;background:${color};color:#FFFFFF;font-family:${FONT};font-size:16px;font-weight:600;line-height:1.2;text-decoration:none">${escapeHtml(label)}</a>
      </td>
    </tr></table>`;
}

export function confirmationEmail(apps: EmailApp[], link: string, site: string) {
  const names = listOf(apps.map((app) => app.name));
  const one = apps.length === 1;
  const color = one ? (INK[apps[0]!.key] ?? HEARTH_INK) : HEARTH_INK;
  const subject = `Confirm: hear when ${names} launches`;
  const body = `<h1 class="text headline" style="margin:0 0 14px;font-size:26px;line-height:1.2;font-weight:700;letter-spacing:-.01em;color:#1C1C1E">One tap to confirm</h1>
    <p class="text" style="margin:0;font-size:16px;line-height:1.55;color:#1C1C1E">You asked to hear when ${escapeHtml(names)} ${one ? 'comes' : 'come'} to the App Store. Confirm, and we’ll email you once on launch day${one ? '' : ' for each'}. Nothing else.</p>
    ${button(link, 'Confirm my email', color)}
    <p class="muted rule" style="margin:28px 0 0;padding:20px 0 0;border-top:1px solid #E5E5EA;font-size:14px;line-height:1.5;color:#6C6C70">The link works for ${CONFIRM_DAYS} days. If this wasn’t you, ignore this email and you won’t hear from us.</p>`;
  const html = layout({
    site, title: subject, preheader: `Confirm your email to hear when ${names} launches.`,
    header: header(site, apps, one ? `${apps[0]!.name} beta` : 'Hearth betas', color), body,
    footerNote: 'You’re getting this because this address was entered at hearthapps.com/beta.',
    darkAccent: one ? (DARK[apps[0]!.key] ?? '#98989D') : '#98989D', neutralButton: color === HEARTH_INK,
  });
  const text = `One tap to confirm\n\nYou asked to hear when ${names} ${one ? 'comes' : 'come'} to the App Store. Confirm, and we'll email you once on launch day${one ? '' : ' for each'}. Nothing else.\n\nConfirm: ${link}\n\nThe link works for ${CONFIRM_DAYS} days. If this wasn't you, ignore this email and you won't hear from us.\n\nHearth Software LLC · hearthapps.com`;
  return { subject, html, text };
}

export function launchEmail(app: EmailApp, appStoreUrl: string, site: string) {
  const color = INK[app.key] ?? HEARTH_INK;
  const subject = `${app.name} is on the App Store`;
  const body = `<h1 class="text headline" style="margin:0 0 14px;font-size:26px;line-height:1.2;font-weight:700;letter-spacing:-.01em;color:#1C1C1E">${escapeHtml(app.name)} is here</h1>
    <p class="text" style="margin:0;font-size:16px;line-height:1.55;color:#1C1C1E">You asked us to tell you when ${escapeHtml(app.name)} launched. It’s on the App Store now, for iPhone and iPad.</p>
    ${button(appStoreUrl, `Get ${app.name}`, color)}
    <p class="muted rule" style="margin:28px 0 0;padding:20px 0 0;border-top:1px solid #E5E5EA;font-size:14px;line-height:1.5;color:#6C6C70">Thanks for waiting with us. This is the one launch email we promised for ${escapeHtml(app.name)}.</p>`;
  const html = layout({
    site, title: subject, preheader: `${app.name} is on the App Store now.`,
    header: header(site, [app], 'Now on the App Store', color), body,
    footerNote: `You’re getting this because you asked to hear when ${escapeHtml(app.name)} launched.`, unsubscribe: true,
    darkAccent: DARK[app.key] ?? '#98989D', neutralButton: color === HEARTH_INK,
  });
  return { subject, html };
}
