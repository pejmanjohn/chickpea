import { escapeHtml } from '../security/html-escape.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { CONNECTOR_LOGOS } from '../config/connector-logos.ts';
import { MODEL_PROVIDER_LOGOS } from './model-provider-logos.ts';
import {
  CONNECTOR_PRESETS,
  GOOGLE_WORKSPACE_SERVICE_PRESETS,
  MANAGED_CONNECTOR_PRESETS,
  CONNECTION_CATALOG_PRESETS,
} from '../config/presets.ts';
import { GOOGLE_WORKSPACE_SCOPE_OPTIONS } from '../config/api-oauth-policy.ts';
import {
  SUGGESTED_SKILL_CATEGORIES,
  SUGGESTED_SKILLS,
} from '../config/suggested-skills.ts';
import { AUTH_BRAND_HTML } from '../auth/brand.ts';
import {
  CHICKPEA_FAVICON_HTML,
  CHICKPEA_MARK_HTML,
  CHICKPEA_WORDMARK_CSS,
  CHICKPEA_WORDMARK_HTML,
} from '../brand/chickpea-mark.ts';
import type { SlackSetupTransaction } from '../identity/types.ts';
import type { SlackAppManifest } from '../slack/app-manifest.ts';
import {
  ADMIN_UI_SCRIPT_PATH,
  ADMIN_UI_STYLESHEET_PATH,
  adminUiAssetUrl,
} from './ui-assets.ts';

const SLACK_LOGO_DATA_URL =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTQiIGhlaWdodD0iNTQiIHZpZXdCb3g9IjAgMCA1NCA1NCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGcgY2xpcC1wYXRoPSJ1cmwoI2NsaXAwXzQxMjdfNzAxMDUpIj4KPHBhdGggZD0iTTExLjM3OSAzMy45OTkzQzExLjM3OSAzNy4xMzU4IDguODQ1MTIgMzkuNjUwNyA1LjcyNzYgMzkuNjUwN0MyLjYxMDA4IDM5LjY1MDcgMC4wNTcyMjA1IDM3LjExNjggMC4wNTcyMjA1IDMzLjk5OTNDMC4wNTcyMjA1IDMwLjg4MTcgMi41OTExIDI4LjM0NzkgNS43MDg2MiAyOC4zNDc5SDExLjM2VjMzLjk5OTNIMTEuMzc5WiIgZmlsbD0iI0UwMUU1QSIvPgo8cGF0aCBkPSJNMTQuMTk2MiAzMy45OTk3QzE0LjE5NjIgMzAuODYzMiAxNi43MzAxIDI4LjM0ODMgMTkuODQ3NiAyOC4zNDgzQzIyLjk2NTEgMjguMzQ4MyAyNS40OTkgMzAuODgyMiAyNS40OTkgMzMuOTk5N1Y0OC4xMzUzQzI1LjQ5OSA1MS4yNzE4IDIyLjk2NTEgNTMuNzg2NyAxOS44NDc2IDUzLjc4NjdDMTYuNzMwMSA1My43ODY3IDE0LjE5NjIgNTEuMjcxOCAxNC4xOTYyIDQ4LjEzNTNWMzMuOTk5N1oiIGZpbGw9IiNFMDFFNUEiLz4KPHBhdGggZD0iTTE5Ljg2NjIgMTEuMjY3M0MxNi43Mjk2IDExLjI2NzMgMTQuMjE0OCA4LjczMzQ3IDE0LjIxNDggNS42MTU5NEMxNC4yMTQ4IDIuNDk4NDIgMTYuNzQ4NiAtMC4wMzU0NTM4IDE5Ljg2NjIgLTAuMDM1NDUzOEMyMi45ODM3IC0wLjAzNTQ1MzggMjUuNTE3NSAyLjQ5ODQyIDI1LjUxNzUgNS42MTU5NFYxMS4yNjczSDE5Ljg2NjJaIiBmaWxsPSIjMzZDNUYwIi8+CjxwYXRoIGQ9Ik0xOS44NjgyIDE0LjEzMzRDMjMuMDA0NyAxNC4xMzM0IDI1LjUxOTYgMTYuNjY3MyAyNS41MTk2IDE5Ljc4NDhDMjUuNTE5NiAyMi45MDIzIDIyLjk4NTcgMjUuNDM2MiAxOS44NjgyIDI1LjQzNjJINS42NzU2NkMyLjUzOTE2IDI1LjQzNjIgMC4wMjQyNjE1IDIyLjkwMjMgMC4wMjQyNjE1IDE5Ljc4NDhDMC4wMjQyNjE1IDE2LjY2NzMgMi41NTgxNCAxNC4xMzM0IDUuNjc1NjYgMTQuMTMzNEgxOS44NjgyWiIgZmlsbD0iIzM2QzVGMCIvPgo8cGF0aCBkPSJNNDIuNTMyMyAxOS43ODUzQzQyLjUzMjMgMTYuNjQ4OCA0NS4wNjYyIDE0LjEzMzkgNDguMTgzNyAxNC4xMzM5QzUxLjMwMTIgMTQuMTMzOSA1My44MzUxIDE2LjY2NzggNTMuODM1MSAxOS43ODUzQzUzLjgzNTEgMjIuOTAyOCA1MS4zMDEyIDI1LjQzNjcgNDguMTgzNyAyNS40MzY3SDQyLjUzMjNWMTkuNzg1M1oiIGZpbGw9IiMyRUI2N0QiLz4KPHBhdGggZD0iTTM5LjcxMjYgMTkuNzkzNEMzOS43MTI2IDIyLjkyOTkgMzcuMTc4NyAyNS40NDQ4IDM0LjA2MTIgMjUuNDQ0OEMzMC45NDM2IDI1LjQ0NDggMjguNDA5OCAyMi45MTEgMjguNDA5OCAxOS43OTM0VjUuNjE5ODZDMjguNDA5OCAyLjQ4MzM2IDMwLjk0MzYgLTAuMDMxNTM5OSAzNC4wNjEyIC0wLjAzMTUzOTlDMzcuMTc4NyAtMC4wMzE1Mzk5IDM5LjcxMjYgMi40ODMzNiAzOS43MTI2IDUuNjE5ODZWMTkuNzkzNFoiIGZpbGw9IiMyRUI2N0QiLz4KPHBhdGggZD0iTTM0LjAzNzYgNDIuNDgyQzM3LjE3NDEgNDIuNDgyIDM5LjY4OSA0NS4wMTU4IDM5LjY4OSA0OC4xMzM0QzM5LjY4OSA1MS4yNTA5IDM3LjE1NTIgNTMuNzg0OCAzNC4wMzc2IDUzLjc4NDhDMzAuOTIwMSA1My43ODQ4IDI4LjM4NjIgNTEuMjUwOSAyOC4zODYyIDQ4LjEzMzRWNDIuNDgySDM0LjAzNzZaIiBmaWxsPSIjRUNCMjJFIi8+CjxwYXRoIGQ9Ik0zNC4wMzgxIDM5LjY1MDdDMzAuOTAxNiAzOS42NTA3IDI4LjM4NjcgMzcuMTE2OCAyOC4zODY3IDMzLjk5OTNDMjguMzg2NyAzMC44ODE4IDMwLjkyMDYgMjguMzQ3OSAzNC4wMzgxIDI4LjM0NzlINDguMjMwNkM1MS4zNjcxIDI4LjM0NzkgNTMuODgyIDMwLjg4MTggNTMuODgyIDMzLjk5OTNDNTMuODgyIDM3LjExNjggNTEuMzQ4MiAzOS42NTA3IDQ4LjIzMDYgMzkuNjUwN0gzNC4wMzgxWiIgZmlsbD0iI0VDQjIyRSIvPgo8L2c+CjxkZWZzPgo8Y2xpcFBhdGggaWQ9ImNsaXAwXzQxMjdfNzAxMDUiPgo8cmVjdCB3aWR0aD0iNTQiIGhlaWdodD0iNTQiIGZpbGw9IndoaXRlIi8+CjwvY2xpcFBhdGg+CjwvZGVmcz4KPC9zdmc+Cg==';

/**
 * Values the Admin application script reads at start-up. The script itself is
 * a static asset (see assets/admin-ui); it used to be inlined here, which put
 * ~250 KiB of compressed browser code inside the Worker's size budget.
 */
export function adminUiConfig(input: {
  isCloudflare: boolean;
  usageAdminUi: boolean;
  workspaceAdminUi: boolean;
  targetChip: string;
}): Record<string, unknown> {
  return {
    isCloudflare: input.isCloudflare,
    usageAdminUi: input.usageAdminUi,
    workspaceAdminUi: input.workspaceAdminUi,
    targetChip: input.targetChip,
    connectorPresets: CONNECTOR_PRESETS,
    googleWorkspaceServicePresets: GOOGLE_WORKSPACE_SERVICE_PRESETS,
    managedConnectorPresets: MANAGED_CONNECTOR_PRESETS,
    connectionCatalogPresets: CONNECTION_CATALOG_PRESETS,
    connectorLogos: CONNECTOR_LOGOS,
    modelProviderLogos: MODEL_PROVIDER_LOGOS,
    suggestedSkillCategories: SUGGESTED_SKILL_CATEGORIES,
    suggestedSkills: SUGGESTED_SKILLS,
    googleWorkspaceScopes: GOOGLE_WORKSPACE_SCOPE_OPTIONS,
    wordmarkHtml: CHICKPEA_WORDMARK_HTML,
  };
}

function adminUiConfigJson(input: Parameters<typeof adminUiConfig>[0]): string {
  // A JSON island is inert data, but `</script` inside a string would still
  // end the element early; escaping `<` closes that off for every value.
  return JSON.stringify(adminUiConfig(input)).replace(/</g, '\\u003c');
}

export function renderAdminPage(
  options: { usageAdminUi?: boolean; workspaceAdminUi?: boolean; assetVersion?: string } = {},
): string {
  // Target-aware setup and provider copy differs between the Node and
  // Cloudflare runtimes. The primary Admin chrome intentionally stays
  // product-focused and does not expose this deployment detail.
  const isCloudflare = isCloudflareTarget();
  const targetChip = isCloudflare ? 'cloudflare · workers' : 'local · node';
  const usageAdminUi = options.usageAdminUi === true;
  // Omission preserves the full Admin shell for callers and tests that do not
  // have a request principal. The authenticated route passes this explicitly.
  const workspaceAdminUi = options.workspaceAdminUi !== false;
  // Tests and fixtures render without a build; the authenticated route passes
  // the content hash so browsers never pair a new shell with a cached script.
  const assetVersion = options.assetVersion ?? 'dev';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chickpea · /admin</title>
${CHICKPEA_FAVICON_HTML}
<style>:root{${CHICKPEA_WORDMARK_CSS}}</style>
<link rel="stylesheet" href="${adminUiAssetUrl(ADMIN_UI_STYLESHEET_PATH, assetVersion)}">
</head>
<body>
<div id="app" class="frame primary-admin-shell" aria-busy="true">
  <header class="topbar">
    <div class="brand">
      ${CHICKPEA_MARK_HTML}
      ${CHICKPEA_WORDMARK_HTML}
    </div>
    <details class="topbar-menu"><summary aria-label="Menu"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg></summary></details>
    <div class="actions actions-list"><span class="hint">Loading workspace&hellip;</span></div>
  </header>
  <div class="body">
    <nav class="rail primary-shell-sidebar" aria-label="Loading Chickpea">
      <div class="primary-shell-brand"><span class="brand-home">${CHICKPEA_MARK_HTML}${CHICKPEA_WORDMARK_HTML}</span></div>
      <div class="rail-context"><div class="rail-head"><span class="section-eyebrow">Loading workspace</span></div></div>
    </nav>
    <main class="main"><div class="main-inner"><div class="empty" role="status"><h1 class="page-title">Loading Chickpea&hellip;</h1><p class="hint">Reading your workspace configuration.</p></div></div></main>
  </div>
</div>
<script id="chickpea-admin-config" type="application/json">${adminUiConfigJson({
    isCloudflare, usageAdminUi, workspaceAdminUi, targetChip,
  })}</script>
<script src="${adminUiAssetUrl(ADMIN_UI_SCRIPT_PATH, assetVersion)}"></script>
</body>
</html>`;
}

type SlackAuthPurpose = 'first_owner' | 'login' | 'invitation';

interface SlackAuthWorkspace {
  teamId: string;
  teamName?: string;
}

/** Shared, self-contained shell for every visible Slack identity journey. */
function renderSlackJourneyPage(input: {
  surface: string;
  eyebrow: string;
  title: string;
  intro?: string;
  titleSuccess?: boolean;
  status?: string;
  statusId?: string;
  body: string;
  alert?: string | undefined;
  rootAttributes?: string;
}): string {
  const alert = input.alert
    ? `<div class="auth-alert" id="auth-error" role="alert" tabindex="-1">${escapeHtml(input.alert)}</div>`
    : '';
  const status = input.status
    ? `<p class="auth-status"${input.statusId ? ` id="${escapeHtml(input.statusId)}"` : ''} role="status" aria-live="polite">${escapeHtml(input.status)}</p>`
    : '';
  const title = input.titleSuccess
    ? `<div class="auth-title-line"><span class="auth-title-success" aria-hidden="true">&#10003;</span><h1 class="auth-title" id="auth-title">${escapeHtml(input.title)}</h1></div>`
    : `<h1 class="auth-title" id="auth-title">${escapeHtml(input.title)}</h1>`;
  const intro = input.intro
    ? `<p class="auth-intro">${escapeHtml(input.intro)}</p>`
    : '';
  return `<!doctype html><html lang="en" data-slack-auth-surface="${escapeHtml(input.surface)}"${input.rootAttributes ? ` ${input.rootAttributes}` : ''}><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>Chickpea · ${escapeHtml(input.title)}</title>${CHICKPEA_FAVICON_HTML}
<style>
:root{${CHICKPEA_WORDMARK_CSS}}
:root{--canvas:#f4ebd8;--card:#fffdf6;--well:#f8f1df;--ink:#3b3220;--muted:#6b5c42;--gold:#dda033;--gold-press:#b27e1f;--line:rgba(59,50,32,.16);--danger:#a83f34;--focus:#b05415;--success:#4f8a3f}*{box-sizing:border-box}html{color-scheme:light}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--canvas);color:var(--ink);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:clamp(12px,4vw,32px);overflow-wrap:anywhere}.auth-card{width:min(600px,100%);background:var(--card);border:1px solid var(--line);border-radius:22px;padding:clamp(22px,6vw,46px);box-shadow:0 14px 38px rgba(59,50,32,.1)}.auth-brand{display:flex;align-items:center;gap:10px;margin-bottom:30px}.auth-brand-mark{width:42px;height:42px;display:block}.auth-brand-name{font-weight:850;font-size:1.15rem}.auth-eyebrow{margin:0;color:var(--muted);font-size:.76rem;font-weight:850;letter-spacing:.09em;text-transform:uppercase}.auth-title-line{align-items:center;display:flex;gap:13px;margin:8px 0 10px}.auth-title{margin:8px 0 10px;font-size:clamp(1.75rem,7vw,2.7rem);line-height:1.05;letter-spacing:-.035em}.auth-title-line .auth-title{margin:0}.auth-title-success{align-items:center;background:var(--success);border-radius:50%;color:#fff;display:inline-flex;flex:0 0 auto;font-size:1.15rem;font-weight:850;height:36px;justify-content:center;width:36px}.auth-intro,.auth-status,.auth-help{color:var(--muted);line-height:1.55}.auth-status{min-height:1.5em;margin:14px 0}.auth-alert{margin:18px 0;border-left:4px solid var(--danger);border-radius:8px;background:#fff3ee;color:var(--danger);padding:12px 14px;font-weight:750;line-height:1.45}.auth-section{margin-top:24px;padding:20px;border:1px solid var(--line);border-radius:15px;background:var(--well)}.auth-section h2{margin:0 0 8px;font-size:1.08rem}label{display:block;margin:17px 0 6px;font-weight:750}label span{display:block;margin-top:2px;color:var(--muted);font-size:.78rem;font-weight:500}input,textarea{width:100%;min-height:46px;border:1px solid var(--line);border-radius:11px;background:#fff;color:var(--ink);padding:11px 12px;font:inherit}textarea{min-height:220px;resize:vertical}details{margin-top:20px;border-top:1px solid var(--line);padding-top:17px}summary{cursor:pointer;font-weight:800}.auth-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}.auth-button,.auth-link{display:inline-flex;align-items:center;justify-content:center;min-height:48px;border:0;border-radius:12px;padding:11px 17px;background:var(--gold);box-shadow:0 3px 0 var(--gold-press);color:var(--ink);font:inherit;font-weight:850;text-decoration:none;cursor:pointer}.auth-button{width:100%}.slack-provider-button{gap:12px;background:#fff;border:1px solid var(--line);box-shadow:0 1px 2px rgba(45,44,47,.04);color:#2d2c2f;font-weight:750}.slack-provider-button:hover{background:#fbfbfb;border-color:rgba(59,50,32,.32);box-shadow:0 2px 7px rgba(45,44,47,.09)}.slack-provider-logo{width:24px;height:24px}.auth-button.secondary,.auth-link.secondary{background:transparent;border:1px solid var(--line);box-shadow:none}.auth-button:active,.auth-link:active{transform:translateY(2px);box-shadow:none}.auth-button:focus-visible,.auth-link:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible,.auth-alert:focus-visible{outline:3px solid color-mix(in srgb,var(--focus) 48%,transparent);outline-offset:3px}.slack-provider-button:focus-visible{outline:2px solid #656468;outline-offset:2px}.auth-warning{margin-top:22px;border:1px solid rgba(168,63,52,.25);border-radius:13px;background:#fff3ee;padding:15px}.auth-warning strong{display:block;margin-bottom:5px}.auth-meta{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.83rem}.auth-manifest{max-height:280px;overflow:auto;white-space:pre-wrap;font-size:.75rem}.slack-logo-image{background:url("${SLACK_LOGO_DATA_URL}") center/contain no-repeat;display:inline-block}.setup-token-callout{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;margin:22px 0;padding:15px 17px;border-left:3px solid var(--gold-press);border-radius:12px;background:var(--well)}.setup-token-callout strong{display:block;margin-bottom:3px}.setup-token-callout p{margin:0;color:var(--muted);font-size:.86rem;line-height:1.45}.setup-slack-link{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:9px 13px;border:1px solid var(--line);border-radius:11px;background:var(--card);color:var(--ink);font-weight:800;text-decoration:none;white-space:nowrap}.setup-slack-logo{width:22px;height:22px}.setup-token-note{display:flex;gap:8px;align-items:flex-start;margin:13px 0 0;color:var(--muted);font-size:.8rem;line-height:1.45}.setup-manual-choice p{margin-bottom:14px}html[data-slack-auth-surface="setup"][data-slack-setup-state="awaiting_app_creation"] .auth-card,html[data-slack-auth-surface="owner-complete"] .auth-card{padding-block:56px}html[data-slack-auth-surface="setup"][data-slack-setup-state="awaiting_app_creation"] .auth-brand,html[data-slack-auth-surface="owner-complete"] .auth-brand{margin-bottom:38px}html[data-slack-auth-surface="setup"][data-slack-setup-state="awaiting_app_creation"] .auth-title,html[data-slack-auth-surface="owner-complete"] .auth-title{margin:14px 0 0}html[data-slack-auth-surface="setup"][data-slack-setup-state="awaiting_app_creation"] .auth-title-line{margin:14px 0 0}html[data-slack-auth-surface="setup"][data-slack-setup-state="awaiting_app_creation"] .auth-title-line .auth-title{margin:0}html[data-slack-auth-surface="setup"][data-slack-setup-state="awaiting_app_creation"] .auth-intro{margin:18px 0 0}html[data-slack-auth-surface="setup"][data-slack-setup-state="awaiting_app_creation"] .auth-intro+form{margin-top:28px}html[data-slack-auth-surface="setup"][data-slack-setup-state="awaiting_app_creation"] form+details{margin-top:30px}html[data-slack-auth-surface="owner-complete"] .auth-actions{margin-top:32px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:440px){body{padding:8px}.auth-card{border-radius:14px;padding:21px 16px}html[data-slack-auth-surface="setup"][data-slack-setup-state="awaiting_app_creation"] .auth-card,html[data-slack-auth-surface="owner-complete"] .auth-card{padding-block:32px}.auth-actions{display:grid}.auth-link,.auth-button{width:100%}.auth-section{padding:16px 13px}.setup-token-callout{grid-template-columns:1fr}.setup-slack-link{width:100%;justify-content:center}}
.brand-wordmark{aspect-ratio:2106/518;background-color:currentColor;display:block;flex:0 0 auto;height:36px;-webkit-print-color-adjust:exact;print-color-adjust:exact;-webkit-mask:var(--chickpea-wordmark-image) center/contain no-repeat;mask:var(--chickpea-wordmark-image) center/contain no-repeat}@media(forced-colors:active){.brand-wordmark{background-color:CanvasText;forced-color-adjust:none}}
</style></head><body><main class="auth-card" aria-labelledby="auth-title">${AUTH_BRAND_HTML}<p class="auth-eyebrow">${escapeHtml(input.eyebrow)}</p>${title}${intro}${alert}${status}${input.body}</main></body></html>`;
}

/** Complete a same-origin POST before navigating across the strict form-action CSP boundary. */
export function renderSlackAuthorizationHandoffPage(
  authorizationUrl: string,
  gatewayOrigin?: string,
): string {
  const target = new URL(authorizationUrl);
  const slackAuthorization = target.origin === 'https://slack.com' &&
    (target.pathname === '/oauth/v2/authorize' || target.pathname === '/openid/connect/authorize');
  // Only deployment configuration may opt into the shared-app claim handoff.
  const gatewayAuthorization = target.origin === gatewayOrigin &&
    /^\/install\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(target.pathname) && !target.search;
  if (target.protocol !== 'https:' || (!slackAuthorization && !gatewayAuthorization) ||
      target.username || target.password || target.hash) {
    throw new TypeError('Slack authorization URL is invalid.');
  }
  const safeTarget = escapeHtml(target.toString());
  const script = gatewayAuthorization ? '/admin/setup/gateway-continue.js' : '/auth/slack/continue.js';
  return renderSlackJourneyPage({
    surface: 'authorization-handoff',
    eyebrow: 'Secure Slack handoff',
    title: 'Opening Slack…',
    intro: 'Chickpea prepared a fresh, short-lived Slack authorization request.',
    status: 'If Slack does not open automatically, use the button below.',
    body: `<div class="auth-actions"><a class="auth-link" data-slack-authorization-link href="${safeTarget}" rel="noreferrer" autofocus>Continue to Slack</a></div><script src="${script}" defer></script>`,
  });
}

export function renderSlackSignInPage(destination: string): string {
  const safeDestination = safeSlackPageDestination(destination);
  return renderSlackJourneyPage({
    surface: 'sign-in',
    eyebrow: 'Chickpea control plane',
    title: 'Welcome back',
    intro: 'Sign in with the Slack account you use with Chickpea in this workspace.',
    body: `<form method="post" action="/auth/slack/oidc/start"><input type="hidden" name="purpose" value="login"><input type="hidden" name="destination" value="${escapeHtml(safeDestination)}"><button class="auth-button slack-provider-button" type="submit" autofocus><span class="slack-provider-logo slack-logo-image" aria-hidden="true"></span>Continue with Slack</button></form>`,
  });
}

export function renderSlackAccessDeniedPage(input: {
  purpose: Exclude<SlackAuthPurpose, 'invitation'>;
  destination: string;
  reason: string;
  workspace?: SlackAuthWorkspace;
}): string {
  const safeDestination = safeSlackPageDestination(input.destination);
  const workspace = slackWorkspaceLabel(input.workspace);
  const firstOwner = input.purpose === 'first_owner';
  const cancelled = input.reason === 'provider_denied';
  const expired = input.reason === 'expired_state';
  const title = cancelled ? 'Slack sign-in was cancelled'
    : expired ? 'Slack sign-in expired'
      : 'That Slack account cannot access Chickpea';
  const intro = firstOwner
    ? `Use the same active Slack member who installed Chickpea in ${workspace}.`
    : `First interact with a Chickpea Agent in ${workspace}, then sign in with that same active Slack member.`;
  const capability = firstOwner
    ? '<input data-slack-setup-capability type="hidden" name="capability">'
    : '';
  const setupScript = firstOwner ? '<script src="/admin/setup/client.js" defer></script>' : '';
  return renderSlackJourneyPage({
    surface: 'access-denied',
    eyebrow: firstOwner ? 'First Owner setup' : 'Access not granted',
    title,
    intro,
    status: firstOwner
      ? 'No Chickpea account or role was created.'
      : 'No Chickpea account or role was created. If access was suspended or removed, ask an Owner to restore it.',
    alert: cancelled || expired ? undefined : 'This Slack identity does not match the required Chickpea access.',
    body: `<form method="post" action="/auth/slack/oidc/start"><input type="hidden" name="purpose" value="${input.purpose}">${capability}<input type="hidden" name="destination" value="${escapeHtml(safeDestination)}"><button class="auth-button" type="submit" autofocus>Try another Slack account</button></form>${setupScript}`,
  });
}

export function renderSlackOwnerCompletePage(destination: string): string {
  const safeDestination = safeSlackPageDestination(destination);
  return renderSlackJourneyPage({
    surface: 'owner-complete',
    eyebrow: 'Setup complete',
    title: '🎉 Installation successful',
    body: `<div class="auth-actions"><a class="auth-link" href="${escapeHtml(safeDestination)}" autofocus>Open Chickpea</a></div>`,
  });
}

export function renderSlackInvitationPage(workspace: SlackAuthWorkspace): string {
  const label = slackWorkspaceLabel(workspace);
  return renderSlackJourneyPage({
    surface: 'invitation', eyebrow: 'Chickpea invitation', title: 'Join Chickpea',
    intro: `Continue with the invited Slack account in ${label}.`,
    status: 'Checking this invitation…',
    statusId: 'invitation-status',
    rootAttributes: 'data-invitation-state="ready"',
    body: '<form id="invitation-form" method="post" action="/auth/slack/oidc/start"><input type="hidden" name="purpose" value="invitation"><input id="invitation-locator" type="hidden" name="invitation"><button class="auth-button" id="invitation-submit" type="submit" disabled autofocus>Continue with Slack</button></form><script src="/auth/slack/invite/client.js" defer></script>',
  });
}

export function renderSlackInvitationMismatchPage(workspace?: SlackAuthWorkspace): string {
  return renderSlackJourneyPage({
    surface: 'invitation-mismatch', eyebrow: 'Invitation identity mismatch',
    title: 'That Slack account cannot use this invitation',
    intro: `Choose the invited account in ${slackWorkspaceLabel(workspace)}. This page does not reveal who was invited.`,
    status: 'No Chickpea access was granted.',
    rootAttributes: 'data-invitation-state="mismatch"',
    body: '<div class="auth-actions"><a class="auth-link" href="/auth/slack/invite" autofocus>Try another Slack account</a></div><script src="/auth/slack/invite/client.js" defer></script>',
  });
}

export function renderSlackInvitationCompletePage(destination: string): string {
  const safeDestination = safeSlackPageDestination(destination);
  return renderSlackJourneyPage({
    surface: 'invitation-complete', eyebrow: 'Invitation accepted', title: 'You’re in',
    intro: 'Your exact Slack identity is now linked to this Chickpea workspace.',
    status: 'Opening the Team page…',
    rootAttributes: `data-invitation-state="complete" data-destination="${escapeHtml(safeDestination)}"`,
    body: `<noscript><a class="auth-link" href="${escapeHtml(safeDestination)}">Open Chickpea</a></noscript><script src="/auth/slack/invite/client.js" defer></script>`,
  });
}

export function renderSlackInvitationUnavailablePage(): string {
  return renderSlackJourneyPage({
    surface: 'invitation-unavailable', eyebrow: 'Invitation unavailable',
    title: 'This invitation is no longer available',
    intro: 'Use a Chickpea Agent in Slack, then sign in with the same full member account. If access was removed, ask an Owner to restore it.',
    status: 'No access was granted.', rootAttributes: 'data-invitation-state="unavailable"',
    body: '<script src="/auth/slack/invite/client.js" defer></script>',
  });
}

/** Guided app adoption; the shared install flow verifies Events after credentials exist. */
export function renderSlackManualSetupPage(input: {
  setup?: SlackSetupTransaction;
  destination: string;
  manifest: SlackAppManifest;
  manifestPrefillUrl: string;
  error?: string;
  autoResume?: boolean;
}): string {
  const state = input.setup?.state ?? 'capability_required';
  const destination = safeSlackPageDestination(input.destination);
  const hidden = `<input data-slack-setup-capability type="hidden" name="capability"><input type="hidden" name="destination" value="${escapeHtml(destination)}">`;
  const manifestJson = escapeHtml(JSON.stringify(input.manifest, null, 2));
  const initialStep = input.error ? 'credentials' : 'create';
  const alert = input.error
    ? `<div class="onboarding-error" role="alert" tabindex="-1"><p class="field-error">${escapeHtml(slackSetupPageMessage(input.error))}</p><p class="hint">For your safety, every secret field has been cleared.</p></div>`
    : '';
  const capabilityPanel = `<section class="onboarding-panel" data-manual-step-panel="create"><p class="onboarding-eyebrow">Connect Slack</p><h1 class="onboarding-title" tabindex="-1">Resume manual setup</h1><p class="onboarding-lede" id="slack-setup-status">Reading the private setup capability from this browser tab.</p><form id="slack-setup-open-form" method="post" action="/admin/setup/manual"><input type="hidden" name="action" value="open">${hidden}<button class="btn btn-primary" type="submit">Continue manual setup</button></form></section>`;
  const createPanelHidden = initialStep === 'create' ? '' : ' hidden';
  const userGroupPrerequisite = `<aside class="onboarding-prerequisite" role="note" aria-label="Agent handle permissions"><h2 class="onboarding-prerequisite-title">Before creating Agent @handles</h2><p>The manifest already requests <code>usergroups:read</code> and <code>usergroups:write</code>. Slack also requires a paid plan and a separate workspace permission that a manifest cannot change.</p><p>In the intended Slack workspace, ask an Owner or Admin to open <strong>Roles &amp; permissions → Account types → Create and edit user groups</strong>, allow <strong>Members</strong>, and save. This permits workspace members, not just Chickpea, to manage user groups. If your organization locks this setting, ask an Org Owner.</p></aside>`;
  const createPanel = `<section class="onboarding-panel" data-manual-step-panel="create"${createPanelHidden}><p class="onboarding-eyebrow">Connect Slack</p><h1 class="onboarding-title" tabindex="-1">Create Chickpea</h1><p class="onboarding-lede">Slack opens in a new tab. Come back here after Chickpea is created.</p>${userGroupPrerequisite}<div class="onboarding-instructions">${manualSlackInstruction(1, 'Choose your workspace, then click Next.', '', 'create-workspace', 'onboarding-shot-viewport', 'Slack Create from manifest screen with the workspace picker and Next button')}${manualSlackInstruction(2, 'Review Chickpea, then click Create and Install.', '', 'create-review', 'onboarding-shot-viewport', 'Slack app review screen showing Chickpea permissions and Create and Install')}</div><div class="onboarding-guide-actions"><button class="btn btn-ghost" type="button" data-manual-step-target="credentials">Already created the app? Add its credentials</button><a class="btn btn-primary" href="${escapeHtml(input.manifestPrefillUrl)}" target="_blank" rel="noreferrer" data-manual-step-target="finish"><span class="onboarding-slack-logo slack-logo-image" aria-hidden="true"></span>Create Chickpea in Slack <span aria-hidden="true">↗</span></a></div></section>`;
  const finishPanel = `<section class="onboarding-panel" data-manual-step-panel="finish" hidden><p class="onboarding-eyebrow">Connect Slack</p><h1 class="onboarding-title" tabindex="-1">Finish creating Chickpea</h1><p class="onboarding-lede">Two quick actions in the Slack tab you just opened.</p><div class="onboarding-instructions">${manualSlackInstruction(1, 'Review the permissions, then click Allow.', '', 'allow', 'onboarding-shot-focused', 'Slack permission approval screen with the Allow button')}${manualSlackInstruction(2, 'When Slack says Chickpea is ready, click Go to App Settings.', '', 'ready', 'onboarding-shot-ready', 'Slack Chickpea is ready dialog with the Go to App Settings button')}</div><div class="onboarding-guide-actions"><button class="btn btn-ghost" type="button" data-manual-step-target="create">Back</button><button class="btn btn-primary" type="button" data-manual-step-target="credentials">Next: Add app credentials</button></div></section>`;
  const credentialsPanel = `<section class="onboarding-panel" data-manual-step-panel="credentials"${initialStep === 'credentials' ? '' : ' hidden'}><p class="onboarding-eyebrow">Connect Slack</p><h1 class="onboarding-title" tabindex="-1">Add app credentials</h1><p class="onboarding-lede">Paste these values once. Chickpea validates the app, encrypts its credentials, and then uses Slack OAuth for the bot token and installer identity. You’ll verify the Events URL after Slack installation.</p><a class="btn btn-ghost onboarding-inline-recovery" href="https://api.slack.com/apps" target="_blank" rel="noreferrer">Lost the Slack tab? Open your apps <span aria-hidden="true">↗</span></a><form class="onboarding-credential-form" method="post" action="/admin/setup/manual"><input type="hidden" name="action" value="adopt">${hidden}<section class="onboarding-credential"><h2 class="onboarding-instruction-title"><span class="onboarding-instruction-number">1</span><span>In Basic Information, copy the app credentials.</span></h2><div class="onboarding-credential-grid"><div class="onboarding-shot onboarding-shot-secret"><img src="/onboarding/signing-secret.webp" alt="Slack Basic Information showing the Signing Secret" loading="lazy" decoding="async"></div><div class="onboarding-credential-help"><label class="field" for="manual-app-id"><span class="field-label">App ID</span><input class="input mono" id="manual-app-id" name="appId" type="text" autocomplete="off" maxlength="64" required></label><label class="field" for="manual-client-id"><span class="field-label">Client ID</span><input class="input mono" id="manual-client-id" name="clientId" type="text" autocomplete="off" maxlength="256" required></label><label class="field" for="manual-client-secret"><span class="field-label">Client Secret</span><input class="input mono" id="manual-client-secret" name="clientSecret" type="password" autocomplete="off" maxlength="4096" required></label><label class="field" for="manual-signing-secret"><span class="field-label">Signing Secret</span><span class="onboarding-credential-subtext">Use Signing Secret — not Client Secret.</span><input class="input mono" id="manual-signing-secret" name="signingSecret" type="password" autocomplete="off" maxlength="4096" required></label></div></div></section><section class="onboarding-credential"><h2 class="onboarding-instruction-title"><span class="onboarding-instruction-number">2</span><span>Export the app manifest as JSON and paste it here.</span></h2><label class="field" for="manual-manifest"><span class="field-label">Exported app manifest (JSON)</span><textarea class="input mono" id="manual-manifest" name="observedManifest" maxlength="7500" required>${manifestJson}</textarea></label></section>${alert}<div class="onboarding-guide-actions"><button class="btn btn-ghost" type="button" data-manual-step-target="finish">Back</button><button class="btn btn-primary" type="submit">Validate and continue</button></div></form></section>`;
  const panels = state === 'capability_required'
    ? capabilityPanel
    : state === 'awaiting_app_creation'
      ? `${createPanel}${finishPanel}${credentialsPanel}`
      : `<section class="onboarding-panel" data-manual-step-panel="create"><p class="onboarding-eyebrow">Manual setup</p><h1 class="onboarding-title" tabindex="-1">Continue shared setup</h1><p class="onboarding-lede">The app is ready. Continue with the encrypted Slack installation and Owner verification.</p><div class="onboarding-actions"><a class="btn btn-primary" href="/admin/setup">Continue setup</a></div></section>`;
  return `<!doctype html><html lang="en" data-slack-manual-setup-state="${escapeHtml(state)}" data-slack-setup-state="${escapeHtml(state)}" data-slack-setup-auto-resume="${String(input.autoResume === true)}" data-manual-initial-step="${initialStep}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Chickpea · Manual Slack setup</title>${CHICKPEA_FAVICON_HTML}<style>${SLACK_MANUAL_SETUP_CSS}</style></head><body><main class="onboarding-shell"><div class="onboarding-shell-inner"><div class="onboarding-brand-row">${AUTH_BRAND_HTML}<span class="onboarding-environment">private setup</span></div><ol class="onboarding-orientation" role="list" aria-label="Onboarding progress"><li class="active" aria-current="step"><span class="onboarding-step-dot">1</span><span class="onboarding-step-label">Connect Slack</span></li><li><span class="onboarding-step-dot">2</span><span class="onboarding-step-label">Choose provider</span></li><li><span class="onboarding-step-dot">3</span><span class="onboarding-step-label">Choose model</span></li><li><span class="onboarding-step-dot">4</span><span class="onboarding-step-label">Try Chickpea</span></li></ol><div class="onboarding-stage" aria-live="polite">${panels}</div></div></main><script src="/admin/setup/manual/client.js" defer></script></body></html>`;
}

function manualSlackInstruction(
  number: number,
  title: string,
  note: string,
  imageName: string,
  imageClass: string,
  alt: string,
): string {
  return `<section class="onboarding-instruction"><h2 class="onboarding-instruction-title"><span class="onboarding-instruction-number">${number}</span><span>${escapeHtml(title)}</span></h2>${note ? `<p class="onboarding-instruction-note">${escapeHtml(note)}</p>` : ''}<div class="onboarding-shot ${escapeHtml(imageClass)}"><img src="/onboarding/${escapeHtml(imageName)}.webp" alt="${escapeHtml(alt)}" loading="lazy" decoding="async"></div></section>`;
}

const SLACK_MANUAL_SETUP_CSS = `
@import url("https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&family=Quicksand:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap");
:root{${CHICKPEA_WORDMARK_CSS}}
:root{--bg:#fffdf6;--canvas:#f4ebd8;--well:#f8f1df;--line:rgba(59,50,32,.1);--line-strong:rgba(59,50,32,.16);--text:#3b3220;--text-2:#6b5c42;--text-3:#9f8f72;--ember:#dda033;--ember-deep:#8a6410;--ember-tint:rgba(221,160,51,.18);--ember-press:#b27e1f;--danger:#b5473a;--font:Quicksand,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--display:"Baloo 2",var(--font);--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace}*{box-sizing:border-box}html{color-scheme:light;background:var(--canvas)}body{margin:0;background:var(--canvas);color:var(--text);font-family:var(--font)}button,input,textarea{font:inherit}.onboarding-shell{isolation:isolate;min-height:100dvh;width:100%}.onboarding-shell-inner{margin:0 auto;max-width:1500px;padding:24px 28px 64px;width:100%}.onboarding-brand-row{align-items:center;display:flex;gap:20px;justify-content:space-between}.auth-brand{align-items:center;display:flex;gap:11px}.auth-brand-mark{height:36px;width:36px}.auth-brand-name{font-family:var(--display);font-size:1.625rem;font-weight:700}.onboarding-environment{color:var(--text-3);font-family:var(--mono);font-size:.8125rem}.onboarding-orientation{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));list-style:none;margin:26px auto 0;max-width:680px;padding:0;width:100%}.onboarding-orientation li{min-width:0;position:relative;text-align:center}.onboarding-orientation li:not(:first-child)::before{background:var(--line-strong);content:"";height:2px;position:absolute;right:50%;top:18px;width:100%;z-index:-1}.onboarding-step-dot{background:var(--canvas);border:2px solid var(--line-strong);border-radius:50%;color:var(--text-3);display:grid;font-family:var(--mono);font-size:.875rem;height:38px;margin:0 auto 9px;place-items:center;width:38px}.active .onboarding-step-dot{background:var(--bg);border-color:var(--ember);box-shadow:0 0 0 5px var(--ember-tint);color:var(--ember-deep)}.onboarding-step-label{color:var(--text-3);display:block;font-size:.875rem;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.active .onboarding-step-label{color:var(--text)}.onboarding-stage{display:grid;min-height:590px;padding-top:32px;place-items:start center}.onboarding-panel{background:var(--bg);border-radius:28px;box-shadow:0 4px 0 rgba(59,50,32,.11);padding:42px 44px;width:min(82%,1280px)}.onboarding-eyebrow{color:var(--ember-deep);font-family:var(--mono);font-size:.75rem;font-weight:700;letter-spacing:.09em;margin:0 0 12px;text-transform:uppercase}.onboarding-title{color:var(--text);font-family:var(--display);font-size:clamp(2.25rem,3.4vw,2.875rem);font-weight:700;letter-spacing:-.025em;line-height:1;margin:0;max-width:24ch;text-wrap:balance}.onboarding-lede{color:var(--text-2);font-size:1.125rem;line-height:1.5;margin:14px 0 0;max-width:58ch}.onboarding-instructions{display:grid;gap:32px;margin-top:32px}.onboarding-instruction{display:grid;gap:13px}.onboarding-instruction-title{align-items:center;color:var(--text);display:grid;font-size:1.125rem;font-weight:700;gap:12px;grid-template-columns:36px minmax(0,1fr);line-height:1.35;margin:0}.onboarding-instruction-number{background:#faedca;border-radius:50%;color:var(--ember-deep);display:grid;font-family:var(--mono);font-size:.875rem;font-weight:700;height:36px;place-items:center;width:36px}.onboarding-instruction-note{color:var(--text-2);font-size:.9375rem;line-height:1.45;margin:-3px 0 0 48px}.onboarding-shot{background:white;border:1px solid var(--line-strong);border-radius:16px;box-shadow:0 2px 0 rgba(59,50,32,.07);overflow:hidden}.onboarding-shot img{display:block;height:auto;width:100%}.onboarding-shot-viewport{height:380px}.onboarding-shot-viewport img{height:100%;object-fit:cover;object-position:center bottom}.onboarding-shot-focused{margin-left:53px;width:min(700px,calc(100% - 53px))}.onboarding-shot-ready{margin-left:53px;width:min(760px,calc(100% - 53px))}.onboarding-shot-wide{margin-left:53px;width:min(920px,calc(100% - 53px))}.onboarding-shot-events{aspect-ratio:1.25;position:relative}.onboarding-shot-events img{height:auto;left:0;position:absolute;top:-7%;width:100%}.onboarding-guide-actions{align-items:center;border-top:1px solid var(--line);display:flex;gap:16px;justify-content:space-between;margin-top:36px;padding-top:22px}.btn{align-items:center;border:0;border-radius:12px;color:var(--text);cursor:pointer;display:inline-flex;font-weight:700;justify-content:center;min-height:46px;padding:10px 17px;text-decoration:none}.btn-primary{background:var(--ember);box-shadow:0 3px 0 var(--ember-press)}.btn-ghost{background:transparent;border:1px solid var(--line-strong)}.slack-logo-image{background:url("${SLACK_LOGO_DATA_URL}") center/contain no-repeat;display:inline-block}.onboarding-slack-logo{height:23px;margin-right:7px;width:23px}.onboarding-inline-recovery{margin-top:10px}.onboarding-credential-form{display:grid;gap:32px;margin-top:32px}.onboarding-credential{display:grid;gap:13px}.onboarding-credential-grid{align-items:start;display:grid;gap:26px;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.onboarding-credential-help{display:grid;gap:9px}.field{display:grid;gap:7px}.field-label{font-weight:700}.input{background:var(--well);border:1px solid var(--line-strong);border-radius:11px;color:var(--text);min-height:48px;padding:11px 12px;width:100%}textarea.input{min-height:230px;resize:vertical}.mono{font-family:var(--mono)}.onboarding-credential-subtext,.hint{color:var(--text-3);font-size:.8125rem}.onboarding-shot-secret{width:min(420px,100%)}.onboarding-error{background:#fff3ee;border-left:4px solid var(--danger);border-radius:8px;padding:12px 14px}.field-error{color:var(--danger);font-weight:700;margin:0 0 4px}.onboarding-actions{display:flex;gap:10px;margin-top:30px}[hidden]{display:none!important}:focus-visible{outline:3px solid rgba(176,84,21,.48);outline-offset:3px}
.onboarding-prerequisite{background:var(--well);border:1px solid var(--line-strong);border-radius:14px;margin-top:24px;padding:18px 20px}.onboarding-prerequisite-title{font-size:1rem;margin:0 0 10px}.onboarding-prerequisite p{color:var(--text-2);font-size:.9375rem;line-height:1.5;margin:10px 0 0}.onboarding-prerequisite code{font-family:var(--mono);font-size:.875em}
.brand-wordmark{aspect-ratio:2106/518;background-color:currentColor;display:block;flex:0 0 auto;height:31px;-webkit-print-color-adjust:exact;print-color-adjust:exact;-webkit-mask:var(--chickpea-wordmark-image) center/contain no-repeat;mask:var(--chickpea-wordmark-image) center/contain no-repeat}@media(forced-colors:active){.brand-wordmark{background-color:CanvasText;forced-color-adjust:none}}
@media(max-width:720px){.onboarding-shell-inner{padding:20px 16px 45px}.onboarding-environment{display:none}.onboarding-orientation{margin-top:34px}.onboarding-step-dot{font-size:.75rem;height:34px;width:34px}.onboarding-orientation li:not(:first-child)::before{top:16px}.onboarding-step-label{font-size:.6875rem}.onboarding-stage{min-height:520px;padding-top:28px}.onboarding-panel{border-radius:22px;padding:30px 22px;width:100%}.onboarding-title{font-size:2.125rem}.onboarding-lede{font-size:1.0625rem}.onboarding-shot-viewport{height:250px}.onboarding-shot-focused,.onboarding-shot-ready,.onboarding-shot-wide{margin-left:0;width:100%}.onboarding-credential-grid{grid-template-columns:1fr}.onboarding-guide-actions{align-items:stretch;flex-direction:column-reverse}.onboarding-guide-actions .btn{width:100%}}
`;

export function renderSlackSetupPage(input: {
  setup?: SlackSetupTransaction;
  destination: string;
  manifest: SlackAppManifest;
  notice?: string;
  error?: string;
  autoResume?: boolean;
  gatewayState?: 'disconnected' | 'pending' | 'connected' | 'error';
}): string {
  const state = input.setup?.state ?? 'capability_required';
  const destination = safeSlackPageDestination(input.destination);
  const notice = input.notice ? slackSetupPageMessage(input.notice) : undefined;
  const error = input.error ? slackSetupPageMessage(input.error) : undefined;
  const hidden = `<input data-slack-setup-capability type="hidden" name="capability"><input type="hidden" name="destination" value="${escapeHtml(destination)}">`;
  const manifestJson = escapeHtml(JSON.stringify(input.manifest, null, 2));
  let title = 'Resume private setup';
  let intro = 'Chickpea keeps this seven-day setup checkpoint without turning the setup link into a user session.';
  let body = '';
  if (state === 'capability_required') {
    body = `<form id="slack-setup-open-form" method="post" action="/admin/setup"><input type="hidden" name="action" value="open">${hidden}${input.notice ? `<input type="hidden" name="notice" value="${escapeHtml(input.notice)}">` : ''}<button class="auth-button" data-primary-action="resume-private" type="submit" autofocus>Continue private setup</button></form>`;
  } else if (state === 'awaiting_app_creation') {
    title = input.gatewayState === 'connected' ? 'Slack is connected' : 'Add Chickpea to Slack';
    intro = input.gatewayState === 'connected'
      ? 'Your Slack workspace is ready. Continue to finish installing Chickpea.'
      : 'The recommended install uses Chickpea’s shared Slack app. Your deployment keeps its own data and never receives a Slack bot token.';
    const primary = input.gatewayState === 'connected'
      ? `<form method="post" action="/auth/slack/oidc/start">${hidden}<input type="hidden" name="purpose" value="first_owner"><button class="auth-button slack-provider-button" data-primary-action="gateway-owner" type="submit" autofocus><span class="slack-provider-logo slack-logo-image" aria-hidden="true"></span>Continue with Slack</button></form>`
      : input.gatewayState === 'pending'
        ? `<form method="post" action="/admin/setup"><input type="hidden" name="action" value="gateway_refresh">${hidden}<button class="auth-button" data-primary-action="gateway-refresh" type="submit" autofocus>Check Slack installation</button></form>`
        : `<form method="post" action="/admin/setup"><input type="hidden" name="action" value="gateway_begin">${hidden}<button class="auth-button slack-provider-button" data-primary-action="gateway-install" type="submit" autofocus><span class="slack-provider-logo slack-logo-image" aria-hidden="true"></span>Add to Slack</button></form>`;
    const customerOwnedFallback = `<details class="setup-manual-choice" data-secondary-action="customer-owned-app"><summary>Use your own Slack app instead</summary><p class="auth-help">For isolated or regulated deployments, create a customer-owned app with a short-lived Slack configuration token.</p><aside class="setup-token-callout"><div><strong>Generate an App Configuration token in Slack</strong><p>Under Your App Configuration Tokens, choose Generate Token and select your workspace.</p></div><a class="setup-slack-link" href="https://api.slack.com/apps#:~:text=Your%20App%20Configuration%20Tokens" target="_blank" rel="noreferrer"><span class="setup-slack-logo slack-logo-image" aria-hidden="true"></span>Open Slack <span class="sr-only">(opens in a new tab)</span></a></aside><form method="post" action="/admin/setup"><input type="hidden" name="action" value="create">${hidden}<label for="configuration-token">Slack configuration access token<span>Paste the xoxe.xoxp- token here.</span></label><input id="configuration-token" type="password" name="configurationToken" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" maxlength="512" placeholder="xoxe.xoxp-…" required><p class="auth-help">Slack also shows a refresh token beginning xoxe-. Chickpea does not need it.</p><button class="auth-button secondary" data-primary-action="create-app" type="submit">Create my Slack app</button></form><p class="auth-help"><a class="auth-link secondary" href="/admin/setup/manual">Can’t create an app configuration token? Use guided manual setup.</a></p></details>`;
    body = `${primary}${input.gatewayState === 'connected' ? '' : customerOwnedFallback}`;
  } else if (state === 'app_creation_pending') {
    title = 'Check the interrupted creation';
    intro = 'Slack may have created the app even though Chickpea did not receive a final response.';
    body = `<form method="post" action="/admin/setup"><input type="hidden" name="action" value="inspect">${hidden}<button class="auth-button" data-primary-action="inspect-creation" type="submit" autofocus>Inspect saved attempt</button></form>`;
  } else if (state === 'ambiguous_external_effect') {
    title = 'Choose the existing Slack app';
    intro = 'Inspect Slack before restarting. Automatically creating again could produce a duplicate app.';
    body = `<form method="post" action="/admin/setup"><input type="hidden" name="action" value="inspect">${hidden}<button class="auth-button" data-primary-action="inspect-ambiguity" type="submit" autofocus>Inspect saved attempt</button></form><details data-secondary-action="manual-adoption"><summary>Adopt the matching app or restart</summary><p class="auth-help">Use the manual adoption fields from the exact manifest, or restart only after confirming Slack did not create the app.</p><pre class="auth-manifest">${manifestJson}</pre><form method="post" action="/admin/setup"><input type="hidden" name="action" value="restart">${hidden}<button class="auth-button secondary" type="submit">I inspected Slack; restart creation</button></form></details>`;
  } else if (state === 'app_created') {
    title = 'Install Chickpea in Slack';
    intro = 'Slack decides whether this member may install directly or must request workspace approval.';
    body = `<form method="post" action="/auth/slack/install/start">${hidden}<button class="auth-button" data-primary-action="install-app" type="submit" autofocus>Continue to Slack</button></form>`;
  } else if (state === 'approval_pending') {
    title = 'Slack approval is pending';
    intro = 'This private setup remains open for seven days. After approval, use a fresh short-lived authorization.';
    body = `<form method="post" action="/auth/slack/install/resume">${hidden}<button class="auth-button" data-primary-action="resume-approval" type="submit" autofocus>Resume Slack installation</button></form>`;
  } else if (state === 'bot_install_pending') {
    title = 'Verify Slack Events';
    intro = 'Chickpea has the bot grant and is waiting for Slack’s signed Events challenge for this exact app and workspace.';
    const eventsUrl = input.setup?.appId
      ? `https://api.slack.com/apps/${encodeURIComponent(input.setup.appId)}/event-subscriptions`
      : 'https://api.slack.com/apps';
    body = `<div class="auth-warning" role="note"><strong>If Slack has not delivered the challenge</strong>Open Event Subscriptions, click Retry beside Request URL, then click Save Changes.</div><div class="auth-actions"><a class="auth-link secondary" href="${escapeHtml(eventsUrl)}" target="_blank" rel="noreferrer">Open Event Subscriptions</a></div><form method="post" action="/auth/slack/install/finalize">${hidden}<button class="auth-button" data-primary-action="verify-events" type="submit" autofocus>Check signed Events verification</button></form>`;
  } else if (state === 'bot_installed') {
    title = 'Become the first Owner';
    intro = 'Sign in as the same Slack member who installed the app. Installation alone does not grant Chickpea access.';
    body = `<form method="post" action="/auth/slack/oidc/start"><input type="hidden" name="purpose" value="first_owner">${hidden}<button class="auth-button slack-provider-button" data-primary-action="claim-owner" type="submit" autofocus><span class="slack-provider-logo slack-logo-image" aria-hidden="true"></span>Sign in with Slack</button></form>`;
  } else if (state === 'install_failed') {
    title = 'Installation could not be verified';
    intro = 'The inactive bot credential was discarded. The private setup state is preserved for inspection.';
    body = '<p class="auth-help">Create a fresh deployment setup link before attempting another installation.</p>';
  } else {
    title = 'Slack setup is complete';
    intro = 'The setup capability no longer grants any action.';
    body = `<div class="auth-actions"><a class="auth-link" href="${escapeHtml(destination)}" autofocus>Open Chickpea</a></div>`;
  }
  const eyebrow = state === 'awaiting_app_creation'
    ? 'Slack setup'
    : 'Private Slack setup';
  return renderSlackJourneyPage({
    surface: 'setup', eyebrow, title, intro,
    ...(state === 'awaiting_app_creation' && input.gatewayState === 'connected'
      ? { titleSuccess: true }
      : {}),
    ...(state === 'awaiting_app_creation' ? {} : { status: slackSetupPageMessage(state) }),
    alert: error ?? notice,
    rootAttributes: `data-slack-setup-state="${escapeHtml(state)}" data-slack-setup-auto-resume="${String(input.autoResume === true)}"`,
    body: `${body}<script src="/admin/setup/client.js" defer></script>`,
  });
}

function slackSetupPageMessage(code: string): string {
  switch (code) {
    case 'capability_required': return 'Reading the private setup capability from this browser tab.';
    case 'awaiting_app_creation': return 'Slack app creation is the only required action now.';
    case 'app_creation_pending': return 'The external result is unknown; no automatic retry will run.';
    case 'ambiguous_external_effect': return 'Inspect Slack, then adopt the matching app or explicitly restart.';
    case 'app_created': return 'App credentials are encrypted. Bot installation is next.';
    case 'approval_pending': return 'No Chickpea role was granted to the requester or approver.';
    case 'bot_install_pending': return 'The candidate remains inactive until signed Events proof succeeds.';
    case 'bot_installed': return 'The installer must now prove the same Slack identity.';
    case 'install_failed': return 'No inactive credential was promoted.';
    case 'consumed': return 'The setup capability has been consumed.';
    case 'waiting_events': return 'Chickpea is waiting for Slack to deliver its signed Events challenge.';
    case 'denied': return 'Slack did not approve this installation. Start a fresh request when ready.';
    case 'cancelled': return 'Slack installation was cancelled. The durable setup can be resumed.';
    case 'expired': return 'The Slack request expired. Resume with a fresh authorization.';
    case 'setup_expired': return 'This private setup link expired. Create a new deployment setup link.';
    case 'setup_conflict': return 'Setup changed in another tab. Reload to inspect the current stage.';
    case 'invalid_configuration_token': return 'Slack rejected the configuration token. Generate a fresh token and retry.';
    case 'invalid_manifest': return 'The Slack app contract does not match this deployment.';
    case 'gateway_not_configured': return 'Chickpea’s shared Slack app is not ready yet. Your deployment and setup link are safe. Retry after the service is configured, or use your own Slack app below.';
    case 'gateway_unreachable': return 'Chickpea’s shared Slack service could not be reached. Your deployment and setup link are safe. Retry Add to Slack, or use your own Slack app below.';
    case 'gateway_redirect_rejected': return 'The shared Slack service returned an unsafe redirect, so Chickpea stopped setup without changing anything. Retry, or use your own Slack app below.';
    case 'gateway_rejected': return 'The shared Slack service could not start this installation. Nothing changed. Retry Add to Slack, or use your own Slack app below.';
    case 'rate_limited': return 'Too many setup attempts. Wait for the retry window before continuing.';
    default: return 'Slack setup could not continue. No secret or role was changed.';
  }
}

function slackWorkspaceLabel(workspace?: SlackAuthWorkspace): string {
  if (!workspace) return 'the connected Slack workspace';
  return workspace.teamName ? `${workspace.teamName} (${workspace.teamId})`
    : `the connected Slack workspace (${workspace.teamId})`;
}

function safeSlackPageDestination(value: string): string {
  if (/^\/setup\/setup_[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  if (!/^\/admin(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/.test(value)) return '/admin';
  try {
    const parsed = new URL(value, 'https://chickpea.invalid');
    if (parsed.origin !== 'https://chickpea.invalid' || parsed.pathname !== value ||
        parsed.pathname === '/admin/api' || parsed.pathname.startsWith('/admin/api/')) return '/admin';
    return parsed.pathname;
  } catch { return '/admin'; }
}

export function renderSlackRecoveryPage(options: {
  stage?: 'token' | 'credentials' | 'waiting_events' | 'complete';
  expectedAppId?: string;
  expectedTeamId?: string;
  error?: string;
} = {}): string {
  const stage = options.stage ?? 'token';
  if (stage === 'complete') {
    return renderSlackJourneyPage({
      surface: 'recovery', title: 'Slack connection repaired', eyebrow: 'Recovery complete',
      intro: 'Recovery did not sign anyone in, bind an identity, or change a Chickpea role.',
      status: 'An existing Owner can now use normal Sign in with Slack.', alert: options.error,
      body: '<div class="auth-actions"><a class="auth-link" href="/auth/slack/sign-in?destination=%2Fadmin" autofocus>Continue to Sign in with Slack</a></div>',
    });
  }
  if (stage === 'waiting_events') {
    return renderSlackJourneyPage({
      surface: 'recovery', title: 'Verify the Events URL', eyebrow: 'Credential repair',
      intro: 'In Slack app settings, retry and save Event Subscriptions for this unchanged app. Then return here to finish the revision-bound verification.',
      status: 'The replacement credential remains inactive until signed Events proof succeeds.',
      alert: options.error,
      body: '<form method="post" action="/admin/recovery"><input type="hidden" name="action" value="finalize"><button class="auth-button" type="submit" autofocus>Verify and promote repair</button></form>',
    });
  }
  if (stage === 'credentials') {
    return renderSlackJourneyPage({
      surface: 'recovery', title: 'Repair Slack credentials', eyebrow: '15-minute recovery session',
      intro: `Enter credentials for the unchanged Slack app ${options.expectedAppId ?? ''} in workspace ${options.expectedTeamId ?? ''}. Values are write-only and encrypted before persistence.`,
      status: 'The current credential stays active unless this replacement passes OAuth and signed Events verification.',
      alert: options.error,
      body: `<form method="post" action="/admin/recovery">
        <input type="hidden" name="action" value="stage">
        <label for="app-id">Slack app ID</label><input id="app-id" name="appId" required maxlength="64" autocomplete="off" value="${escapeHtml(options.expectedAppId ?? '')}">
        <label for="team-id">Slack team ID</label><input id="team-id" name="teamId" required maxlength="64" autocomplete="off" value="${escapeHtml(options.expectedTeamId ?? '')}">
        <label for="client-id">Client ID</label><input id="client-id" name="clientId" required maxlength="256" autocomplete="off">
        <label for="client-secret">Client secret</label><input id="client-secret" name="clientSecret" type="password" required maxlength="4096" autocomplete="off">
        <label for="signing-secret">Signing secret</label><input id="signing-secret" name="signingSecret" type="password" required maxlength="4096" autocomplete="off">
        <label for="configuration-token">Configuration token <span>only if deployment URLs changed</span></label><input id="configuration-token" name="configurationToken" type="password" maxlength="512" autocomplete="off" aria-describedby="configuration-token-help">
        <p id="configuration-token-help" class="auth-help">A short-lived token is used only in this request to update the unchanged app's OAuth and Events URLs. It is never stored.</p>
        <button class="auth-button" type="submit" autofocus>Encrypt credentials and authorize Slack</button>
      </form>`,
    });
  }
  return renderSlackJourneyPage({
    surface: 'recovery', title: 'Repair the Slack connection', eyebrow: 'Deployment recovery',
    intro: 'This hidden path repairs only the existing Slack app and workspace. It cannot create an Owner, change a role, or issue a Chickpea session.',
    status: 'A valid token opens one browser-bound 15-minute repair session.', alert: options.error,
    body: `<form method="post" action="/admin/recovery">
      <input type="hidden" name="action" value="begin">
      <label for="recovery-token">Deployment recovery token</label>
      <input id="recovery-token" name="recoveryToken" type="password" autocomplete="off" required maxlength="512" ${options.error ? 'aria-describedby="auth-error"' : ''}>
      <button class="auth-button" type="submit" autofocus>Start 15-minute repair</button>
    </form>`,
  });
}
