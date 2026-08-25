import { isCloudflareTarget } from '../config/runtime-target.ts';
import { CONNECTOR_LOGOS } from '../config/connector-logos.ts';
import {
  CONNECTOR_PRESETS,
  GOOGLE_WORKSPACE_SERVICE_PRESETS,
  MANAGED_CONNECTOR_PRESETS,
  REUSABLE_CONNECTOR_PRESETS,
} from '../config/presets.ts';
import { GOOGLE_WORKSPACE_SCOPE_OPTIONS } from '../config/api-oauth-policy.ts';
import {
  SUGGESTED_SKILL_CATEGORIES,
  SUGGESTED_SKILLS,
} from '../config/suggested-skills.ts';
import { AUTH_BRAND_HTML } from '../auth/brand.ts';
import type { SlackSetupTransaction } from '../identity/types.ts';
import type { SlackAppManifest } from '../slack/app-manifest.ts';

const ADMIN_FAVICON = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='8 9 32 32'%3E%3Ccircle cx='24' cy='25' r='15.5' fill='%23E3AC45'/%3E%3Ccircle cx='17' cy='17.5' r='4.2' fill='%23F4D084'/%3E%3Ccircle cx='18.5' cy='24' r='1.9' fill='%233B3220'/%3E%3Ccircle cx='29.5' cy='24' r='1.9' fill='%233B3220'/%3E%3Cpath d='M19 29 Q24 32.5 29 29' fill='none' stroke='%233B3220' stroke-width='1.8' stroke-linecap='round'/%3E%3Ccircle cx='15.5' cy='28.5' r='2' fill='%23DC8A4F' opacity='0.4'/%3E%3Ccircle cx='32.5' cy='28.5' r='2' fill='%23DC8A4F' opacity='0.4'/%3E%3C/svg%3E">`;
const SLACK_LOGO_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAA/CAMAAABnwz74AAAAn1BMVEX///+j3++a2+rw5M3n2tOk0K7L3L54xrXI0sftyHSPxZqLwZSp07HI6/RkzOpz0uyJ09tmtHlirnNwtH59z+ZZyOpdrXFbqm1dsnOPxppNxej23qjupqThYIDldY3yr7rodJPx0Ibz0YreSW3dO2XjMV7kVnv43qzzyXbvuE/ttUXyyHfjNmPjKVrbJVXwsTvusj3aG1DbLFLhH1PvscJL5pvlAAAAAXRSTlMAQObYZgAABDtJREFUSMe9lw1vokAQhvkQVsFCEUFbRVBEQUWl9v//tpuZ3QU8bW97l9ybaAI4z843UdOeSTdAendtDizLGtiaonSdIYAN5Y2R7TjMdZyxIuDF8FD+q7zhsmACCl01wnDqRREhXqX9JI4n8Ww2USNMo0gAvNch2ccxegCEwDUVMmBEkhD5L5o2tlg8D8AHAMwchUTqfhQJROQZNgACHsCPAcgAwNAhQDxDF5QAxj1gDACKABkqAE2nInQhOAFo8gOAZvh3HlhBIBCqgDfm9T0QACCoAjAP0+nUgC/jrQOgD6qAvsZWOBGEvwZ0Hrj/Aph8DdC/0O+ALonmeDx+M+Vg6FNMehR1Q8THear3AZMewHVcFrqOZQr76F0q6nVh5BEBhknYI4BMYD/MQYFr0Xi39tG9wAlca48Al83JHggI0L0HU+lC5Bsm9sGE1gEAZrgPbAdMA/jM5yEzNZ1Fz+17rRz3AablzmVrBY6lDYwo+haA44ze0z5wTRkSKgwB8PI9wETALIbDSU8ANL0U8KPePUoihBtz+8DhgDDkpeUAn6+vR/P3d6yCbmHS+UoMGVUlZGHI0A/Xxq3LvD4ASwIfqqvPsMy2C/kWDoxFWUMeAeOdyHzqvN7JBHn3xHObcQLkHAALCiFgjLmunAV6k5GmrXx/yuRzeLO5ILKHMuKFA+oNFkQyBOEXXQ6H+os+7J6PRvB+tEfixyO41OjrOw21/ytzuVyaZjvg2jJJlnfPzQXIvFPv8WiVZlmWghJ+YwWX2aoNMllvnmidyMdplm9BeV5k/N4qL0DbneDty+pwqB51PCbCfou/L06nekd3VkVd10VRn3MOPFYX0BV1aMUR+DzJ8uJEJ54KAqxOaA6AuqHrdXW4cKMegOwP1RoykeyKFoAnJjtuD4QmX0HnYQAPElGUezAQDqDwxCSXgKLZpuYXACIcDuVGS7PWvKj7gHNRfOQc8JQADAIMskIeWNxagMgCepCUPN5WkJCrJAAgWW0loOY5yG91TWUoaulBHyAKcqHEUg52wgWwx+5K8kYS6lNqYxWqPgId4IDLpTpiFdIcCfWt2KXUF9sOkCNAEEQl5fmo6rgQnXQ6QRtlqSYAzRn18SEA2roUgF4rgQdVuRCjkHymaZaI1n4C0OzNppTqhmG/6E9bO1w9wFkCNPOpnk82AhoOaFrAT9TzoAPgOvg7AHeT9oEqoQWcOWCxL49i/uW++QMg/w2wkW1QlUqEFiBCSEo5vNC5KmEAAM1rBJw6wAEBlRrgXNcIgO4WgIvYAIdqo/CPRQLqFnDhk0cAhb5IdgRAUQiLEidYbEUlD7LzTQLyzwSrcJGEaj36M0DLtjdOaM601vcQw5UvIaUq4HuhaW44EGLA9yXN8fVaKXbjKNuhB9tM9k3KF7OqPRA+6d2YtH23WMIiWC+UOplkDkB3P98PBs+P/wV/Ze9+4cPjFgAAAABJRU5ErkJggg==';

export function renderAdminPage(
  options: { usageAdminUi?: boolean } = {},
): string {
  // Target-aware setup and provider copy differs between the Node and
  // Cloudflare runtimes. The primary Admin chrome intentionally stays
  // product-focused and does not expose this deployment detail.
  const isCloudflare = isCloudflareTarget();
  const targetChip = isCloudflare ? 'cloudflare · workers' : 'local · node';
  const usageAdminUi = options.usageAdminUi === true;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chickpea · /admin</title>
${ADMIN_FAVICON}
<style>
@import url("https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&family=Quicksand:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap");

:root {
  /* surfaces */
  --bg: #fffdf6;            /* card cream (was white) */
  --canvas: #f4ebd8;        /* NEW: page tan behind the cards */
  --well: #f8f1df;          /* inset clay wells */
  --raise: rgba(59, 50, 32, 0.06);
  --line: rgba(59, 50, 32, 0.1);
  --line-strong: rgba(59, 50, 32, 0.16);
  /* ink */
  --text: #3b3220;
  --text-2: #6b5c42;
  --text-3: #9f8f72;
  /* accent — names kept for compatibility; values are now chickpea gold */
  --ember: #dda033;
  --ember-deep: #8a6410;
  --ember-bright: #e5ac44;
  --ember-tint: rgba(221, 160, 51, 0.18);
  --ember-press: #b27e1f;   /* NEW: hard press-shadow under gold buttons */
  /* status */
  --ok: #4e7a3e;
  --ok-solid: #6fa25b;      /* NEW: solid sprout green (badges, toggle on) */
  --ok-tint: rgba(111, 162, 91, 0.16);
  --danger: #b5473a;
  --danger-tint: rgba(206, 101, 83, 0.16);
  --danger-well: #fbe3dc;   /* NEW: soft red panel fill */
  /* type */
  --font: Quicksand, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --display: "Baloo 2", var(--font);  /* NEW: headings */
  --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --radius: 13px;
  /* depth */
  --card-shadow: 0 2px 0 rgba(59, 50, 32, 0.08);      /* NEW */
  --press-shadow: 0 2px 0 rgba(59, 50, 32, 0.14);     /* NEW */
  --pop-shadow: 0 10px 26px -10px rgba(59, 50, 32, 0.4); /* NEW */
}
/* Agent and Channel visual foundation. These custom properties deliberately
   live on page-level surface hooks instead of :root: Settings, Team, Usage,
   Audit, Account, identity management, and onboarding keep their current
   composition while later visual units can share the prototype primitives. */
.admin-surface {
  --admin-visual-font: "Avenir Next", Avenir, ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --admin-visual-ink: #403726;
  --admin-visual-muted: #7f7055;
  --admin-visual-faint: #b2a487;
  --admin-visual-gold: #dda126;
  --admin-visual-gold-dark: #b77806;
  --admin-visual-canvas: #f4ead2;
  --admin-visual-paper: #fffdf7;
  --admin-visual-paper-soft: #fbf7ec;
  --admin-visual-line: #e8deca;
  --admin-visual-green: #4e7a3e;
  --admin-visual-green-soft: #eaf2e2;
  --admin-visual-shadow: 0 1px 0 rgba(73, 57, 27, .12), 0 22px 60px rgba(89, 65, 24, .06);
  --admin-visual-radius-sm: 10px;
  --admin-visual-radius-md: 14px;
  --admin-visual-radius-lg: 20px;
  --admin-visual-space-1: 4px;
  --admin-visual-space-2: 8px;
  --admin-visual-space-3: 12px;
  --admin-visual-space-4: 16px;
  --admin-visual-space-5: 24px;
  --admin-visual-space-6: 32px;
  --admin-visual-icon-size: 34px;
  --admin-visual-content-width: 1180px;
  --admin-visual-reading-width: 820px;
  --admin-visual-status-ready: var(--admin-visual-green);
  --admin-visual-status-attention: #d99b29;
  /* Semantic accents stay stable across Agent tabs and Channel summaries so
     the same concept keeps the same visual cue wherever it appears. */
  --semantic-instructions-fg: #b96c06;
  --semantic-instructions-bg: #fbefe0;
  --semantic-instructions-line: #f6d9b6;
  --semantic-skill-fg: #5f8d58;
  --semantic-skill-bg: #e7f1e3;
  --semantic-skill-line: #d1e3cb;
  --semantic-connector-fg: #b66253;
  --semantic-connector-bg: #f6e5e1;
  --semantic-connector-line: #ebccc5;
  --semantic-repository-fg: #526ca9;
  --semantic-repository-bg: #e6edf8;
  --semantic-repository-line: #ccd8ec;
  --semantic-memory-fg: #7d6091;
  --semantic-memory-bg: #efe6f4;
  --semantic-memory-line: #dfcfe8;
  --semantic-channel-fg: #4b863d;
  --semantic-channel-bg: #ebf0e2;
  --semantic-channel-line: #bacfac;
  --semantic-model-fg: #7554ca;
  --semantic-model-bg: #eee5f6;
  --semantic-model-line: #cbb7ec;
  --semantic-slack-bg: #f0eafa;
  --semantic-slack-line: #ddd2ef;
  --semantic-neutral-fg: #78684c;
  --semantic-neutral-bg: #eee7d9;
  --semantic-neutral-line: #dfd4c0;

  /* Existing controls inherit the scoped type and palette without a markup or
     save/route change. Later units consume the named visual primitives below. */
  --font: var(--admin-visual-font);
  --display: var(--admin-visual-font);
  --bg: var(--admin-visual-paper);
  --well: var(--admin-visual-paper-soft);
  --line: var(--admin-visual-line);
  --line-strong: #ded2bb;
  --text: var(--admin-visual-ink);
  --text-2: #6e6048;
  --text-3: var(--admin-visual-muted);
  --ember: var(--admin-visual-gold);
  --ember-press: var(--admin-visual-gold-dark);
  --ok: var(--admin-visual-green);
  --ok-solid: var(--admin-visual-green);
  --ok-tint: var(--admin-visual-green-soft);
  --radius: var(--admin-visual-radius-md);
  --card-shadow: var(--admin-visual-shadow);
}
.admin-surface .admin-visual-surface {
  background: var(--admin-visual-paper);
  border: 1px solid var(--admin-visual-line);
  border-radius: var(--admin-visual-radius-lg);
  box-shadow: var(--admin-visual-shadow);
}
.admin-surface .admin-visual-icon-tile {
  align-items: center;
  border-radius: var(--admin-visual-radius-sm);
  display: inline-flex;
  height: var(--admin-visual-icon-size);
  justify-content: center;
  width: var(--admin-visual-icon-size);
}
.admin-surface .admin-visual-status {
  align-items: center;
  border-radius: 999px;
  display: inline-flex;
  font-size: .75rem;
  font-weight: 700;
  gap: 7px;
  padding: 8px 12px;
}
.admin-surface .admin-visual-status[data-status="ready"] { background: var(--admin-visual-green-soft); color: var(--admin-visual-status-ready); }
.admin-surface .admin-visual-status[data-status="attention"] { background: #fbf1da; color: #9d6e19; }
.admin-surface .admin-visual-width { max-width: var(--admin-visual-content-width); }
.admin-surface .admin-visual-reading-width { max-width: var(--admin-visual-reading-width); }
* { box-sizing: border-box; margin: 0; padding: 0; }
html { color-scheme: light; }
body {
  background: var(--canvas);
  color: var(--text-2);
  font-family: var(--font);
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
button, input, textarea, select { font: inherit; }
::selection { background: var(--ember-tint); }
.ic   { flex-shrink: 0; height: 16px; width: 16px; }
.ic-l { height: 1lh; }
.step-num, .fav-meta, .fav-model { font-variant-numeric: tabular-nums; }
.page-title { color: var(--text); font-family: var(--display); font-size: 1.375rem; font-weight: 700; letter-spacing: 0; text-wrap: balance; }
.page-title.mono-title { font-family: var(--mono); font-size: 1.0625rem; }
.section-eyebrow {
  color: var(--text-3);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}
.field-label { color: var(--text); display: block; font-size: 0.8125rem; font-weight: 700; }
.hint { color: var(--text-3); font-size: 0.8125rem; text-wrap: pretty; }
.empty-inline { display: grid; gap: 4px; }
.empty-inline .hint { margin: 0; }
.mono { font-family: var(--mono); font-size: 0.75rem; }
.btn {
  align-items: center;
  border: 0;
  border-radius: 12px;
  cursor: pointer;
  display: inline-flex;
  font-size: 0.8125rem;
  font-weight: 700;
  gap: 6px;
  justify-content: center;
  min-height: 34px;
  padding: 7px 14px;
  text-decoration: none;
}
.btn:disabled { cursor: not-allowed; opacity: 0.55; }
.btn:focus-visible, .x-btn:focus-visible, .rail-add:focus-visible, .chan-item:focus-visible, .section-nav-item:focus-visible {
  outline: 2px solid var(--ember-press);
  outline-offset: 2px;
}
.btn-primary { background: var(--ember); box-shadow: 0 2.5px 0 var(--ember-press); color: #3a2a08; }
.btn-primary:hover:not(:disabled) { background: var(--ember-bright); }
.btn-primary:active:not(:disabled) { box-shadow: 0 0.5px 0 var(--ember-press); transform: translateY(2px); }
.btn-soft { background: var(--bg); box-shadow: var(--press-shadow); color: var(--text); }
.btn-soft:hover:not(:disabled) { background: #fff9e9; }
.btn-soft:active:not(:disabled) { box-shadow: 0 0.5px 0 rgba(59, 50, 32, 0.14); transform: translateY(1.5px); }
.btn-ghost { background: transparent; color: var(--text-2); font-weight: 600; }
.btn-ghost:hover:not(:disabled) { background: rgba(59, 50, 32, 0.06); color: var(--text); }
.btn-danger { background: var(--danger-well); box-shadow: 0 2px 0 rgba(180, 71, 58, 0.25); color: var(--danger); }
.btn-danger:hover:not(:disabled) { background: #f8d8cf; }
.btn-danger:active:not(:disabled) { box-shadow: 0 0.5px 0 rgba(180, 71, 58, 0.25); transform: translateY(1.5px); }
/* Destructive PRIMARY inside the profile footer: solid deep red with cream
   text, so it contrasts with the tinted well around it. */
.profile-foot .btn-danger {
  background: #b5473a;
  box-shadow: 0 2.5px 0 #8f3428;
  color: #fff6f3;
}
.profile-foot .btn-danger:hover:not(:disabled) { background: #c4574a; }
.profile-foot .btn-danger:active:not(:disabled) { box-shadow: 0 0.5px 0 #8f3428; transform: translateY(2px); }
.btn-sm { border-radius: 11px; font-size: 0.75rem; min-height: 28px; padding: 4px 11px; }
.agent-readonly-fields { border: 0; min-width: 0; padding: 0; }
.agent-readonly-note { margin-bottom: 18px; }
.btn.i-lead { padding-left: 10px; }
.btn-sm.i-lead { padding-left: 8px; }
.input, .textarea {
  background: var(--bg);
  border: 0;
  border-radius: var(--radius);
  box-shadow: inset 0 2px 3px rgba(59, 50, 32, 0.09), inset 0 0 0 1.5px rgba(59, 50, 32, 0.1);
  color: var(--text);
  font-size: 0.875rem;
  font-weight: 600;
  padding: 9px 14px;
  width: 100%;
}
.input::placeholder, .textarea::placeholder { color: var(--text-3); font-weight: 500; }
.input:focus-visible, .textarea:focus-visible {
  outline: 2px solid var(--ember-press);
  outline-offset: -1px;
}
.textarea { line-height: 1.6; min-height: 96px; resize: vertical; }
.input.mono, .textarea.mono { font-size: 0.78125rem; font-weight: 500; }
.select-wrap { align-items: center; display: inline-grid; grid-template-columns: 1fr; width: 100%; }
.select-wrap select.input {
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  grid-column: 1;
  grid-row: 1;
  padding-right: 32px;
}
.select-wrap .select-caret {
  color: var(--text-3);
  grid-column: 1;
  grid-row: 1;
  justify-self: end;
  margin-right: 10px;
  pointer-events: none;
}
.toggle {
  background: rgba(59, 50, 32, 0.16);
  border-radius: 999px;
  box-shadow: inset 0 1.5px 3px rgba(59, 50, 32, 0.2);
  display: inline-flex;
  flex-shrink: 0;
  padding: 3px;
  position: relative;
  transition: background 0.2s ease-in-out;
  width: 46px;
}
.toggle:has(:checked) { background: var(--ok-solid); }
.toggle .thumb {
  aspect-ratio: 1;
  background: var(--bg);
  border-radius: 999px;
  box-shadow: 0 1.5px 2px rgba(59, 50, 32, 0.3);
  transition: transform 0.2s ease-in-out;
  width: 50%;
}
.toggle:has(:checked) .thumb { transform: translateX(100%); }
.toggle input { appearance: none; cursor: pointer; inset: 0; position: absolute; }
.toggle:has(:focus-visible) { outline: 2px solid var(--ember-press); outline-offset: 2px; }
.badge {
  align-items: center;
  border-radius: 999px;
  display: inline-flex;
  flex-shrink: 0;
  font-size: 0.71875rem;
  font-weight: 700;
  gap: 5px;
  padding: 4px 11px;
  white-space: nowrap;
}
.badge .dot { background: currentColor; border-radius: 999px; height: 5px; width: 5px; }
.badge-on { background: var(--ok-solid); box-shadow: 0 1.5px 0 rgba(78, 122, 62, 0.6); color: #fffdf6; }
.badge-off { background: rgba(59, 50, 32, 0.1); color: #8a7a5c; }
.chip {
  background: rgba(59, 50, 32, 0.08);
  border-radius: 8px;
  color: var(--text-2);
  display: inline-flex;
  font-family: var(--mono);
  font-size: 0.6875rem;
  max-width: 100%;
  overflow-wrap: anywhere;
  padding: 2px 8px;
}
/* Keep the channel hierarchy and settings surface together at desktop sizes.
   The selected Channels-hub layout is intentionally broad; inner profile and
   settings content still keeps its own narrower reading measure. */
.frame { display: flex; flex-direction: column; margin: 0 auto; max-width: 1420px; min-height: 100dvh; width: 100%; }
.topbar {
  align-items: center;
  border-bottom: 0;
  display: flex;
  gap: 12px;
  height: 60px;
  padding: 4px 24px 0;
  position: relative;
}
.brand { align-items: center; display: flex; flex: 1; gap: 10px; min-width: 0; }
.brand-home { align-items: center; background: none; border: 0; border-radius: 10px; cursor: pointer; display: flex; gap: 10px; min-width: 0; padding: 0; }
.brand-home:focus-visible { outline: 2px solid var(--ember-press); outline-offset: 2px; }
.avatar {
  align-items: center;
  border-radius: 0;
  color: transparent;
  display: flex;
  flex-shrink: 0;
  font-size: 0;
  height: 32px;
  justify-content: center;
  width: 32px;
}
/* The mark is inline SVG (see topbarHtml) so the face can react: JS sets
   --prox (0 at >=420px from the cursor, 1 at the mark) and lerps the pupil
   translate inline; everything below is driven by those two inputs. */
.avatar .pea { display: block; height: 32px; overflow: visible; width: 32px; }
.pea-eyes { transform: scale(calc(1 + var(--prox, 0) * 0.14)); transform-box: fill-box; transform-origin: center; transition: transform 0.25s ease; }
.pea-smile { opacity: calc(1 - clamp(0, (var(--prox, 0) - 0.55) * 3.3, 1)); transition: opacity 0.2s ease; }
.pea-grin { opacity: clamp(0, (var(--prox, 0) - 0.55) * 3.3, 1); transition: opacity 0.2s ease; }
.pea-blush { opacity: calc(0.4 + var(--prox, 0) * 0.45); transition: opacity 0.25s ease; }
.pea-lids { opacity: 0; }
.avatar.is-boop .pea { animation: pea-boop 0.45s cubic-bezier(0.34, 1.56, 0.64, 1); transform-origin: 50% 88%; }
.avatar.is-boop .pea-eyes { opacity: 0; }
.avatar.is-boop .pea-lids { opacity: 1; }
.avatar.is-boop .pea-smile { opacity: 0; }
.avatar.is-boop .pea-grin { opacity: 1; }
.avatar.is-boop .pea-blush { opacity: 0.9; }
@keyframes pea-boop {
  0% { transform: scale(1, 1); }
  30% { transform: scale(1.18, 0.8); }
  62% { transform: scale(0.92, 1.1); }
  100% { transform: scale(1, 1); }
}
@media (prefers-reduced-motion: reduce) {
  .pea-eyes, .pea-smile, .pea-grin, .pea-blush { transition: none; }
  .avatar.is-boop .pea { animation: none; }
}
.brand-name { color: var(--text); font-family: var(--display); font-size: 1.125rem; font-weight: 700; }
.topbar .actions { align-items: center; display: flex; gap: 9px; }
.body { display: flex; flex: 1; gap: 14px; min-height: 0; padding: 8px 16px 16px; }
.rail {
  background: var(--bg);
  border-radius: 18px;
  border-right: 0;
  box-shadow: var(--card-shadow);
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 10px;
  flex-shrink: 0;
  width: clamp(248px, 22vw, 314px);
}
.rail-context {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 10px;
}
.rail-head { align-items: center; display: flex; justify-content: space-between; padding: 0 10px 10px; }
.platform-row {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 12px;
  color: var(--text);
  cursor: pointer;
  display: flex;
  font-size: 0.8125rem;
  font-weight: 700;
  gap: 8px;
  padding: 8px 10px;
  text-align: left;
  width: 100%;
}
.platform-row:hover { background: #f6eedc; }
.platform-row.active { background: var(--ember-tint); }
.platform-logo { flex-shrink: 0; height: 20px; object-fit: contain; width: 20px; }
.slack-logo-image { background: url("${SLACK_LOGO_DATA_URL}") center / contain no-repeat; display: inline-block; }
.platform-row .platform-status { color: var(--ok); font-size: 0.6875rem; font-weight: 700; margin-left: auto; }
.platform-row .platform-status.attention { color: var(--danger); }
.ws-row {
  align-items: center;
  color: var(--text);
  display: flex;
  gap: 7px;
  font-size: 0.8125rem;
  font-weight: 700;
  padding: 6px 10px;
}
.chan-item {
  background: transparent;
  border: 0;
  border-radius: 12px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-left: 12px;
  padding: 8px 11px;
  text-align: left;
  text-decoration: none;
}
.chan-item:hover { background: #f6eedc; }
.chan-item.active { background: var(--ember-tint); }
.chan-name { color: var(--text); font-family: var(--mono); font-size: 0.78125rem; font-weight: 500; overflow-wrap: anywhere; }
.chan-meta { color: var(--text-3); font-size: 0.6875rem; font-weight: 600; overflow-wrap: anywhere; }
.rail-add {
  background: none;
  border: 0;
  border-radius: 12px;
  align-items: center;
  color: var(--text-3);
  cursor: pointer;
  display: flex;
  font-size: 0.8125rem;
  font-weight: 700;
  gap: 7px;
  margin-left: 12px;
  padding: 7px 10px 7px 8px;
  text-align: left;
}
.ws-row .ic { color: var(--text-3); }
.rail-add:hover:not(:disabled) { background: #f6eedc; color: var(--text-2); }
.rail-add.active { background: var(--ember-tint); color: var(--text); }
.rail-add:disabled { cursor: not-allowed; opacity: 0.5; }
.section-switcher {
  border-top: 1.5px solid rgba(59, 50, 32, .15);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  gap: 2px;
  margin-top: auto;
  padding: 14px 2px 0;
}
.section-nav-item {
  background: transparent;
  border: 0;
  border-radius: 11px;
  color: var(--text-2);
  cursor: pointer;
  display: block;
  font-size: .8125rem;
  font-weight: 500;
  padding: 8px 10px;
  text-align: left;
  text-decoration: none;
  width: 100%;
}
.section-nav-item:hover { background: #f6eedc; color: var(--text); }
.section-nav-item.active { background: var(--ember-tint); color: var(--text); }
.chan-opt-note { color: var(--text-3); font-size: 0.71875rem; }
.link-btn { background: none; border: 0; color: var(--ember-press); cursor: pointer; font-size: 0.8125rem; font-weight: 600; padding: 0; text-decoration: underline; }
.link-btn:hover { color: var(--ember); }
.main {
  background: var(--bg);
  border-radius: 20px;
  box-shadow: var(--card-shadow);
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 48px 32px 48px;
}
.main:has(.slack-overview) { padding-top: 32px; }
.main-inner { container-type: inline-size; display: flex; flex-direction: column; gap: 26px; margin: 0 auto; max-width: 760px; width: 100%; }
.frame.onboarding-frame { height: auto; max-width: none; overflow: visible; }
.onboarding-shell { isolation: isolate; min-height: 100dvh; width: 100%; }
.onboarding-shell-inner { margin: 0 auto; max-width: 1500px; padding: 24px 28px 64px; width: 100%; }
.onboarding-brand-row { align-items: center; display: flex; gap: 20px; justify-content: space-between; }
.onboarding-brand { align-items: center; color: var(--text); display: inline-flex; gap: 11px; min-width: 0; text-decoration: none; }
.onboarding-brand .avatar, .onboarding-brand .avatar .pea { height: 36px; width: 36px; }
.onboarding-brand .brand-name { font-size: 1.625rem; line-height: 1; }
.onboarding-environment { color: var(--text-3); font-family: var(--mono); font-size: .8125rem; }
.onboarding-orientation { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); list-style: none; margin: 26px auto 0; max-width: 560px; padding: 0; width: 100%; }
.onboarding-orientation li { min-width: 0; position: relative; text-align: center; }
.onboarding-orientation li:not(:first-child)::before { background: var(--line-strong); content: ""; height: 2px; position: absolute; right: 50%; top: 18px; width: 100%; z-index: -1; }
.onboarding-orientation li.complete:not(:first-child)::before,
.onboarding-orientation li.active:not(:first-child)::before { background: var(--ember); }
.onboarding-step-dot { background: var(--canvas); border: 2px solid var(--line-strong); border-radius: 50%; color: var(--text-3); display: grid; font-family: var(--mono); font-size: .875rem; font-variant-numeric: tabular-nums; height: 38px; margin: 0 auto 9px; place-items: center; width: 38px; }
.complete .onboarding-step-dot { background: var(--ember); border-color: var(--ember); color: var(--text); }
.active .onboarding-step-dot { background: var(--bg); border-color: var(--ember); box-shadow: 0 0 0 5px var(--ember-tint); color: var(--ember-deep); }
.onboarding-step-label { color: var(--text-3); display: block; font-size: .875rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.active .onboarding-step-label, .complete .onboarding-step-label { color: var(--text); }
.onboarding-stage { display: grid; min-height: 590px; padding-top: 32px; place-items: start center; }
.onboarding-panel { background: var(--bg); border-radius: 28px; box-shadow: 0 4px 0 rgba(59, 50, 32, .11); padding: 42px 44px; width: min(82%, 1280px); }
.onboarding-panel-wide { width: min(82%, 900px); }
.onboarding-eyebrow { color: var(--ember-deep); font-family: var(--mono); font-size: .75rem; font-weight: 700; letter-spacing: .09em; margin: 0 0 12px; text-transform: uppercase; }
.onboarding-title { color: var(--text); font-family: var(--display); font-size: clamp(2.25rem, 3.4vw, 2.875rem); font-weight: 700; letter-spacing: -.025em; line-height: 1; margin: 0; max-width: 24ch; text-wrap: balance; }
.onboarding-lede { color: var(--text-2); font-size: 1.125rem; line-height: 1.5; margin: 14px 0 0; max-width: 58ch; text-wrap: pretty; }
.onboarding-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; margin-top: 30px; }
.onboarding-actions .btn { min-height: 50px; padding: 11px 19px; }
.onboarding-slack-logo { display: inline-block; flex: 0 0 auto; height: 23px; margin-right: 7px; width: 23px; }
.onboarding-instructions { display: grid; gap: 32px; margin-top: 32px; }
.onboarding-instruction { display: grid; gap: 13px; }
.onboarding-instruction-title { align-items: center; color: var(--text); display: grid; font-size: 1.125rem; font-weight: 700; gap: 12px; grid-template-columns: 36px minmax(0, 1fr); line-height: 1.35; margin: 0; }
.onboarding-instruction-number { background: #faedca; border-radius: 50%; color: var(--ember-deep); display: grid; font-family: var(--mono); font-size: .875rem; font-weight: 700; height: 36px; place-items: center; width: 36px; }
.onboarding-instruction-note { color: var(--text-2); font-size: .9375rem; line-height: 1.45; margin: -3px 0 0 48px; }
.onboarding-shot { background: white; border: 1px solid var(--line-strong); border-radius: 16px; box-shadow: 0 2px 0 rgba(59, 50, 32, .07); overflow: hidden; }
.onboarding-shot img { display: block; height: auto; width: 100%; }
.onboarding-shot-viewport { height: 380px; }
.onboarding-shot-viewport img { height: 100%; object-fit: cover; object-position: center bottom; }
.onboarding-shot-banner { margin-left: 53px; width: min(920px, calc(100% - 53px)); }
.onboarding-shot-focused { margin-left: 53px; width: min(700px, calc(100% - 53px)); }
.onboarding-shot-ready { margin-left: 53px; width: min(760px, calc(100% - 53px)); }
.onboarding-shot-events { aspect-ratio: 1.25; position: relative; }
.onboarding-shot-events img { height: auto; left: 0; position: absolute; top: -7%; width: 100%; }
.onboarding-shot-wide { margin-left: 53px; width: min(920px, calc(100% - 53px)); }
.onboarding-check-list { display: grid; gap: 10px; margin-top: 26px; }
.onboarding-check-row { align-items: center; background: white; border: 1px solid var(--line); border-radius: 14px; display: grid; gap: 13px; grid-template-columns: 34px minmax(0, 1fr); padding: 13px 14px; }
.onboarding-check-copy strong { display: block; font-size: .875rem; }
.onboarding-check-copy span { color: var(--text-2); display: block; font-size: .8125rem; line-height: 1.4; margin-top: 2px; }
.onboarding-check-icon { background: var(--ok-solid); border-radius: 50%; color: white; display: grid; font-size: .75rem; height: 20px; place-items: center; width: 20px; }
.onboarding-check-pending { background: #faedca; border-radius: 50%; color: var(--ember-deep); display: grid; font-family: var(--mono); font-size: .75rem; font-weight: 700; height: 30px; place-items: center; width: 30px; }
.onboarding-recovery-note { background: #faedca; border-radius: 14px; color: var(--text-2); font-size: .9375rem; line-height: 1.5; margin-top: 24px; padding: 16px 18px; }
.onboarding-recovery-note strong { color: var(--text); display: block; margin-bottom: 3px; }
.onboarding-guide-actions { align-items: center; border-top: 1px solid var(--line); display: flex; gap: 16px; justify-content: space-between; margin-top: 36px; padding-top: 22px; }
.onboarding-inline-recovery { margin-top: 10px; min-height: 38px; padding-inline: 0; }
.onboarding-credential-form { display: grid; gap: 32px; margin-top: 32px; }
.onboarding-credential { display: grid; gap: 13px; }
.onboarding-credential-grid { align-items: start; display: grid; gap: 26px; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.onboarding-credential-help { display: grid; gap: 9px; }
.onboarding-credential-help .field { display: grid; gap: 7px; }
.onboarding-credential-help .field-label { font-size: 1rem; }
.onboarding-credential-help .input { background: var(--well); min-height: 54px; }
.onboarding-credential-subtext { color: var(--text-3); display: block; font-size: .8125rem; margin-bottom: 7px; }
.onboarding-shot-token { aspect-ratio: 4.1; position: relative; }
.onboarding-shot-token img { height: auto; left: -4.7%; max-width: none; position: absolute; top: -9%; width: 109.4%; }
.onboarding-shot-secret { width: min(420px, 100%); }
.onboarding-return-note { align-items: flex-start; background: var(--ok-tint); border-radius: 13px; color: #466a38; display: flex; font-size: .875rem; gap: 10px; margin-bottom: 26px; padding: 13px 15px; }
.onboarding-return-note strong { color: #36592a; }
.onboarding-return-icon { background: var(--ok-solid); border-radius: 50%; color: white; display: grid; flex: 0 0 auto; font-size: .75rem; height: 19px; place-items: center; width: 19px; }
.onboarding-form { display: grid; gap: 18px; margin-top: 28px; }
.onboarding-form .field { display: grid; gap: 7px; }
.onboarding-form .input { background: var(--well); min-height: 44px; }
.onboarding-form-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; padding-top: 4px; }
.onboarding-panel > details.advanced { margin-top: 18px; padding-top: 12px; }
.onboarding-error { align-items: flex-start; display: grid; gap: 10px; grid-column: 1 / -1; width: 100%; }
.onboarding-error-scopes { color: var(--text-2); font-family: var(--mono); font-size: .75rem; overflow-wrap: anywhere; }
.onboarding-workspace-row { align-items: center; border: 1px solid var(--line); border-radius: 13px; display: flex; gap: 16px; justify-content: space-between; margin-top: 26px; padding: 13px 15px; }
.onboarding-workspace-label { color: var(--text); font-weight: 700; }
.onboarding-workspace-meta { color: var(--text-3); font-size: .8125rem; }
.onboarding-channel-list { display: grid; gap: 9px; margin-top: 24px; }
.onboarding-channel-choice { display: block; position: relative; }
.onboarding-channel-choice input { opacity: 0; pointer-events: none; position: absolute; }
.onboarding-channel-card { align-items: center; background: var(--bg); border: 1px solid var(--line); border-radius: 13px; cursor: pointer; display: flex; gap: 16px; justify-content: space-between; min-height: 58px; padding: 12px 15px; }
.onboarding-channel-card:hover { background: #fff9e9; }
.onboarding-channel-choice input:focus-visible + .onboarding-channel-card { outline: 3px solid rgba(138, 100, 16, .42); outline-offset: 2px; }
.onboarding-channel-choice input:checked + .onboarding-channel-card { background: var(--ember-tint); border-color: var(--ember); box-shadow: inset 0 0 0 1px var(--ember); }
.onboarding-channel-name { color: var(--text); display: block; font-weight: 700; }
.onboarding-channel-description { color: var(--text-3); display: block; font-size: .8125rem; margin-top: 2px; }
.onboarding-radio-dot { background: var(--bg); border: 2px solid var(--line-strong); border-radius: 50%; flex: 0 0 auto; height: 17px; width: 17px; }
.onboarding-channel-choice input:checked + .onboarding-channel-card .onboarding-radio-dot { border: 5px solid var(--ember); }
.onboarding-reversible { color: var(--text-3); font-size: .8125rem; margin: 17px 0 0; }
.onboarding-success { align-items: flex-start; display: flex; gap: 14px; }
.onboarding-success-icon { background: var(--ok-solid); border-radius: 50%; color: white; display: grid; flex: 0 0 auto; font-size: 1.3125rem; font-weight: 700; height: 42px; place-items: center; width: 42px; }
.onboarding-success-badge { align-items: center; background: var(--ok-tint); border-radius: 999px; color: #36592a; display: inline-flex; font-size: .8125rem; font-weight: 700; gap: 7px; margin-bottom: 16px; padding: 8px 12px; }
.onboarding-success-badge::before { background: var(--ok-solid); border-radius: 50%; color: white; content: "✓"; display: grid; font-size: .6875rem; height: 18px; place-items: center; width: 18px; }
.onboarding-success-summary { background: var(--ok-tint); border-radius: 15px; color: #466a38; font-size: .9375rem; font-weight: 700; line-height: 1.45; margin-top: 26px; padding: 16px 18px; }
.onboarding-prompt-box { background: var(--well); border-radius: 15px; box-shadow: inset 0 0 0 1px var(--line); margin-top: 30px; padding: 19px; }
.onboarding-prompt-label { color: var(--text-3); font-family: var(--mono); font-size: .6875rem; letter-spacing: .06em; margin: 0 0 9px; text-transform: uppercase; }
.onboarding-prompt { color: var(--text); font-size: 1rem; font-weight: 600; line-height: 1.65; margin: 0; }
.onboarding-status { color: var(--ok); font-size: .8125rem; font-weight: 700; margin: 10px 0 0; min-height: 20px; }
@media (max-width: 720px) {
  .onboarding-shell-inner { padding: 20px 16px 45px; }
  .onboarding-environment { display: none; }
  .onboarding-orientation { margin-top: 34px; }
  .onboarding-step-dot { font-size: .75rem; height: 34px; width: 34px; }
  .onboarding-orientation li:not(:first-child)::before { top: 16px; }
  .onboarding-step-label { font-size: .6875rem; }
  .onboarding-stage { min-height: 520px; padding-top: 28px; }
  .onboarding-panel, .onboarding-panel-wide { border-radius: 22px; padding: 30px 22px; width: 100%; }
  .onboarding-brand .avatar, .onboarding-brand .avatar .pea { height: 34px; width: 34px; }
  .onboarding-brand .brand-name { font-size: 1.625rem; }
  .onboarding-title { font-size: 2.125rem; }
  .onboarding-lede { font-size: 1.0625rem; }
  .onboarding-instruction-title { font-size: 1rem; gap: 11px; grid-template-columns: 32px minmax(0, 1fr); }
  .onboarding-instruction-number { font-size: .75rem; height: 32px; width: 32px; }
  .onboarding-instruction-note { margin-left: 43px; }
  .onboarding-shot-viewport { height: 250px; }
  .onboarding-shot-banner, .onboarding-shot-focused, .onboarding-shot-ready, .onboarding-shot-wide { margin-left: 0; width: 100%; }
  .onboarding-credential-grid { grid-template-columns: 1fr; }
  .onboarding-guide-actions { align-items: stretch; flex-direction: column-reverse; }
  .onboarding-guide-actions .btn { min-height: 44px; width: 100%; }
  .onboarding-actions, .onboarding-form-actions { align-items: stretch; flex-direction: column-reverse; }
  .onboarding-completion-actions { flex-direction: column; }
  .onboarding-actions .btn, .onboarding-form-actions .btn { font-size: .9375rem; min-height: 44px; width: 100%; }
  .onboarding-workspace-row { align-items: flex-start; }
}
.slack-overview { gap: 22px; max-width: 990px; }
.slack-head { align-items: center; display: flex; gap: 16px; }
.slack-logo-large { flex-shrink: 0; height: 48px; object-fit: contain; width: 48px; }
.workspace-card {
  align-items: center;
  background: var(--bg);
  border-radius: 16px;
  box-shadow: inset 0 0 0 1.5px var(--line-strong);
  display: grid;
  gap: 14px;
  grid-template-columns: minmax(180px, 1.4fr) auto minmax(118px, auto) minmax(190px, 1fr);
  padding: 12px 14px;
}
.workspace-ident { align-items: center; display: flex; gap: 11px; min-width: 0; }
.workspace-card .badge { justify-self: start; }
.workspace-icon {
  align-items: center;
  background: var(--bg);
  border-radius: 12px;
  box-shadow: inset 0 0 0 1.5px var(--line-strong);
  color: var(--text-2);
  display: inline-flex;
  flex-shrink: 0;
  height: 42px;
  justify-content: center;
  width: 42px;
}
.workspace-icon .ic { height: 22px; width: 22px; }
.workspace-name { color: var(--text); font-size: 0.9375rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-meta { color: var(--text-3); font-size: 0.75rem; overflow-wrap: anywhere; }
.behavior-list { background: var(--well); border-radius: 16px; overflow: hidden; }
.behavior-row { align-items: center; display: flex; gap: 18px; padding: 13px 16px; }
.behavior-row + .behavior-row { border-top: 1.5px solid var(--bg); }
.behavior-copy { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.behavior-title { color: var(--text); font-size: 0.8125rem; font-weight: 700; }
.behavior-state { color: var(--text-3); font-size: 0.75rem; min-width: 22px; text-align: right; }
.action-well {
  align-items: center;
  background: var(--well);
  border-radius: 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  padding: 10px 12px;
}
.action-well .slack-console-link { margin-left: auto; }
.danger-panel {
  align-items: center;
  background: var(--danger-well);
  border-radius: 14px;
  display: flex;
  gap: 16px;
  padding: 14px 16px;
}
.danger-copy { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.danger-title { color: var(--danger); font-size: 0.8125rem; font-weight: 700; }
.inline-status { color: var(--text-3); font-size: 0.75rem; width: 100%; }
.inline-status.ok { color: var(--ok); font-weight: 700; }
.inline-status.error { color: var(--danger); font-weight: 700; }
.slack-overview-foot { align-items: center; display: flex; flex-wrap: wrap; gap: 12px; }
.main-head { align-items: flex-start; display: flex; gap: 12px; justify-content: space-between; }
.section { border-top: 1.5px solid rgba(59, 50, 32, 0.15); display: flex; flex-direction: column; gap: 13px; padding-top: 18px; }
.section:first-child { border-top: 0; padding-top: 0; }
.section-head { align-items: baseline; display: flex; gap: 10px; justify-content: space-between; }
.section-title { color: var(--text); font-family: var(--display); font-size: 1rem; font-weight: 700; text-wrap: balance; }
.field { display: flex; flex-direction: column; gap: 6px; }
.form-grid { display: grid; gap: 16px 18px; grid-template-columns: 1fr 1fr; }
.form-grid .full { grid-column: 1 / -1; }
.bundle-row {
  align-items: center;
  background: var(--well);
  border-radius: 14px;
  box-shadow: none;
  display: flex;
  gap: 10px;
  min-height: 46px;
  padding: 10px 14px;
}
.bundle-row .b-name { align-items: center; color: var(--text); display: inline-flex; flex-shrink: 0; font-size: 0.8125rem; font-weight: 700; gap: 6px; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bundle-row .b-meta { color: var(--text-3); font-family: var(--mono); font-size: 0.6875rem; min-width: 0; overflow-wrap: anywhere; }
.bundle-row .spacer { flex: 1; }
.channel-audit-rows { display: flex; flex-direction: column; gap: 10px; }
.channel-memory-summary { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.channel-memory-total { color: var(--text); font-size: 0.8125rem; font-variant-numeric: tabular-nums; font-weight: 700; }
.channel-memory-note { color: var(--text-3); font-size: 0.78125rem; text-wrap: pretty; }
.channel-memory-row .btn { flex-shrink: 0; }
.channel-routine-preview { color: var(--text-3); font-size: 0.78125rem; line-height: 1.5; }
.x-btn {
  background: none;
  border: 0;
  border-radius: 9px;
  color: var(--text-3);
  cursor: pointer;
  font-size: 0.875rem;
  line-height: 1;
  padding: 4px 7px;
}
.x-btn:hover { background: rgba(59, 50, 32, 0.08); color: var(--text); }
.well {
  background: var(--well);
  border-radius: 14px;
  box-shadow: none;
  padding: 5px 16px;
}
.well dl { display: flex; flex-direction: column; }
.well .kv, .adv-rows .kv {
  border-top: 1.5px solid var(--bg);
  display: grid;
  gap: 16px;
  grid-template-columns: 148px 1fr;
  padding: 11px 0;
}
.well .kv:first-child, .adv-rows .kv:first-child { border-top: 0; }
.well dt, .adv-rows dt { color: var(--text); font-size: 0.8125rem; font-weight: 700; }
.well dd, .adv-rows dd { color: var(--text-2); font-size: 0.8125rem; min-width: 0; }
.well dd.mono, .adv-rows dd.mono { font-size: 0.75rem; overflow-wrap: anywhere; }
.instructions-preview {
  background: var(--bg);
  border-left: 3px solid var(--line-strong);
  border-radius: 0 10px 10px 0;
  color: var(--text-2);
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 0.8125rem;
  margin-top: 2px;
  padding: 10px 14px;
}
.layer-tag {
  color: var(--text-3);
  font-size: 0.65625rem;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}
.layer-tag.ember { color: var(--ember-press); }
.from-addendum { border-left: 3px solid var(--ember); margin-left: -16px; padding-left: 13px; }
details.advanced { border-top: 1.5px solid rgba(59, 50, 32, 0.15); padding-top: 4px; }
details.advanced summary {
  align-items: center;
  color: var(--text-2);
  cursor: pointer;
  display: flex;
  font-size: 0.875rem;
  font-weight: 700;
  gap: 7px;
  list-style: none;
  padding: 13px 0;
}
details.advanced summary::-webkit-details-marker { display: none; }
details.advanced summary::before {
  background-color: var(--text-3);
  content: "";
  flex-shrink: 0;
  height: 16px;
  -webkit-mask: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2016%2016%27%3E%3Cpath%20d%3D%27M6.22%204.22a.75.75%200%200%201%201.06%200l3.25%203.25a.75.75%200%200%201%200%201.06l-3.25%203.25a.75.75%200%200%201-1.06-1.06L8.94%208%206.22%205.28a.75.75%200%200%201%200-1.06Z%27%2F%3E%3C%2Fsvg%3E") center / 16px 16px no-repeat;
  mask: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2016%2016%27%3E%3Cpath%20d%3D%27M6.22%204.22a.75.75%200%200%201%201.06%200l3.25%203.25a.75.75%200%200%201%200%201.06l-3.25%203.25a.75.75%200%200%201-1.06-1.06L8.94%208%206.22%205.28a.75.75%200%200%201%200-1.06Z%27%2F%3E%3C%2Fsvg%3E") center / 16px 16px no-repeat;
  width: 16px;
}
details[open].advanced summary::before {
  -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2016%2016%27%3E%3Cpath%20d%3D%27M4.22%206.22a.75.75%200%200%201%201.06%200L8%208.94l2.72-2.72a.75.75%200%201%201%201.06%201.06l-3.25%203.25a.75.75%200%200%201-1.06%200L4.22%207.28a.75.75%200%200%201%200-1.06Z%27%2F%3E%3C%2Fsvg%3E");
  mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2016%2016%27%3E%3Cpath%20d%3D%27M4.22%206.22a.75.75%200%200%201%201.06%200L8%208.94l2.72-2.72a.75.75%200%201%201%201.06%201.06l-3.25%203.25a.75.75%200%200%201-1.06%200L4.22%207.28a.75.75%200%200%201%200-1.06Z%27%2F%3E%3C%2Fsvg%3E");
}
.adv-rows { display: flex; flex-direction: column; padding-bottom: 14px; }
.save-bar { align-items: center; display: flex; gap: 10px; justify-content: flex-end; }
.save-note { color: var(--text-3); font-size: 0.75rem; margin-right: auto; }
.save-bar-sticky {
  background: var(--bg);
  border-top: 0;
  bottom: 0;
  box-shadow: 0 -8px 24px rgba(59, 50, 32, 0.14);
  left: 0;
  padding: 13px 32px calc(13px + env(safe-area-inset-bottom, 0px));
  position: fixed;
  right: 0;
  z-index: 20;
}
.save-bar-sticky.is-clean { display: none; }
/* One-shot entrance: slide up + a warm pulse so going dirty is impossible to
   miss (and re-cued on picker Apply, where edits read as already committed). */
.save-bar-sticky.cue { animation: save-bar-cue 1.4s ease; }
.save-bar-sticky.cue [data-action="save-profile"] { animation: save-btn-cue 1.4s ease; }
@keyframes save-bar-cue {
  0% { box-shadow: 0 -8px 24px rgba(59, 50, 32, 0.14); transform: translateY(100%); }
  16% { transform: translateY(0); }
  38% { box-shadow: 0 -8px 34px rgba(221, 160, 51, 0.6); }
  100% { box-shadow: 0 -8px 24px rgba(59, 50, 32, 0.14); transform: translateY(0); }
}
@keyframes save-btn-cue {
  0%, 32% { transform: scale(1); }
  46% { transform: scale(1.07); }
  62% { transform: scale(1); }
  76% { transform: scale(1.05); }
  100% { transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .save-bar-sticky.cue, .save-bar-sticky.cue [data-action="save-profile"] { animation: none; }
}
.save-bar-inner { align-items: center; display: flex; gap: 10px; margin: 0 auto; max-width: 760px; }
.save-bar-inner .save-note { margin-right: auto; }
.modal-backdrop {
  align-items: center;
  background: rgba(59, 50, 32, 0.4);
  bottom: 0;
  display: flex;
  justify-content: center;
  left: 0;
  padding: 20px;
  position: fixed;
  right: 0;
  top: 0;
  z-index: 50;
}
.modal-card {
  background: var(--bg);
  border-radius: 20px;
  box-shadow: 0 24px 60px rgba(59, 50, 32, 0.3);
  max-width: 440px;
  padding: 20px 22px;
  width: 100%;
}
.modal-title { color: var(--text); font-family: var(--display); font-size: 1.0625rem; font-weight: 700; }
.modal-body { color: var(--text-2); font-size: 0.875rem; margin-top: 6px; }
.modal-foot { align-items: center; display: flex; gap: 8px; margin-top: 18px; }
.modal-foot .spacer { flex: 1; }
.managed-setup-modal { display: grid; gap: 16px; max-width: 560px; padding: 26px; }
.managed-setup-modal .modal-title { font-size: 1.25rem; }
.managed-setup-intro { color: var(--text-2); display: grid; font-size: .875rem; gap: 10px; line-height: 1.55; }
.managed-setup-intro p { margin: 0; }
.managed-setup-connector { align-items: center; background: var(--well); border: 1px solid var(--line); border-radius: 14px; display: flex; gap: 12px; padding: 12px 14px; }
.managed-setup-connector .conn-logo { flex: 0 0 auto; }
.managed-setup-connector strong { color: var(--text); }
.managed-setup-progress { color: var(--text-2); font-size: .8125rem; margin: 0; min-height: 20px; }
.managed-setup-progress.error { color: var(--danger); }
.managed-waiting { align-items: center; background: var(--well); border-radius: 14px; display: flex; gap: 14px; padding: 16px; }
.managed-waiting-mark { align-items: center; background: var(--ember-tint); border-radius: 999px; color: var(--ember-press); display: inline-flex; flex: 0 0 40px; font-weight: 800; height: 40px; justify-content: center; }
.managed-waiting p { margin: 3px 0 0; }
.managed-impact { background: var(--well); border-radius: 12px; color: var(--text-2); font-size: .8125rem; padding: 11px 13px; }
@media (max-width: 720px) {
  .modal-foot { flex-direction: column-reverse; align-items: stretch; }
  .modal-foot .spacer { display: none; }
}
.error, .field-error { color: var(--danger); font-size: 0.8125rem; font-weight: 600; }
.empty {
  align-items: flex-start;
  background: var(--well);
  border-radius: 16px;
  box-shadow: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px;
}
/* ---- profiles master-detail (topbar nav active + role badge) ---- */
.nav-active { background: var(--text); box-shadow: 0 2px 0 rgba(30, 24, 12, 0.5); color: #f6edda; }
.nav-active:hover:not(:disabled) { background: #4a4028; color: #f6edda; }
.badge-role { background: var(--ember-tint); color: var(--ember-press); }

/* ---- profiles overview cards ---- */
.pcard {
  background: var(--well);
  border-radius: 18px;
  box-shadow: none;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 16px 18px;
}
.pcard + .pcard { margin-top: 12px; }
.pcard .pcard-head { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; }
.pcard .pcard-name { color: var(--text); font-family: var(--display); font-size: 0.9375rem; font-weight: 700; }
.pcard .pcard-foot { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; }
.pcard .pcard-foot .spacer { flex: 1; }

.tool-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }

/* ---- profile custom skills ---- */
.skill-list { display: flex; flex-direction: column; gap: 8px; }
.skill-row {
  align-items: center;
  background: var(--well);
  border-radius: 14px;
  box-shadow: none;
  display: flex;
  gap: 12px;
  padding: 12px 14px;
}
.skill-row .sk-body { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.skill-row .sk-name { align-items: center; color: var(--text); display: flex; flex-wrap: wrap; font-family: var(--mono); font-size: 0.78125rem; font-weight: 600; gap: 8px; overflow-wrap: anywhere; }
.skill-row .sk-desc { color: var(--text-3); font-size: 0.78125rem; overflow-wrap: anywhere; }
.badge-src {
  background: rgba(59, 50, 32, 0.08);
  border-radius: 999px;
  color: var(--text-3);
  font-family: var(--mono);
  font-size: 0.625rem;
  font-weight: 500;
  letter-spacing: 0.05em;
  padding: 2px 9px;
  text-transform: uppercase;
  white-space: nowrap;
}
.skill-form {
  background: var(--well);
  border-radius: 16px;
  box-shadow: none;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 18px;
}
.skill-form .input, .skill-form .textarea { background: var(--bg); }
.skill-form-actions { align-items: center; display: flex; gap: 8px; justify-content: flex-end; }
.skill-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.skill-build {
  align-items: center;
  background: var(--well);
  border-radius: 15px;
  display: flex;
  gap: 14px;
  justify-content: space-between;
  padding: 14px 16px;
}
.skill-build-copy { color: var(--text-2); font-size: .75rem; line-height: 1.45; }
.skill-build-copy strong { color: var(--text); display: block; font-size: .8125rem; margin-bottom: 2px; }
.configured-skills { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.configured-skills > h3 { color: var(--text); font-size: .8125rem; margin: 0 3px; }
.suggested-skills { display: flex; flex-direction: column; margin-top: 10px; }
.suggested-skills-head { align-items: flex-end; display: flex; gap: 14px; justify-content: space-between; margin-bottom: 12px; }
.suggested-skills-head h3 { color: var(--text); font-size: 1rem; letter-spacing: -.02em; margin: 0; }
.suggested-skills-head p { color: var(--text-3); font-size: .75rem; line-height: 1.45; margin: 3px 0 0; }
.suggested-on-count { color: var(--ok); font-size: .6875rem; font-weight: 700; white-space: nowrap; }
.suggested-category-nav {
  border-bottom: 1px solid var(--line-strong);
  display: flex;
  gap: 3px;
  overflow-x: auto;
  scrollbar-width: none;
}
.suggested-category-nav::-webkit-scrollbar { display: none; }
.suggested-category {
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--text-3);
  cursor: pointer;
  flex: none;
  font: inherit;
  font-size: .6875rem;
  font-weight: 700;
  padding: 8px 10px 9px;
  white-space: nowrap;
}
.suggested-category:hover { color: var(--text); }
.suggested-category[aria-selected="true"] { border-bottom-color: var(--ember); color: var(--text); }
.suggested-category:focus-visible { border-radius: 7px 7px 0 0; outline: 2px solid var(--ember-press); outline-offset: -2px; }
.suggested-category-count { color: var(--text-3); font-family: var(--mono); font-size: .5625rem; margin-left: 4px; }
.suggested-catalog-head { align-items: baseline; display: flex; gap: 8px; margin: 10px 3px 6px; }
.suggested-catalog-head strong { color: var(--text); font-size: .8125rem; }
.suggested-catalog-summary { color: var(--text-3); font-size: .625rem; }
.suggested-skill-list { border-top: 1px solid var(--line-strong); display: flex; flex-direction: column; }
.suggested-skill-row {
  align-items: center;
  border-bottom: 1px solid var(--line-strong);
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0, 1fr) auto;
  padding: 9px 4px;
}
.suggested-skill-row.is-on { background: var(--ok-tint); border-radius: 12px; margin: 2px 0; padding: 8px 10px; }
.suggested-skill-copy { min-width: 0; }
.suggested-skill-title { align-items: baseline; display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 3px; }
.suggested-skill-title strong { color: var(--text); font-size: .8125rem; }
.suggested-skill-slug { color: var(--text-3); font-family: var(--mono); font-size: .625rem; }
.suggested-skill-byline { color: var(--text-3); font-size: .625rem; }
.suggested-skill-byline:hover { color: var(--text); }
.suggested-skill-byline:focus-visible { border-radius: 3px; outline: 2px solid var(--ember-press); outline-offset: 2px; }
.suggested-skill-state { color: var(--ok); font-size: .625rem; font-weight: 700; margin-left: auto; }
.suggested-skill-state.is-blocked { color: var(--text-3); }
.suggested-skill-description { color: var(--text-2); font-size: .6875rem; line-height: 1.45; }
.suggested-disclosure { align-items: flex-start; color: var(--text-3); display: flex; font-size: .625rem; gap: 7px; line-height: 1.45; margin: 14px 2px 0; }
.suggested-disclosure .ic { flex: none; margin-top: 1px; }
@media (max-width: 720px) {
  .skill-row { align-items: stretch; flex-direction: column; }
  .configured-skills .skill-row {
    align-items: center;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
  }
  .skill-build { align-items: stretch; flex-direction: column; }
  .suggested-skills-head { align-items: flex-start; flex-direction: column; gap: 4px; }
}

/* ---- import skills from a URL ---- */
.import-panel { gap: 12px; }
.import-source-tools { align-items: center; display: flex; flex-wrap: wrap; gap: 8px 12px; }
.import-source-tools .hint { flex: 1; min-width: 220px; }
.import-browse-host { display: flex; flex-direction: column; gap: 8px; }
.import-browse-picker { margin-left: 0; max-width: none; }
.import-browse-row { border: 0; font: inherit; text-align: left; width: 100%; }
.import-disclosure {
  background: rgba(59, 50, 32, 0.055);
  border-radius: 11px;
  color: var(--text-3);
  display: flex;
  flex-direction: column;
  font-size: 0.75rem;
  gap: 7px;
  line-height: 1.45;
  padding: 10px 12px;
}
.import-disclosure .badge-src { align-self: flex-start; }
.import-summary {
  align-items: baseline;
  color: var(--text-2);
  display: flex;
  flex-wrap: wrap;
  font-size: 0.8125rem;
  gap: 8px 12px;
  justify-content: space-between;
}
.import-summary .import-note { color: var(--text-3); }
.import-list { display: flex; flex-direction: column; gap: 8px; }
.import-row {
  align-items: flex-start;
  background: var(--well);
  border-radius: 14px;
  box-shadow: none;
  cursor: pointer;
  display: flex;
  gap: 11px;
  padding: 12px 14px;
  position: relative;
}
.import-row:focus-within { outline: 2px solid var(--ember-press); outline-offset: 2px; }
.import-row.on { box-shadow: inset 0 0 0 2px var(--ember); }
.import-check {
  background: var(--bg);
  border-radius: 6px;
  box-shadow: inset 0 0 0 1.5px rgba(59, 50, 32, 0.18);
  flex-shrink: 0;
  height: 18px;
  margin-top: 1px;
  position: relative;
  width: 18px;
}
.import-check.on { background: var(--ember); box-shadow: 0 1.5px 0 var(--ember-press); }
.import-check.on::after {
  background-color: #3a2a08;
  content: "";
  height: 12px;
  inset: 3px;
  -webkit-mask: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2016%2016%27%3E%3Cpath%20d%3D%27M12.416%203.376a.75.75%200%200%201%20.208%201.04l-5%207.5a.75.75%200%200%201-1.154.114l-3-3a.75.75%200%201%201%201.06-1.06l2.353%202.353%204.493-6.74a.75.75%200%200%201%201.04-.207Z%27%2F%3E%3C%2Fsvg%3E") center / 12px 12px no-repeat;
  mask: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2016%2016%27%3E%3Cpath%20d%3D%27M12.416%203.376a.75.75%200%200%201%20.208%201.04l-5%207.5a.75.75%200%200%201-1.154.114l-3-3a.75.75%200%201%201%201.06-1.06l2.353%202.353%204.493-6.74a.75.75%200%200%201%201.04-.207Z%27%2F%3E%3C%2Fsvg%3E") center / 12px 12px no-repeat;
  position: absolute;
  width: 12px;
}
.import-check input { appearance: none; cursor: pointer; inset: 0; margin: 0; opacity: 0; position: absolute; }
.import-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.import-name { align-items: center; color: var(--text); display: flex; flex-wrap: wrap; font-family: var(--mono); font-size: 0.78125rem; font-weight: 600; gap: 8px; overflow-wrap: anywhere; }
.import-desc { color: var(--text-3); font-size: 0.78125rem; overflow-wrap: anywhere; }
.badge-src.import-scripts { text-transform: none; letter-spacing: 0; }

/* ---- settings: model-provider rows + favorites ---- */
.prov-row { background: var(--well); border-radius: 18px; box-shadow: none; display: flex; flex-direction: column; }
.prov-row + .prov-row { margin-top: 12px; }
.prov-head { align-items: center; display: flex; flex-wrap: wrap; gap: 10px 12px; padding: 15px 18px; }
.prov-id { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.prov-name { color: var(--text); font-family: var(--display); font-size: 0.9375rem; font-weight: 700; }
.prov-sub { color: var(--text-3); font-size: 0.75rem; }
.prov-sub .mono-frag { font-family: var(--mono); font-size: 0.6875rem; }
.prov-status { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; }
.prov-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; }
.prov-body { border-top: 1.5px solid var(--bg); display: flex; flex-direction: column; gap: 12px; padding: 15px 18px; }
.prov-body .input { background: var(--bg); }
.openai-auth-list { display: flex; flex-direction: column; gap: 10px; }
.openai-auth-option { background: var(--bg); border-radius: 14px; display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; }
.openai-auth-head { align-items: center; display: flex; flex-wrap: wrap; gap: 10px 12px; }
.openai-auth-copy { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 190px; }
.openai-auth-title { color: var(--text); font-size: 0.875rem; font-weight: 700; }
.openai-auth-meta { color: var(--text-3); font-size: 0.75rem; }
.openai-auth-option .input { background: var(--well); }
.paste-row { display: flex; flex-wrap: wrap; gap: 9px; }
.paste-row .input { flex: 1; min-width: 220px; }
.github-installations { display: flex; flex-direction: column; gap: 10px; }
.github-installations .prov-row + .prov-row { margin-top: 0; }
.github-installation-copy { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.github-installation-name { color: var(--text); font-family: var(--mono); font-size: 0.8125rem; font-weight: 700; overflow-wrap: anywhere; }
.github-installation-meta { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; }
.fav-sub { color: var(--text-3); font-size: 0.65625rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.fav-list { display: flex; flex-direction: column; gap: 6px; }
.fav-row { align-items: center; background: var(--bg); border-radius: 13px; border-top: 0; box-shadow: 0 1.5px 0 rgba(59, 50, 32, 0.08); display: flex; gap: 10px; padding: 8px 12px; }
.fav-row:first-child { border-top: 0; }
.fav-model { color: var(--text); font-family: var(--mono); font-size: 0.75rem; min-width: 0; overflow-wrap: anywhere; }
.fav-meta { color: var(--text-3); flex-shrink: 0; font-size: 0.6875rem; font-weight: 600; margin-left: auto; text-align: right; white-space: nowrap; }
.fav-meta .price { color: var(--text-2); }
.star { background: none; border: 0; color: var(--text-3); cursor: pointer; flex-shrink: 0; font-size: 1rem; line-height: 1; padding: 2px; }
.star.on { color: #d9962c; }
.star:focus-visible { outline: 2px solid var(--ember-press); outline-offset: 2px; }
.fav-empty { color: var(--text-3); font-size: 0.8125rem; padding: 6px 2px; }
.fav-provider .prov-head { padding: 17px 18px; }
.fav-provider-id { align-items: center; flex-direction: row; flex-wrap: wrap; gap: 10px; }
.fav-provider .badge-on { background: var(--ok-tint); box-shadow: none; color: var(--ok); }
.fav-provider-controls { align-items: center; display: flex; gap: 10px; }
.fav-provider-error { padding: 0 18px 14px; }
.fav-provider-body { gap: 0; padding: 0 18px 16px; }
.fav-summary { align-items: center; display: flex; gap: 16px; justify-content: space-between; min-height: 56px; }
.fav-summary-copy { align-items: baseline; display: flex; flex-wrap: wrap; gap: 8px 18px; min-width: 0; }
.fav-summary-title { color: var(--text); font-size: 0.875rem; font-weight: 700; }
.fav-summary-count { color: var(--text-3); font-size: 0.8125rem; }
.fav-manager { border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 10px; padding: 14px 0 4px; }
.fav-selected { border-top: 1px solid var(--line); display: flex; flex-direction: column; }
.fav-selected .fav-row { background: transparent; border-radius: 0; box-shadow: none; min-height: 44px; padding: 10px 2px; }
.fav-selected .fav-row + .fav-row { border-top: 1px solid var(--line); }
.fav-provider-editor { padding-top: 15px; }
@media (max-width: 620px) {
  .fav-summary { align-items: flex-start; flex-direction: column; padding: 14px 0; }
}
.raw-error {
  background: var(--danger-well);
  border-radius: 12px;
  box-shadow: inset 0 0 0 1.5px rgba(180, 71, 58, 0.18);
  color: #9e3d31;
  font-family: var(--mono);
  font-size: 0.6875rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
  padding: 10px 12px;
  white-space: pre-wrap;
}

/* ---- model picker Settings action footer ---- */
.combo-settings { border-top: 1.5px solid var(--well); font-size: 0.8125rem; margin-top: 4px; padding: 9px 10px; }
.combo-list {
  background: var(--bg);
  border-radius: 16px;
  box-shadow: var(--pop-shadow), inset 0 0 0 1.5px rgba(59, 50, 32, 0.08);
  display: flex;
  flex-direction: column;
  margin-top: 6px;
  overflow: hidden;
  padding: 6px;
}
.combo-group {
  align-items: baseline;
  color: var(--text-3);
  display: flex;
  gap: 8px;
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 8px 10px 4px;
  text-transform: uppercase;
}
.combo-group .src { letter-spacing: 0; text-transform: none; }
.combo-opt {
  background: transparent;
  border: 0;
  border-radius: 10px;
  color: var(--text);
  cursor: pointer;
  font-family: var(--mono);
  font-size: 0.75rem;
  padding: 7px 10px;
  text-align: left;
  width: 100%;
}
.combo-opt.plain { font-family: var(--font); font-weight: 600; }
.combo-opt:hover { background: #f6eedc; }
.combo-opt.active { background: rgba(221, 160, 51, 0.22); color: var(--ember-press); }
.combo-foot { border-top: 1.5px solid var(--well); color: var(--text-3); font-size: 0.75rem; margin-top: 4px; padding: 9px 10px 4px; }
/* ---- profile Model click-to-open combobox ---- */
.model-combo { position: relative; }
.model-combo .model-combo-input { padding-right: 32px; }
.model-combo .model-combo-caret {
  color: var(--text-3);
  pointer-events: none;
  position: absolute;
  right: 12px;
  top: 10px;
}
.model-combo .combo-list {
  left: 0;
  margin-top: 4px;
  max-height: 320px;
  overflow-y: auto;
  position: absolute;
  right: 0;
  top: 100%;
  z-index: 20;
}
@media (max-width: 720px) {
  .body { flex-direction: column; }
  .rail { border-bottom: 0; width: 100%; }
  .rail-context { max-height: 46vh; }
  .section-switcher { display: none; }
  .main { padding: 20px; }
  .form-grid { grid-template-columns: 1fr; }
  .prov-actions { margin-left: 0; width: 100%; }
  .well .kv, .adv-rows .kv { grid-template-columns: 1fr; gap: 3px; }
  .btn { font-size: 0.875rem; padding: 9px 15px; }
  .btn-sm { font-size: 0.8125rem; padding: 6px 12px; }
  .main-head, .section-head, .bundle-row, .save-bar { align-items: stretch; flex-direction: column; }
  .channel-memory-total, .channel-memory-note { font-size: 1rem; }
  .workspace-card { align-items: flex-start; grid-template-columns: 1fr; }
  .behavior-row { align-items: flex-start; }
  .behavior-row .toggle { margin-left: auto; }
  .action-well, .danger-panel, .slack-overview-foot { align-items: stretch; flex-direction: column; }
  .action-well .slack-console-link { margin-left: 0; }
  .bundle-row .b-name { max-width: 100%; }
  .save-note { margin-right: 0; }
  .save-bar-sticky { padding: 13px 20px calc(13px + env(safe-area-inset-bottom, 0px)); }
  .save-bar-inner { align-items: stretch; flex-direction: column; }
  .save-bar-inner .save-note { margin-right: 0; }
  body { font-size: 1rem; }
  .hint, .field-label { font-size: 0.9375rem; }
  .mono { font-size: 0.9375rem; }
  .input, .textarea { font-size: 1rem; }
  .input.mono, .textarea.mono { font-size: 1rem; }
  .badge { font-size: 0.8125rem; padding: 4px 12px; }
  .chip { font-size: 0.8125rem; }
  .toggle { width: 52px; }
  .ic { height: 18px; width: 18px; }
  .step-num { font-size: 0.9375rem; height: 30px; width: 30px; }
  .success-toast { align-items: flex-start; }
  .topbar .topbar-menu { display: inline-flex; }
  .topbar .topbar-menu > summary { display: inline-flex; }
  .topbar .actions-list { display: none; }
  .topbar-menu[open] ~ .actions-list {
    align-items: stretch;
    background: var(--bg);
    border-radius: 16px;
    box-shadow: 0 12px 30px rgba(59, 50, 32, 0.22), inset 0 0 0 1.5px rgba(59, 50, 32, 0.08);
    display: flex;
    flex-direction: column;
    padding: 6px;
    position: absolute;
    right: 20px;
    top: 54px;
    z-index: 30;
  }
}

@media (min-width: 721px) {
  .frame { height: 100dvh; overflow: hidden; }
  .body { overflow: hidden; }
  .rail, .main { max-height: 100%; }
  .topbar .topbar-menu, .topbar .actions-list { display: none; }
}

/* ---- action buttons never wrap their label ---- */
.save-bar .btn { flex-shrink: 0; white-space: nowrap; }

/* ---- topbar hamburger disclosure (mobile only) ---- */
.topbar-menu { display: none; }
.topbar-menu > summary {
  align-items: center;
  border-radius: 12px;
  color: var(--text-2);
  cursor: pointer;
  display: none;
  list-style: none;
  min-height: 34px;
  padding: 6px 8px;
}
.topbar-menu > summary::-webkit-details-marker { display: none; }
.topbar-menu > summary:hover { background: rgba(59, 50, 32, 0.06); color: var(--text); }
.topbar-menu > summary:focus-visible { outline: 2px solid var(--ember-press); outline-offset: 2px; }
.actions-list { align-items: center; display: flex; gap: 9px; }

/* ---- unified primary Admin shell ------------------------------------- */
.primary-admin-shell {
  --admin-visual-canvas: #f4ead2;
  --admin-visual-paper: #fffdf7;
  --admin-visual-line: #e8deca;
  background: var(--admin-visual-canvas);
  height: auto;
  min-height: 100dvh;
  overflow: visible;
  max-width: none;
}
.primary-admin-shell > .topbar { display: none; }
.primary-admin-shell .body { align-items: flex-start; gap: 24px; overflow: visible; padding: 0 24px 0 0; }
.primary-admin-shell .primary-shell-sidebar {
  align-self: flex-start;
  background: rgba(255, 253, 247, .74);
  border-radius: 0;
  border-right: 1px solid rgba(130, 105, 58, .12);
  box-shadow: none;
  height: 100dvh;
  max-height: 100dvh;
  overflow: hidden;
  padding: 27px 22px 22px;
  position: sticky;
  top: 0;
  width: 292px;
}
.primary-admin-shell .primary-shell-brand {
  align-items: center;
  display: flex;
  gap: 11px;
  padding: 0 3px 25px;
}
.primary-admin-shell .primary-shell-brand .brand-home { flex: 1; }
.primary-admin-shell .primary-shell-brand .brand-name { font-size: 1.25rem; }
.primary-admin-shell .primary-shell-sidebar .rail-context { padding-bottom: 14px; }
.primary-admin-shell .primary-shell-sidebar .rail-head { padding-left: 3px; padding-right: 3px; }
.primary-admin-shell .primary-shell-sidebar .section-switcher { border-color: var(--admin-visual-line); }
.primary-admin-shell .main {
  align-self: flex-start;
  background: var(--admin-visual-paper);
  border: 1px solid rgba(118, 94, 51, .08);
  height: auto;
  margin: 22px auto;
  max-height: none;
  min-height: calc(100dvh - 44px);
  overflow: visible;
  max-width: 1440px;
  width: 100%;
}

/* Agent and Channel pages keep their specialized rail and content density
   inside the shared attached shell. */
.admin-surface .agent-shell-sidebar .rail-head { padding: 0 3px 8px; }
.agent-slack-context { padding: 0 3px 8px; }
.agent-slack-row {
  align-items: center;
  color: var(--text);
  display: flex;
  font-size: .8125rem;
  font-weight: 700;
  gap: 10px;
  min-height: 42px;
}
.agent-slack-row .platform-logo { height: 22px; width: 22px; }
.agent-slack-status {
  align-items: center;
  color: var(--ok);
  display: inline-flex;
  font-size: .6875rem;
  gap: 5px;
  margin-left: auto;
}
.agent-slack-status::before { background: currentColor; border-radius: 50%; content: ""; height: 7px; width: 7px; }
.agent-slack-status.disconnected { color: var(--text-3); }
.agent-slack-status.attention { color: var(--danger); }
.agent-workspace-row { margin: 3px 0 2px; padding: 6px 0; }
.agent-roster { display: flex; flex-direction: column; gap: 4px; }
.agent-roster-item {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 10px;
  color: var(--text);
  cursor: pointer;
  display: flex;
  gap: 10px;
  min-width: 0;
  padding: 10px 9px;
  text-align: left;
  width: 100%;
}
.agent-roster-item:hover { background: rgba(232, 216, 182, .5); }
.agent-roster-item.active { background: #f4e8cc; }
.agent-roster-item:focus-visible, .primary-shell-brand .brand-home:focus-visible {
  outline: 2px solid var(--ember-press);
  outline-offset: 2px;
}
.agent-roster-icon {
  align-items: center;
  background: #e6edf8;
  border-radius: 10px;
  color: #526ca9;
  display: inline-flex;
  flex: none;
  height: 34px;
  justify-content: center;
  width: 34px;
}
.agent-roster-icon.variant-1 { background: #e7f1e3; color: #5f8d58; }
.agent-roster-icon.variant-2 { background: #efe6f4; color: #7d6091; }
.agent-roster-icon.has-avatar { background: transparent; overflow: hidden; }
.agent-roster-icon.has-avatar img { display: block; height: 100%; object-fit: cover; width: 100%; }
.agent-roster-icon .ic { height: 18px; width: 18px; }
.agent-roster-copy { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.agent-roster-name {
  font-size: .75rem;
  font-weight: 750;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-roster-meta {
  color: var(--text-3);
  font-size: .625rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-roster-add { margin: 5px 0 0; padding-left: 12px; }
.admin-surface .main {
  padding: 44px 46px 48px;
}
.mobile-agent-roster { display: flex; flex-direction: column; gap: 4px; min-width: min(340px, calc(100vw - 40px)); }
.mobile-agent-roster-head { align-items: center; display: flex; gap: 10px; justify-content: space-between; padding: 4px 6px 8px; }
.mobile-agent-roster .agent-roster-add { margin-left: 0; }

@media (max-width: 1000px) {
  .primary-admin-shell .body { gap: 15px; padding-right: 15px; }
  .primary-admin-shell .primary-shell-sidebar { width: 228px; }
  .admin-surface .main { padding: 32px 28px; }
}

@media (max-width: 740px) {
  .primary-admin-shell > .topbar { display: flex; }
  .primary-admin-shell .body { flex-direction: column; gap: 0; padding-right: 0; }
  .primary-admin-shell .primary-shell-sidebar { display: none; }
  .primary-admin-shell .main {
    align-self: auto;
    margin: 10px;
    padding: 26px 20px;
    width: calc(100% - 20px);
  }
  .primary-admin-shell .topbar .topbar-menu,
  .primary-admin-shell .topbar .topbar-menu > summary { display: inline-flex; }
  .primary-admin-shell .topbar .actions-list { display: none; }
  .primary-admin-shell .topbar-menu[open] ~ .actions-list {
    align-items: stretch;
    background: var(--bg);
    border-radius: 16px;
    box-shadow: 0 12px 30px rgba(59, 50, 32, .22), inset 0 0 0 1.5px rgba(59, 50, 32, .08);
    display: flex;
    flex-direction: column;
    max-height: calc(100dvh - 76px);
    overflow-y: auto;
    padding: 6px;
    position: absolute;
    right: 20px;
    top: 54px;
    z-index: 30;
  }
}

/* ---- wizard steps ---- */
.stepper { display: flex; flex-direction: column; gap: 22px; }
.step-block { display: flex; gap: 13px; }
.step-block.dimmed { opacity: 0.45; }
.step-num {
  align-items: center;
  border-radius: 999px;
  display: inline-flex;
  flex-shrink: 0;
  font-family: var(--display);
  font-size: 0.875rem;
  font-weight: 700;
  height: 28px;
  justify-content: center;
  width: 28px;
}
.step-num.active { background: var(--ember); box-shadow: 0 1.5px 0 var(--ember-press); color: #3a2a08; }
.step-num.idle { background: rgba(59, 50, 32, 0.1); color: var(--text-3); }
.step-num.done { background: var(--ok-solid); box-shadow: 0 1.5px 0 rgba(78, 122, 62, 0.6); color: #fffdf6; }
.step-block.dimmed .step-num { cursor: pointer; }
.advance-step {
  background: none;
  border: 0;
  cursor: pointer;
  display: flex;
  flex: 1;
  gap: 13px;
  padding: 0;
  text-align: left;
}
.advance-step:focus-visible { outline: 2px solid var(--ember-press); outline-offset: 2px; }
.step-body { display: flex; flex: 1; flex-direction: column; gap: 11px; min-width: 0; }
.step-title { color: var(--text); font-size: 0.875rem; font-weight: 700; }
.step-done-line { align-items: center; display: flex; gap: 10px; min-height: 28px; }
.warn-accent { border-left: 3px solid var(--ember); padding-left: 11px; }
.callout {
  align-items: flex-start;
  background: rgba(221, 160, 51, 0.16);
  border-radius: 14px;
  color: var(--text-2);
  display: flex;
  font-size: 0.8125rem;
  gap: 9px;
  line-height: 1.55;
  padding: 12px 14px;
}
.callout .g { color: var(--ember-deep); flex-shrink: 0; }
.tiny-label { color: var(--text-3); font-size: 0.6875rem; }

/* ---- paired instruction+field block ---- */
.paste-pair {
  background: var(--well);
  border-radius: 16px;
  box-shadow: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 13px 15px;
}
.paste-pair .pair-head {
  align-items: baseline;
  color: var(--text-2);
  display: flex;
  font-size: 0.8125rem;
  gap: 9px;
  line-height: 1.55;
}
.paste-pair .pair-head .n {
  align-items: center;
  background: rgba(221, 160, 51, 0.28);
  border-radius: 999px;
  color: var(--ember-deep);
  display: inline-flex;
  flex-shrink: 0;
  font-size: 0.6875rem;
  font-weight: 700;
  height: 20px;
  justify-content: center;
  position: relative;
  top: 2px;
  width: 20px;
}
.paste-pair .input { background: var(--bg); }
.spinner {
  animation: ds-spin 0.7s linear infinite;
  border: 2.5px solid rgba(221, 160, 51, 0.35);
  border-radius: 999px;
  border-top-color: var(--ember-deep);
  display: inline-block;
  height: 13px;
  width: 13px;
}
@keyframes ds-spin { to { transform: rotate(360deg); } }

/* ---- connected success toast ---- */
.success-toast {
  align-items: center;
  background: var(--ok-tint);
  border-radius: 14px;
  color: var(--ok);
  display: flex;
  font-size: 0.8125rem;
  font-weight: 600;
  gap: 9px;
  padding: 9px 13px;
}

/* ---- 48px touch targets on icon-only buttons ---- */
@media (pointer: coarse) {
  .x-btn { position: relative; }
  .x-btn::after { content: ""; inset: 50%; min-height: 44px; min-width: 44px; position: absolute; transform: translate(-50%, -50%); }
}

/* ---- inline title rename (profile edit head) ---- */
.title-row { align-items: center; display: flex; gap: 8px; }
.rename-btn {
  align-items: center;
  background: rgba(59, 50, 32, 0.07);
  border: 0;
  border-radius: 9px;
  color: var(--text-2);
  cursor: pointer;
  display: inline-flex;
  flex-shrink: 0;
  height: 26px;
  justify-content: center;
  width: 26px;
}
.rename-btn:hover { background: rgba(59, 50, 32, 0.11); color: var(--text); }
.rename-btn:focus-visible { outline: 2px solid var(--ember-press); outline-offset: 2px; }
.rename-btn .ic { display: block; height: 16px; width: 16px; }
.page-title-input { font-family: var(--display); font-size: 1.25rem; font-weight: 700; max-width: 32ch; }

/* ---- profile capability tabs (Instructions / Skills / Connections / Repositories) ----
   "Ringed tray": the tab bar and its visible panel read as ONE cream container
   outlined by a 1.5px ring, with a solid seam under the tabs. The active tab
   is a solid cocoa pill (same idiom as the topbar's active nav). Pills INSIDE
   panels stay clay, like every other row on the page.

   Markup note: .ptabs and the .ptab-panel siblings have no shared wrapper, so
   the tray is drawn as two halves (rounded top on .ptabs, rounded bottom on
   the visible panel) and the panel pulls itself flush with a -14px margin
   (cancelling .section's 14px gap). If you'd rather not rely on that, wrap
   them in <div class="ptab-tray"> — rules for that path are included below —
   and drop the margin-top hack automatically (the .ptab-tray rules override). */
.ptabs {
  align-self: stretch;
  background: var(--bg);
  border: 1.5px solid rgba(59, 50, 32, 0.14);
  border-bottom: 1.5px solid rgba(59, 50, 32, 0.13);
  border-radius: 18px 18px 0 0;
  display: flex;
  gap: 3px;
  max-width: 100%;
  overflow-x: auto;
  padding: 10px 12px;
}
.ptab {
  background: none;
  border: 0;
  border-radius: 999px;
  color: var(--text-2);
  cursor: pointer;
  flex-shrink: 0;
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 700;
  line-height: 1;
  padding: 8px 15px;
  white-space: nowrap;
}
.ptab:hover { background: var(--well); color: var(--text); }
.ptab.on {
  background: var(--text);
  box-shadow: 0 2px 0 rgba(30, 24, 12, 0.5);
  color: #f6edda;
}
.ptab:focus-visible { outline: 2px solid var(--ember-press); outline-offset: 2px; }
.ptab .ptab-count { color: var(--text-3); font-family: var(--mono); font-size: 0.71875rem; font-weight: 400; margin-left: 7px; }
.ptab.on .ptab-count { color: #cbbfa5; }
.ptab .ptab-dot { background: var(--ember); border-radius: 999px; box-shadow: 0 0 0 3px var(--ember-tint); display: inline-block; height: 6px; margin-left: 7px; vertical-align: 1px; width: 6px; }
.ptab-panel {
  border: 1.5px solid rgba(59, 50, 32, 0.14);
  border-radius: 0 0 18px 18px;
  border-top: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: -14px; /* cancels .section's gap so the panel sits flush under .ptabs */
  padding: 16px 18px 18px;
}
.ptab-panel[hidden] { display: none; }
.ptab-hint { margin: 0; max-width: 62ch; }
/* Optional wrapper path (preferred if you can touch markup): */
.ptab-tray { display: flex; flex-direction: column; }
.ptab-tray .ptab-panel { margin-top: 0; }
/* Inside the tray, list rows are clay wells (no under-shadow needed) */
.ptab-panel .skill-row, .ptab-panel .conn-tool { background: var(--well); box-shadow: none; }
.ptab-panel .skill-form { background: var(--well); }
.ptab-panel .skill-form .conn-tool, .ptab-panel .skill-form .import-row { background: var(--bg); box-shadow: 0 1.5px 0 rgba(59, 50, 32, 0.08); }

/* ---- Agent-first detail and owner memory -------------------------------- */
.agent-profile-page { display: flex; flex-direction: column; gap: 15px; min-width: 0; }
.admin-surface .agent-profile-page { font-family: "Avenir Next", Avenir, ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.agent-profile-header { align-items: center; display: flex; gap: 24px; justify-content: space-between; }
.agent-profile-heading { display: flex; flex: 1; flex-direction: column; gap: 7px; min-width: 0; }
.agent-profile-heading .page-title { font-size: clamp(2rem, 3.4vw, 2.75rem); letter-spacing: -.04em; line-height: 1.06; }
.agent-profile-header-actions { align-items: center; display: flex; flex: none; gap: 10px; }
.agent-status-chip { align-items: center; border-radius: 999px; display: inline-flex; font-size: .75rem; font-weight: 750; gap: 7px; padding: 8px 12px; }
.agent-status-chip > span { background: currentColor; border-radius: 50%; height: 7px; width: 7px; }
.agent-status-chip.enabled { background: var(--ok-tint); color: var(--ok); }
.agent-status-chip.disabled { background: var(--well); color: var(--text-3); }
.agent-description-row { align-items: center; display: flex; gap: 8px; margin: -5px 0 15px; max-width: 78ch; min-width: 0; }
.agent-profile-intro { color: var(--text-3); flex: 0 1 auto; font-size: .9375rem; margin: 0; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.agent-description-row.is-empty .agent-profile-intro { color: var(--text-3); }
.agent-description-input { max-width: 78ch; }
.agent-presence-card { align-items: stretch; gap: 18px; grid-template-columns: minmax(0, 1fr); }
.agent-slack-card-icon { align-items: center; background: transparent; border: 1px solid var(--admin-visual-line); border-radius: 10px; display: inline-flex; justify-content: center; }
.agent-slack-card-mark { height: 19px; width: 19px; }
.agent-presence-grid { align-items: start; display: grid; gap: 24px; grid-template-columns: minmax(250px, 1fr) minmax(240px, 1fr); }
.agent-avatar-control { align-items: center; display: flex; gap: 14px; min-height: 64px; }
.agent-avatar-image, .agent-avatar-fallback { border-radius: 16px; flex: none; height: 64px; width: 64px; }
.agent-avatar-image { object-fit: cover; }
.agent-avatar-fallback { align-items: center; background: var(--well); display: flex; font-size: 30px; justify-content: center; }
.agent-avatar-actions { min-width: 0; }
.agent-avatar-actions .hint { margin-top: 6px; }
.agent-handle-control { position: relative; }
.agent-handle-prefix { color: var(--text-3); font-family: var(--mono); left: 14px; pointer-events: none; position: absolute; top: 50%; transform: translateY(-50%); z-index: 1; }
.agent-handle-control .input { min-width: 0; padding-left: 30px; }
.agent-overflow { position: relative; }
.agent-overflow-trigger { align-items: center; background: var(--bg); border: 1px solid var(--admin-visual-line); border-radius: 10px; color: var(--text); cursor: pointer; display: inline-flex; height: 38px; justify-content: center; width: 42px; }
.agent-overflow-trigger:focus-visible, .agent-overflow-menu button:focus-visible { outline: 2px solid var(--ember-press); outline-offset: 2px; }
.agent-overflow-menu { background: var(--bg); border: 1px solid var(--admin-visual-line); border-radius: 12px; box-shadow: var(--pop-shadow); display: flex; flex-direction: column; gap: 3px; min-width: 240px; padding: 6px; position: absolute; right: 0; top: calc(100% + 6px); z-index: 25; }
.agent-overflow-menu button { background: transparent; border: 0; border-radius: 8px; color: var(--text); cursor: pointer; font: inherit; font-size: .8125rem; font-weight: 700; padding: 9px 10px; text-align: left; }
.agent-overflow-menu button:hover { background: var(--well); }
.agent-overflow-menu button.danger { color: var(--danger); }
.agent-overflow-menu button:disabled { cursor: not-allowed; opacity: .48; }
.agent-overflow-guidance { border-top: 1px solid var(--line); color: var(--text-3); font-size: .6875rem; line-height: 1.45; margin: 3px 4px 0; padding: 8px 6px 3px; }
.agent-tabs-card { border: 1px solid #dfd2b9; border-radius: 16px; background: var(--bg); overflow: hidden; }
.agent-tabs-card .ptabs { background: #f5ecd9; border: 0; border-bottom: 1px solid #dfd2b9; border-radius: 0; padding: 10px; }
.agent-tabs-card .ptab-panel { background: var(--bg); border: 0; border-radius: 0; min-height: 315px; padding: 28px; }
.agent-tab-head { align-items: flex-start; display: flex; gap: 12px; margin-bottom: 8px; }
.agent-tab-icon, .agent-card-icon { flex: none; height: 34px; width: 34px; }
.semantic-icon { align-items: center; border: 1px solid transparent; border-radius: 10px; display: inline-flex; flex: none; justify-content: center; }
.agent-tab-icon .ic, .agent-card-icon .ic { display: block; height: 18px; width: 18px; }
.semantic-icon.tone-instructions { background: var(--semantic-instructions-bg); border-color: var(--semantic-instructions-line); color: var(--semantic-instructions-fg); }
.semantic-icon.tone-skill, .semantic-icon.tone-capability { background: var(--semantic-skill-bg); border-color: var(--semantic-skill-line); color: var(--semantic-skill-fg); }
.semantic-icon.tone-connector { background: var(--semantic-connector-bg); border-color: var(--semantic-connector-line); color: var(--semantic-connector-fg); }
.semantic-icon.tone-repository { background: var(--semantic-repository-bg); border-color: var(--semantic-repository-line); color: var(--semantic-repository-fg); }
.semantic-icon.tone-model { background: var(--semantic-model-bg); border-color: var(--semantic-model-line); color: var(--semantic-model-fg); }
.semantic-icon.tone-memory { background: var(--semantic-memory-bg); border-color: var(--semantic-memory-line); color: var(--semantic-memory-fg); }
.semantic-icon.tone-channel { background: var(--semantic-channel-bg); border-color: var(--semantic-channel-line); color: var(--semantic-channel-fg); }
.semantic-icon.tone-neutral { background: var(--semantic-neutral-bg); border-color: var(--semantic-neutral-line); color: var(--semantic-neutral-fg); }
.semantic-icon.tone-slack { background: var(--semantic-slack-bg); border-color: var(--semantic-slack-line); }
.agent-tab-head h2, .agent-card-heading h2 { color: var(--text); font-size: 1.05rem; letter-spacing: -.015em; margin: 0 0 4px; }
.agent-tab-head p, .agent-card-heading p { color: var(--text-3); font-size: .75rem; line-height: 1.45; margin: 0; }
.agent-instructions-editor .textarea { background: #fdf9f0; font-size: .875rem; line-height: 1.65; min-height: 170px; }
.agent-instructions-guidance { align-items: flex-start; background: var(--well); border-radius: 10px; color: var(--text-3); display: flex; font-size: .75rem; gap: 8px; line-height: 1.45; margin: 12px 0 0; padding: 10px 12px; }
.agent-detail-card { align-items: center; background: var(--bg); border: 1px solid var(--admin-visual-line); border-radius: 14px; display: grid; gap: 22px; min-height: 105px; padding: 18px 20px; }
.agent-placement-card { align-items: stretch; gap: 16px; grid-template-columns: minmax(0, 1fr); }
.agent-model-card { grid-template-columns: 245px minmax(0, 1fr); }
.agent-card-heading { align-items: flex-start; display: flex; gap: 12px; }
.agent-placement-head { align-items: center; display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr) auto; }
.agent-placement-head > .btn { white-space: nowrap; }
.agent-placement-body { min-width: 0; }
.agent-placement-label { align-items: center; display: flex; justify-content: space-between; margin-bottom: 8px; }
.agent-placement-label h3 { color: var(--text-3); font-size: .625rem; letter-spacing: .08em; margin: 0; text-transform: uppercase; }
.agent-placement-count { color: var(--text-3); font-size: .6875rem; }
.agent-channel-empty { align-items: center; background: #fbf1da; border: 1px solid #ecd7a7; border-radius: 12px; display: grid; gap: 16px; grid-template-columns: auto minmax(0, 1fr) auto; padding: 16px; }
.agent-channel-empty-icon { align-items: center; background: var(--bg); border: 1px solid #e6d2a5; border-radius: 10px; color: #9d6e19; display: inline-flex; flex: none; font-size: 1.15rem; font-weight: 800; height: 40px; justify-content: center; width: 40px; }
.agent-channel-empty strong { color: var(--text); display: block; font-size: .875rem; }
.agent-channel-empty p { color: var(--text-2); font-size: .75rem; line-height: 1.5; margin: 3px 0 0; }
.agent-channel-empty > .btn { white-space: nowrap; }
.agent-channel-empty-readonly { background: var(--well); border-color: var(--line); grid-template-columns: minmax(0, 1fr); }
.agent-model-card .agent-model-row { background: transparent; padding: 0; }
.agent-advanced-card { margin-top: 7px; }
.agent-advanced-card > summary { align-items: center; display: flex; font-weight: 750; gap: 9px; padding: 16px 18px; }
.agent-advanced-card > summary::before { display: none; }
.agent-advanced-card > summary::after { color: var(--text-3); content: "›"; font-size: 1.15rem; margin-left: auto; }
.agent-advanced-card[open] > summary::after { transform: rotate(90deg); }
.agent-kicker { color: var(--ember-deep); font-family: var(--mono); font-size: .6875rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.agent-model-row, .agent-advanced-row, .channel-agent-hero, .channel-try-card {
  align-items: center;
  background: var(--well);
  border-radius: 14px;
  display: flex;
  gap: 14px;
  justify-content: space-between;
  padding: 14px 16px;
}
.agent-model-row > div, .agent-advanced-row > span, .channel-agent-hero > div { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.agent-model-row .field { flex: 1; min-width: 0; }
.agent-advanced-row + .agent-advanced-row { border-top: 1px solid var(--line); border-radius: 0; }
.agent-advanced-row .btn { flex-shrink: 0; }
.agent-advanced-select { flex: 0 1 320px !important; max-width: 320px; min-width: 250px !important; }
.where-list { border: 1px solid var(--line); border-radius: 11px; display: grid; overflow: hidden; }
.where-entry { align-items: stretch; background: var(--well); display: grid; grid-template-columns: minmax(0, 1fr) auto; min-width: 0; }
.where-entry + .where-entry { border-top: 1px solid var(--line); }
.where-channel-row { align-items: center; background: transparent; border: 0; color: var(--text); cursor: pointer; display: grid; font: inherit; font-size: .75rem; font-weight: 700; gap: 9px; grid-template-columns: auto minmax(0, 1fr) auto; min-height: 42px; min-width: 0; padding: 8px 11px; text-align: left; width: 100%; }
.where-channel-row:hover, .where-channel-row:focus-visible { background: #f4ead6; }
.where-channel-row:focus-visible, .where-remove:focus-visible { outline: 2px solid var(--ember-press); outline-offset: -2px; }
.where-channel-hash { color: var(--semantic-channel-fg); font-size: .9375rem; }
.where-channel-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.where-channel-open { color: var(--text-3); }
.where-remove { align-items: center; background: transparent; border: 0; border-left: 1px solid var(--line); border-radius: 0; color: var(--text-3); cursor: pointer; display: inline-flex; justify-content: center; min-height: 42px; padding: 8px 11px; }
.where-remove:hover { background: #eee3cd; color: var(--text); }
.capability-preview-list { display: flex; flex-wrap: wrap; gap: 8px; }
.capability-pill {
  align-items: center;
  background: var(--well);
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text);
  display: inline-flex;
  font: inherit;
  font-size: .75rem;
  font-weight: 700;
  gap: 6px;
  min-height: 34px;
  padding: 7px 11px;
}
button.capability-pill { cursor: pointer; }
.owner-memory-intro { align-items: center; display: flex; flex-wrap: wrap; gap: 8px 14px; justify-content: space-between; }
.owner-memory-intro p { margin: 0; }
.owner-memory-editor { background: #fffdf8; border: 1px solid #e7dcc7; border-radius: 12px; display: flex; flex-direction: column; gap: 13px; min-width: 0; padding: 22px 24px 24px; }
.agent-tabs-card [id="ptab-panel-memory"] .owner-memory-editor { border-bottom: 0; border-left: 0; border-radius: 0; border-right: 0; margin: 8px -28px -28px; }
.owner-memory-editor-head { align-items: flex-start; border-bottom: 1px solid #eee4d1; display: flex; gap: 18px; justify-content: space-between; padding-bottom: 16px; }
.owner-memory-form { display: grid; gap: 13px; }
.owner-memory-editor textarea { line-height: 1.65; min-height: 300px; resize: vertical; }
.owner-memory-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; padding-top: 1px; }
.owner-memory-status { color: var(--text-3); font-size: .75rem; min-height: 18px; }
.owner-memory-status.error { color: var(--danger); }
.channel-detail-page { display: flex; flex-direction: column; gap: 24px; }
.channel-detail-header { align-items: flex-start; display: flex; gap: 24px; justify-content: space-between; }
.channel-detail-head-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.channel-detail-head-copy .link-btn { align-self: flex-start; margin-bottom: 3px; }
.channel-detail-controls { align-items: center; display: flex; flex: none; gap: 12px; padding-top: 25px; }
.channel-detail-status { align-items: center; display: inline-flex; font-size: .6875rem; font-weight: 800; gap: 7px; white-space: nowrap; }
.channel-detail-status::before { background: currentColor; border-radius: 50%; content: ""; height: 7px; width: 7px; }
.channel-detail-status.ready { color: var(--ok); }
.channel-detail-status.needs-attention, .channel-detail-status.unassigned { color: #9d6e19; }
.channel-detail-status.resolving, .channel-detail-status.disabled { color: var(--text-3); }
.channel-enabled-control { align-items: center; display: flex; gap: 9px; }
.channel-enabled-label { color: var(--text-2); font-size: .6875rem; font-weight: 700; }
.channel-header-error { background: #fbf1da; border-radius: 10px; color: #835e1e; font-size: .75rem; margin-top: 7px; padding: 9px 11px; }
.channel-agent-section, .channel-capabilities-section, .channel-try-section { margin-top: 0; }
.channel-agent-hero { align-items: center; background: var(--ember-tint); display: grid; grid-template-columns: auto minmax(0, 1fr) auto; padding: 18px; }
.channel-agent-hero > .agent-roster-icon { height: 44px; width: 44px; }
.channel-agent-hero > .agent-roster-icon .ic { height: 21px; width: 21px; }
.channel-agent-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.channel-agent-hero h2 { color: var(--text); font-family: var(--display); font-size: 1.15rem; margin: 0; }
.channel-agent-intro { color: var(--text-2); display: -webkit-box; font-size: .75rem; line-height: 1.45; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.channel-agent-meta { color: var(--text-3); font-size: .65625rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.channel-agent-actions { align-items: center; display: flex; gap: 8px; }
.channel-capability-groups { display: grid; gap: 12px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.channel-capability-group { background: var(--well); border-radius: 14px; min-width: 0; padding: 13px; }
.channel-capability-group-head { align-items: center; display: flex; gap: 8px; margin-bottom: 10px; }
.channel-capability-icon { border-radius: 8px; height: 28px; width: 28px; }
.channel-capability-group-head strong { color: var(--text); font-size: .75rem; }
.channel-section-heading { align-items: flex-start; display: flex; gap: 11px; justify-content: flex-start; }
.channel-section-icon { height: 34px; width: 34px; }
.channel-section-heading > div { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.channel-section-heading .section-title, .channel-section-heading .hint { margin: 0; }
.channel-section-slack-mark { height: 18px; width: 18px; }
.channel-try-card { align-items: center; display: grid; gap: 20px; grid-template-columns: minmax(0, 1fr) auto; }
.channel-try-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.channel-try-prompt { color: var(--text); font-size: .8125rem; font-weight: 700; line-height: 1.55; }
.channel-try-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.channel-try-status { color: var(--text-3); display: block; font-size: .6875rem; min-height: 17px; }
.channel-try-status.error { color: var(--danger); }
.channel-advanced-card { background: var(--well); border: 1px solid var(--line); border-radius: 16px; padding: 0 18px; }
.channel-advanced-card > summary { color: var(--text); font-size: .8125rem; font-weight: 800; min-height: 54px; }
.channel-advanced-card[open] > summary { border-bottom: 1px solid var(--line); }
.channel-advanced-content { display: flex; flex-direction: column; gap: 22px; padding: 20px 0 2px; }
.channel-advanced-section + .channel-advanced-section { border-top: 1px solid var(--line); padding-top: 20px; }
.channel-resolution-card { background: var(--bg); border: 1px solid var(--line); border-radius: 13px; padding: 14px; }
.channel-resolution-card .well { background: transparent; padding: 0; }
.channels-index-head { align-items: flex-start; display: flex; gap: 20px; justify-content: space-between; }
.channels-index-head-copy { display: flex; flex-direction: column; gap: 5px; max-width: 620px; }
.channels-index-head .btn-primary { flex: none; margin-top: 2px; }
.channels-overview-card {
  align-items: stretch;
  background: var(--well);
  border: 1px solid var(--line);
  border-radius: 16px;
  display: grid;
  gap: 18px;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 330px);
  padding: 17px 18px;
}
.channels-overview-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.channels-summary-stat { border-right: 1px solid var(--line); display: flex; flex-direction: column-reverse; gap: 3px; justify-content: center; min-width: 0; padding: 0 18px; }
.channels-summary-stat:first-child { padding-left: 0; }
.channels-summary-stat:last-child { border-right: 0; }
.channels-summary-stat dt { color: var(--text-3); font-size: .6875rem; font-weight: 700; }
.channels-summary-stat dd { color: var(--text); font-size: 1.1rem; font-weight: 800; line-height: 1.25; }
.channels-slack-state { align-items: center; display: inline-flex; font-size: .75rem; font-weight: 750; gap: 7px; white-space: nowrap; }
.channels-slack-state::before, .channel-status::before { background: currentColor; border-radius: 50%; content: ""; flex: none; height: 7px; width: 7px; }
.channels-slack-state.connected, .channel-status.ready { color: var(--ok); }
.channels-slack-state.degraded, .channel-status.needs-attention, .channel-status.agent-disabled, .channel-status.unassigned { color: #9d6e19; }
.channels-slack-state.disconnected, .channel-status.saved, .channel-status.discovered { color: var(--text-3); }
.channels-index-search { align-self: center; display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.channels-index-search .field-label { font-size: .6875rem; }
.channels-index-table { background: var(--bg); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
.channels-index-table-head, .channels-index-row { display: grid; grid-template-columns: minmax(200px, 1fr) minmax(280px, 1.6fr) 130px; }
.channels-index-table-head { background: var(--well); border-bottom: 1px solid var(--line); color: var(--text-3); font-size: .625rem; font-weight: 800; letter-spacing: .07em; padding: 10px 16px; text-transform: uppercase; }
.channels-index-list { display: flex; flex-direction: column; }
.channels-index-row { align-items: center; border-bottom: 1px solid var(--line); min-height: 72px; padding: 10px 16px; }
.channels-index-row:last-child { border-bottom: 0; }
.channels-index-row:hover { background: #fffcf3; }
.channels-index-cell { align-items: center; display: flex; min-width: 0; padding-right: 14px; }
.channels-index-cell::before { content: attr(data-label); display: none; }
.channels-index-channel, .channels-index-agent { align-items: center; background: transparent; border: 0; color: inherit; cursor: pointer; display: flex; font: inherit; gap: 10px; min-width: 0; padding: 3px; text-align: left; width: 100%; }
.channels-index-channel:hover .channels-index-name, .channels-index-agent:hover .channels-index-agent-name { color: var(--ember-press); }
.channels-index-channel:focus-visible, .channels-index-agent:focus-visible { border-radius: 9px; outline: 2px solid var(--ember-press); outline-offset: 2px; }
.channel-hash { align-items: center; background: var(--semantic-channel-bg); border-radius: 10px; color: var(--semantic-channel-fg); display: inline-flex; flex: none; font-family: var(--mono); font-size: 1rem; font-weight: 700; height: 34px; justify-content: center; width: 34px; }
.channels-index-agent .agent-roster-icon { height: 34px; width: 34px; }
.channels-index-copy, .channels-index-agent-copy, .channels-index-behavior { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.channels-index-name, .channels-index-agent-name, .channels-index-behavior strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.channels-index-name, .channels-index-agent-name { color: var(--text); font-size: .8125rem; font-weight: 750; }
.channels-index-copy small, .channels-index-agent-copy small, .channels-index-behavior small { color: var(--text-3); font-size: .65625rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.channels-index-behavior strong { color: var(--text-2); font-size: .75rem; font-weight: 650; }
.channels-index-agent-empty { color: var(--text-3); display: flex; flex-direction: column; font-size: .75rem; gap: 2px; min-width: 0; }
.channels-index-agent-empty strong { color: var(--text-2); }
.channels-index-agents { display: flex; flex-wrap: wrap; gap: 7px; min-width: 0; }
.channels-index-agents .channels-index-agent { background: var(--well); border-radius: 10px; padding: 6px 8px; width: auto; }
.channel-status { align-items: center; display: inline-flex; font-size: .6875rem; font-weight: 750; gap: 7px; white-space: nowrap; }
.channels-index-empty { padding: 36px 20px; text-align: center; }
.channels-index-empty .field-label { margin-bottom: 4px; }
.channels-index-fallback { margin: 0; }
.channels-connection-card { border-top: 1px solid var(--line); margin-top: 24px; padding-top: 24px; }
@container (max-width: 750px) {
  .agent-profile-header { align-items: flex-start; flex-direction: column; }
  .agent-profile-header-actions { width: 100%; }
  .agent-overflow { margin-left: auto; }
  .agent-presence-grid { grid-template-columns: 1fr; }
  .agent-detail-card, .agent-placement-card, .agent-model-card { align-items: stretch; grid-template-columns: 1fr; }
  .agent-placement-head, .agent-channel-empty { align-items: start; grid-template-columns: 1fr; }
  .agent-placement-head > .btn, .agent-channel-empty > .btn { justify-self: start; }
  .agent-channel-empty-icon { display: none; }
  .owner-memory-editor { padding: 20px; }
  .agent-tabs-card [id="ptab-panel-memory"] .owner-memory-editor { margin: 8px -20px -20px; }
  .channel-capability-groups { grid-template-columns: 1fr; }
  .owner-memory-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .owner-memory-actions .spacer { display: none; }
  .owner-memory-actions .btn { width: 100%; }
  .agent-model-row { align-items: stretch; flex-direction: column; }
  .agent-advanced-policy-row { align-items: stretch; flex-direction: column; }
  .agent-advanced-policy-row .agent-advanced-select { flex-basis: auto !important; max-width: none; min-width: 0 !important; width: 100%; }
  .channel-detail-header { flex-direction: column; gap: 14px; }
  .channel-detail-controls { justify-content: space-between; padding-top: 0; width: 100%; }
  .channel-agent-hero { align-items: flex-start; grid-template-columns: auto minmax(0, 1fr); }
  .channel-agent-actions { grid-column: 1 / -1; justify-content: flex-end; width: 100%; }
  .channel-try-card { align-items: stretch; grid-template-columns: 1fr; }
  .channel-try-actions { justify-content: flex-start; }
  .channels-index-head { align-items: stretch; flex-direction: column; }
  .channels-index-head .btn-primary { align-self: flex-start; }
  .channels-overview-card { grid-template-columns: 1fr; }
  .channels-overview-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .channels-summary-stat:nth-child(2) { border-right: 0; }
  .channels-summary-stat:last-child { border-right: 0; border-top: 1px solid var(--line); grid-column: 1 / -1; margin-top: 12px; padding: 12px 0 0; }
  .channels-index-table-head { display: none; }
  .channels-index-row { align-items: stretch; gap: 13px; grid-template-columns: 1fr; padding: 15px; }
  .channels-index-row + .channels-index-row { border-top: 7px solid var(--well); }
  .channels-index-cell { align-items: flex-start; display: grid; gap: 8px; grid-template-columns: 76px minmax(0, 1fr); padding-right: 0; }
  .channels-index-cell::before { color: var(--text-3); display: block; font-size: .625rem; font-weight: 800; letter-spacing: .06em; padding-top: 7px; text-transform: uppercase; }
  .channels-index-channel, .channels-index-agent { padding: 0; }
}

@media (max-width: 740px) {
  .agent-profile-page .ptabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); overflow: visible; }
  .agent-profile-page .ptab { min-width: 0; padding-inline: 8px; text-align: center; }
  .agent-profile-page .agent-tabs-card .ptab-panel { padding: 20px; }
  .agent-profile-page .save-bar-inner { align-items: stretch; }
}
@media (max-width: 480px) {
  .agent-profile-page .ptabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

/* ---- profile repositories ---------------------------------------------- */
.repo-panel-head, .repo-group-actions, .repo-picker-foot, .repo-footer, .repo-account-choice {
  align-items: center;
  display: flex;
  gap: 9px;
}
.repo-panel-head { justify-content: space-between; }
.repo-groups { display: flex; flex-direction: column; gap: 10px; }
.repo-group {
  background: var(--well);
  border-radius: 14px;
  padding: 0 14px;
}
.repo-group > summary {
  align-items: center;
  color: var(--text);
  cursor: pointer;
  display: flex;
  gap: 9px;
  list-style: none;
  min-height: 50px;
}
.repo-group > summary::-webkit-details-marker { display: none; }
.repo-group > summary::after {
  color: var(--text-3);
  content: "›";
  font-size: 1.15rem;
  margin-left: auto;
  transform: rotate(90deg);
}
.repo-group:not([open]) > summary::after { transform: rotate(0deg); }
.repo-avatar {
  align-items: center;
  background: var(--text);
  border-radius: 8px;
  color: #f6edda;
  display: inline-flex;
  flex-shrink: 0;
  font-family: var(--display);
  font-size: 0.75rem;
  font-weight: 700;
  height: 26px;
  justify-content: center;
  text-transform: uppercase;
  width: 26px;
}
.repo-group-name { font-size: 0.8125rem; font-weight: 700; }
.repo-group-count { color: var(--text-3); font-size: 0.71875rem; }
.repo-group-body { border-top: 1.5px solid var(--bg); display: flex; flex-direction: column; gap: 10px; padding: 12px 0 14px; }
.repo-group-actions { flex-wrap: wrap; }
.repo-all-label { align-items: center; display: flex; gap: 9px; margin-right: auto; }
.repo-rows { display: flex; flex-direction: column; gap: 6px; }
.repo-row {
  align-items: center;
  background: var(--bg);
  border-radius: 11px;
  display: flex;
  gap: 9px;
  min-height: 40px;
  padding: 7px 9px 7px 11px;
}
.repo-row .ic { color: var(--text-3); flex-shrink: 0; }
.repo-name { color: var(--text); font-size: 0.75rem; min-width: 0; overflow-wrap: anywhere; }
.repo-account-choices { background: var(--well); border-radius: 14px; display: flex; flex-direction: column; gap: 7px; padding: 10px; }
.repo-account-choice { background: var(--bg); border-radius: 11px; justify-content: flex-start; width: 100%; }
.repo-picker-host { position: relative; }
.repo-picker {
  background: var(--bg);
  border: 1.5px solid rgba(59, 50, 32, 0.14);
  border-radius: 16px;
  box-shadow: 0 18px 42px rgba(59, 50, 32, 0.2);
  display: flex;
  flex-direction: column;
  gap: 11px;
  margin-left: auto;
  max-width: 520px;
  padding: 14px;
  width: 100%;
}
.repo-picker-title { color: var(--text); font-size: 0.875rem; font-weight: 700; }
.repo-picker-list { display: flex; flex-direction: column; gap: 5px; max-height: 280px; overflow-y: auto; }
.repo-picker-row {
  align-items: center;
  background: var(--well);
  border-radius: 10px;
  cursor: pointer;
  display: flex;
  gap: 9px;
  min-height: 39px;
  padding: 7px 10px;
}
.repo-picker-row:hover { background: #f3ead5; }
.repo-picker-row input { accent-color: var(--ember-press); flex-shrink: 0; }
.repo-picker-row .repo-name { flex: 1; }
.repo-picker-foot { border-top: 1.5px solid var(--well); padding-top: 11px; }
.repo-footer { border-top: 1.5px solid rgba(59, 50, 32, 0.13); flex-wrap: wrap; margin-top: 2px; padding-top: 12px; }
.repo-footer .hint { margin-right: auto; }
@media (max-width: 720px) {
  .repo-panel-head, .repo-picker-foot, .repo-footer { align-items: stretch; flex-direction: column; }
  .repo-panel-head .btn, .repo-picker-foot .btn, .repo-footer .btn { width: 100%; }
  .repo-all-label { margin-right: 0; }
  .repo-group-actions { align-items: stretch; flex-direction: column; }
}

/* ---- profile connections (remote MCP servers) ---- */
.conn-host { color: var(--text-3); font-family: var(--mono); font-size: 0.71875rem; overflow-wrap: anywhere; }
.conn-meta { align-items: center; display: flex; flex-wrap: wrap; gap: 6px 10px; }
.conn-pill {
  align-items: center;
  border-radius: 999px;
  display: inline-flex;
  flex-shrink: 0;
  font-size: 0.71875rem;
  font-weight: 700;
  gap: 5px;
  padding: 3px 10px;
  white-space: nowrap;
}
.conn-pill-on { background: var(--ok-tint); color: var(--ok); }
.conn-pill-off { background: rgba(59, 50, 32, 0.08); color: #8a7a5c; }
.conn-pill-warn { background: var(--danger-well); color: var(--danger); }
#conn-gallery-search-input { margin-bottom: 8px; }
.gallery-head { align-items: center; color: var(--text-3); display: flex; font-size: 0.75rem; font-weight: 600; gap: 8px; letter-spacing: 0.04em; margin: 12px 2px 4px; text-transform: uppercase; }
.gallery-head-count { margin-left: auto; }
.gallery-list { border-radius: var(--radius); box-shadow: inset 0 0 0 1px var(--line); overflow: hidden; }
.gallery-row { align-items: center; display: flex; gap: 12px; padding: 9px 12px; }
.gallery-row + .gallery-row { box-shadow: inset 0 1px 0 var(--line); }
.gallery-row:hover { background: var(--well); }
.gallery-row-copy { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.gallery-row-name { font-weight: 600; }
.gallery-row-desc { color: var(--text-3); font-size: 0.75rem; line-height: 1.35; overflow-wrap: anywhere; }
@media (min-width: 721px) {
  .gallery-row-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
.gallery-lane { background: rgba(59, 50, 32, 0.08); border-radius: 999px; color: var(--text-3); font-size: 0.625rem; font-weight: 700; letter-spacing: 0.05em; padding: 3px 7px; white-space: nowrap; }
.gallery-row-spacer { margin-left: auto; }
.gallery-empty { color: var(--text-3); font-size: 0.8125rem; padding: 14px 4px; }
.conn-logo { align-items: center; border-radius: 8px; display: inline-flex; flex: none; height: 30px; justify-content: center; width: 30px; }
.conn-logo-mono { color: #fff; font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.02em; }
.conn-logo-img { background: #fff; box-shadow: inset 0 0 0 1px var(--line); }
.conn-logo-img svg { max-width: 20px; max-height: 20px; height: auto; width: auto; }
.conn-logo-raster { overflow: hidden; }
.conn-logo-raster img { display: block; width: 100%; height: 100%; object-fit: cover; }
.conn-title, .conn-recommended-head { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; }
.google-access-label { align-items: center; display: flex; gap: 8px; }
.google-access-label .conn-logo { border-radius: 6px; height: 24px; width: 24px; }
.google-service-summary { align-items: center; display: flex; flex-wrap: wrap; gap: 6px; }
.google-service-chip { align-items: center; background: rgba(255,255,255,0.52); border: 1px solid var(--border); border-radius: 999px; color: var(--text-2); display: inline-flex; font-size: 0.71875rem; font-weight: 650; gap: 6px; padding: 4px 9px 4px 5px; }
.google-service-chip .conn-logo { border-radius: 5px; height: 20px; width: 20px; }
.google-service-level { color: var(--text-3); font-weight: 600; }
@media (max-width: 720px) {
  .gallery-row-described { align-items: center; display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; row-gap: 6px; }
  .gallery-row-described > .conn-logo { grid-column: 1; grid-row: 1 / span 2; }
  .gallery-row-described > .gallery-row-copy { grid-column: 2 / 4; grid-row: 1; }
  .gallery-row-described > .gallery-lane { grid-column: 2; grid-row: 2; justify-self: start; }
  .gallery-row-described > .gallery-row-spacer { display: none; }
  .gallery-row-described > .btn { grid-column: 3; grid-row: 2; justify-self: end; }
}
.oauth-account { align-items: center; background: rgba(255,255,255,0.48); border: 1px solid var(--border); border-radius: 14px; display: flex; gap: 12px; justify-content: space-between; padding: 14px 16px; }
.oauth-account-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.oauth-account-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 12px; justify-content: flex-end; }
.oauth-account-status { color: var(--ok); font-size: 0.8125rem; font-weight: 800; }
.oauth-account-name { color: var(--text); font-size: 0.9375rem; font-weight: 750; overflow-wrap: anywhere; }
.oauth-account-detail { color: var(--text-3); font-size: 0.78125rem; overflow-wrap: anywhere; }
.oauth-signin { align-self: flex-start; }
.oauth-signin .conn-logo { border-radius: 5px; height: 18px; width: 18px; }
.oauth-return { border: 1px solid var(--border); border-left-width: 4px; border-radius: 12px; font-size: 0.875rem; font-weight: 650; line-height: 1.45; margin-bottom: 18px; padding: 12px 14px; }
.oauth-return.ok { background: rgba(45, 125, 78, 0.08); border-left-color: var(--ok); color: var(--text); }
.oauth-return.error { background: rgba(173, 54, 50, 0.08); border-left-color: var(--danger); color: var(--danger); }
.conn-view-seg { margin-bottom: 10px; }
.conn-url-chip { background: var(--well); border-radius: 999px; color: var(--text-3); font-size: 0.6875rem; padding: 4px 8px; }
.hint-link { color: var(--ember-deep); font-size: 0.8125rem; font-weight: 700; text-decoration: none; }
.hint-link:hover { color: var(--ember-press); text-decoration: underline; }
.seg { background: var(--bg); border-radius: 12px; box-shadow: inset 0 0 0 1.5px rgba(59, 50, 32, 0.12); display: inline-flex; overflow: hidden; }
.seg button {
  appearance: none;
  background: transparent;
  border: 0;
  color: var(--text-2);
  cursor: pointer;
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  padding: 8px 14px;
}
.seg button + button { box-shadow: inset 1.5px 0 0 rgba(59, 50, 32, 0.12); }
.seg button.on { background: var(--ember); box-shadow: inset 0 1.5px 0 rgba(255, 240, 205, 0.6); color: #3a2a08; font-weight: 700; }
.seg button:disabled { color: var(--text-3); cursor: not-allowed; opacity: 0.55; }
.conn-tools { display: flex; flex-direction: column; gap: 6px; }
.conn-tool {
  align-items: flex-start;
  background: var(--bg);
  border-radius: 13px;
  box-shadow: 0 1.5px 0 rgba(59, 50, 32, 0.08);
  cursor: pointer;
  display: flex;
  gap: 11px;
  padding: 10px 13px;
}
.conn-tool .tool-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.conn-tool .tool-name { color: var(--text); font-family: var(--mono); font-size: 0.75rem; font-weight: 600; overflow-wrap: anywhere; }
.conn-tool .tool-desc { color: var(--text-3); font-size: 0.75rem; overflow-wrap: anywhere; }
.conn-header-row { display: flex; flex-wrap: wrap; gap: 8px; }
.conn-header-row .input { flex: 1; min-width: 140px; }
.conn-security { color: var(--text-3); font-size: 0.78125rem; text-wrap: pretty; }
.conn-template-hint { color: var(--danger); font-weight: 700; }
.connection-state-stack { display: grid; gap: 22px; }
.connection-state-stack .connection-state-section { display: grid; gap: 8px; }
.connection-state-stack .connection-section-head {
  align-items: center;
  color: var(--text-3);
  display: flex;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 0 3px;
  text-transform: uppercase;
}
.connection-state-stack .connection-section-head h3 { font: inherit; margin: 0; }
.connection-state-stack .connection-section-count { margin-left: auto; }
.connection-state-stack .connection-account-list {
  background: var(--bg);
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  overflow: visible;
}
.connection-state-stack .connection-account-row {
  align-items: center;
  display: grid;
  gap: 12px;
  grid-template-columns: 42px minmax(180px, 1fr) minmax(88px, auto) auto 76px 28px;
  min-height: 64px;
  padding: 7px 14px;
  position: relative;
}
.connection-state-stack .connection-account-row + .connection-account-row { border-top: 1px solid var(--line); }
.connection-state-stack .connection-account-row:hover { background: rgba(248, 241, 226, 0.58); }
.connection-state-stack .connection-account-row:first-child { border-radius: 16px 16px 0 0; }
.connection-state-stack .connection-account-row:last-child { border-radius: 0 0 16px 16px; }
.connection-state-stack .connection-account-row:only-child { border-radius: 16px; }
.connection-state-stack .connection-account-row .conn-logo { border-radius: 10px; height: 42px; width: 42px; }
.connection-state-stack .connection-account-row .conn-logo-img svg { max-height: 28px; max-width: 28px; }
.connection-state-stack .connection-account-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.connection-state-stack .connection-account-name { color: var(--text); font-size: 0.9375rem; font-weight: 600; line-height: 1.2; }
.connection-state-stack .connection-account-identity {
  color: var(--text-3);
  font-size: 0.78125rem;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.connection-state-stack .connection-account-state { color: var(--text-3); font-size: 0.75rem; font-weight: 700; white-space: nowrap; }
.connection-state-stack .connection-account-state::before { content: ""; border: 1.5px solid currentColor; border-radius: 50%; display: inline-block; height: 6px; margin-right: 7px; vertical-align: 1px; width: 6px; }
.connection-state-stack .connection-account-state-ready { color: #946000; }
.connection-state-stack .connection-account-state-ready::before { background: #dda116; border-color: #dda116; }
.connection-state-stack .connection-account-state-warn { color: var(--danger); }
.connection-state-stack .connection-account-state-placeholder,
.connection-state-stack .connection-capability-placeholder,
.connection-state-stack .connection-row-action-placeholder,
.connection-state-stack .connection-row-menu-placeholder { min-width: 0; }
.connection-state-stack .connection-capabilities { justify-self: end; position: relative; }
.connection-state-stack .connection-capabilities > summary {
  align-items: center;
  background: rgba(59, 50, 32, 0.065);
  border: 0;
  border-radius: 999px;
  color: var(--text-2);
  cursor: pointer;
  display: inline-flex;
  font-size: 0.75rem;
  font-weight: 700;
  gap: 10px;
  list-style: none;
  min-height: 34px;
  padding: 6px 14px;
  white-space: nowrap;
}
.connection-state-stack .connection-capabilities > summary::-webkit-details-marker,
.connection-state-stack .connection-row-menu > summary::-webkit-details-marker { display: none; }
.connection-state-stack .connection-capabilities > summary::after {
  border-bottom: 1.5px solid currentColor;
  border-right: 1.5px solid currentColor;
  content: "";
  height: 5px;
  margin-left: 1px;
  transform: translateY(-2px) rotate(45deg);
  transition: transform 120ms ease;
  width: 5px;
}
.connection-state-stack .connection-capabilities[open] > summary::after { transform: translateY(1px) rotate(225deg); }
.connection-state-stack .connection-capabilities > summary:hover,
.connection-state-stack .connection-capabilities > summary:focus-visible { background: rgba(59, 50, 32, 0.11); outline: none; }
.connection-state-stack .connection-capabilities:not([open]):hover > .connection-capabilities-popover,
.connection-state-stack .connection-capabilities:not([open]):focus-within > .connection-capabilities-popover { display: block; }
.connection-state-stack .connection-capabilities-popover {
  background: var(--bg);
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  box-shadow: 0 18px 42px rgba(59, 50, 32, 0.2);
  margin-top: 7px;
  min-width: 330px;
  padding: 13px;
  position: absolute;
  right: 0;
  top: 100%;
  z-index: 12;
}
.connection-state-stack .connection-capabilities-popover h4 { font-size: 0.8125rem; margin: 0 0 3px; }
.connection-state-stack .connection-capabilities-popover p { color: var(--text-3); font-size: 0.71875rem; line-height: 1.35; margin: 0 0 10px; }
.connection-state-stack .connection-capability-list { display: grid; gap: 0; list-style: none; margin: 0; padding: 0; }
.connection-state-stack .connection-capability-list li { align-items: start; border-top: 1px solid var(--line); display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr) auto; padding: 8px 0; }
.connection-state-stack .connection-capability-list li:first-child { border-top: 0; }
.connection-state-stack .connection-capability-description { color: var(--text-2); font-size: 0.75rem; line-height: 1.35; }
.connection-state-stack .connection-capability-effect { color: var(--ok); font-family: var(--mono); font-size: 0.625rem; font-weight: 750; text-transform: uppercase; }
.connection-state-stack .connection-capability-effect-write { color: #a66b00; }
.connection-state-stack .connection-capability-effect-unknown { color: var(--text-3); }
.connection-state-stack .connection-capability-grant { border-top: 1px solid var(--line); margin-top: 4px !important; padding-top: 9px; }
.connection-state-stack .connection-row-action { justify-self: stretch; min-width: 76px; padding-left: 12px; padding-right: 12px; }
.connection-state-stack .connection-row-menu { justify-self: end; position: relative; }
.connection-state-stack .connection-row-menu > summary {
  align-items: center;
  border-radius: 8px;
  color: var(--text-3);
  cursor: pointer;
  display: inline-flex;
  font-size: 1.25rem;
  height: 28px;
  justify-content: center;
  line-height: 1;
  list-style: none;
  width: 28px;
}
.connection-state-stack .connection-row-menu > summary:hover,
.connection-state-stack .connection-row-menu > summary:focus-visible { background: rgba(59, 50, 32, 0.08); color: var(--text); outline: none; }
.connection-state-stack .connection-row-menu-panel {
  background: var(--bg);
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  box-shadow: 0 14px 34px rgba(59, 50, 32, 0.19);
  display: grid;
  min-width: 210px;
  padding: 6px;
  position: absolute;
  /* Keep the menu clear of the shared overflow-button column so the next
     row's menu remains directly clickable while this one is open. */
  right: 34px;
  top: 34px;
  z-index: 13;
}
.connection-state-stack .connection-row-menu-panel button {
  background: transparent;
  border: 0;
  border-radius: 7px;
  color: var(--text-2);
  cursor: pointer;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 650;
  padding: 8px 9px;
  text-align: left;
}
.connection-state-stack .connection-row-menu-panel button:hover { background: var(--well); }
.connection-state-stack .connection-row-menu-panel button.danger { color: var(--danger); }
.connection-state-stack .connection-row-editor { grid-column: 2 / -1; padding: 0 0 10px; }
.connection-state-stack .connection-empty { border: 1px solid var(--line-strong); border-radius: 14px; color: var(--text-3); font-size: 0.8125rem; padding: 14px 16px; }
.managed-provider-section { display: grid; gap: 16px; }
.managed-provider-card { background: var(--well); border: 1px solid var(--line); border-radius: 16px; display: grid; gap: 16px; padding: 18px; }
.managed-provider-status { align-items: flex-start; display: flex; gap: 11px; }
.managed-provider-status p { margin: 3px 0 0; }
.managed-provider-dot { border: 2px solid var(--text-3); border-radius: 50%; flex: 0 0 10px; height: 10px; margin-top: 5px; width: 10px; }
.managed-provider-dot.ready { background: var(--ok); border-color: var(--ok); }
.managed-provider-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.managed-provider-guidance { color: var(--text-2); font-size: .8125rem; margin: 0; }
.managed-key-form { display: grid; gap: 10px; }
.managed-settings-list { border: 1px solid var(--line-strong); border-radius: 16px; overflow: hidden; }
.managed-settings-row { align-items: center; background: var(--bg); display: grid; gap: 12px; grid-template-columns: 38px minmax(0, 1fr) auto; min-height: 58px; padding: 8px 14px; }
.managed-settings-row + .managed-settings-row { border-top: 1px solid var(--line); }
.managed-settings-row .conn-logo { border-radius: 9px; height: 38px; width: 38px; }
.managed-settings-row .conn-logo-img svg { max-height: 26px; max-width: 26px; }
.managed-settings-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.managed-readiness { color: var(--text-3); font-size: .75rem; white-space: nowrap; }
.managed-readiness::before { border: 1.5px solid currentColor; border-radius: 50%; content: ""; display: inline-block; height: 6px; margin-right: 7px; vertical-align: 1px; width: 6px; }
.managed-readiness-ready { color: var(--ok); }
.managed-readiness-ready::before { background: var(--ok); border-color: var(--ok); }
.managed-readiness-prerequisite { color: #946000; }
.connection-inventory-row { align-items: center; border: 1px solid var(--line); border-radius: 14px; display: flex; gap: 14px; justify-content: space-between; padding: 12px 14px; }
.connection-inventory-row + .connection-inventory-row { margin-top: 8px; }
.connection-inventory-row .connection-account-copy { min-width: 0; }
.connection-inventory-actions { align-items: center; display: flex; flex-shrink: 0; gap: 6px; }
.danger-text { color: var(--danger); }
@media (max-width: 720px) {
  .skill-row.conn-row { align-items: stretch; flex-direction: column; }
}
@media (max-width: 620px) {
  .managed-settings-row { align-items: start; grid-template-columns: 38px minmax(0, 1fr); }
  .managed-readiness { grid-column: 2; }
  .connection-inventory-row { align-items: stretch; flex-direction: column; }
  .connection-inventory-actions { justify-content: flex-end; }
}
@media (max-width: 900px) {
  .connection-state-stack .connection-account-row {
    align-items: center;
    gap: 7px 10px;
    grid-template-columns: 38px minmax(0, 1fr) auto auto 28px;
    min-height: 72px;
    padding: 9px 11px;
  }
  .connection-state-stack .connection-account-row .conn-logo { height: 38px; width: 38px; }
  .connection-state-stack .connection-account-copy { grid-column: 2 / 5; }
  .connection-state-stack .connection-account-state { grid-column: 2 / 5; grid-row: 2; }
  .connection-state-stack .connection-capabilities { grid-column: 2; grid-row: 3; justify-self: start; }
  .connection-state-stack .connection-row-action { grid-column: 4; grid-row: 3; }
  .connection-state-stack .connection-row-menu { grid-column: 5; grid-row: 1 / span 3; }
  .connection-state-stack .connection-account-row > .conn-logo { grid-column: 1; grid-row: 1 / span 3; }
  .connection-state-stack .connection-capabilities-popover { min-width: min(330px, calc(100vw - 48px)); right: -38px; }
  .connection-state-stack .connection-account-state-placeholder,
  .connection-state-stack .connection-capability-placeholder,
  .connection-state-stack .connection-row-action-placeholder,
  .connection-state-stack .connection-row-menu-placeholder { display: none; }
  .connection-state-stack .connection-row-editor { grid-column: 1 / -1; }
}
@media (max-width: 520px) {
  .connection-state-stack .connection-account-row:has(.connection-capabilities) .connection-row-action { grid-row: 4; }
  .connection-state-stack .connection-account-row:has(.connection-capabilities) .connection-row-menu,
  .connection-state-stack .connection-account-row:has(.connection-capabilities) > .conn-logo { grid-row: 1 / span 4; }
}

/* ---- profile footer (delete / add-to-channels / usage) ---- */
.profile-foot { align-items: center; border-top: 1.5px solid rgba(59, 50, 32, 0.15); display: flex; flex-wrap: wrap; gap: 10px; padding-top: 20px; }

/* ---- Audit logs: Scheduled Work and Memory domains ---- */
.audit-rail { gap: 2px; }
.audit-rail .ws-row { margin-top: 5px; }
.audit-channel-name { align-items: center; display: flex; gap: 8px; }
.audit-channel-marker { align-items: center; color: var(--text-3); display: inline-flex; flex: 0 0 16px; font-size: 0.9375rem; justify-content: center; line-height: 1; width: 16px; }
.audit-channel-marker .ic { height: 16px; width: 16px; }
.audit-main { gap: 18px; max-width: none; }
.audit-main-head { align-items: flex-start; display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; }
.audit-tabs { border-bottom: 1.5px solid var(--line-strong); display: flex; gap: 4px; overflow-x: auto; }
.audit-tab {
  background: transparent;
  border: 0;
  border-bottom: 3px solid transparent;
  color: var(--text-3);
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 700;
  margin-bottom: -1.5px;
  padding: 9px 13px;
  white-space: nowrap;
}
.audit-tab:not(:disabled) { cursor: pointer; }
.audit-tab.active { border-color: var(--ember-press); color: var(--text); }
.audit-tab:disabled { cursor: not-allowed; opacity: 0.52; }
.scheduled-filters { align-items: flex-end; display: flex; flex-wrap: wrap; gap: 9px; }
.scheduled-filters .field { min-width: 220px; }
.scheduled-capability { background: transparent; border-top: 1.5px solid var(--line-strong); margin-top: 2px; padding-top: 13px; }
.scheduled-capability > summary { align-items: center; cursor: pointer; display: flex; gap: 10px; list-style: none; }
.scheduled-capability > summary::-webkit-details-marker { display: none; }
.scheduled-capability > summary::before { color: var(--text-3); content: "▸"; font-size: 0.72rem; }
.scheduled-capability[open] > summary::before { content: "▾"; }
.scheduled-capability-summary { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.scheduled-capability-copy { background: var(--well); border-radius: 13px; margin-top: 10px; padding: 13px 15px; }
.scheduled-capability-limits { border-top: 1px solid var(--line-strong); margin-top: 9px; padding-top: 8px; }
.scheduled-capability-limits summary, .scheduled-technical summary { color: var(--text-2); cursor: pointer; font-size: 0.75rem; font-weight: 700; }
.scheduled-capability-limits .hint { margin: 7px 0 0; }
.scheduled-page-intro { margin: -10px 0 0; }
.scheduled-table-wrap { border: 1px solid var(--line-strong); border-radius: 12px; overflow-x: auto; }
.scheduled-table { border-collapse: collapse; min-width: 820px; width: 100%; }
.scheduled-table th { color: var(--text-3); font-size: 0.6875rem; font-weight: 800; letter-spacing: 0.02em; padding: 10px 12px; text-align: left; }
.scheduled-table td { border-top: 1px solid var(--line-strong); color: var(--text-2); font-size: 0.75rem; padding: 12px; vertical-align: middle; }
.scheduled-table tr:hover td { background: var(--well); }
.scheduled-name-button { background: transparent; border: 0; color: var(--text); cursor: pointer; font: inherit; font-weight: 800; padding: 0; text-align: left; }
.scheduled-name-button:hover { color: var(--ember-press); text-decoration: underline; text-underline-offset: 2px; }
.scheduled-name-button.unavailable { color: var(--text-3); font-weight: 650; }
.scheduled-table-state { background: var(--well); border-radius: 99px; color: var(--text-2); display: inline-block; font-size: 0.6875rem; font-weight: 750; padding: 3px 8px; text-transform: capitalize; white-space: nowrap; }
.scheduled-table-state.active, .scheduled-table-state.running, .scheduled-table-state.succeeded { background: var(--ok-tint); color: var(--ok); }
.scheduled-table-footer { align-items: center; color: var(--text-3); display: flex; font-size: 0.6875rem; justify-content: space-between; padding: 10px 2px 0; }
.scheduled-row-actions { position: relative; }
.scheduled-row-actions > summary { align-items: center; border-radius: 8px; color: var(--text-3); cursor: pointer; display: inline-flex; font-size: 1.15rem; height: 28px; justify-content: center; list-style: none; width: 28px; }
.scheduled-row-actions > summary::-webkit-details-marker { display: none; }
.scheduled-row-actions > summary:hover { background: var(--well); color: var(--text); }
.scheduled-row-menu { background: var(--bg); border: 1px solid var(--line-strong); border-radius: 10px; box-shadow: 0 10px 30px rgba(59, 50, 32, 0.16); display: flex; flex-direction: column; min-width: 145px; padding: 5px; position: absolute; right: 0; top: 31px; z-index: 12; }
.scheduled-row-menu .btn { justify-content: flex-start; width: 100%; }
.scheduled-row-menu .btn-danger { background: transparent; box-shadow: none; }
.scheduled-summary-modal { max-width: 560px; width: min(560px, calc(100vw - 32px)); }
.scheduled-summary-head { align-items: flex-start; display: flex; gap: 12px; }
.scheduled-summary-head > div { min-width: 0; }
.scheduled-summary-close { background: transparent; border: 0; border-radius: 8px; color: var(--text-3); cursor: pointer; font-size: 1.25rem; height: 32px; margin-left: auto; width: 32px; }
.scheduled-summary-close:hover { background: var(--well); color: var(--text); }
.scheduled-summary-scope { color: var(--text-3); font-size: 0.75rem; margin: 3px 0 0; }
.scheduled-summary-section { margin-top: 18px; }
.scheduled-summary-prompt { color: var(--text-2); font-size: 0.8125rem; line-height: 1.55; margin: 6px 0 0; white-space: pre-wrap; }
.scheduled-summary-grid { display: grid; gap: 14px 18px; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 18px; }
.scheduled-summary-grid .scheduled-meta-item { font-size: 0.75rem; }
.scheduled-summary-foot { align-items: center; border-top: 1px solid var(--line-strong); display: flex; gap: 8px; margin-top: 20px; padding-top: 14px; }
.scheduled-detail-head { align-items: flex-start; display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; }
.scheduled-detail-back { align-self: flex-start; }
.scheduled-detail-tabs { border-bottom: 1.5px solid var(--line-strong); display: flex; gap: 4px; }
.scheduled-detail-tab { background: transparent; border: 0; border-bottom: 3px solid transparent; color: var(--text-3); cursor: pointer; font: inherit; font-size: 0.8125rem; font-weight: 750; margin-bottom: -1.5px; padding: 9px 13px; }
.scheduled-detail-tab.active { border-color: var(--ember-press); color: var(--text); }
.scheduled-detail-count { background: var(--well); border-radius: 99px; display: inline-block; font-size: 0.6875rem; margin-left: 3px; min-width: 21px; padding: 2px 6px; text-align: center; }
.scheduled-activity-intro { margin-bottom: 12px; }
.scheduled-card { background: var(--well); border-radius: 16px; min-width: 0; padding: 15px; }
.scheduled-card + .scheduled-card { margin-top: 12px; }
.scheduled-definition { padding: 18px; }
.scheduled-meta { display: grid; gap: 12px 22px; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); margin-top: 15px; }
.scheduled-meta-item { min-width: 0; }
.scheduled-meta-item .field-label { display: block; margin-bottom: 3px; }
.scheduled-meta-item .mono { overflow-wrap: anywhere; }
.scheduled-definition-grid { display: grid; gap: 14px; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 15px; }
.scheduled-definition-panel { min-width: 0; }
.scheduled-technical { border-top: 1px solid var(--line-strong); margin-top: 15px; padding-top: 10px; }
.scheduled-technical .scheduled-meta { margin-top: 10px; }
.scheduled-task { background: var(--bg); border-radius: 12px; color: var(--text-2); font-size: 0.8125rem; line-height: 1.55; margin: 10px 0 0; padding: 12px; white-space: pre-wrap; }
.scheduled-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 13px; }
.scheduled-list { display: flex; flex-direction: column; gap: 5px; }
.scheduled-list-row { align-items: flex-start; background: var(--bg); border: 0; border-radius: 11px; color: var(--text-2); cursor: pointer; display: flex; flex-direction: column; gap: 3px; padding: 10px 11px; text-align: left; width: 100%; }
.scheduled-list-row:hover { box-shadow: inset 0 0 0 1.5px var(--line-strong); }
.scheduled-list-row.active { box-shadow: inset 0 0 0 1.5px var(--ember-press); color: var(--text); }
.scheduled-run { background: var(--bg); border-radius: 12px; display: flex; flex-direction: column; gap: 7px; padding: 11px 12px; }
.scheduled-run + .scheduled-run { margin-top: 7px; }
.scheduled-run-head { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; }
.scheduled-run-grid { display: grid; gap: 10px 18px; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); }
.scheduled-run-item { min-width: 0; }
.scheduled-run-item .field-label { display: block; margin-bottom: 2px; }
.scheduled-run-value { color: var(--text-2); font-size: 0.75rem; overflow-wrap: anywhere; }
.scheduled-run-tech { border-top: 1px solid var(--line-strong); margin-top: 3px; padding-top: 7px; }
.scheduled-run-tech .scheduled-run-grid { margin-top: 8px; }
.scheduled-revisions { display: flex; flex-direction: column; gap: 6px; }
.scheduled-revision { align-items: baseline; background: var(--bg); border-radius: 10px; display: flex; flex-wrap: wrap; gap: 7px; padding: 8px 10px; }
.scheduled-live { min-height: 1.2em; }
.memory-banner { background: var(--ember-tint); border-radius: 13px; color: var(--text-2); font-size: 0.78125rem; padding: 10px 13px; }
.memory-layout { display: grid; gap: 14px; grid-template-columns: minmax(180px, 0.7fr) minmax(320px, 1.8fr); min-height: 480px; }
.memory-pane { background: var(--well); border-radius: 16px; min-width: 0; padding: 12px; }
.memory-pane-title { color: var(--text-3); font-size: 0.6875rem; font-weight: 800; letter-spacing: 0.08em; margin: 1px 3px 9px; text-transform: uppercase; }
.memory-file-list { display: flex; flex-direction: column; gap: 4px; }
.memory-file {
  align-items: flex-start;
  background: transparent;
  border: 0;
  border-radius: 10px;
  color: var(--text-2);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 10px;
  text-align: left;
  width: 100%;
}
.memory-file:hover { background: var(--bg); }
.memory-file.active { background: var(--bg); box-shadow: inset 0 0 0 1.5px var(--line-strong); color: var(--text); }
.memory-file-name { font-family: var(--mono); font-size: 0.75rem; overflow-wrap: anywhere; }
.memory-file-meta { color: var(--text-3); font-size: 0.6875rem; }
.memory-editor { display: flex; flex-direction: column; gap: 13px; }
.memory-editor-head { align-items: flex-start; display: flex; flex-wrap: wrap; gap: 9px; justify-content: space-between; }
.memory-editor-title { font-family: var(--mono); font-size: 0.9375rem; font-weight: 700; overflow-wrap: anywhere; }
.memory-editor-actions { display: flex; flex-wrap: wrap; gap: 7px; }
.memory-source {
  background: #2e281d;
  border-radius: 12px;
  color: #fff8e8;
  font-family: var(--mono);
  font-size: 0.71875rem;
  line-height: 1.65;
  margin: 0;
  max-height: 420px;
  overflow: auto;
  padding: 14px;
  white-space: pre-wrap;
  word-break: break-word;
}
.memory-history { display: flex; flex-direction: column; gap: 6px; }
.memory-history-row { align-items: baseline; background: var(--bg); border-radius: 10px; display: flex; flex-wrap: wrap; gap: 7px; padding: 8px 10px; }
.memory-history-row .spacer { flex: 1; }
.memory-review { background: var(--danger-well); border-radius: 12px; color: var(--danger); display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 12px; }
.memory-live { min-height: 1.2em; }
@media (max-width: 900px) {
  .memory-layout { grid-template-columns: 1fr; }
  .memory-pane { min-height: auto; }
  .scheduled-definition-grid { grid-template-columns: 1fr; }
}
@media (max-width: 720px) {
  .audit-main-head, .memory-editor-head, .memory-review { align-items: stretch; flex-direction: column; }
  .memory-editor-actions .btn { flex: 1; }
  .scheduled-meta, .scheduled-run-grid { grid-template-columns: 1fr; }
  .scheduled-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

/* ---- usage and estimated spend ---------------------------------------- */
.usage-main { gap: 22px; max-width: 1100px; }
.usage-head { display: flex; flex-direction: column; }
.usage-head-copy { display: flex; flex-direction: column; gap: 4px; max-width: 720px; }
.usage-controls { container-type: inline-size; min-width: 0; width: 100%; }
.usage-control-row { align-items: end; display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(150px, 200px)); }
.usage-control-row.has-custom { grid-template-columns: repeat(4, minmax(0, 1fr)) auto; }
.usage-controls .field { min-width: 0; }
.usage-apply { min-height: 37px; white-space: nowrap; }
.usage-custom-error { grid-column: 1 / -1; margin: 0; }
.usage-contract { align-items: center; background: var(--well); border-left: 4px solid var(--ember); border-radius: 12px; display: flex; gap: 14px; justify-content: space-between; padding: 12px 14px; }
.usage-grid { display: grid; gap: 12px; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.usage-card { background: var(--well); border-radius: 14px; display: flex; flex-direction: column; gap: 3px; min-width: 0; padding: 14px; }
.usage-card-primary { background: var(--text); color: #fff8e8; }
.usage-card-label { color: var(--text-3); font-size: 0.6875rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
.usage-card-primary .usage-card-label, .usage-card-primary .hint { color: #d9cdb5; }
.usage-card-value { color: var(--text); font-family: var(--display); font-size: 1.55rem; font-variant-numeric: tabular-nums; font-weight: 700; line-height: 1.15; overflow-wrap: anywhere; }
.usage-card-primary .usage-card-value { color: #fff8e8; }
.usage-data-note { color: var(--text-3); font-size: .75rem; }
.usage-section { border-top: 1.5px solid rgba(59, 50, 32, .15); display: flex; flex-direction: column; gap: 12px; padding-top: 18px; }
.usage-section-head { align-items: baseline; display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between; }
.usage-table-wrap { border: 1.5px solid var(--line); border-radius: 14px; overflow-x: auto; }
.usage-table { border-collapse: collapse; font-size: .75rem; width: 100%; }
.usage-table th { background: var(--well); color: var(--text-3); font-size: .65625rem; letter-spacing: .05em; padding: 9px 10px; text-align: left; text-transform: uppercase; white-space: nowrap; }
.usage-table td { border-top: 1px solid var(--line); color: var(--text-2); padding: 10px; vertical-align: top; }
.usage-table .number { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.usage-row-action { background: none; border: 0; color: var(--ember-press); cursor: pointer; font-weight: 700; padding: 0; text-align: left; }
.usage-row-action:hover { text-decoration: underline; }
.usage-work-label { color: var(--text); display: block; font-weight: 700; }
.usage-term-help, .usage-token-total {
  cursor: help;
  display: inline-block;
  position: relative;
  text-decoration-color: rgba(59, 50, 32, .35);
  text-decoration-line: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}
.usage-term-help::after, .usage-token-total::after {
  background: var(--text);
  border-radius: 8px;
  bottom: calc(100% + 8px);
  box-shadow: 0 6px 18px rgba(59, 50, 32, .18);
  color: #fff8e8;
  content: attr(data-tooltip);
  font-family: var(--body);
  font-size: .6875rem;
  font-weight: 600;
  left: 50%;
  letter-spacing: 0;
  line-height: 1.4;
  opacity: 0;
  padding: 7px 9px;
  pointer-events: none;
  position: absolute;
  text-align: left;
  text-transform: none;
  transform: translate(-50%, 4px);
  transition: opacity .12s ease, transform .12s ease;
  white-space: normal;
  width: 280px;
  z-index: 60;
}
.usage-token-total::after { max-width: 240px; white-space: nowrap; width: max-content; }
.usage-term-help:hover::after, .usage-term-help:focus-visible::after,
.usage-token-total:hover::after, .usage-token-total:focus-visible::after { opacity: 1; transform: translate(-50%, 0); }
.usage-table .usage-term-help::after, .usage-table .usage-token-total::after {
  bottom: auto;
  top: calc(100% + 8px);
  transform: translate(-50%, -4px);
}
.usage-table .usage-term-help:hover::after, .usage-table .usage-term-help:focus-visible::after,
.usage-table .usage-token-total:hover::after, .usage-table .usage-token-total:focus-visible::after { transform: translate(-50%, 0); }
.usage-term-help:focus-visible, .usage-token-total:focus-visible { outline: 2px solid var(--ember-press); outline-offset: 2px; }
.usage-filter-chip { align-items: center; background: var(--ember-tint); border-radius: 999px; color: var(--ember-deep); display: inline-flex; font-size: .71875rem; font-weight: 700; gap: 6px; padding: 5px 9px; }
@media (max-width: 900px) {
  .usage-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@container (max-width: 820px) {
  .usage-control-row.has-custom { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .usage-apply { justify-self: start; }
}
@container (max-width: 520px) {
  .usage-control-row, .usage-control-row.has-custom { grid-template-columns: 1fr; }
  .usage-apply { justify-self: stretch; width: 100%; }
}
@media (max-width: 720px) {
  .usage-grid { grid-template-columns: 1fr; }
  .usage-contract { align-items: flex-start; flex-direction: column; }
}

/* ---- team access ------------------------------------------------------- */
.team-main { display: grid; gap: 22px; max-width: 760px; }
.team-hero { align-items: flex-start; display: flex; gap: 16px; justify-content: space-between; }
.team-count { background: var(--ember-tint); border-radius: 999px; color: var(--ember-deep); font-size: .75rem; font-weight: 800; padding: 6px 10px; white-space: nowrap; }
.team-card { background: var(--bg); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--card-shadow); padding: 18px; }
.team-card h2 { color: var(--text); font-size: 1rem; margin: 0 0 12px; }
.team-card > .hint { margin: 0 0 18px; }
.team-auto-note { background: var(--ok-tint); border: 1px solid rgba(53,115,83,.18); border-radius: 12px; color: var(--text-2); font-size: .8125rem; line-height: 1.55; padding: 13px 14px; }
.team-auto-note strong { color: var(--text); }
.team-column-guide { color: var(--text-3); display: grid; font-size: .625rem; font-weight: 850; gap: 14px; grid-template-columns: minmax(0, 1fr) 112px 38px; letter-spacing: .06875rem; padding: 0 18px 7px; text-transform: uppercase; }
.team-column-guide span:nth-child(2) { text-align: center; }
.team-list { border: 1px solid var(--line); border-radius: 16px; overflow: visible; }
.team-row { align-items: center; background: #fffefa; display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr) 112px 38px; min-height: 82px; padding: 14px 18px; position: relative; }
.team-row + .team-row { border-top: 1px solid var(--line); }
.team-row:first-child { border-radius: 15px 15px 0 0; }
.team-row:last-child { border-radius: 0 0 15px 15px; }
.team-row-identity { align-items: center; display: flex; gap: 13px; min-width: 0; }
.team-avatar { align-items: center; background: var(--well); border: 1px solid var(--line); border-radius: 50%; color: var(--text-2); display: inline-flex; flex: 0 0 auto; font-size: .75rem; font-weight: 850; height: 46px; justify-content: center; overflow: hidden; width: 46px; }
.team-avatar img { display: block; height: 100%; object-fit: cover; width: 100%; }
.team-row-main { min-width: 0; }
.team-row-title { color: var(--text); font-size: 1rem; font-weight: 820; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.team-you { background: var(--well); border-radius: 6px; color: var(--text-2); font-size: .6875rem; font-weight: 800; margin-left: 7px; padding: 3px 6px; vertical-align: 2px; }
.team-row-sub { align-items: center; color: var(--text-2); display: flex; font-size: .8125rem; gap: 7px; line-height: 1.45; margin-top: 4px; min-width: 0; }
.team-row-sub-copy { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.team-row-sub-separator { color: #c6b999; }
.team-row-actions { align-items: center; display: flex; justify-content: flex-end; width: 38px; }
.team-role, .team-role-select { align-items: center; background: #fff; border: 1px solid #d9ceb8; border-radius: 10px; color: var(--text); display: inline-flex; font-family: inherit; font-size: .8125rem; font-weight: 800; height: 35px; justify-content: center; width: 112px; }
.team-role { background: #fcfaf4; padding: 0 10px; }
.team-role-select-wrap { align-items: center; display: inline-flex; justify-content: flex-end; position: relative; width: 112px; }
.team-role-select { appearance: none; cursor: pointer; padding: 0 34px 0 12px; }
.team-role-select:disabled { cursor: wait; opacity: .6; }
.team-role-select:focus-visible { outline: 2px solid var(--ember-press); outline-offset: 2px; }
.team-role-select-icon { align-items: center; color: var(--text-2); display: inline-flex; height: 16px; justify-content: center; pointer-events: none; position: absolute; right: 12px; width: 16px; }
.team-role-select-icon svg { height: 14px; width: 14px; }
.team-access-status { align-items: center; color: #6f7f64; display: inline-flex; flex: 0 0 auto; font-size: .6875rem; font-weight: 700; gap: 5px; white-space: nowrap; }
.team-access-status::before { background: currentColor; border-radius: 50%; content: ""; height: 6px; width: 6px; }
.team-access-status.suspended { color: var(--ember-deep); font-weight: 800; }
.team-actions-wrap { position: relative; }
.team-actions-trigger { align-items: center; background: transparent; border: 1px solid transparent; border-radius: 10px; color: var(--text-2); cursor: pointer; display: inline-flex; height: 38px; justify-content: center; padding: 0; width: 38px; }
.team-actions-trigger:hover, .team-actions-trigger[aria-expanded="true"] { background: var(--well); border-color: var(--line); color: var(--text); }
.team-actions-trigger:focus-visible { outline: 2px solid var(--ember-press); outline-offset: 2px; }
.team-action-menu { background: var(--bg); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 16px 36px rgba(58,43,22,.16); display: grid; min-width: 220px; padding: 6px; position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; }
.team-action-menu button { background: transparent; border: 0; border-radius: 8px; color: var(--text); cursor: pointer; font: inherit; font-size: .8125rem; font-weight: 700; padding: 9px 10px; text-align: left; width: 100%; }
.team-action-menu button:hover, .team-action-menu button:focus-visible { background: var(--well); outline: 0; }
.team-action-menu button.danger { color: var(--danger); }
.team-action-divider { border-top: 1px solid var(--line); margin: 5px 4px; }
.team-empty { color: var(--text-2); font-size: .8125rem; padding: 8px 0; }
@media (max-width: 620px) {
  .team-hero { align-items: stretch; }
  .team-hero { flex-direction: column; }
  .team-count { width: max-content; }
  .team-column-guide { display: none; }
  .team-row { gap: 10px; grid-template-columns: minmax(0, 1fr) 112px 38px; padding: 14px; }
  .team-row-sub { align-items: flex-start; flex-direction: column; gap: 2px; }
  .team-row-sub-separator { display: none; }
}
@media (max-width: 480px) {
  .team-row { grid-template-columns: minmax(0, 1fr) 38px; }
  .team-row-identity { grid-column: 1 / -1; padding-right: 48px; }
  .team-row-sub { align-items: center; flex-direction: row; gap: 7px; }
  .team-row-sub-separator { display: inline; }
  .team-role, .team-role-select-wrap { grid-column: 1; grid-row: 2; justify-self: end; }
  .team-row-actions { grid-column: 2; grid-row: 2; }
}

</style>
</head>
<body>
<div id="app" class="frame primary-admin-shell" aria-busy="true">
  <header class="topbar">
    <div class="brand">
      <span class="avatar"><svg class="pea" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><circle cx="24" cy="25" r="15.5" fill="#E3AC45"></circle><circle cx="17" cy="17.5" r="4.2" fill="#F4D084"></circle><g class="pea-eyes"><circle class="pea-eye" cx="18.5" cy="24" r="1.9" fill="#3B3220"></circle><circle class="pea-eye" cx="29.5" cy="24" r="1.9" fill="#3B3220"></circle></g><g class="pea-lids"><path d="M16.4 24.2 Q18.5 22 20.6 24.2" fill="none" stroke="#3B3220" stroke-width="1.8" stroke-linecap="round"></path><path d="M27.4 24.2 Q29.5 22 31.6 24.2" fill="none" stroke="#3B3220" stroke-width="1.8" stroke-linecap="round"></path></g><path class="pea-smile" d="M19 29 Q24 32.5 29 29" fill="none" stroke="#3B3220" stroke-width="1.8" stroke-linecap="round"></path><path class="pea-grin" d="M18.5 28.5 Q24 35.5 29.5 28.5 Z" fill="#3B3220"></path><circle class="pea-blush" cx="15.5" cy="28.5" r="2" fill="#DC8A4F"></circle><circle class="pea-blush" cx="32.5" cy="28.5" r="2" fill="#DC8A4F"></circle></svg></span>
      <span class="brand-name">Chickpea</span>
    </div>
    <details class="topbar-menu"><summary aria-label="Menu"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg></summary></details>
    <div class="actions actions-list"><span class="hint">Loading workspace&hellip;</span></div>
  </header>
  <div class="body">
    <nav class="rail primary-shell-sidebar" aria-label="Loading Chickpea">
      <div class="primary-shell-brand"><span class="brand-home"><span class="avatar"><svg class="pea" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><circle cx="24" cy="25" r="15.5" fill="#E3AC45"></circle><circle cx="17" cy="17.5" r="4.2" fill="#F4D084"></circle><circle cx="18.5" cy="24" r="1.9" fill="#3B3220"></circle><circle cx="29.5" cy="24" r="1.9" fill="#3B3220"></circle><path d="M19 29 Q24 32.5 29 29" fill="none" stroke="#3B3220" stroke-width="1.8" stroke-linecap="round"></path></svg></span><span class="brand-name">Chickpea</span></span></div>
      <div class="rail-context"><div class="rail-head"><span class="section-eyebrow">Loading workspace</span></div></div>
    </nav>
    <main class="main"><div class="main-inner"><div class="empty" role="status"><h1 class="page-title">Loading Chickpea&hellip;</h1><p class="hint">Reading your workspace configuration.</p></div></div></main>
  </div>
</div>
<script>
(function () {
  try { sessionStorage.removeItem("chickpea.owner-setup.v1"); } catch (_) {}
  // Server-resolved runtime target: the Workers AI row is binding-only, so it is
  // shown on Cloudflare and hidden on Node (the inline script has no target check
  // of its own — this is interpolated as a literal boolean at render time).
  var IS_CLOUDFLARE = ${isCloudflare};
  var USAGE_ADMIN_UI = ${usageAdminUi};
  var CONNECTOR_PRESETS = ${JSON.stringify(CONNECTOR_PRESETS).replace(/</g, '\\u003c')};
  var GOOGLE_WORKSPACE_SERVICE_PRESETS = ${JSON.stringify(GOOGLE_WORKSPACE_SERVICE_PRESETS).replace(/</g, '\\u003c')};
  var MANAGED_CONNECTOR_PRESETS = ${JSON.stringify(MANAGED_CONNECTOR_PRESETS).replace(/</g, '\\u003c')};
  var REUSABLE_CONNECTOR_PRESETS = ${JSON.stringify(REUSABLE_CONNECTOR_PRESETS).replace(/</g, '\\u003c')};
  var CONNECTOR_LOGOS = ${JSON.stringify(CONNECTOR_LOGOS).replace(/</g, '\\u003c')};
  var SUGGESTED_SKILL_CATEGORIES = ${JSON.stringify(SUGGESTED_SKILL_CATEGORIES).replace(/</g, '\\u003c')};
  var SUGGESTED_SKILLS = ${JSON.stringify(SUGGESTED_SKILLS).replace(/</g, '\\u003c')};
  var SUGGESTED_SKILL_CATEGORY_COUNTS = {};
  SUGGESTED_SKILLS.forEach(function (skill) {
    if (skill.featured) SUGGESTED_SKILL_CATEGORY_COUNTS.featured = (SUGGESTED_SKILL_CATEGORY_COUNTS.featured || 0) + 1;
    skill.categories.forEach(function (category) {
      SUGGESTED_SKILL_CATEGORY_COUNTS[category] = (SUGGESTED_SKILL_CATEGORY_COUNTS[category] || 0) + 1;
    });
  });
  var API_CONNECTION_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
  var GOOGLE_WORKSPACE_SCOPES = ${JSON.stringify(GOOGLE_WORKSPACE_SCOPE_OPTIONS)};
  var ONBOARDING_PROMPT = "@Chickpea Give me three useful ways you can help this channel, each with an example prompt I could try next.";
  var state = {
    agents: [],
    grants: [],
    models: { providers: [] },
    active: null,
    effective: null,
    effectiveError: "",
    addChannelOpen: false,
    channelFormDraft: { workspaceId: "", channelId: "", channelLabel: "" },
    addChannelError: "",
    addChannelInvite: "",
    addChannelManual: false,
    addChannelSelected: "",
    // Optional profile carried into the add-channel flow (profile page's
    // "Add a new channel with this profile"); empty means the Default profile.
    addChannelAgentId: "",
    slackChannels: null,
    slackChannelsError: null,
    slackChannelsLoading: false,
    slackChannelsRequestId: 0,
    channelIndex: [],
    channelIndexError: "",
    channelIndexQuery: "",
    swapOpen: false,
    channelDraft: { enabled: true },
    // Channel-memory actions re-render the page. Preserve this disclosure so
    // those actions do not hide their own form inside a collapsed <details>.
    channelTryNotice: "",
    channelTryError: false,
    channelTryRequestId: 0,
    dirty: false,
    saveError: "",
    // Agents are the primary authoring destination. channelScreen distinguishes
    // the secondary Channels index from a concrete Slack-channel detail.
    view: "profiles",
    // Team is Chickpea's authorization surface. Slack interactions provision
    // ordinary members; Owners manage the durable roster here.
    team: null,
    teamLoading: false,
    teamError: "",
    teamBusy: "",
    teamNotice: "",
    teamActionMenuId: "",
    // Owner transitions, suspension, and permanent removal are confirmation
    // boundaries. Routine role changes and restoration remain one click.
    teamConfirm: null,
    channelScreen: "overview",
    profileScreen: "list",
    profileLastAgentId: null,
    profileDirty: false,
    disableConfirm: false,
    profileOverflowOpen: false,
    profileReplacementDefaultAgentId: "",
    editingAgentId: null,
    profileDraft: null,
    profileError: "",
    profileConflict: false,
    profilePresenceMutation: null,
    // Active capability tab on the profile edit screen. Panels stay mounted
    // ([hidden]) across switches, so no draft state lives here — just which
    // panel is visible.
    profileTab: "instructions",
    suggestedSkillCategory: "featured",
    // Inline title and description editing on the profile edit screen. Each
    // carries { prev } while open so Escape can restore the prior draft text.
    profileRenaming: null,
    profileDescriptionEditing: null,
    // "Add to channels" picker in the profile footer. Candidates come from the
    // Slack workspace catalog; active grants only exclude existing Agent reach.
    attachPicker: false,
    attachChannelSelected: "",
    attachError: "",
    attachNotice: "",
    // Inline custom-skill editor on the profile edit page. null when closed; when
    // open it is { index: <number|null for a new skill>, name, description,
    // instructions, error }. Only one editor is open at a time.
    skillEditor: null,
    // Inline "Import from URL" panel on the profile edit page. null when closed.
    // When open it is { source, loading, error, resolution, selected, browse }
    // where browse is an import-local GitHub account/repository picker. It is
    // deliberately separate from repositoryPicker and profileDraft.repositories:
    // choosing a source must never grant the profile runtime repository access.
    // browse is null when closed; otherwise it carries the installation search.
    //
    // resolution is the /admin/api/skills/resolve payload (null until "Find
    // skills" returns) and selected is a boolean[] parallel to resolution.skills.
    skillImport: null,
    // Inline Connections (remote MCP server) editor on the profile edit page.
    // null when closed; when open it is a working copy of one connection plus
    // TRANSIENT secrets (bearerToken + headerValues) that live ONLY here and are
    // PUT to the settings store on save, then cleared after success — they never
    // enter the profile PATCH body. { index: <number|null for new>, id, displayName, url,
    // transport, authMode, headerNames, headerValues, bearerToken,
    // enabled, testing, testError, discoveredTools, checked (bool[] parallel to
    // discoveredTools), lifecycleStatus, statusText, lastCheckedAt, sources
    // (secret presence from a prior save: {bearer, headers}), error }.
    connectionEditor: null,
    // Status-only OAuth return state parsed from the callback redirect. No
    // authorization code, token, verifier, client secret, or provider error is
    // ever placed in the URL or this browser state.
    oauthReturn: null,
    // Inline credentialed REST API editor. Its credential is transient and is
    // written to the API-connection secret endpoint only after the profile
    // policy saves successfully.
    apiConnectionEditor: null,
    // Connections are reusable accounts. The Agent owns only bindings; this
    // view deliberately exposes Team vs My account without ever receiving a
    // credential or secret reference from the server.
    agentConnections: { agentId: "", workspaceId: "", attached: [], available: [], managedCatalog: [], managedCanConfigure: false, managedConfigurationReadOnly: false, loading: false, error: "", notice: "" },
    composioSetup: null,
    managedAuthorization: null,
    agentSchedules: { agentId: "", viewerMembershipId: "", schedules: [], members: [], loading: false, busy: "", error: "", notice: "" },
    connectionAccountsSupported: null,
    connectionAccountForm: null,
    managedResourceEditor: null,
    // Non-null only while the gallery's single Custom connection flow is open.
    // Both lane editors may coexist so tab switches preserve typed values.
    customConnectionLane: null,
    connectorGallerySearch: "",
    // Index of the connection pending removal (its confirm modal is open), or
    // null. The DELETE of its secrets is issued on the next profile save.
    connectionRemove: null,
    apiConnectionRemove: null,
    // When the user tries to leave a dirty Agent or Channel editor, this holds
    // the pending navigation and the shared confirmation modal is shown.
    leavePrompt: null,
    // The existing mobile hamburger is the narrow-screen transition into the
    // Agent roster. Focus is explicitly returned to its trigger on close.
    mobileAgentRosterOpen: false,
    mobileAgentRosterFocus: "",
    slack: null,
    onboarding: null,
    onboardingError: "",
    onboardingBusy: false,
    onboardingNotice: "",
    onboardingChannelSelected: "",
    // A successful first Slack connection gets one calm acknowledgement before
    // channel selection. This is intentionally page-local: a reload resumes at
    // the durable onboarding stage instead of replaying a celebration.
    onboardingSlackConnected: false,
    slackOnboardingFocus: "",
    // Set from a just-completed connect (POST result carries team + botName);
    // drives the dismissable success toast in the connected funnel.
    slackToast: null,
    slackToastDismissed: false,
    // Post-onboarding Slack management state. The behavior payload comes from
    // /admin/api/slack-behavior as { value, source } entries so env-managed
    // toggles stay visibly read-only instead of pretending a stored write won.
    slackBehavior: null,
    slackBehaviorError: "",
    slackBehaviorBusy: "",
    // One lock covers every Slack connection operation. The legacy per-action
    // booleans below still drive their specific labels, while this value keeps
    // test, credential replacement, disconnect, and navigation from racing.
    slackConnectionBusy: "",
    slackReconnectError: "",
    slackTestBusy: false,
    slackTestStatus: null,
    slackDisconnectConfirm: false,
    slackDisconnectBusy: false,
    slackDisconnectError: "",
    // Settings (model-providers) destination. state.settings holds the last
    // /admin/api/providers payload; provUi/favUi carry the per-provider paste,
    // remove-confirmation, and favorites-search UI state; favorites and
    // providerModels cache the loaded arrays so the managers render without a
    // round trip per keystroke.
    settings: null,
    settingsSection: "providers",
    settingsLoaded: false,
    settingsLoadGeneration: 0,
    connectionInventory: { accounts: [], loading: false, error: "", notice: "" },
    connectorSettings: { provider: null, catalog: [], canConfigure: false, recoveryMode: false, impact: { accounts: 0, schedules: 0 }, loading: false, busy: "", error: "", notice: "", key: "", editing: false, confirm: "" },
    providerSettingsRequestId: 0,
    settingsError: "",
    modelCatalog: null,
    modelCatalogLoaded: false,
    modelCatalogError: "",
    modelCatalogBusy: false,
    modelCatalogRequestId: 0,
    // App-level GitHub credentials and installations. Secrets never enter this
    // object: status is write-only metadata plus profile references for the
    // pre-disconnect warning.
    githubStatus: null,
    githubStatusLoaded: false,
    githubStatusRequestId: 0,
    githubError: "",
    githubBusy: "",
    githubManifestOpen: false,
    githubOrg: "",
    githubDisconnectConfirm: false,
    githubDisconnectError: "",
    // Install-level coding sandbox. This is deliberately separate from profile
    // state: enabled repository grants imply availability, with no per-profile
    // sandbox switch.
    sandboxStatus: null,
    sandboxLoaded: false,
    sandboxError: "",
    sandboxSaving: false,
    sandboxConfirm: "",
    sandboxReadyAttested: false,
    sandboxNotice: "",
    // Profile-local repository selection UI. The picker is a working selection
    // only; Apply writes grants into profileDraft and the existing profile Save
    // action remains the sole persistence path.
    repositoryPicker: null,
    repositoryAddOpen: false,
    egress: null,
    egressLoaded: false,
    egressError: "",
    egressSaving: false,
    provUi: {},
    favUi: {},
    // null = favorites not yet fetched (picker/Settings load them lazily). The
    // profile Model picker distinguishes "not loaded" (fall back to static
    // suggestions mid-load) from "loaded but empty" (suppress the group). Readers
    // outside the picker go through favoritesFor(), which null-coalesces to [].
    favorites: { openrouter: null, "workers-ai": null },
    // Dynamic model lists per provider id, loaded lazily. openrouter/workers-ai
    // feed the Settings favorites managers; anthropic/openai feed the profile
    // Model picker's FULL dynamic group (F5). null = not yet loaded.
    providerModels: { anthropic: null, openai: null, openrouter: null, "workers-ai": null },
    // Profile Model picker (F6): a real click-to-open combobox. Closed = the
    // input + chevron; open = the grouped dynamic options popover. The filter
    // mirrors the input value so typing narrows the list. providerModelsError
    // marks a provider whose model fetch failed so the picker can fall back to
    // the static suggestions for it (offline).
    modelPickerOpen: false,
    modelPickerFilter: "",
    providerModelsError: {},
    // Audit Logs has two live domains: Scheduled Work for routines and their
    // executions, and Memory for durable channel context. The selected domain
    // owns its own route and loading state so switching tabs cannot mix data.
    auditDomain: "scheduled-work",
    scheduledRoutines: null,
    scheduledLoading: false,
    scheduledError: "",
    scheduledSelection: "",
    scheduledDetail: null,
    scheduledDetailLoading: false,
    scheduledInspector: false,
    scheduledDetailTab: "overview",
    scheduledBusy: "",
    scheduledNotice: "",
    scheduledCapability: null,
    scheduledLimits: null,
    scheduledFilters: { workspaceId: "", channelId: "", state: "current" },
    scheduledDeleteConfirm: false,
    usageOverview: null,
    usageMetadata: null,
    usageOperations: null,
    usageNextCursor: null,
    usageLoading: false,
    usageLoadingMore: false,
    usageError: "",
    usagePeriod: "last_30_days",
    usageCustomFrom: "",
    usageCustomTo: "",
    usageCustomDraftFrom: "",
    usageCustomDraftTo: "",
    usageCustomError: "",
    usageGroupBy: "channel",
    usageOperationFilter: null,
    usageRequestId: 0,
    // Channel detail keeps a small, independently filtered scheduled-work
    // summary. It must not reuse the Audit tab's pageable/filterable list.
    channelScheduledRoutines: null,
    channelScheduledLoading: false,
    channelScheduledError: "",
    channelScheduledKey: "",
    // Every Agent owns one durable memory body. It follows the Agent into
    // direct messages and every Channel where the Agent has reach.
    ownerMemory: {
      ownerKind: "",
      workspaceId: "",
      ownerId: "",
      detail: null,
      draft: null,
      dirty: false,
      loading: false,
      busy: "",
      error: "",
      notice: "",
      conflict: null,
      requestId: 0
    }
  };
  var lastRenderedPath = "";
  var egressDraft = { mode: "allowlist", domains: [""] };
  var sandboxDraft = {
    allowedHosts: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"],
    monthlySessionCap: 200
  };
  // The Repositories picker and the Skills import browser search the same
  // installation-repos endpoint. One controller owns the request-identity
  // guard, the loading/error state, and the 250ms debounce for both lanes;
  // they differ only in where their slot lives and how they repaint.
  function createRepoSearchController(config) {
    var timer = null;
    function clearTimer() {
      if (timer && typeof clearTimeout === "function") clearTimeout(timer);
      timer = null;
    }
    function paint() {
      config.rerender();
      config.focus();
    }
    function load() {
      var slot = config.slotOf();
      if (!slot) return Promise.resolve();
      var requestId = (slot.requestId || 0) + 1;
      slot.requestId = requestId;
      slot.loading = true;
      slot.error = "";
      paint();
      var path = "/admin/api/github/installations/" + encodeURIComponent(String(slot.installationId)) +
        "/repos?q=" + encodeURIComponent(slot.query || "") + "&page=1";
      return api(path).then(function (body) {
        if (config.slotOf() !== slot || slot.requestId !== requestId) return;
        slot.repos = (body && body.repos) || [];
        slot.totalCount = Number((body && body.totalCount) || 0);
        slot.truncated = !!(body && body.truncated);
        if (config.onLoaded) config.onLoaded(slot);
        slot.loading = false;
        slot.error = "";
        paint();
      }).catch(function (error) {
        if (config.slotOf() !== slot || slot.requestId !== requestId) return;
        slot.loading = false;
        slot.error = (error && (error.serverMessage || error.message)) || "Could not load repositories.";
        paint();
      });
    }
    function search(query) {
      var slot = config.slotOf();
      if (!slot) return;
      slot.query = query;
      // Invalidate the currently running query immediately. Otherwise its
      // response can land during this query's debounce window and briefly show
      // results for the previous text beneath the new input value.
      slot.requestId = (slot.requestId || 0) + 1;
      clearTimer();
      var run = function () {
        timer = null;
        if (config.slotOf() === slot) load();
      };
      if (typeof setTimeout === "function") timer = setTimeout(run, 250);
      else run();
    }
    // Drop the pending debounce and invalidate the in-flight request before the
    // lane clears its slot, so a late response can never repaint a closed
    // browser.
    function reset() {
      clearTimer();
      var slot = config.slotOf();
      if (slot) slot.requestId = (slot.requestId || 0) + 1;
    }
    return { load: load, search: search, reset: reset };
  }

  var repoPickerSearch = createRepoSearchController({
    slotOf: function () { return state.repositoryPicker; },
    rerender: function () { render(); },
    focus: function () { focusRepositorySearch(); },
    onLoaded: function (picker) {
      // Accumulate every name this picker session has confirmed the current
      // App installation can reach before adopting an older unbound grant.
      picker.seenFullNames = picker.seenFullNames || {};
      picker.repos.forEach(function (repo) {
        if (repo && repo.fullName) picker.seenFullNames[repo.fullName] = true;
      });
    }
  });

  var skillImportRepoSearch = createRepoSearchController({
    slotOf: function () {
      var browse = state.skillImport && state.skillImport.browse;
      return browse && !browse.chooseAccount && browse.installationId ? browse : null;
    },
    rerender: function () { rerenderSkillImportBrowse(); },
    focus: function () { focusSkillImportBrowseSearch(); }
  });

  // Inline Heroicons (micro, 16px) — solid unless noted. Colour inherits from
  // the parent via currentColor; never override fill in CSS.
  function icon(name, extra) {
    var paths = {
      "chevron-down": "M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z",
      "chevron-right": "M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z",
      check: "M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 1 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z",
      "x-mark": "M2.22 2.22a.75.75 0 0 1 1.06 0L8 6.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L9.06 8l4.72 4.72a.75.75 0 1 1-1.06 1.06L8 9.06l-4.72 4.72a.75.75 0 0 1-1.06-1.06L6.94 8 2.22 3.28a.75.75 0 0 1 0-1.06Z",
      plus: "M8.75 3.75a.75.75 0 0 0-1.5 0v3.5h-3.5a.75.75 0 0 0 0 1.5h3.5v3.5a.75.75 0 0 0 1.5 0v-3.5h3.5a.75.75 0 0 0 0-1.5h-3.5v-3.5Z",
      copy: "M5.25 1.5A2.25 2.25 0 0 0 3 3.75v6.5a.75.75 0 0 0 1.5 0v-6.5c0-.414.336-.75.75-.75h4.5a.75.75 0 0 0 0-1.5h-4.5Zm1 3A2.25 2.25 0 0 0 4 6.75v5.5a2.25 2.25 0 0 0 2.25 2.25h4.5A2.25 2.25 0 0 0 13 12.25v-5.5a2.25 2.25 0 0 0-2.25-2.25h-4.5Zm-.75 2.25c0-.414.336-.75.75-.75h4.5c.414 0 .75.336.75.75v5.5a.75.75 0 0 1-.75.75h-4.5a.75.75 0 0 1-.75-.75v-5.5Z",
      // Sharpened pencil: tapered nib, barrel, and a detached ferrule/eraser cap.
      // The two subpaths make it read as a pencil rather than a diagonal wedge, and
      // the ink box is symmetric about (8, 8) so it centres in any square treatment.
      pencil: "M10.868 7.565 5.847 12.585 3.016 13.514A.42.42 0 0 1 2.486 12.984L3.415 10.153 8.435 5.132ZM11.645 6.787 13.272 5.161A.9.9 0 0 0 13.272 3.888L12.112 2.728A.9.9 0 0 0 10.839 2.728L9.213 4.355Z",
      "lock-closed": "M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z",
      repository: "M3 1.5A1.5 1.5 0 0 0 1.5 3v9.25A2.25 2.25 0 0 0 3.75 14.5H14a.75.75 0 0 0 .75-.75V3A1.5 1.5 0 0 0 13.25 1.5H3Zm0 1.5h10.25v8.5H3.75c-.263 0-.516.045-.75.128V3Zm.75 2.25A.75.75 0 0 1 6.5 4.5h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1-.75-.75Z",
      "arrow-path": "M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08.932.75.75 0 0 1-1.3-.75 6 6 0 0 1 9.44-1.242l.842.84V3.227a.75.75 0 0 1 .75-.75Zm-.911 7.5A.75.75 0 0 1 13.2 11a6 6 0 0 1-9.44 1.241l-.84-.84v1.372a.75.75 0 0 1-1.5 0V9.591a.75.75 0 0 1 .75-.75H5.35a.75.75 0 0 1 0 1.5H3.98l.841.84a4.5 4.5 0 0 0 7.08-.932.75.75 0 0 1 1.025-.272Z",
      "exclamation-triangle": "M6.701 2.25c.577-1 2.02-1 2.598 0l5.196 9a1.5 1.5 0 0 1-1.299 2.25H2.804a1.5 1.5 0 0 1-1.299-2.25l5.196-9ZM8 5a.75.75 0 0 1 .75.75v2.5a.75.75 0 0 1-1.5 0v-2.5A.75.75 0 0 1 8 5Zm0 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
      robot: "M6.5 1.75a1.5 1.5 0 0 1 3 0v.5h1.75A2.75 2.75 0 0 1 14 5v5a2.75 2.75 0 0 1-2.75 2.75h-.5v1a.75.75 0 0 1-1.5 0v-1h-2.5v1a.75.75 0 0 1-1.5 0v-1h-.5A2.75 2.75 0 0 1 2 10V5a2.75 2.75 0 0 1 2.75-2.75H6.5v-.5Zm-1.75 2A1.25 1.25 0 0 0 3.5 5v5c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V5c0-.69-.56-1.25-1.25-1.25h-6.5ZM6 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm4 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM5.75 9h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5Z",
      clock: "M8 1.25a6.75 6.75 0 1 0 0 13.5 6.75 6.75 0 0 0 0-13.5Zm0 1.5A5.25 5.25 0 1 1 8 13.25 5.25 5.25 0 0 1 8 2.75Zm.75 1.5a.75.75 0 0 0-1.5 0V8c0 .2.08.39.22.53l2.5 2.5a.75.75 0 1 0 1.06-1.06L8.75 7.69V4.25Z",
      ellipsis: "M3.75 8a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm5.5 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm5.5 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z",
      gear: "M8.75 1.25a.75.75 0 0 0-1.5 0v.58a6.2 6.2 0 0 0-1.38.57l-.41-.41A.75.75 0 0 0 4.4 3.05l.41.41c-.24.44-.43.9-.57 1.38h-.58a.75.75 0 0 0 0 1.5h.58c.14.48.33.94.57 1.38l-.41.41A.75.75 0 1 0 5.46 9.2l.41-.41c.44.24.9.43 1.38.57v.58a.75.75 0 0 0 1.5 0v-.58a6.2 6.2 0 0 0 1.38-.57l.41.41a.75.75 0 1 0 1.06-1.06l-.41-.41c.24-.44.43-.9.57-1.38h.58a.75.75 0 0 0 0-1.5h-.58a6.2 6.2 0 0 0-.57-1.38l.41-.41A.75.75 0 0 0 10.54 2l-.41.41a6.2 6.2 0 0 0-1.38-.57v-.59ZM8 7.5a1.9 1.9 0 1 1 0-3.8 1.9 1.9 0 0 1 0 3.8Z",
      hash: "M5.25 1.5 4.75 4.5H2V6h2.5l-.667 4H1v1.5h2.583l-.5 3h1.521l.5-3h4l-.5 3h1.521l.5-3H13.5V10h-2.625l.667-4H14V4.5h-2.208l.5-3h-1.521l-.5 3h-4l.5-3H5.25ZM6.02 6h4l-.667 4h-4l.667-4Z",
      sparkle: "M8 1.25a.75.75 0 0 1 .72.54l.52 1.83a4.5 4.5 0 0 0 3.14 3.14l1.83.52a.75.75 0 0 1 0 1.44l-1.83.52a4.5 4.5 0 0 0-3.14 3.14l-.52 1.83a.75.75 0 0 1-1.44 0l-.52-1.83a4.5 4.5 0 0 0-3.14-3.14l-1.83-.52a.75.75 0 0 1 0-1.44l1.83-.52a4.5 4.5 0 0 0 3.14-3.14l.52-1.83A.75.75 0 0 1 8 1.25Z",
      "bars-3": "M2 4.75A.75.75 0 0 1 2.75 4h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75Zm0 3.5A.75.75 0 0 1 2.75 7.5h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 8.25Zm0 3.5a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75Z"
    };
    return '<svg class="ic' + (extra ? " " + extra : "") + '" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="' + paths[name] + '"/></svg>';
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function api(path, options) {
    return fetch(path, Object.assign({ credentials: "same-origin" }, options || {})).then(function (response) {
      return response.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
        if (!response.ok) {
          var message = body && body.error ? body.error : "HTTP " + response.status;
          var err = new Error(message);
          // Keep a server-provided detail (e.g. the wizard's slack_auth_failed
          // carries Slack's machine error code) so callers can surface it.
          if (body && body.detail) err.detail = body.detail;
          // A provider rejection carries the upstream HTTP status (e.g. 401) so
          // the Settings paste flow can echo it verbatim in the .raw-error block.
          if (body && body.status != null) err.providerStatus = body.status;
          // Channel-grant validation returns a ready-to-show message (naming
          // the connected workspace, or explaining a channel_not_found); keep it.
          if (body && body.message) err.serverMessage = body.message;
          err.payload = body;
          err.status = response.status;
          throw err;
        }
        return body;
      });
    });
  }

  function suggestedSkillIndex(skills, suggestion) {
    return skills.findIndex(function (skill) {
      return skill.suggestedSkillId === suggestion.id && skill.name === suggestion.name;
    });
  }

  function isSuggestedSkillSnapshot(skill) {
    return SUGGESTED_SKILLS.some(function (suggestion) {
      return skill.suggestedSkillId === suggestion.id && skill.name === suggestion.name;
    });
  }

  function postJson(path, method, body) {
    return api(path, {
      method: method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  function activeChannelProjection() {
    if (!state.active) return null;
    return (state.channelIndex || []).find(function (channel) {
      return channel.workspaceId === state.active.workspaceId && channel.channelId === state.active.channelId;
    }) || null;
  }

  function firstWorkspaceGrant() {
    return state.grants[0] || null;
  }

  function defaultChannelFormWorkspaceId() {
    if (state.active && state.active.workspaceId) return state.active.workspaceId;
    var grant = firstWorkspaceGrant();
    return connectedTeamId() || (grant ? grant.workspaceId : "");
  }

  function syncChannelFormWorkspacePrefill() {
    if (!state.channelFormDraft.workspaceId) {
      state.channelFormDraft.workspaceId = defaultChannelFormWorkspaceId();
    }
  }

  function agentById(id) {
    return state.agents.find(function (agent) { return agent.id === id; }) || null;
  }

  function normalizeChannelLabel(label) {
    return String(label || "").trim().replace(/^#+/, "");
  }

  function channelLabel(assignment) {
    var label = normalizeChannelLabel(assignment && assignment.channelLabel);
    return "#" + (label || String((assignment && assignment.channelId) || "channel"));
  }

  function channelCountLabel(count) {
    return count + " " + (count === 1 ? "channel" : "channels");
  }

  function allGrantsForAgent(agentId) {
    return state.grants.filter(function (grant) { return grant.agentId === agentId; });
  }

  function defaultAgent() {
    return state.agents[0] || null;
  }

  function clearCustomConnectionMode() {
    state.connectionEditor = null;
    state.apiConnectionEditor = null;
    state.customConnectionLane = null;
  }

  function resetRepositoryTransientState() {
    repoPickerSearch.reset();
    state.repositoryPicker = null;
    state.repositoryAddOpen = false;
  }

  function resetSkillImportBrowseTransientState() {
    skillImportRepoSearch.reset();
    if (state.skillImport) state.skillImport.browse = null;
  }

  function resetProfileTransientState() {
    state.profileError = "";
    state.profileConflict = false;
    state.profilePresenceMutation = null;
    state.profileDirty = false;
    state.disableConfirm = false;
    state.profileOverflowOpen = false;
    state.profileReplacementDefaultAgentId = "";
    state.profileTab = "instructions";
    state.suggestedSkillCategory = "featured";
    state.profileRenaming = null;
    state.profileDescriptionEditing = null;
    state.attachPicker = false;
    state.attachChannelSelected = "";
    state.attachError = "";
    state.attachNotice = "";
    state.skillEditor = null;
    resetSkillImportBrowseTransientState();
    state.skillImport = null;
    clearCustomConnectionMode();
    state.connectorGallerySearch = "";
    state.connectionRemove = null;
    state.apiConnectionRemove = null;
    state.connectionAccountForm = null;
    resetRepositoryTransientState();
    state.modelPickerOpen = false;
    state.modelPickerFilter = "";
  }

  // Open a profile's edit screen (from a click or a route), resetting every
  // transient editor state.
  function openProfileEditor(selected) {
    state.mobileAgentRosterOpen = false;
    state.view = "profiles";
    state.profileScreen = "edit";
    state.editingAgentId = selected.id;
    state.profileLastAgentId = selected.id;
    state.profileDraft = cloneAgent(selected);
    resetProfileTransientState();
    render();
    if (selected.canEdit === false) {
      prepareReadOnlyAgentState(selected.id);
      render();
      return Promise.resolve();
    } else {
      var connectionsLoad = loadAgentConnections(selected.id);
      loadAgentSchedules(selected.id);
      loadOwnerMemory("agent", connectedTeamId(), selected.id);
      return connectionsLoad;
    }
  }

  function prepareReadOnlyAgentState(agentId) {
    state.agentConnections = { agentId: agentId, workspaceId: connectedTeamId(), attached: [], available: [], managedCatalog: [], managedCanConfigure: false, managedConfigurationReadOnly: false, loading: false, error: "", notice: "", legacyFallback: true };
    state.agentSchedules = { agentId: agentId, viewerMembershipId: "", schedules: [], members: [], loading: false, busy: "", error: "", notice: "" };
    state.ownerMemory = {
      ownerKind: "agent", workspaceId: connectedTeamId() || "workspace", ownerId: agentId,
      detail: null, draft: null, dirty: false, loading: false, busy: "", error: "", notice: "", conflict: null,
      requestId: state.ownerMemory.requestId + 1
    };
  }

  function openNewProfile() {
    state.mobileAgentRosterOpen = false;
    state.view = "profiles";
    state.profileScreen = "create";
    state.profileDraft = newProfileDraft();
    state.editingAgentId = null;
    resetProfileTransientState();
    state.agentConnections = { agentId: "", workspaceId: connectedTeamId(), attached: [], available: [], managedCatalog: [], managedCanConfigure: false, managedConfigurationReadOnly: false, loading: false, error: "", notice: "" };
    state.agentSchedules = { agentId: "", viewerMembershipId: "", schedules: [], members: [], loading: false, busy: "", error: "", notice: "" };
    render();
  }

  function openDuplicateProfile(selected) {
    var baseName = String(selected.name || "Agent").trim() + " copy";
    var name = baseName;
    var suffix = 2;
    var occupiedIds = new Set(state.agents.map(function (agent) { return agent.id; }));
    while (occupiedIds.has(slugId(name))) {
      name = baseName + " " + suffix;
      suffix += 1;
    }
    var draft = newProfileDraft();
    draft.name = name;
    draft.description = selected.description || "";
    draft.handle = handleFromAgentName(name);
    draft.instructions = selected.instructions || "";
    draft.model = selected.model || "";
    draft.skills = (selected.skills || []).map(function (skill) {
      var copy = {
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        enabled: skill.enabled
      };
      if (skill.suggestedSkillId !== undefined) copy.suggestedSkillId = skill.suggestedSkillId;
      return copy;
    });
    draft.duplicateSourceName = selected.name || "Agent";
    state.mobileAgentRosterOpen = false;
    state.view = "profiles";
    state.profileScreen = "create";
    state.profileDraft = draft;
    state.editingAgentId = null;
    resetProfileTransientState();
    state.agentConnections = { agentId: "", workspaceId: connectedTeamId(), attached: [], available: [], managedCatalog: [], managedCanConfigure: false, managedConfigurationReadOnly: false, loading: false, error: "", notice: "" };
    state.agentSchedules = { agentId: "", viewerMembershipId: "", schedules: [], members: [], loading: false, busy: "", error: "", notice: "" };
    render();
  }

  // ---- URL routing ----------------------------------------------------------
  // The address bar mirrors the main-panel destination. render() pushes the
  // canonical path when it changes; popstate and the initial deep link apply
  // the inverse. Headless test harnesses have no history/location — every
  // touchpoint no-ops there.
  var canNavigate = typeof history !== "undefined" && typeof location !== "undefined" && !!history.pushState;
  // URL sync stays off until the boot sequence has applied the initial route,
  // so the first data render can't clobber a deep link before it is read.
  var routeReady = false;

  function canonicalPath() {
    if (state.view === "onboarding") return "/admin/onboarding";
    if (state.view === "usage") return "/admin/usage";
    if (state.view === "team") return "/admin/team";
    if (state.view === "settings") {
      if (state.settingsSection === "slack") {
        return "/admin/settings/slack";
      }
      return "/admin/settings/" + encodeURIComponent(state.settingsSection);
    }
    if (state.view === "audit") {
      return "/admin/audit-logs/scheduled-work" + (state.scheduledSelection ? "/" + encodeURIComponent(state.scheduledSelection) : "");
    }
    if (state.view === "profiles") {
      if (state.profileScreen === "create") return "/admin/agents/new";
      if (state.profileScreen === "edit" && state.editingAgentId) return "/admin/agents/" + encodeURIComponent(state.editingAgentId);
      return "/admin/agents";
    }
    if (state.channelScreen === "detail" && state.active) return "/admin/channels/" + encodeURIComponent(state.active.workspaceId) + "/" + encodeURIComponent(state.active.channelId);
    return "/admin/channels";
  }

  // Some deep-linkable UI state (currently the Scheduled Work summary modal)
  // is not a new page. Keep it out of the scroll-reset identity so opening and
  // closing an overlay never loses the underlying list position.
  function pagePositionKey() {
    if (state.view === "audit") return "/admin/audit-logs/scheduled-work";
    return canonicalPath();
  }

  function syncUrl(replace) {
    if (!canNavigate || !routeReady) return;
    var canonical = canonicalPath();
    if (location.pathname === canonical) return;
    if (replace) history.replaceState(null, "", canonical);
    else history.pushState(null, "", canonical);
  }

  // Apply a URL path to state — the inverse of canonicalPath(). Unknown paths
  // land on the channels view.
  function applyRoute(pathname) {
    var parts = String(pathname || "").split("/").filter(Boolean).map(function (part) {
      try { return decodeURIComponent(part); } catch (err) { return part; }
    });
    state.leavePrompt = null;
    if (parts[1] === "onboarding") {
      state.view = "onboarding";
      state.channelScreen = "overview";
      state.profileScreen = "list";
      render();
      return;
    }
    if (parts[1] === "usage" && USAGE_ADMIN_UI) { applyUsageQuery(location.search || ""); openUsage(); return; }
    if (parts[1] === "team") { openTeam(); return; }
    if (parts[1] === "settings") {
      openSettings(parts[2] || "providers");
      return;
    }
    if (parts[1] === "audit-logs") {
      if (parts[2] === "scheduled-work") {
        openScheduledWork(parts[3] || "");
        return;
      }
      openAuditLogs(parts[3] || "", parts[4] || "", parts[5] || "");
      return;
    }
    if (parts[1] === "agents") {
      if (parts[2] === "new") {
        openNewProfile();
        return;
      }
      if (parts[2]) {
        var routedAgent = agentById(parts[2]);
        if (routedAgent) return openProfileEditor(routedAgent);
      }
      enterProfiles(null);
      return;
    }
    if (parts[1] === "channels" && parts[2] && parts[3]) {
      state.view = "channels";
      state.channelScreen = "detail";
      state.profileScreen = "list";
      selectActive(parts[2], parts[3]);
      render();
      return;
    }
    if (parts[1] === "channels") {
      openChannels();
      return;
    }
    var initialAgent = state.agents[0] || null;
    if (initialAgent) return openProfileEditor(initialAgent);
    else enterProfiles(null);
  }

  function render() {
    var renderedPath = pagePositionKey();
    var resetPagePosition = routeReady && !!lastRenderedPath && renderedPath !== lastRenderedPath;
    lastRenderedPath = renderedPath;
    var app = document.getElementById("app");
    if (app.removeAttribute) app.removeAttribute("aria-busy");
    var overlays = teamConfirmModalHtml() + composioSetupModalHtml() + managedAuthorizationModalHtml() + connectorSettingsConfirmModalHtml() + leavePromptModalHtml() + connectionRemoveModalHtml() + apiConnectionRemoveModalHtml() + slackDisconnectModalHtml() + githubDisconnectModalHtml() + sandboxConfirmModalHtml() + scheduledRoutineSummaryModalHtml() + scheduledDeleteModalHtml();
    if (state.view === "onboarding") {
      app.className = "frame onboarding-frame";
      app.innerHTML = onboardingShellHtml() + overlays;
    } else {
      var adminSurfaceClass = "";
      if (state.view === "profiles") {
        adminSurfaceClass = " admin-surface" + (state.profileScreen === "edit" ? " admin-surface-agent-detail" : "");
      } else if (state.view === "channels" && state.channelScreen === "overview") {
        adminSurfaceClass = " admin-surface admin-surface-channels-index";
      } else if (state.view === "channels" && state.channelScreen === "detail") {
        adminSurfaceClass = " admin-surface admin-surface-channel-detail";
      }
      app.className = "frame" + (isPrimaryAdminSurface() ? " primary-admin-shell" : "") + adminSurfaceClass;
      app.innerHTML = topbarHtml() + '<div class="body">' + railHtml() + mainHtml() + "</div>" + overlays;
    }
    if (state.view === "onboarding" && state.slackOnboardingFocus) {
      var pendingOnboardingFocus = state.slackOnboardingFocus;
      var onboardingFocus = document.getElementById(state.slackOnboardingFocus) ||
        document.querySelector('[data-action="' + state.slackOnboardingFocus + '"]');
      state.slackOnboardingFocus = "";
      if (onboardingFocus && onboardingFocus.focus) onboardingFocus.focus();
      if (pendingOnboardingFocus === "onboarding-channel-heading" && !state.slackChannels) {
        state.slackOnboardingFocus = pendingOnboardingFocus;
      }
    }
    if (state.mobileAgentRosterFocus) {
      var mobileRosterFocus = state.mobileAgentRosterFocus === "close"
        ? document.querySelector('[data-action="mobile-agents-close"]')
        : document.querySelector('.topbar-menu > summary');
      state.mobileAgentRosterFocus = "";
      if (mobileRosterFocus && mobileRosterFocus.focus) mobileRosterFocus.focus();
    }
    if (state.teamConfirm) {
      [document.querySelector(".topbar"), document.querySelector(".body")].forEach(function (region) {
        if (!region) return;
        region.inert = true;
        if (region.setAttribute) region.setAttribute("aria-hidden", "true");
      });
      var teamConfirmCancel = document.querySelector('[data-action="team-confirm-cancel"]');
      if (teamConfirmCancel && teamConfirmCancel.focus) teamConfirmCancel.focus();
    }
    if (state.composioSetup || state.managedAuthorization || state.connectorSettings.confirm) {
      [document.querySelector(".topbar"), document.querySelector(".body")].forEach(function (region) {
        if (!region) return;
        region.inert = true;
        if (region.setAttribute) region.setAttribute("aria-hidden", "true");
      });
    }
    // The disconnect confirmation is a true modal: keep the rest of the app
    // out of the focus and accessibility trees until it is resolved.
    if (state.slackDisconnectConfirm) {
      [document.querySelector(".topbar"), document.querySelector(".body")].forEach(function (region) {
        if (!region) return;
        region.inert = true;
        if (region.setAttribute) region.setAttribute("aria-hidden", "true");
      });
      // Any background request can replace the page while the modal is open.
      // Re-home focus after every render so it never falls back to <body>.
      if (state.slackDisconnectBusy) focusSlackDisconnectDialog();
      else if (state.slackDisconnectError) focusSlackLiveRegion("slack-disconnect-error");
      else focusAction("slack-disconnect-cancel");
    }
    if (state.githubDisconnectConfirm) {
      [document.querySelector(".topbar"), document.querySelector(".body")].forEach(function (region) {
        if (!region) return;
        region.inert = true;
        if (region.setAttribute) region.setAttribute("aria-hidden", "true");
      });
      if (state.githubBusy === "disconnect") focusGithubDisconnectDialog();
      else if (state.githubDisconnectError) focusSlackLiveRegion("github-disconnect-error");
      else focusAction("github-disconnect-cancel");
    }
    if (state.sandboxConfirm) {
      [document.querySelector(".topbar"), document.querySelector(".body")].forEach(function (region) {
        if (!region) return;
        region.inert = true;
        if (region.setAttribute) region.setAttribute("aria-hidden", "true");
      });
      var sandboxConfirmFocus = state.sandboxSaving
        ? document.querySelector('[data-role="sandbox-confirm-dialog"]')
        : state.sandboxError
          ? document.querySelector('[data-role="sandbox-confirm-error"]')
          : document.querySelector('[data-action="sandbox-confirm-cancel"]');
      if (sandboxConfirmFocus && sandboxConfirmFocus.focus) sandboxConfirmFocus.focus();
    }
    if (state.scheduledSelection && !state.scheduledInspector && !state.scheduledDeleteConfirm) {
      [document.querySelector(".topbar"), document.querySelector(".body")].forEach(function (region) {
        if (!region) return;
        region.inert = true;
        if (region.setAttribute) region.setAttribute("aria-hidden", "true");
      });
      var routineSummaryClose = document.querySelector('[data-action="scheduled-summary-close"]');
      if (routineSummaryClose && routineSummaryClose.focus) routineSummaryClose.focus();
    }
    if (state.scheduledDeleteConfirm) {
      [document.querySelector(".topbar"), document.querySelector(".body")].forEach(function (region) {
        if (!region) return;
        region.inert = true;
        if (region.setAttribute) region.setAttribute("aria-hidden", "true");
      });
      var routineDeleteCancel = document.querySelector('[data-action="scheduled-delete-cancel"]');
      if (routineDeleteCancel && routineDeleteCancel.focus) routineDeleteCancel.focus();
    }
    syncUrl();
    // Replacing the old nested .main scroller used to make every destination
    // start at the top. Document scrolling keeps its offset across innerHTML
    // replacement, so preserve that navigation contract explicitly while
    // leaving same-page status and picker renders in place.
    if (resetPagePosition && typeof window !== "undefined" && typeof window.scrollTo === "function") {
      window.scrollTo(0, 0);
    }
    syncOnboardingActivity();
  }

  // Inline Agent controls can re-render the whole shell below the fold.
  // Preserve both the legacy nested .main position and the document position:
  // the primary shell now grows naturally, while other Admin surfaces may
  // still use the inner scroller.
  function renderPreservingPagePosition() {
    var currentMain = document.querySelector(".main");
    var scrollTop = currentMain ? currentMain.scrollTop : 0;
    var scrollLeft = currentMain ? currentMain.scrollLeft : 0;
    var pageX = typeof window !== "undefined" ? (window.scrollX || window.pageXOffset || 0) : 0;
    var pageY = typeof window !== "undefined" ? (window.scrollY || window.pageYOffset || 0) : 0;
    var active = document.activeElement;
    var activeId = active && active.id ? active.id : "";
    var caret = null;
    if (activeId) {
      try { caret = active.selectionStart; } catch (error) { caret = null; }
    }
    render();
    var nextMain = document.querySelector(".main");
    if (nextMain) {
      if (nextMain.scrollTop !== scrollTop) nextMain.scrollTop = scrollTop;
      if (nextMain.scrollLeft !== scrollLeft) nextMain.scrollLeft = scrollLeft;
    }
    if (activeId) {
      var nextActive = document.getElementById(activeId);
      if (nextActive && nextActive.focus) {
        try { nextActive.focus({ preventScroll: true }); } catch (error) { nextActive.focus(); }
        if (caret != null && nextActive.setSelectionRange) {
          try { nextActive.setSelectionRange(caret, caret); } catch (error) { /* ignore */ }
        }
      }
    }
    // Focus restoration can itself scroll an off-screen input into view in
    // browsers that ignore preventScroll. Make page position the final state.
    if (typeof window !== "undefined" && typeof window.scrollTo === "function") {
      var nextPageX = window.scrollX || window.pageXOffset || 0;
      var nextPageY = window.scrollY || window.pageYOffset || 0;
      if (nextPageX !== pageX || nextPageY !== pageY) window.scrollTo(pageX, pageY);
    }
  }

  function renderSlackChannelCatalogState(preserveAgentId) {
    var activeAgentId = state.profileDraft && state.profileDraft.id;
    if (
      state.view === "profiles" &&
      state.profileScreen === "edit" &&
      (state.attachPicker || (preserveAgentId && activeAgentId === preserveAgentId))
    ) {
      renderPreservingPagePosition();
      return;
    }
    render();
  }

  function leavePromptModalHtml() {
    if (!state.leavePrompt) return "";
    var subject = state.leavePrompt.kind === "channel" ? "Channel" : "Agent";
    return '<div class="modal-backdrop">' +
      '<div class="modal-card" role="dialog" aria-modal="true" aria-label="Unsaved changes">' +
      '<h2 class="modal-title">Unsaved changes</h2>' +
      '<p class="modal-body">This ' + subject + ' has changes you haven&rsquo;t saved. Save them before leaving, or discard them.</p>' +
      '<div class="modal-foot">' +
      '<button type="button" class="btn btn-ghost" data-action="leave-cancel">Keep editing</button>' +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn btn-danger" data-action="leave-discard">Discard &amp; leave</button>' +
      '<button type="button" class="btn btn-primary" data-action="leave-save">Save changes</button>' +
      '</div></div></div>';
  }

  function composioSetupModalHtml() {
    var setup = state.composioSetup;
    if (!setup) return "";
    var busy = setup.phase === "validating" || setup.phase === "preparing";
    var title = "Set up " + setup.label;
    var providerLink = 'In Composio, open Settings &rarr; Project Settings &rarr; API Keys. <a class="hint-link" href="https://dashboard.composio.dev" target="_blank" rel="noopener noreferrer">Open Composio &nearr;</a>';
    var body;
    if (!setup.canConfigure) {
      body = '<div class="managed-setup-intro"><p>' + esc(setup.label) + ' is available in Chickpea, but managed connectors must first be enabled by a Chickpea owner or admin.</p>' +
        '<p class="hint">Ask an owner or admin to open Settings &rarr; Connectors and enable managed connectors for this installation.</p></div>' +
        '<div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="composio-setup-close">Close</button><span class="spacer"></span><button type="button" class="btn btn-soft" data-action="composio-setup-settings">View Connectors settings</button></div>';
    } else if (setup.deploymentManaged) {
      body = '<div class="managed-setup-intro"><p>' + esc(setup.label) + ' is available in Chickpea and this installation already supplies its project key through deployment configuration.</p>' +
        '<p class="hint">Open Settings &rarr; Connectors and prepare the standard connector defaults. The deployment key stays read-only in Admin.</p></div>' +
        '<div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="composio-setup-close">Close</button><span class="spacer"></span><button type="button" class="btn btn-primary" data-action="composio-setup-settings">Open Connectors settings</button></div>';
    } else {
      var setupPreset = (REUSABLE_CONNECTOR_PRESETS || []).find(function (preset) {
        return preset.id === setup.presetId;
      }) || {
        id: setup.presetId,
        logoId: setup.toolkit,
        name: setup.label,
        accent: "#dda126"
      };
      var phaseCopy = setup.phase === "validating"
        ? "Checking this project key&hellip;"
        : setup.phase === "preparing"
          ? "Preparing managed connectors&hellip;"
          : setup.phase === "selected_unavailable"
            ? setup.label + " still needs additional setup. Other connectors that finished are ready to use."
            : "";
      body = '<div class="managed-setup-intro"><div class="managed-setup-connector">' + connectorLogoHtml(setupPreset) +
        '<div><strong>' + esc(setup.label) + '</strong><p class="hint">' + esc(setup.description) + '</p></div></div>' +
        '<p>One Composio project unlocks Chickpea&rsquo;s managed connectors. Add its project key once; Chickpea prepares the standard connector setup for you.</p>' + providerLink + '</div>' +
        '<div class="field"><label class="field-label" for="composio-project-key">Composio project key</label><input class="input mono" id="composio-project-key" type="password" autocomplete="off" value="' + esc(setup.key || "") + '" data-action="composio-setup-key" aria-describedby="composio-project-key-help' + (setup.error ? ' composio-project-key-error' : '') + '"' + (busy ? ' disabled' : '') + '><p class="hint" id="composio-project-key-help">Stored encrypted and never shown again.</p>' +
        (setup.error ? '<p class="field-error" id="composio-project-key-error" role="alert">' + esc(setup.error) + '</p>' : '') + '</div>' +
        (phaseCopy ? '<p class="managed-setup-progress' + (setup.phase === "selected_unavailable" ? ' error' : '') + '" role="' + (setup.phase === "selected_unavailable" ? 'alert' : 'status') + '" aria-live="' + (setup.phase === "selected_unavailable" ? 'assertive' : 'polite') + '">' + phaseCopy + '</p>' : '') +
        '<div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="composio-setup-close"' + (busy ? ' disabled' : '') + '>Cancel</button><span class="spacer"></span>' +
        (setup.phase === "selected_unavailable" ? '<button type="button" class="btn btn-soft" data-action="composio-setup-settings">Review connector status</button>' : '') +
        '<button type="button" class="btn btn-primary" data-action="composio-setup-save"' + (busy || !String(setup.key || "").trim() ? ' disabled' : '') + '>' + (busy ? "Setting up&hellip;" : "Save key and continue") + '</button></div>';
    }
    return '<div class="modal-backdrop"><div class="modal-card managed-setup-modal" role="dialog" aria-modal="true" aria-labelledby="composio-setup-title" tabindex="-1" data-role="composio-setup-dialog"><h2 class="modal-title" id="composio-setup-title">' + esc(title) + '</h2>' + body + '</div></div>';
  }

  function managedAuthorizationModalHtml() {
    var current = state.managedAuthorization;
    if (!current) return "";
    var failed = current.status === "failed";
    var cancelling = current.status === "cancelling";
    var statusCopy = failed
      ? current.error
      : cancelling
        ? "Canceling this sign-in safely&hellip;"
        : current.error || "Waiting for you to approve access in the sign-in tab.";
    return '<div class="modal-backdrop"><div class="modal-card managed-setup-modal" role="dialog" aria-modal="true" aria-labelledby="managed-auth-title" tabindex="-1" data-role="managed-auth-dialog">' +
      '<h2 class="modal-title" id="managed-auth-title">Connect ' + esc(current.label) + '</h2>' +
      '<div class="managed-waiting"><span class="managed-waiting-mark" aria-hidden="true">' + (failed ? '!' : '<span class="spinner"></span>') + '</span><div><strong>' + (failed ? 'Sign-in needs attention' : 'Finish sign-in in the new tab') + '</strong><p class="hint" role="' + (failed ? 'alert' : 'status') + '" aria-live="' + (failed ? 'assertive' : 'polite') + '">' + esc(statusCopy) + '</p></div></div>' +
      (current.popupBlocked && !failed ? '<p class="callout">Your browser did not open the hosted sign-in tab. Use Open sign-in below.</p>' : '') +
      '<div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="managed-auth-cancel"' + (cancelling ? ' disabled' : '') + '>' + (cancelling ? 'Canceling&hellip;' : 'Cancel') + '</button><span class="spacer"></span>' +
      (failed ? '<button type="button" class="btn btn-soft" data-action="managed-auth-retry">Check again</button>' : '') +
      '<button type="button" class="btn btn-primary" data-action="managed-auth-open"' + (cancelling ? ' disabled' : '') + '>Open sign-in &nearr;</button></div></div></div>';
  }

  function topbarHtml() {
    // Desktop section navigation lives persistently at the bottom of the rail.
    // This duplicate action row is mobile-only and is revealed by the hamburger.
    var slackPresentation = slackConnectionPresentation();
    var connectedBadge = isSlackConnected()
      ? '<span class="badge ' + (slackPresentation.key === "connected" ? "badge-on" : "badge-off") + '"><span class="dot"></span>' + esc(slackPresentation.label) + '</span>'
      : "";
    var scoped = isAgentChannelSurface();
    var mobileRoster = scoped && state.mobileAgentRosterOpen;
    var actions = mobileRoster
      ? mobileAgentRosterHtml()
      : connectedBadge +
        '<button type="button" class="btn btn-soft' + (primarySection() === "profiles" ? " nav-active" : "") + '" data-action="' + (scoped ? "mobile-agents-open" : "open-profiles") + '" data-section-switcher="true">Agents</button>' +
        '<button type="button" class="btn btn-soft' + (primarySection() === "channels" ? " nav-active" : "") + '" data-action="open-channels" data-section-switcher="true">Channels</button>' +
        '<button type="button" class="btn btn-soft' + (primarySection() === "team" ? " nav-active" : "") + '" data-action="open-team" data-section-switcher="true">Team</button>' +
        (USAGE_ADMIN_UI ? '<button type="button" class="btn btn-soft' + (primarySection() === "usage" ? " nav-active" : "") + '" data-action="open-usage" data-section-switcher="true">Usage</button>' : '') +
        '<button type="button" class="btn btn-soft' + (primarySection() === "settings" ? " nav-active" : "") + '" data-action="open-settings" data-section-switcher="true">Settings</button>';
    // The brand doubles as a home affordance to the canonical Agent.
    return '<header class="topbar' + (scoped ? ' admin-mobile-topbar' : '') + '">' +
      '<div class="brand"><button type="button" class="brand-home" data-action="go-home" aria-label="Home">' + peaMarkHtml() + '<span class="brand-name">Chickpea</span></button></div>' +
      '<details class="topbar-menu"' + (mobileRoster ? ' open' : '') + '><summary aria-label="Menu" data-role="mobile-menu-trigger">' + icon("bars-3") + '</summary></details>' +
      '<div class="actions actions-list">' + actions + '</div>' +
      "</header>";
  }

  function peaMarkHtml() {
    return '<span class="avatar"><svg class="pea" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><circle cx="24" cy="25" r="15.5" fill="#E3AC45"></circle><circle cx="17" cy="17.5" r="4.2" fill="#F4D084"></circle><g class="pea-eyes"><circle class="pea-eye" cx="18.5" cy="24" r="1.9" fill="#3B3220"></circle><circle class="pea-eye" cx="29.5" cy="24" r="1.9" fill="#3B3220"></circle></g><g class="pea-lids"><path d="M16.4 24.2 Q18.5 22 20.6 24.2" fill="none" stroke="#3B3220" stroke-width="1.8" stroke-linecap="round"></path><path d="M27.4 24.2 Q29.5 22 31.6 24.2" fill="none" stroke="#3B3220" stroke-width="1.8" stroke-linecap="round"></path></g><path class="pea-smile" d="M19 29 Q24 32.5 29 29" fill="none" stroke="#3B3220" stroke-width="1.8" stroke-linecap="round"></path><path class="pea-grin" d="M18.5 28.5 Q24 35.5 29.5 28.5 Z" fill="#3B3220"></path><circle class="pea-blush" cx="15.5" cy="28.5" r="2" fill="#DC8A4F"></circle><circle class="pea-blush" cx="32.5" cy="28.5" r="2" fill="#DC8A4F"></circle></svg></span>';
  }

  function primarySection() {
    return state.view === "audit" ? "channels" : state.view;
  }

  function isAgentChannelSurface() {
    return state.view === "profiles" || state.view === "channels";
  }

  function isPrimaryAdminSurface() {
    if (state.view === "profiles" || state.view === "channels" || state.view === "team" || state.view === "usage") return true;
    if (state.view !== "settings") return false;
    return true;
  }

  function selectedAgentIdForRoster() {
    if (state.view === "profiles" && state.profileScreen === "edit") return state.editingAgentId || "";
    return "";
  }

  function agentIconVariant(agentId) {
    var value = String(agentId || "");
    var hash = 0;
    for (var index = 0; index < value.length; index += 1) hash += value.charCodeAt(index);
    return hash % 3;
  }

  function agentPlacementMeta(agent) {
    var channelCount = channelGrantsForAgent(agent.id).length;
    return channelCountLabel(channelCount) + (agentHasDmDefault(agent.id) ? " + Direct messages" : "");
  }

  function agentRosterAvatarHtml(agent) {
    var avatarUrl = agent.slackPresence && agent.slackPresence.avatar && agent.slackPresence.avatar.url;
    if (avatarUrl) {
      return '<span class="agent-roster-icon has-avatar" aria-hidden="true"><img src="' + esc(avatarUrl) + '" alt=""></span>';
    }
    return '<span class="agent-roster-icon variant-' + agentIconVariant(agent.id) + '" aria-hidden="true">' + icon("robot") + '</span>';
  }

  function agentRosterItemsHtml() {
    var selectedAgentId = selectedAgentIdForRoster();
    return state.agents.map(function (agent) {
      var active = agent.id === selectedAgentId;
      var meta = agentPlacementMeta(agent);
      return '<button type="button" class="agent-roster-item' + (active ? ' active' : '') + '" data-action="edit-profile" data-agent="' + esc(agent.id) + '"' +
        (active ? ' aria-current="page"' : '') + ' aria-label="Open Agent ' + esc(agent.name) + ', ' + esc(meta) + '">' +
        agentRosterAvatarHtml(agent) +
        '<span class="agent-roster-copy"><span class="agent-roster-name" title="' + esc(agent.name) + '">' + esc(agent.name) + '</span>' +
        '<span class="agent-roster-meta" title="' + esc(meta) + '">' + esc(meta) + '</span></span></button>';
    }).join("");
  }

  function mobileAgentRosterHtml() {
    return '<div class="mobile-agent-roster" role="group" aria-label="Choose an Agent">' +
      '<div class="mobile-agent-roster-head"><strong>Agents</strong><button type="button" class="btn btn-ghost btn-sm" data-action="mobile-agents-close">Close</button></div>' +
      agentRosterItemsHtml() +
      '<button type="button" class="agent-roster-item agent-roster-add" data-action="new-profile">' + icon("plus") + 'New Agent</button></div>';
  }

  function sectionSwitcherHtml() {
    var active = primarySection();
    var sections = [
      { id: "profiles", label: "Agents", action: "open-profiles" },
      { id: "channels", label: "Channels", action: "open-channels" },
      { id: "team", label: "Team", action: "open-team" }
    ];
    if (USAGE_ADMIN_UI) sections.push({ id: "usage", label: "Usage", action: "open-usage" });
    sections.push({ id: "settings", label: "Settings", action: "open-settings" });
    return '<nav class="section-switcher" aria-label="Admin navigation">' +
      sections.map(function (section) {
        var selected = active === section.id;
        return '<button type="button" class="section-nav-item' + (selected ? " active" : "") + '" data-action="' + section.action + '" data-section-switcher="true"' +
          (selected ? ' aria-current="page"' : '') + '>' + section.label + '</button>';
      }).join("") + '</nav>';
  }

  // The connected workspace's display name for a rail group header: the friendly
  // team name for the workspace Chickpea is installed in, else the raw workspace id
  // (multiple workspaces can be grouped; only the connected one has a name).
  function railGroupLabel(workspaceId) {
    if (isSlackConnected() && workspaceId === connectedTeamId()) return connectedTeamName();
    return workspaceId || "Workspace";
  }

  function railHtml() {
    if (state.view === "onboarding") return onboardingRailHtml();
    if (state.view === "usage") return usageRailHtml();
    if (state.view === "team") return teamRailHtml();
    if (isAgentChannelSurface()) return profilesRailHtml();
    if (state.view === "settings") return settingsRailHtml();
    if (state.view === "audit") return scheduledWorkRailHtml();
    return channelsRailHtml();
  }

  function primaryShellBrandHtml() {
    return '<div class="primary-shell-brand"><button type="button" class="brand-home" data-action="go-home" aria-label="Home">' + peaMarkHtml() + '<span class="brand-name">Chickpea</span></button></div>';
  }

  function onboardingRailHtml() {
    var stage = state.onboarding && state.onboarding.stage;
    var current = stage === "connect_slack" ? 0 : stage === "choose_channel" ? 1 : 2;
    var labels = ["Connect Slack", "Choose a channel", "Try Chickpea"];
    return '<nav class="rail" aria-label="Setup progress"><div class="rail-context">' +
      '<div class="rail-head"><span class="section-eyebrow">Get started</span></div>' +
      labels.map(function (label, index) {
        var done = index < current || stage === "complete";
        var active = index === current && stage !== "complete";
        return '<div class="chan-item' + (active ? ' active' : '') + '"' + (active ? ' aria-current="step"' : '') + '>' +
          '<span class="chan-name">' + (done ? '&#10003; ' : (index + 1) + '. ') + esc(label) + '</span></div>';
      }).join("") + '</div>' + sectionSwitcherHtml() + '</nav>';
  }

  function channelsRailHtml() {
    var channels = configuredChannelsForIndex().filter(function (channel) { return channel.configured; });
    var groups = [];
    channels.forEach(function (channel) {
      var group = groups.find(function (candidate) { return candidate.workspaceId === channel.workspaceId; });
      if (!group) {
        group = { workspaceId: channel.workspaceId, channels: [] };
        groups.push(group);
      }
      group.channels.push(channel);
    });
    var html = '<nav class="rail" aria-label="Channels"><div class="rail-context">' +
      '<div class="rail-head"><span class="section-eyebrow">Channels</span></div>' +
      '<button type="button" class="platform-row' + (state.view === "channels" && state.channelScreen === "overview" ? " active" : "") + '" data-action="open-channels">' +
      '<span class="platform-logo slack-logo-image" aria-hidden="true"></span>Slack' +
      (isSlackConnected() ? '<span class="platform-status' + (slackConnectionPresentation().key === "connected" ? '' : ' attention') + '">' + esc(slackConnectionPresentation().label) + '</span>' : '') + '</button>';
    if (channels.length === 0) {
      html += '<div class="ws-row">' + icon("chevron-down") + esc(railGroupLabel(connectedTeamId())) + '</div>' +
        '<div class="empty" style="margin:8px 0 8px 12px; padding:12px;"><p class="hint" style="margin:0;">No channels yet</p></div>';
    } else {
      groups.forEach(function (group) {
        html += '<div class="ws-row">' + icon("chevron-down") + esc(railGroupLabel(group.workspaceId)) + '</div>';
        group.channels.forEach(function (channel) {
          var active = state.channelScreen === "detail" && state.active && state.active.workspaceId === channel.workspaceId && state.active.channelId === channel.channelId;
          var grants = Array.isArray(channel.grants) ? channel.grants : [];
          var names = grants.map(function (grant) {
            var agent = agentById(grant.agentId);
            return grant.agentName || (agent && agent.name) || grant.agentId;
          });
          html += '<button type="button" class="chan-item' + (active ? " active" : "") + '" data-action="select-channel" data-workspace="' + esc(channel.workspaceId) + '" data-channel="' + esc(channel.channelId) + '">' +
            '<span class="chan-name">#' + esc(normalizeChannelLabel(channel.channelName)) + '</span>' +
            '<span class="chan-meta">' + esc(names.length ? names.join(", ") : "No Agents published") + '</span></button>';
        });
      });
    }
    // The picker itself lives in the MAIN panel (rail placement was a walkthrough
    // complaint). The rail add-button is the secondary path to it; disabled only
    // in the transient null-connection state (a failed connection fetch).
    var addDisabled = !isSlackConnected();
    html += '<button type="button" class="rail-add" data-action="toggle-add-channel"' +
      (addDisabled ? ' disabled title="Connect @Chickpea first"' : '') + '>' + icon("plus") + 'Add Slack channel</button>';
    if (addDisabled) {
      html += '<p class="hint" style="margin-left:12px; padding:0 10px;">Connect @Chickpea first</p>';
    }
    return html + '</div>' + sectionSwitcherHtml() + '</nav>';
  }

  function usageRailHtml() {
    return '<nav class="rail primary-shell-sidebar" aria-label="Usage">' + primaryShellBrandHtml() + '<div class="rail-context">' +
      '<div class="rail-head"><span class="section-eyebrow">Usage</span></div>' +
      '<button type="button" class="chan-item active" data-action="open-usage"><span class="chan-name">Overview</span><span class="chan-meta">Spend and usage</span></button>' +
      '</div>' + sectionSwitcherHtml() + '</nav>';
  }

  function teamRailHtml() {
    var members = state.team && state.team.members
      ? state.team.members.filter(function (member) { return member.status !== "removed"; })
      : [];
    return '<nav class="rail primary-shell-sidebar" aria-label="Team">' + primaryShellBrandHtml() + '<div class="rail-context">' +
      '<div class="rail-head"><span class="section-eyebrow">Team</span></div>' +
      '<button type="button" class="chan-item active" data-action="open-team" aria-current="page"><span class="chan-name">Members</span><span class="chan-meta">' + members.length + ' member' + (members.length === 1 ? '' : 's') + '</span></button>' +
      '</div>' + sectionSwitcherHtml() + '</nav>';
  }

  function teamMainHtml() {
    var team = state.team;
    if (state.teamLoading && !team) {
      return '<div class="empty"><h1 class="page-title">Loading your team&hellip;</h1><p class="hint">Reading Chickpea memberships.</p></div>';
    }
    if (!team) {
      return '<div class="empty"><h1 class="page-title">Team is unavailable</h1><p class="error">' + esc(state.teamError || "Could not load team access.") + '</p><button type="button" class="btn btn-soft" data-action="team-retry">Retry</button></div>';
    }
    var members = (team.members || []).filter(function (member) { return member.status !== "removed"; });
    if (team.viewer && team.viewer.membershipId) {
      members.sort(function (left, right) {
        if (left.id === team.viewer.membershipId) return -1;
        if (right.id === team.viewer.membershipId) return 1;
        return 0;
      });
    }
    var notice = state.teamError
      ? '<p class="error" role="alert">' + esc(state.teamError) + '</p>'
      : (state.teamNotice ? '<p class="hint" role="status">' + esc(state.teamNotice) + '</p>' : '');
    return '<div class="team-hero"><div><p class="section-eyebrow">People &amp; access</p><h1 class="page-title">Your team</h1><p class="hint">Manage the people who have interacted with Chickpea in Slack.</p></div><span class="team-count">' + members.length + ' member' + (members.length === 1 ? '' : 's') + '</span></div>' +
      '<div class="team-auto-note"><strong>Membership is automatic.</strong> Full Slack members join automatically the first time they interact with an Agent. Guests and Slack Connect users are not provisioned.</div>' +
      notice +
      '<section class="team-card" aria-labelledby="members-heading"><h2 id="members-heading">Members</h2><p class="hint">Owners can change roles, suspend access, restore access, or permanently remove a member.</p>' +
      (members.length ? '<div class="team-column-guide" aria-hidden="true"><span>Member</span><span>Role</span><span></span></div><div class="team-list">' + members.map(teamMemberRowHtml).join("") + '</div>' : '<p class="team-empty">No one has interacted with an Agent yet.</p>') + '</section>';
  }

  function teamMembershipLabel(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function teamMemberRowHtml(member) {
    var viewer = state.team && state.team.viewer ? state.team.viewer : { role: "admin", membershipId: "" };
    var canManageAccess = viewer.role === "owner" && viewer.membershipId !== member.id && member.status !== "removed";
    var busy = state.teamBusy === "member:" + member.id;
    var label = member.realName || member.displayName || member.slackUserId || "Slack member";
    var menuOpen = state.teamActionMenuId === member.id;
    var accessActions = member.status === "suspended"
      ? '<button type="button" role="menuitem" data-action="team-status-action" data-membership="' + esc(member.id) + '" data-status="active">Restore Chickpea access</button><div class="team-action-divider" role="separator"></div><button type="button" role="menuitem" class="danger" data-action="team-status-action" data-membership="' + esc(member.id) + '" data-status="removed">Remove from Chickpea</button>'
      : '<button type="button" role="menuitem" data-action="team-status-action" data-membership="' + esc(member.id) + '" data-status="suspended">Suspend Chickpea access</button><button type="button" role="menuitem" class="danger" data-action="team-status-action" data-membership="' + esc(member.id) + '" data-status="removed">Remove from Chickpea</button>';
    var actions = canManageAccess
      ? '<div class="team-actions-wrap"><button type="button" class="team-actions-trigger" data-action="team-actions-toggle" data-membership="' + esc(member.id) + '" aria-haspopup="menu" aria-expanded="' + (menuOpen ? 'true' : 'false') + '" aria-label="Actions for ' + esc(label) + '"' + (busy ? ' disabled' : '') + '>' + icon("ellipsis") + '</button>' + (menuOpen ? '<div class="team-action-menu" role="menu" aria-label="Actions for ' + esc(label) + '">' + accessActions + '</div>' : '') + '</div>'
      : '';
    var roleLabel = teamMembershipLabel(member.role);
    var statusLabel = teamMembershipLabel(member.status);
    var canChangeRole = viewer.role === "owner" && member.status === "active";
    var roleControl = canChangeRole
      ? '<span class="team-role-select-wrap"><select class="team-role-select" data-action="team-role-select" data-membership="' + esc(member.id) + '" aria-label="Change role for ' + esc(label) + '"' + (busy ? ' disabled' : '') + '>' + ["member", "admin", "owner"].map(function (role) { return '<option value="' + role + '"' + (role === member.role ? ' selected' : '') + '>' + esc(teamMembershipLabel(role)) + '</option>'; }).join("") + '</select><span class="team-role-select-icon" aria-hidden="true">' + icon("chevron-down") + '</span></span>'
      : '<span class="team-role" aria-label="Role: ' + esc(roleLabel) + '">' + esc(roleLabel) + '</span>';
    var secondary = [];
    if (member.handle) secondary.push("@" + member.handle);
    if (member.contactEmail) secondary.push(member.contactEmail);
    if (!secondary.length) secondary.push(member.slackUserId ? "Slack member · " + member.slackUserId : "Slack identity unavailable");
    var initials = label.split(/\s+/).filter(Boolean).slice(0, 2).map(function (part) { return part.charAt(0); }).join("").toUpperCase() || "?";
    var avatar = member.avatarUrl
      ? '<span class="team-avatar"><img src="' + esc(member.avatarUrl) + '" alt=""></span>'
      : '<span class="team-avatar" aria-hidden="true">' + esc(initials) + '</span>';
    return '<article class="team-row"><div class="team-row-identity">' + avatar + '<div class="team-row-main"><div class="team-row-title">' + esc(label) + (viewer.membershipId === member.id ? ' <span class="team-you">You</span>' : '') + '</div><div class="team-row-sub"><span class="team-row-sub-copy">' + esc(secondary.join(" · ")) + '</span><span class="team-row-sub-separator" aria-hidden="true">·</span><span class="team-access-status ' + esc(member.status) + '" aria-label="Access: ' + esc(statusLabel) + '">' + esc(statusLabel) + '</span></div></div></div>' + roleControl + '<div class="team-row-actions">' + actions + '</div></article>';
  }

  function teamConfirmModalHtml() {
    var confirmation = state.teamConfirm;
    if (!confirmation) return "";
    return '<div class="modal-backdrop"><div class="modal-card" role="dialog" aria-modal="true" aria-label="' + esc(confirmation.confirmLabel) + '">' +
      '<h2 class="modal-title">' + esc(confirmation.title) + '</h2><p class="modal-body">' + esc(confirmation.detail) + '</p>' +
      '<div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="team-confirm-cancel">Cancel</button><span class="spacer"></span><button type="button" class="btn ' + (confirmation.danger ? 'btn-danger' : 'btn-primary') + '" data-action="team-confirm-apply">' + esc(confirmation.confirmLabel) + '</button></div></div></div>';
  }

  function profilesRailHtml() {
    var connected = isSlackConnected();
    var slackPresentation = slackConnectionPresentation();
    var workspaceLabel = railGroupLabel(connectedTeamId());
    var status = connected
      ? '<span class="agent-slack-status' + (slackPresentation.key === "connected" ? '' : ' attention') + '">' + esc(slackPresentation.label) + '</span>'
      : '<span class="agent-slack-status disconnected">Not connected</span>';
    return '<aside class="rail primary-shell-sidebar agent-shell-sidebar">' +
      primaryShellBrandHtml() +
      '<div class="rail-context"><div class="rail-head"><span class="section-eyebrow">Agents</span></div>' +
      '<div class="agent-slack-context"><div class="agent-slack-row"><span class="platform-logo slack-logo-image" aria-hidden="true"></span>Slack' + status + '</div>' +
      '<div class="ws-row agent-workspace-row">' + icon("chevron-down") + esc(workspaceLabel) + '</div></div>' +
      '<nav class="agent-roster" aria-label="Agents">' + agentRosterItemsHtml() +
      '<button type="button" class="agent-roster-item agent-roster-add" data-action="new-profile">' + icon("plus") + 'New Agent</button></nav></div>' +
      sectionSwitcherHtml() + '</aside>';
  }

  function settingsRailHtml() {
    var sections = [
      { id: "slack", name: "Slack", meta: "Installation" },
      { id: "connectors", name: "Connectors", meta: "Managed integrations" },
      { id: "providers", name: "Model providers", meta: "Keys and models" },
      { id: "github", name: "GitHub", meta: "Accounts and access" },
      { id: "sandbox", name: "Coding sandbox", meta: "Workspace runtime" },
      { id: "outbound", name: "Outbound access", meta: "Network policy" }
    ];
    var primaryShell = isPrimaryAdminSurface();
    var html = '<nav class="rail' + (primaryShell ? ' primary-shell-sidebar' : '') + '" aria-label="Settings">' +
      (primaryShell ? primaryShellBrandHtml() : '') + '<div class="rail-context">' +
      '<div class="rail-head"><span class="section-eyebrow">Settings</span></div>';
    sections.forEach(function (section) {
      var active = state.settingsSection === section.id;
      html += '<button type="button" class="chan-item' + (active ? " active" : "") + '" data-action="settings-section" data-section="' + section.id + '"' +
        (active ? ' aria-current="page"' : '') + '><span class="chan-name">' + section.name + '</span><span class="chan-meta">' + section.meta + '</span></button>';
    });
    return html + '</div>' + sectionSwitcherHtml() + '</nav>';
  }

  function usageDateValue(date) {
    return String(date.getFullYear()).padStart(4, "0") + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  }

  function parseUsageDate(value) {
    var match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(String(value || ""));
    if (!match) return null;
    var date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
    return date;
  }

  function usageCustomRange(fromValue, toValue) {
    if (!fromValue || !toValue) return { error: "Choose a start and end date." };
    var fromDate = parseUsageDate(fromValue);
    var endDate = parseUsageDate(toValue);
    if (!fromDate || !endDate) return { error: "Choose valid dates." };
    var todayValue = usageDateValue(new Date());
    if (String(toValue) > todayValue) return { error: "End date cannot be in the future." };
    var to = String(toValue) === todayValue
      ? Date.now() + 1
      : new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() + 1).getTime();
    var from = fromDate.getTime();
    if (to <= from) return { error: "Start date must be on or before end date." };
    if (to - from > 366 * 24 * 60 * 60 * 1000) return { error: "Choose a range of 366 days or less." };
    return { from: from, to: to, error: "" };
  }

  function usageDefaultCustomDates() {
    var to = new Date();
    var from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - 29);
    return { from: usageDateValue(from), to: usageDateValue(to) };
  }

  function usageStartOfWeek(date) {
    var start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    return start;
  }

  function usageRange() {
    var now = new Date();
    var to = now.getTime() + 1;
    if (state.usagePeriod === "custom") {
      var custom = usageCustomRange(state.usageCustomFrom, state.usageCustomTo);
      if (!custom.error) return { from: custom.from, to: custom.to };
    }
    if (state.usagePeriod === "this_month") return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), to: to };
    if (state.usagePeriod === "last_month") return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), to: new Date(now.getFullYear(), now.getMonth(), 1).getTime() };
    if (state.usagePeriod === "this_week") return { from: usageStartOfWeek(now).getTime(), to: to };
    if (state.usagePeriod === "last_week") {
      var thisWeek = usageStartOfWeek(now);
      var lastWeek = new Date(thisWeek.getFullYear(), thisWeek.getMonth(), thisWeek.getDate() - 7);
      return { from: lastWeek.getTime(), to: thisWeek.getTime() };
    }
    var rollingDays = state.usagePeriod === "last_7_days" ? 7 : state.usagePeriod === "last_90_days" ? 90 : 30;
    return { from: to - rollingDays * 24 * 60 * 60 * 1000, to: to };
  }

  function applyUsageQuery(search) {
    if (!search) return;
    var params = new URLSearchParams(search);
    var allowedPeriods = ["last_7_days", "last_30_days", "last_90_days", "this_month", "last_month", "this_week", "last_week", "custom"];
    var period = params.get("period");
    var legacyDays = Number(params.get("days"));
    if (!allowedPeriods.includes(period) && [7, 30, 90].includes(legacyDays)) period = "last_" + legacyDays + "_days";
    if (allowedPeriods.includes(period)) {
      if (period === "custom") {
        var customFrom = params.get("from") || "";
        var customTo = params.get("to") || "";
        var custom = usageCustomRange(customFrom, customTo);
        if (!custom.error) {
          state.usagePeriod = period;
          state.usageCustomFrom = customFrom;
          state.usageCustomTo = customTo;
          state.usageCustomDraftFrom = customFrom;
          state.usageCustomDraftTo = customTo;
        }
      } else {
        state.usagePeriod = period;
      }
    }
    var group = params.get("groupBy");
    if (["channel", "agent", "provider", "model"].includes(group)) state.usageGroupBy = group;
  }

  function syncUsageQueryUrl() {
    if (!canNavigate || !routeReady || state.view !== "usage") return;
    var params = new URLSearchParams();
    params.set("period", state.usagePeriod);
    if (state.usagePeriod === "custom") {
      params.set("from", state.usageCustomFrom);
      params.set("to", state.usageCustomTo);
    }
    params.set("groupBy", state.usageGroupBy);
    history.replaceState(null, "", "/admin/usage?" + params.toString());
  }

  function applyCustomUsageRange() {
    var custom = usageCustomRange(state.usageCustomDraftFrom, state.usageCustomDraftTo);
    if (custom.error) {
      state.usageCustomError = custom.error;
      render();
      return;
    }
    state.usageCustomFrom = state.usageCustomDraftFrom;
    state.usageCustomTo = state.usageCustomDraftTo;
    state.usageCustomError = "";
    state.usageOperationFilter = null;
    syncUsageQueryUrl();
    loadUsage(true);
  }

  function usageQueryPath(path, includeGroup, includeOperationFilter, cursor) {
    var range = usageRange();
    var params = new URLSearchParams();
    params.set("from", String(range.from));
    params.set("to", String(range.to));
    params.set("currency", "USD");
    if (includeGroup) params.set("groupBy", state.usageGroupBy);
    if (cursor) params.set("cursor", cursor);
    if (path.indexOf("operations") >= 0) params.set("limit", "50");
    if (includeOperationFilter && state.usageOperationFilter) {
      var filterNames = {
        profile: "profile", channel: "channel", work_kind: "workKind",
        routine: "routine", provider: "provider", credential: "credential",
        model: "model", status: "status"
      };
      var filterName = filterNames[state.usageOperationFilter.groupBy];
      if (filterName) params.set(filterName, state.usageOperationFilter.value);
    }
    return path + "?" + params.toString();
  }

  function openTeam() {
    state.view = "team";
    state.profileScreen = "list";
    state.disableConfirm = false;
    state.teamError = "";
    state.teamNotice = "";
    state.teamActionMenuId = "";
    state.teamConfirm = null;
    render();
    loadTeam();
  }

  function loadTeam() {
    state.teamLoading = true;
    state.teamError = "";
    render();
    return api("/admin/api/team").then(function (body) {
      state.team = body;
      state.teamLoading = false;
      render();
      return body;
    }).catch(function (error) {
      state.teamLoading = false;
      state.teamError = error.serverMessage || error.message || "Could not load team access.";
      render();
      return null;
    });
  }

  function finishTeamMutation(message) {
    state.teamNotice = message;
    return loadTeam().then(function () {
      state.teamBusy = "";
      render();
    });
  }

  function teamMutationErrorText(error) {
    var message = error && (error.serverMessage || error.message);
    var networkFailure = !error || error.status == null && (
      message === "Failed to fetch" ||
      message === "Load failed" ||
      message === "NetworkError when attempting to fetch resource."
    );
    if (networkFailure) {
      return "Chickpea could not be reached. Reload this page to check whether the change succeeded before trying again.";
    }
    return message || "The team change could not be saved.";
  }

  function failTeamMutation(error) {
    state.teamBusy = "";
    state.teamError = teamMutationErrorText(error);
    render();
  }

  function updateTeamMembership(membershipId, field, value) {
    if (state.teamBusy || !membershipId) return;
    state.teamBusy = "member:" + membershipId;
    state.teamError = "";
    state.teamNotice = "";
    render();
    var body = {};
    body[field] = value;
    postJson("/admin/api/team/memberships/" + encodeURIComponent(membershipId), "PATCH", body)
      .then(function () { return finishTeamMutation("Membership updated."); })
      .catch(failTeamMutation);
  }

  function teamMemberById(membershipId) {
    return state.team && (state.team.members || []).find(function (member) { return member.id === membershipId; });
  }

  function confirmTeamRole(member, role) {
    var label = member.realName || member.displayName || member.slackUserId || "this member";
    var roleLabel = teamMembershipLabel(role);
    var article = role === "member" ? "a" : "an";
    state.teamConfirm = {
      membershipId: member.id,
      field: "role",
      value: role,
      title: "Make " + label + " " + article + " " + roleLabel + "?",
      detail: role === "owner"
        ? "Owners can manage every Chickpea member and change workspace access."
        : "This removes Owner authority. Chickpea will refuse the change if it would leave the workspace without an active Owner.",
      confirmLabel: "Make " + roleLabel,
      danger: false
    };
    render();
  }

  function confirmTeamStatus(member, status) {
    var label = member.realName || member.displayName || member.slackUserId || "this member";
    var removing = status === "removed";
    state.teamConfirm = {
      membershipId: member.id,
      field: "status",
      value: status,
      title: removing ? "Remove " + label + " from Chickpea?" : "Suspend " + label + "'s Chickpea access?",
      detail: removing
        ? "They will lose Chickpea access immediately. Removal is permanent."
        : "They will not be able to use Agents, sign in to Chickpea, or use their personal connections. Scheduled work running as them will pause. Their Agents and saved configuration will remain, and an Owner can restore access later.",
      confirmLabel: removing ? "Remove" : "Suspend Chickpea access",
      danger: true
    };
    render();
  }

  function openUsage() {
    state.view = "usage";
    state.profileScreen = "list";
    state.disableConfirm = false;
    render();
    if (!state.usageOverview || !state.usageOperations) loadUsage(false);
  }

  function loadUsage(forceMetadata) {
    var requestId = ++state.usageRequestId;
    state.usageLoading = true;
    state.usageError = "";
    state.usageOperations = null;
    state.usageNextCursor = null;
    render();
    var metadataPromise = state.usageMetadata && !forceMetadata
      ? Promise.resolve(state.usageMetadata)
      : api("/admin/api/usage/metadata");
    return Promise.all([
      api(usageQueryPath("/admin/api/usage/overview", true, false, "")),
      api(usageQueryPath("/admin/api/usage/operations", false, true, "")),
      metadataPromise
    ]).then(function (parts) {
      if (requestId !== state.usageRequestId) return;
      state.usageOverview = parts[0];
      state.usageOperations = parts[1].items || [];
      state.usageNextCursor = parts[1].nextCursor || null;
      state.usageMetadata = parts[2];
      state.usageLoading = false;
      render();
    }).catch(function (error) {
      if (requestId !== state.usageRequestId) return;
      state.usageLoading = false;
      state.usageError = error.serverMessage || error.message || "Usage reporting is unavailable.";
      render();
    });
  }

  function loadUsageOperations(reset) {
    if (reset) {
      state.usageOperations = null;
      state.usageNextCursor = null;
    }
    state.usageLoadingMore = true;
    state.usageError = "";
    render();
    return api(usageQueryPath("/admin/api/usage/operations", false, true, reset ? "" : state.usageNextCursor || "")).then(function (body) {
      var items = body.items || [];
      state.usageOperations = reset ? items : (state.usageOperations || []).concat(items);
      state.usageNextCursor = body.nextCursor || null;
      state.usageLoadingMore = false;
      render();
    }).catch(function (error) {
      state.usageLoadingMore = false;
      state.usageError = error.serverMessage || error.message || "Recent activity could not be loaded.";
      render();
    });
  }

  function loadMoreUsageOperations() {
    if (!state.usageNextCursor || state.usageLoadingMore) return;
    loadUsageOperations(false);
  }

  function usageInt(value) {
    return value == null ? "Unknown" : Number(value).toLocaleString("en-US");
  }

  function usageMoney(micros, currency) {
    if (micros == null) return "Unknown";
    var amount = Number(micros) / 1000000;
    var currencyCode = currency || "USD";
    if (amount > 0 && amount < 0.01) return currencyCode === "USD" ? "<$0.01" : "<" + currencyCode + " 0.01";
    if (currencyCode === "USD") return amount.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return currencyCode + " " + amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function usageDelta(current, previous, formatter) {
    if (current == null || previous == null) return "Prior period unavailable";
    if (Number(previous) === 0) return Number(current) === 0 ? "No change from prior period" : "New in this period";
    var change = (Number(current) - Number(previous)) / Number(previous) * 100;
    return (change >= 0 ? "+" : "") + change.toFixed(0) + "% vs prior period" + (formatter ? " · " + formatter(previous) + " prior" : "");
  }

  function usageOperationAmount(detail) {
    var amounts = (detail.measurements || []).filter(function (measurement) {
      return measurement.estimateCompleteness === "complete" && measurement.estimateCurrency === "USD" && measurement.estimateAmountMicros != null;
    });
    if (!amounts.length) return null;
    return amounts.reduce(function (sum, measurement) { return sum + Number(measurement.estimateAmountMicros); }, 0);
  }

  function usageOperationTokens(detail, field) {
    var values = (detail.measurements || []).map(function (measurement) { return measurement[field]; }).filter(function (value) { return value != null; });
    return values.length ? values.reduce(function (sum, value) { return sum + Number(value); }, 0) : null;
  }

  function usageOperationProvider(detail) {
    var measurement = (detail.measurements || []).at(-1);
    return measurement && (measurement.returnedProvider || measurement.providerRoute || measurement.requestedProvider) || detail.operation.requestedProvider || "Unknown";
  }

  function usageOperationModel(detail) {
    var measurement = (detail.measurements || []).at(-1);
    return measurement && (measurement.returnedModel || measurement.requestedModel) || detail.operation.requestedModel || "Unknown";
  }

  function usageWorkLabel(operation) {
    if (operation.operationKind === "routine_run") return operation.routineLabel || operation.routineId || "Scheduled work";
    if (operation.operationKind === "interaction_classification") return "Interaction classification";
    if (operation.conversationKind === "direct_message") return "Direct message";
    return operation.channelLabel ? "#" + operation.channelLabel : operation.channelId || "Interactive turn";
  }

  function usageStatusBadge(status) {
    var good = status === "completed";
    return '<span class="badge ' + (good ? "badge-on" : "badge-off") + '">' + (good ? '<span class="dot"></span>' : '') + esc(String(status || "unknown").replace(/_/g, " ")) + '</span>';
  }

  function usageActivityLabelHtml(label) {
    var explanation = "Activity includes each Slack message Chickpea responds to and each scheduled routine run.";
    return '<span class="usage-term-help" tabindex="0" data-tooltip="' + esc(explanation) + '" aria-label="' + esc(label) + '. ' + esc(explanation) + '">' + esc(label) + '</span>';
  }

  function usageActivityNoun(value) {
    return Number(value) === 1 ? "activity" : "activities";
  }

  function usageCoverageHtml(totals) {
    var activityCount = Number(totals.operationCount || 0);
    var pricedCount = Number(totals.pricedOperationCount || 0);
    var meteredCount = Number(totals.meteredOperationCount || 0);
    if (activityCount <= 0 || (pricedCount >= activityCount && meteredCount >= activityCount)) return "";
    if (pricedCount === meteredCount) {
      var missingCount = Math.max(0, activityCount - pricedCount);
      var missingCopy = missingCount === 1
        ? "One activity did not report token usage and could not be priced."
        : usageInt(missingCount) + " activities did not report token usage and could not be priced.";
      return '<p class="usage-data-note"><strong>Totals include ' + usageInt(pricedCount) + ' of ' + usageInt(activityCount) + ' ' + usageActivityNoun(activityCount) + '.</strong> ' + missingCopy + '</p>';
    }
    return '<p class="usage-data-note"><strong>Some activity is missing usage data.</strong> Cost estimates include ' + usageInt(pricedCount) + ' of ' + usageInt(activityCount) + ' ' + usageActivityNoun(activityCount) + '; token totals include ' + usageInt(meteredCount) + ' of ' + usageInt(activityCount) + '.</p>';
  }

  function usageTokenTotalHtml(input, cached, output, total) {
    var totalLabel = usageInt(total);
    if (input == null && cached == null && output == null) return totalLabel;
    var split = usageInt(input) + " input · " + usageInt(cached) + " cached input · " + usageInt(output) + " output";
    return '<span class="usage-token-total" tabindex="0" data-tooltip="' + esc(split) + '" aria-label="' + esc(totalLabel + " total tokens; " + split) + '">' + totalLabel + '</span>';
  }

  function usageCachedTokens(source) {
    var read = source && source.cacheReadTokens;
    var write = source && source.cacheWriteTokens;
    return read == null && write == null ? null : Number(read || 0) + Number(write || 0);
  }

  function usageOperationCachedTokens(detail) {
    return usageCachedTokens({
      cacheReadTokens: usageOperationTokens(detail, "cacheReadTokens"),
      cacheWriteTokens: usageOperationTokens(detail, "cacheWriteTokens")
    });
  }

  function usageGroupsHtml(summary) {
    var groups = summary.groups || [];
    if (!groups.length) return '<div class="empty"><p class="hint">No breakdown data for this period.</p></div>';
    var rows = groups.map(function (group) {
      var channel = state.usageGroupBy === "channel" ? (state.channelIndex || []).find(function (candidate) { return candidate.channelId === group.key; }) : null;
      var label = group.label || (channel && normalizeChannelLabel(channel.channelName)) || (state.usageGroupBy === "channel" && group.key === "direct_message" ? "Direct message" : group.key) || "Unknown";
      label = state.usageGroupBy === "channel" && label !== "Direct message" && !String(label).startsWith("#") ? "#" + label : label;
      return '<tr><td><button type="button" class="usage-row-action" data-action="usage-group-filter" data-value="' + esc(group.key) + '" data-label="' + esc(label) + '">' + esc(label) + '</button></td>' +
        '<td class="number">' + usageInt(group.operationCount) + '</td><td class="number">' + usageInt(group.inputTokens) + '</td>' +
        '<td class="number">' + usageInt(usageCachedTokens(group)) + '</td><td class="number">' + usageInt(group.outputTokens) + '</td><td class="number">' + usageInt(group.totalTokens) + '</td>' +
        '<td class="number">' + usageMoney(group.estimateAmountMicros, summary.currency) + '</td></tr>';
    }).join("");
    return '<div class="usage-table-wrap"><table class="usage-table"><thead><tr><th>' + esc(state.usageGroupBy.replace(/_/g, " ")) + '</th><th class="number">' + usageActivityLabelHtml("Activity") + '</th><th class="number">Input tokens</th><th class="number">Cached input</th><th class="number">Output tokens</th><th class="number">Total tokens</th><th class="number">Spend</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function usageOperationsHtml() {
    if (!state.usageOperations) return '<div class="empty"><p class="hint">Loading activity&hellip;</p></div>';
    var visibleOperations = state.usageOperations.filter(function (detail) {
      return detail && detail.operation && detail.operation.operationKind !== "interaction_classification";
    });
    var loadMore = state.usageNextCursor ? '<button type="button" class="btn btn-ghost" data-action="usage-load-more"' + (state.usageLoadingMore ? ' disabled' : '') + '>' + (state.usageLoadingMore ? 'Loading&hellip;' : 'Load more') + '</button>' : '';
    if (!visibleOperations.length) return '<div class="empty"><p class="hint">No customer activity on this page' + (state.usageOperationFilter ? ' for this filter' : '') + '.</p>' + loadMore + '</div>';
    var rows = visibleOperations.map(function (detail) {
      var operation = detail.operation;
      var input = usageOperationTokens(detail, "inputTokens");
      var cached = usageOperationCachedTokens(detail);
      var output = usageOperationTokens(detail, "outputTokens");
      var total = usageOperationTokens(detail, "totalTokens");
      var localAgent = agentById(operation.agentId);
      var agentLabel = operation.agentLabel || (localAgent && localAgent.name) || operation.agentId || "Unknown";
      return '<tr><td><strong class="usage-work-label">' + esc(usageWorkLabel(operation)) + '</strong><div class="hint">' + esc(new Date(operation.startedAt).toLocaleString()) + '</div></td>' +
        '<td>' + esc(agentLabel) + '</td><td>' + esc(usageOperationProvider(detail)) + '</td><td>' + esc(usageOperationModel(detail)) + '</td>' +
        '<td>' + usageStatusBadge(operation.status) + '</td><td class="number">' + usageTokenTotalHtml(input, cached, output, total) + '</td><td class="number">' + usageMoney(usageOperationAmount(detail), "USD") + '</td></tr>';
    }).join("");
    return '<div class="usage-table-wrap"><table class="usage-table"><thead><tr><th>Channel or routine</th><th>Agent</th><th>Provider</th><th>Model</th><th>Status</th><th class="number">Tokens</th><th class="number">Spend</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      loadMore;
  }

  function usageMainHtml() {
    var periods = [["last_7_days", "Last 7 days"], ["last_30_days", "Last 30 days"], ["last_90_days", "Last 90 days"], ["this_month", "This month"], ["last_month", "Last month"], ["this_week", "This week"], ["last_week", "Last week"], ["custom", "Custom"]];
    var customControls = state.usagePeriod === "custom"
      ? '<label class="field" for="usage-custom-from"><span class="field-label">From</span><input class="input" id="usage-custom-from" name="usage-custom-from" type="date" max="' + usageDateValue(new Date()) + '" value="' + esc(state.usageCustomDraftFrom) + '" data-action="usage-custom-from"></label>' +
        '<label class="field" for="usage-custom-to"><span class="field-label">To</span><input class="input" id="usage-custom-to" name="usage-custom-to" type="date" max="' + usageDateValue(new Date()) + '" value="' + esc(state.usageCustomDraftTo) + '" data-action="usage-custom-to"></label>' +
        '<button type="button" class="btn btn-soft usage-apply" data-action="usage-custom-apply">Apply dates</button>' +
        (state.usageCustomError ? '<p class="field-error usage-custom-error" role="alert">' + esc(state.usageCustomError) + '</p>' : '')
      : '';
    var controls = '<div class="usage-controls"><div class="usage-control-row' + (state.usagePeriod === "custom" ? ' has-custom' : '') + '"><label class="field"><span class="field-label">Period</span><span class="select-wrap"><select class="input" name="usage-period" data-action="usage-range">' +
      periods.map(function (period) { return '<option value="' + period[0] + '"' + (state.usagePeriod === period[0] ? ' selected' : '') + '>' + period[1] + '</option>'; }).join("") +
      '</select><span class="select-caret">' + icon("chevron-down") + '</span></span></label><label class="field"><span class="field-label">Break down by</span><span class="select-wrap"><select class="input" name="usage-group" data-action="usage-group">' +
      [["channel", "Channel"], ["agent", "Agent"], ["provider", "Provider"], ["model", "Model"]].map(function (option) { return '<option value="' + option[0] + '"' + (state.usageGroupBy === option[0] ? ' selected' : '') + '>' + option[1] + '</option>'; }).join("") +
      '</select><span class="select-caret">' + icon("chevron-down") + '</span></span></label>' + customControls + '</div></div>';
    var head = '<div class="usage-head"><div class="usage-head-copy"><span class="section-eyebrow">Reporting</span><h1 class="page-title">Usage</h1><p class="hint">See token usage and spend across channels, Agents, providers, and recent activity.</p></div></div>' + controls +
      '<div class="usage-contract"><p><strong>Set spending limits with each model provider;</strong> Chickpea reports estimated spend for activity it handles.</p><button type="button" class="btn btn-ghost btn-sm" data-action="usage-open-settings">Model settings</button></div>';
    if (state.usageLoading && !state.usageOverview) return head + '<div class="empty"><p class="hint">Loading usage and estimated spend&hellip;</p></div>';
    if (state.usageError && !state.usageOverview) return head + '<div class="empty"><p class="field-error">' + esc(state.usageError) + '</p><button type="button" class="btn btn-ghost" data-action="usage-retry">Retry</button></div>';
    if (!state.usageOverview || !state.usageMetadata) return head;
    var current = state.usageOverview.current;
    var previous = state.usageOverview.previous;
    var totals = current.totals;
    var prior = previous.totals;
    var estimate = current.mixedCurrency ? "Multiple currencies" : usageMoney(totals.estimateAmountMicros, current.currency || "USD");
    var denominator = Number(totals.pricedOperationCount || 0);
    var perPriced = denominator > 0 && totals.estimateAmountMicros != null ? usageMoney(Math.round(Number(totals.estimateAmountMicros) / denominator), current.currency || "USD") : "Unknown";
    var summary = '<div class="usage-grid"><div class="usage-card usage-card-primary"><span class="usage-card-label">Estimated spend</span><span class="usage-card-value">' + esc(estimate) + '</span><span class="hint">' + esc(usageDelta(totals.estimateAmountMicros, prior.estimateAmountMicros)) + '</span></div>' +
      '<div class="usage-card"><span class="usage-card-label">' + usageActivityLabelHtml("Activity") + '</span><span class="usage-card-value">' + usageInt(totals.operationCount) + '</span><span class="hint">' + esc(usageDelta(totals.operationCount, prior.operationCount)) + '</span></div>' +
      '<div class="usage-card"><span class="usage-card-label">Tokens</span><span class="usage-card-value">' + usageInt(totals.totalTokens) + '</span><span class="hint">' + usageInt(totals.inputTokens) + ' input · ' + usageInt(usageCachedTokens(totals)) + ' cached input · ' + usageInt(totals.outputTokens) + ' output</span></div>' +
      '<div class="usage-card"><span class="usage-card-label">Average spend</span><span class="usage-card-value">' + esc(perPriced) + '</span><span class="hint">Across ' + usageInt(denominator) + ' priced ' + usageActivityNoun(denominator) + '</span></div></div>';
    var coverage = usageCoverageHtml(totals);
    var staleCatalogs = (state.usageMetadata.catalogs || []).filter(function (catalog) { return Date.now() >= catalog.staleAfter; });
    var freshness = staleCatalogs.length ? '<p class="field-error">Spend estimates need a pricing update for ' + staleCatalogs.length + ' provider' + (staleCatalogs.length === 1 ? '' : 's') + '.</p>' : '';
    var filter = state.usageOperationFilter ? '<span class="usage-filter-chip">Recent activity: ' + esc(state.usageOperationFilter.label) + ' <button type="button" class="x-btn" data-action="usage-clear-filter" aria-label="Clear activity filter">&times;</button></span>' : '';
    var groupLabel = state.usageGroupBy === "channel" ? "channel" : state.usageGroupBy;
    return head + summary + coverage + freshness +
      '<section class="usage-section"><div class="usage-section-head"><div><h2 class="section-title">Spend by ' + esc(groupLabel) + '</h2><p class="hint">Compare where token usage and spend are concentrated.</p></div></div>' + usageGroupsHtml(current) + '</section>' +
      '<section class="usage-section"><div class="usage-section-head"><div><h2 class="section-title">Recent ' + usageActivityLabelHtml("activity") + '</h2><p class="hint">Hover over total tokens to see the input, cached input, and output split.</p></div>' + filter + '</div>' + usageOperationsHtml() + '</section>';
  }

  function isOnboardingSlackConnection() {
    return state.view === "onboarding" && state.onboarding && state.onboarding.stage === "connect_slack";
  }

  function onboardingConnectHtml() {
    return '<section class="onboarding-panel"><p class="onboarding-eyebrow">Slack setup</p>' +
      '<h1 class="onboarding-title">Finish connecting Slack</h1>' +
      '<p class="onboarding-lede">This deployment has not completed its verified Slack installation. Resume the private setup link created by your deploy, or use the recovery runbook if that link expired.</p>' +
      '<p class="hint">Chickpea never asks you to paste a bot token into the Admin control plane.</p></section>';
  }

  function onboardingSlackConnectedHtml() {
    var workspace = state.onboarding && state.onboarding.workspace;
    var workspaceName = (workspace && workspace.name) || (state.slack && state.slack.teamName) || "your workspace";
    return '<section class="onboarding-panel onboarding-panel-wide"><span class="onboarding-success-badge">Slack connected</span>' +
      '<h1 class="onboarding-title" id="onboarding-connected-heading" tabindex="-1">Everything worked</h1>' +
      '<p class="onboarding-lede">Chickpea is connected to ' + esc(workspaceName) + ' and ready for a channel.</p>' +
      '<div class="onboarding-success-summary">Workspace, permissions, and event delivery are ready.</div>' +
      '<div class="onboarding-actions"><button type="button" class="btn btn-primary" data-action="onboarding-continue-to-channel">Choose a channel</button></div></section>';
  }

  function onboardingChannelChoicesHtml() {
    var channels = state.slackChannels && state.slackChannels.channels ? state.slackChannels.channels : [];
    if (!channels.length) return '<p class="hint">No channels are available yet.</p>';
    return channels.map(function (channel) {
      var selected = channel.id === state.onboardingChannelSelected;
      var description = channel.isPrivate
        ? 'Private channel · @Chickpea is already a member'
        : (channel.isMember ? '@Chickpea is already a member' : 'Chickpea will join this public channel');
      return '<label class="onboarding-channel-choice"><input type="radio" name="channelSelect" value="' + esc(channel.id) + '" data-action="onboarding-channel-select"' + (selected ? ' checked' : '') + '>' +
        '<span class="onboarding-channel-card"><span><span class="onboarding-channel-name"># ' + esc(channel.name + (channel.isPrivate ? ' (private)' : '')) + '</span>' +
        '<span class="onboarding-channel-description">' + esc(description) + '</span></span><span class="onboarding-radio-dot" aria-hidden="true"></span></span></label>';
    }).join("");
  }

  function onboardingChooseChannelHtml() {
    var workspace = state.onboarding && state.onboarding.workspace;
    var loading = state.slackChannelsLoading || !state.slackChannels;
    var picker = loading
      ? '<p class="hint">Loading public channels&hellip;</p>'
      : state.slackChannelsError
        ? '<p class="field-error" role="alert">' + esc(state.slackChannelsError.text) + '</p>'
        : '<div class="onboarding-channel-list" role="radiogroup" aria-label="Choose a Slack channel">' + onboardingChannelChoicesHtml() + '</div>';
    var selected = findSlackChannel(state.onboardingChannelSelected);
    var buttonLabel = selected ? 'Add @Chickpea to #' + selected.name : 'Choose a channel';
    return '<section class="onboarding-panel onboarding-panel-wide"><p class="onboarding-eyebrow">Step 2 of 3</p>' +
      '<h1 class="onboarding-title" id="onboarding-channel-heading" tabindex="-1">Choose where Chickpea should start</h1>' +
      '<p class="onboarding-lede">Pick one channel for the first conversation. You can add or remove channels anytime.</p>' +
      '<div class="onboarding-workspace-row"><div><div class="onboarding-workspace-label">' + esc((workspace && workspace.name) || "Slack") + '</div>' +
      '<div class="onboarding-workspace-meta">' + esc((workspace && workspace.id) || "") + '</div></div><span class="badge badge-on"><span class="dot"></span>Slack connected</span></div>' +
      '<form data-action="onboarding-channel-form">' + picker +
      '<p class="onboarding-reversible">Chickpea will only answer in channels you choose. For a private channel, invite @Chickpea there first, then refresh.</p>' +
      (state.onboardingError ? '<p class="field-error" role="alert">' + esc(state.onboardingError) + '</p>' : '') +
      '<div class="onboarding-actions"><button type="submit" class="btn btn-primary"' + (loading || state.onboardingBusy || !selected ? ' disabled' : '') + '>' + (state.onboardingBusy ? 'Adding&hellip;' : esc(buttonLabel)) + '</button>' +
      '<button type="button" class="btn btn-soft" data-action="refresh-onboarding-channels">' + icon("arrow-path") + 'Refresh channels</button></div></form></section>';
  }

  function onboardingTryHtml(complete) {
    var workspace = state.onboarding && state.onboarding.workspace;
    var channel = state.onboarding && state.onboarding.channel;
    if (!workspace || !channel) return '<div class="empty"><p class="field-error">The onboarding channel is unavailable.</p></div>';
    var deepLink = 'https://app.slack.com/client/' + encodeURIComponent(workspace.id) + '/' + encodeURIComponent(channel.id);
    if (complete) {
      var completedAgentId = (state.onboarding && state.onboarding.agentId) || ((defaultAgent() && defaultAgent().id) || "");
      var completedAgent = agentById(completedAgentId) || defaultAgent();
      return '<section class="onboarding-panel onboarding-panel-wide"><span class="onboarding-success-badge">Reply confirmed in #' + esc(channel.name) + '</span>' +
        '<h1 class="onboarding-title">Chickpea is ready</h1>' +
        '<p class="onboarding-lede">Your setup is working. Continue in ' + esc((completedAgent && completedAgent.name) || "your Agent") + ' to shape what Chickpea knows and can do.</p>' +
        '<div class="onboarding-actions onboarding-completion-actions"><button type="button" class="btn btn-primary" data-action="open-profiles" data-agent="' + esc(completedAgentId) + '">Open ' + esc((completedAgent && completedAgent.name) || "Default Agent") + '</button>' +
        '<a class="btn btn-soft" href="' + esc(deepLink) + '" target="_blank" rel="noopener noreferrer">Open #' + esc(channel.name) + ' in Slack</a></div></section>';
    }
    return '<section class="onboarding-panel onboarding-panel-wide"><div class="onboarding-success"><span class="onboarding-success-icon" aria-hidden="true">&#10003;</span><div>' +
      '<p class="onboarding-eyebrow">Step 3 of 3</p><h1 class="onboarding-title">Try Chickpea in #' + esc(channel.name) + '</h1>' +
      '<p class="onboarding-lede">Open the channel and try one useful request. Your first reply confirms that everything is working.</p></div></div>' +
      '<div class="onboarding-prompt-box"><p class="onboarding-prompt-label">Suggested first message</p><p class="onboarding-prompt">' + esc(ONBOARDING_PROMPT) + '</p>' +
      '<input id="onboarding-prompt" type="text" hidden readonly value="' + esc(ONBOARDING_PROMPT) + '">' +
      '<p class="onboarding-status" role="status">' + esc(state.onboardingNotice || 'Waiting for Chickpea to reply…') + '</p></div>' +
      (state.onboardingError ? '<div class="onboarding-actions"><span class="field-error" role="alert">' + esc(state.onboardingError) + '</span><button type="button" class="btn btn-soft" data-action="retry-onboarding">Check again</button></div>' : '') +
      '<div class="onboarding-actions"><a class="btn btn-primary" href="' + esc(deepLink) + '" target="_blank" rel="noopener noreferrer">Open #' + esc(channel.name) + ' in Slack</a>' +
      '<button type="button" class="btn btn-soft" data-action="copy-onboarding-prompt">Copy message</button>' +
      '<button type="button" class="btn btn-ghost" data-action="onboarding-proceed-dashboard"' + (state.onboardingBusy ? ' disabled' : '') + '>' + (state.onboardingBusy ? 'Opening dashboard&hellip;' : 'Proceed to Dashboard') + '</button></div></section>';
  }

  function onboardingMainHtml() {
    if (state.onboardingError && !state.onboarding) {
      return '<section class="onboarding-panel"><p class="onboarding-eyebrow">Setup</p><h1 class="onboarding-title">Setup could not load</h1><p class="field-error">' + esc(state.onboardingError) + '</p><div class="onboarding-actions"><button type="button" class="btn btn-soft" data-action="retry-onboarding">Try again</button></div></section>';
    }
    if (!state.onboarding) return '<section class="onboarding-panel"><p class="onboarding-eyebrow">Setup</p><h1 class="onboarding-title">Loading setup&hellip;</h1></section>';
    if (state.onboarding.stage === "connect_slack") return onboardingConnectHtml();
    if (state.onboarding.stage === "choose_channel") return state.onboardingSlackConnected ? onboardingSlackConnectedHtml() : onboardingChooseChannelHtml();
    if (state.onboarding.stage === "try") return onboardingTryHtml(false);
    return onboardingTryHtml(true);
  }

  function onboardingStepNumber() {
    var stage = state.onboarding && state.onboarding.stage;
    if (stage === "choose_channel") return 2;
    if (stage === "try" || stage === "complete") return 3;
    return 1;
  }

  function onboardingOrientationHtml() {
    var current = onboardingStepNumber();
    var journeyComplete = state.onboarding && state.onboarding.stage === "complete";
    var labels = ["Connect Slack", "Choose a channel", "Try Chickpea"];
    return '<ol class="onboarding-orientation" role="list" aria-label="Onboarding progress">' + labels.map(function (label, index) {
      var step = index + 1;
      var isComplete = journeyComplete || step < current;
      var isActive = !journeyComplete && step === current;
      var className = isComplete ? "complete" : isActive ? "active" : "";
      return '<li class="' + className + '"' + (isActive ? ' aria-current="step"' : '') + '><span class="onboarding-step-dot">' + (isComplete ? '&#10003;' : step) + '</span><span class="onboarding-step-label">' + esc(label) + '</span></li>';
    }).join("") + '</ol>';
  }

  function onboardingShellHtml() {
    return '<main class="onboarding-shell"><div class="onboarding-shell-inner"><div class="onboarding-brand-row">' +
      '<div class="onboarding-brand">' + peaMarkHtml() + '<span class="brand-name">Chickpea</span></div><span class="onboarding-environment">${targetChip}</span></div>' +
      onboardingOrientationHtml() + '<div class="onboarding-stage" aria-live="polite">' + onboardingMainHtml() + '</div></div></main>';
  }

  function mainHtml() {
    if (state.view === "onboarding") {
      return '<main class="main"><div class="main-inner">' + onboardingMainHtml() + '</div></main>';
    }
    if (state.view === "usage") {
      return '<main class="main"><div class="main-inner usage-main">' + usageMainHtml() + '</div></main>';
    }
    if (state.view === "team") {
      return '<main class="main"><div class="main-inner team-main">' + teamMainHtml() + '</div></main>';
    }
    // Profiles is a first-class main-panel destination (master-detail, per cards
    // 09-12) that takes precedence over the channel chrome — reachable from the
    // topbar and the channel page's Manage-profiles affordance, connected or not.
    if (state.view === "profiles") {
      return '<main class="main"><div class="main-inner">' + profilesMainHtml() + '</div></main>';
    }
    // Settings (model providers, cards 13-14) is a first-class main-panel
    // destination like Profiles — reachable from the topbar and the picker's
    // "Manage providers" affordance, connected or not.
    if (state.view === "settings") {
      return '<main class="main"><div class="main-inner">' + settingsMainHtml() + '</div></main>';
    }
    if (state.view === "audit") {
      return '<main class="main"><div class="main-inner audit-main">' + scheduledWorkMainHtml() + '</div></main>';
    }
    if (state.channelScreen === "overview") {
      return '<main class="main"><div class="main-inner slack-overview">' + slackOverviewHtml() + '</div></main>';
    }
    // Not connected → the main panel is ONLY the Connect stepper. Nothing can
    // answer until there are live wire credentials, so no channel chrome shows.
    if (state.slack && !state.slack.connected) {
      return '<main class="main"><div class="main-inner">' + slackStepperHtml() + '</div></main>';
    }
    var channel = activeChannelProjection();
    var connected = isSlackConnected();
    // Connected: credential provenance is demoted to a collapsed disclosure at
    // the very bottom so it never competes with the funnel or the channel page.
    var slackBottom = connected ? connectionDetailsHtml() : "";
    var addPanel = addChannelPanelHtml();
    var invite = inviteReminderHtml();
    if (!channel) {
      if (connected) {
        // Connected + zero channels: the funnel is the single focus of the
        // screen — replaced by the picker when the operator opens it.
        var body = state.addChannelOpen ? addPanel : funnelHtml();
        return '<main class="main"><div class="main-inner">' + invite + body + slackBottom + '</div></main>';
      }
      // Transient null connection (a failed connection fetch): keep a minimal,
      // non-blocking empty so the rest of the admin still renders.
      var emptyBlock = state.addChannelOpen ? "" : '<div class="empty">' +
        '<h1 class="page-title">No channels yet &mdash; add one</h1>' +
        '<p class="hint">Pick a Slack Channel and assign an Agent. Then mention the Agent handle when you want it to respond.</p>' +
        addChannelButtonHtml("btn btn-soft") +
        '</div>';
      return '<main class="main"><div class="main-inner">' + invite + addPanel + emptyBlock + '</div></main>';
    }
    var readiness = channel.readiness || null;
    var detailStatus = !(channel.grants || []).length
      ? { key: "unassigned", label: "No Agents", reason: "Publish an Agent from its Channels tab." }
      : readiness && readiness.ready === false
      ? { key: "needs-attention", label: "Needs attention", reason: (readiness.reasons || []).join(". ") || "Review the Agent grants for this Channel." }
      : { key: "ready", label: "Ready", reason: "Chickpea can route every active Agent grant in this Channel." };
    var channelRecord = {
      workspaceId: channel.workspaceId,
      channelId: channel.channelId,
      channelLabel: channel.channelName || channel.channelId
    };
    return '<main class="main"><div class="main-inner"><div class="channel-detail-page">' + invite + addPanel +
      '<header class="channel-detail-header"><div class="channel-detail-head-copy">' +
      '<button type="button" class="link-btn" style="align-self:flex-start;" data-action="channel-back">&larr; Channels</button>' +
      '<span class="agent-kicker">Slack Channel</span>' +
      '<h1 class="page-title mono-title">#' + esc(normalizeChannelLabel(channel.channelName || channel.channelId)) + '</h1>' +
      '<p class="hint">This page is an inventory of reach. Every Agent keeps its own behavior, memory, connections, and schedules.</p>' +
      '</div><div class="channel-detail-controls"><span class="channel-detail-status ' + detailStatus.key + '" title="' + esc(detailStatus.reason) + '" role="status">' + esc(detailStatus.label) + '</span></div></header>' +
      channelGrantRosterHtml(channel) +
      channelTryHtml(channelRecord) +
      '</div></div></main>';
  }

  // ---- Channels > Slack overview ------------------------------------------

  function slackConnectionMutable() {
    var credentials = state.slack && state.slack.credentials;
    return !!credentials && credentials.botToken === "stored" && credentials.signingSecret === "stored";
  }

  function connectedAssignmentCount() {
    var teamId = connectedTeamId();
    var channels = (state.channelIndex || []).filter(function (channel) {
      return Array.isArray(channel.grants) && channel.grants.length > 0;
    });
    return teamId
      ? channels.filter(function (channel) { return channel.workspaceId === teamId; }).length
      : channels.length;
  }

  function slackCredentialSummary() {
    if (state.slack && state.slack.transportMode === "gateway") {
      return "Connection managed by Chickpea gateway";
    }
    var credentials = state.slack && state.slack.credentials;
    if (!credentials) return "Credential status unavailable";
    var sources = [credentials.botToken, credentials.signingSecret];
    if (sources.every(function (source) { return source === "env"; })) return "Credentials managed by environment";
    if (sources.some(function (source) { return source === "env"; })) return "Credentials partly managed by environment";
    return "Credentials stored in Chickpea";
  }

  function slackBehaviorRowHtml(key, title, description) {
    var entry = state.slackBehavior && state.slackBehavior[key];
    var value = entry ? !!entry.value : true;
    var envManaged = !!entry && entry.source === "env";
    var busy = state.slackBehaviorBusy === key;
    // Serialize writes: each response is a complete settings snapshot, so a
    // second overlapping update could otherwise let an older response win.
    var disabled = !entry || envManaged || !!state.slackBehaviorBusy;
    var sourceNote = envManaged ? " Managed by the environment." : "";
    return '<div class="behavior-row"><div class="behavior-copy">' +
      '<span class="behavior-title">' + esc(title) + '</span>' +
      '<span class="hint">' + esc(description + sourceNote) + '</span></div>' +
      '<span class="behavior-state">' + (busy ? "Saving" : value ? "On" : "Off") + '</span>' +
      '<span class="toggle"><span class="thumb"></span><input type="checkbox" data-action="slack-behavior" data-setting="' + esc(key) + '" ' +
      (value ? "checked " : "") + (disabled ? "disabled " : "") + 'aria-label="' + esc(title) + '"></span></div>';
  }

  function slackBehaviorHtml() {
    if (!state.slackBehavior) {
      if (state.slackBehaviorBusy) {
        return '<div class="empty"><p class="field-label">Loading Slack behavior&hellip;</p></div>';
      }
      return '<div class="empty"><p class="field-label">Slack behavior could not load</p>' +
        '<p class="error" role="alert">' + esc(state.slackBehaviorError || "Reload the settings to try again.") + '</p>' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="slack-behavior-retry">Retry</button></div>';
    }
    return '<div class="behavior-list">' +
      slackBehaviorRowHtml("nativeTasks", "Show native task plans", "Project admitted Work as Slack task cards. The existing checklist remains the fallback when Slack rejects the native stream.") +
      slackBehaviorRowHtml("progressiveStreaming", "Stream safe answer text", "Show answer-only text as it is generated. Memory, recovery, sandbox, and effect-capable turns remain terminal-only.") +
      '</div>' +
      (state.slackBehaviorError
        ? '<div class="inline-status error" role="alert">' + esc(state.slackBehaviorError) +
          ' <button type="button" class="link-btn" data-action="slack-behavior-retry">Retry</button></div>'
        : '');
  }

  function slackConnectionStatusHtml() {
    var status = state.slackTestStatus;
    if (!status) return "";
    return '<p class="inline-status ' + (status.ok ? "ok" : "error") + '" role="status" aria-live="polite">' + esc(status.message) + '</p>';
  }

  function configuredChannelsForIndex() {
    var projected = (state.channelIndex || []).map(function (channel) {
      return {
        workspaceId: channel.workspaceId,
        channelId: channel.channelId,
        channelName: channel.channelName || channel.channelId,
        grants: Array.isArray(channel.grants) ? channel.grants : [],
        readiness: channel.readiness || null,
        configured: Array.isArray(channel.grants) && channel.grants.length > 0
      };
    });
    if (!projected.length) {
      var fallbackByChannel = new Map();
      state.agents.forEach(function (agent) {
        var channels = agent.whereItWorks && Array.isArray(agent.whereItWorks.channels)
          ? agent.whereItWorks.channels
          : [];
        channels.forEach(function (channel) {
          var key = channel.workspaceId + "\u0000" + channel.channelId;
          var current = fallbackByChannel.get(key) || {
            workspaceId: channel.workspaceId,
            channelId: channel.channelId,
            channelName: channel.channelName || channel.channelId,
            grants: [],
            readiness: null,
            configured: true
          };
          current.grants.push({
            agentId: agent.id,
            agentName: agent.name,
            agentEnabled: agent.enabled,
            agentLifecycle: agent.lifecycle || null,
            status: channel.status || "active"
          });
          fallbackByChannel.set(key, current);
        });
      });
      projected = Array.from(fallbackByChannel.values());
    }
    var seen = new Set(projected.map(function (channel) { return channel.workspaceId + "\u0000" + channel.channelId; }));
    var catalog = (state.slackChannels && state.slackChannels.channels) || [];
    catalog.forEach(function (channel) {
      var workspaceId = (state.slackChannels && state.slackChannels.teamId) || connectedTeamId();
      var key = workspaceId + "\u0000" + channel.id;
      if (seen.has(key)) return;
      projected.push({
        workspaceId: workspaceId,
        channelId: channel.id,
        channelName: channel.name || channel.id,
        grants: [],
        readiness: null,
        configured: false
      });
    });
    return projected;
  }

  function channelsSlackStatus() {
    if (!isSlackConnected() || (state.slack && state.slack.health === "revoked")) {
      return { key: "disconnected", label: "Slack disconnected" };
    }
    if (state.slack && state.slack.health && state.slack.health !== "healthy") {
      return { key: "degraded", label: "Slack needs attention" };
    }
    return { key: "connected", label: "Slack connected" };
  }

  function channelIndexState(channel, agent) {
    if (!channel.configured) return { key: "discovered", label: "No Agents" };
    if (channel.readiness && channel.readiness.ready === false) return { key: "needs-attention", label: "Needs attention" };
    if (channel.readiness && channel.readiness.ready === true) return { key: "ready", label: "Ready" };
    return { key: "saved", label: "Granted" };
  }

  function channelsIndexHtml() {
    if (state.addChannelOpen) {
      return '<button type="button" class="link-btn" data-action="toggle-add-channel">&larr; Channels</button>' + addChannelPanelHtml();
    }
    var allChannels = configuredChannelsForIndex();
    var query = String(state.channelIndexQuery || "").trim().toLowerCase();
    var channels = allChannels.filter(function (channel) {
      if (!query) return true;
      var agentNames = (channel.grants || []).map(function (grant) { return grant.agentName || grant.agentId; }).join(" ");
      return (channel.channelName + " " + channel.channelId + " " + agentNames).toLowerCase().indexOf(query) >= 0;
    });
    var error = state.channelIndexError
      ? '<p class="inline-status error channels-index-fallback" role="status">The Channel index could not refresh. Showing saved Agent grants; reconnect or reload to try again.</p>'
      : "";
    var rows = channels.map(function (channel) {
      var grants = channel.grants || [];
      var rowState = channelIndexState(channel);
      var channelName = "#" + normalizeChannelLabel(channel.channelName);
      var agentControl = grants.length
        ? '<div class="channels-index-agents">' + grants.map(function (grant) {
            var agentName = grant.agentName || grant.agentId;
            return '<button type="button" class="channels-index-agent" data-action="open-profiles" data-agent="' + esc(grant.agentId) + '" aria-label="Open Agent: ' + esc(agentName) + '">' +
              '<span class="agent-roster-icon variant-' + agentIconVariant(grant.agentId) + '" aria-hidden="true">' + icon("robot") + '</span>' +
              '<span class="channels-index-agent-copy"><span class="channels-index-agent-name" title="' + esc(agentName) + '">' + esc(agentName) + '</span><small>' + esc(grant.status === "active" ? "Active" : "Needs attention") + '</small></span></button>';
          }).join("") + '</div>'
        : '<span class="channels-index-agent-empty"><strong>No Agents</strong><span>Publish from an Agent’s Channels tab.</span></span>';
      var readinessReason = channel.readiness && channel.readiness.reasons && channel.readiness.reasons.length
        ? channel.readiness.reasons.join(". ")
        : rowState.label;
      return '<div class="channels-index-row" role="row" data-channel-state="' + rowState.key + '">' +
        '<div class="channels-index-cell" role="cell" data-label="Channel"><div class="channels-index-channel">' +
        '<span class="channel-hash" aria-hidden="true">#</span><span class="channels-index-copy"><span class="channels-index-name" title="' + esc(channelName) + '">' + esc(channelName) + '</span><small title="' + esc(channel.channelId) + '">' + esc(channel.configured ? grants.length + " Agent grant" + (grants.length === 1 ? "" : "s") : "Discovered in Slack") + '</small></span></div></div>' +
        '<div class="channels-index-cell" role="cell" data-label="Agents">' + agentControl + '</div>' +
        '<div class="channels-index-cell" role="cell" data-label="Status"><span class="channel-status ' + rowState.key + '" title="' + esc(readinessReason) + '">' + esc(rowState.label) + '</span></div></div>';
    }).join("");
    if (!rows) {
      rows = '<div class="channels-index-empty"><p class="field-label">' + (query ? "No Channels or Agents match" : "No Channels yet") + '</p><p class="hint">' + (query ? "Try a different Channel or Agent name." : "Publish an Agent to a Slack Channel to see it here.") + '</p></div>';
    }
    var configuredCount = allChannels.filter(function (channel) { return channel.configured; }).length;
    var activeGrantCount = allChannels.reduce(function (count, channel) { return count + (channel.grants || []).filter(function (grant) { return grant.status === "active"; }).length; }, 0);
    var slackStatus = channelsSlackStatus();
    return '<div class="channels-index-head"><div class="channels-index-head-copy"><span class="agent-kicker">Slack</span><h1 class="page-title">Channels</h1><p class="hint">Channels grant reach only. Each Agent keeps the same instructions, memory, connections, and schedules everywhere it works.</p></div></div>' +
      '<div class="channels-overview-card"><dl class="channels-overview-stats"><div class="channels-summary-stat"><dt>Configured Channels</dt><dd>' + configuredCount + '</dd></div>' +
      '<div class="channels-summary-stat"><dt>Active Agent grants</dt><dd>' + activeGrantCount + '</dd></div>' +
      '<div class="channels-summary-stat"><dt>Connection</dt><dd><span class="channels-slack-state ' + slackStatus.key + '">' + esc(slackStatus.label) + '</span></dd></div></dl>' +
      '<label class="channels-index-search" for="channels-index-query"><span class="field-label">Find a Channel or Agent</span><input class="input" id="channels-index-query" type="search" value="' + esc(state.channelIndexQuery) + '" placeholder="Find a Channel or Agent" data-action="channels-index-query"></label></div>' +
      error + '<section class="section"><div class="section-head"><div><h2 class="section-title" id="channel-assignments-heading">Channel grants</h2><p class="hint">Open an Agent to add or remove its Channel access. Multiple Agents can work in the same Channel.</p></div></div>' +
      '<div class="channels-index-table" role="table" aria-label="Channel grants"><div class="channels-index-table-head" role="row"><span role="columnheader">Channel</span><span role="columnheader">Agents</span><span role="columnheader">Status</span></div><div class="channels-index-list" role="rowgroup">' + rows + '</div></div></section>';
  }

  function slackOverviewHtml() {
    var head = '<div class="slack-head"><span class="slack-logo-large slack-logo-image" role="img" aria-label="Slack"></span>' +
      '<div><h1 class="page-title" style="font-size:1.75rem;">Slack</h1><p class="hint">Manage where Chickpea answers in Slack.</p></div></div>';
    if (!state.slack) {
      return head + '<div class="empty"><p class="field-label">Slack settings are unavailable</p><p class="hint">Reload the page to try the connection again.</p></div>';
    }
    if (!isSlackConnected()) return channelsIndexHtml() + '<section class="channels-connection-card" aria-label="Connect Slack">' + slackStepperHtml() + '</section>';
    return channelsIndexHtml();
  }

  function slackWorkspaceSettingsHtml() {
    if (!state.slack) {
      return '<section class="section"><div class="empty"><p class="field-label">Slack settings are unavailable</p><p class="hint">Reload the page to try the connection again.</p></div></section>';
    }
    if (!isSlackConnected()) {
      return '<section class="section"><div class="section-head"><div><h2 class="section-title">Workspace connection</h2><p class="hint">Connect Slack before publishing Agents to Channels.</p></div></div>' + slackStepperHtml() + '</section>';
    }
    var count = connectedAssignmentCount();
    var mutable = slackConnectionMutable();
    var connectionBusy = !!state.slackConnectionBusy;
    var slackPresentation = slackConnectionPresentation();
    var workspace = '<section class="section"><div class="section-head"><h2 class="section-title">Connected workspace</h2></div>' +
      '<div class="workspace-card"><div class="workspace-ident"><span class="workspace-icon"><span class="platform-logo slack-logo-image" aria-hidden="true"></span></span>' +
      '<div style="min-width:0;"><div class="workspace-name">' + esc(connectedTeamName()) + '</div><div class="workspace-meta mono">Team ID ' + esc(connectedTeamId() || "Unknown") + '</div></div></div>' +
      '<span class="badge ' + (slackPresentation.key === "connected" ? "badge-on" : "badge-off") + '"><span class="dot"></span>' + esc(slackPresentation.label) + '</span>' +
      '<span class="hint">' + esc(count + " configured " + (count === 1 ? "channel" : "channels")) + '</span>' +
      '<span class="hint">' + esc(slackCredentialSummary()) + '</span></div></section>';
    var behavior = '<section class="section"><div class="section-head"><div><h2 class="section-title">Slack behavior</h2>' +
      '<p class="hint">Control how Chickpea behaves across this Slack workspace.</p></div></div>' + slackBehaviorHtml() + '</section>';
    var testButton = state.slackTestBusy
      ? '<button type="button" class="btn btn-soft i-lead" disabled><span class="spinner"></span>Testing&hellip;</button>'
      : '<button type="button" class="btn btn-soft i-lead" data-action="slack-test"' + (connectionBusy ? " disabled" : "") + '>' + icon("arrow-path") + 'Test connection</button>';
    var connection = '<section class="section"><div class="section-head"><div><h2 class="section-title">Connection</h2>' +
      '<p class="hint">Manage this Slack workspace connection.</p></div></div>' +
      '<div class="action-well">' + testButton +
      slackConnectionStatusHtml() + '</div>' +
      (!mutable ? '<div class="action-well"><div class="danger-copy"><span class="danger-title">Reconnect the shared Slack app</span>' +
      '<span class="hint">Refresh Slack authorization without changing Agents, Channel grants, or saved settings.</span></div>' +
      '<button type="button" class="btn btn-soft i-lead" data-action="slack-gateway-refresh"' +
      (connectionBusy ? ' disabled' : '') + '>' + (state.slackConnectionBusy === "refresh" ? '<span class="spinner"></span>Opening Slack&hellip;' : icon("arrow-path") + 'Reconnect with Slack') + '</button>' +
      (state.slackReconnectError ? '<span class="inline-status error" role="alert">' + esc(state.slackReconnectError) + '</span>' : '') +
      '<p class="hint" style="flex-basis:100%;">The Slack Owner or Admin who approves this connection grants Chickpea encrypted access only for managing Agent user groups. If that member’s Slack access changes, reconnect as another current Owner or Admin.</p></div>' : '') +
      '<div class="danger-panel"><div class="danger-copy"><span class="danger-title">Disconnect this workspace</span>' +
      '<span class="hint">Stops Chickpea from answering. Agents and Channel configuration stay saved so you can reconnect later. This does not uninstall the Slack app.</span>' +
      (!mutable ? '<span class="hint">This connection is managed by the environment and is read-only here.</span>' : "") +
      (state.slackDisconnectError ? '<span class="inline-status error">' + esc(state.slackDisconnectError) + '</span>' : "") + '</div>' +
      '<button type="button" class="btn btn-danger" data-action="slack-disconnect-open"' + (mutable && !connectionBusy ? "" : " disabled") + '>Disconnect</button></div></section>';
    return workspace + behavior + connection;
  }

  function slackDisconnectModalHtml() {
    if (!state.slackDisconnectConfirm) return "";
    var button = state.slackDisconnectBusy
      ? '<button type="button" class="btn btn-danger" disabled><span class="spinner"></span>Disconnecting&hellip;</button>'
      : '<button type="button" class="btn btn-danger" data-action="slack-disconnect-confirm">Disconnect workspace</button>';
    return '<div class="modal-backdrop"><div class="modal-card" role="dialog" aria-modal="true" aria-label="Disconnect Slack workspace" tabindex="-1" data-role="slack-disconnect-dialog">' +
      '<h2 class="modal-title">Disconnect ' + esc(connectedTeamName()) + '?</h2>' +
      '<p class="modal-body">Chickpea will stop answering in Slack. Agents and Channel mappings stay saved. The Slack app itself remains installed until you remove it in Slack.</p>' +
      (state.slackDisconnectError ? '<p class="error" style="margin-top:10px;" role="alert" aria-live="assertive" tabindex="-1" data-role="slack-disconnect-error">' + esc(state.slackDisconnectError) + '</p>' : "") +
      '<div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="slack-disconnect-cancel"' + (state.slackDisconnectBusy ? " disabled" : "") + '>Keep connected</button><span class="spacer"></span>' + button + '</div></div></div>';
  }

  function githubDisconnectModalHtml() {
    if (!state.githubDisconnectConfirm) return "";
    var status = state.githubStatus || { mode: "none", referencingProfiles: [] };
    var profiles = status.referencingProfiles || [];
    var names = joinNames(profiles.map(function (profile) {
      return '<span class="mono" style="color:var(--text);">' + esc(profile.name) + '</span>';
    }));
    var profileWarning = profiles.length
      ? '<b style="font-weight:500; color:var(--text);">' + profiles.length + ' Agent' + (profiles.length === 1 ? "" : "s") + '</b> ' + (profiles.length === 1 ? "references" : "reference") + ' GitHub repositories &mdash; ' + names + '. Those repository selections stay saved, but cannot be used until GitHub is reconnected.'
      : 'No Agents currently reference GitHub repositories.';
    var appNote = ' The GitHub App remains installed on GitHub until you remove it there.';
    var button = state.githubBusy === "disconnect"
      ? '<button type="button" class="btn btn-danger" disabled><span class="spinner"></span>Disconnecting&hellip;</button>'
      : '<button type="button" class="btn btn-danger" data-action="github-disconnect-confirm">Disconnect GitHub</button>';
    return '<div class="modal-backdrop"><div class="modal-card" role="dialog" aria-modal="true" aria-label="Disconnect GitHub" tabindex="-1" data-role="github-disconnect-dialog">' +
      '<h2 class="modal-title">Disconnect GitHub?</h2>' +
      '<p class="modal-body">Chickpea will remove the stored GitHub App credentials. Environment-configured App credentials, if present, remain active. ' + profileWarning + appNote + '</p>' +
      (state.githubDisconnectError ? '<p class="error" style="margin-top:10px;" role="alert" aria-live="assertive" tabindex="-1" data-role="github-disconnect-error">' + esc(state.githubDisconnectError) + '</p>' : "") +
      '<div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="github-disconnect-cancel"' + (state.githubBusy === "disconnect" ? " disabled" : "") + '>Keep connected</button><span class="spacer"></span>' + button + '</div></div></div>';
  }

  function sandboxConfirmModalHtml() {
    if (!state.sandboxConfirm) return "";
    var busy = !!state.sandboxSaving;
    var busyStatus = busy
      ? '<p class="sr-only" role="status" aria-live="polite">' + (state.sandboxSaving === "install" ? "Requesting installation." : "Enabling coding sandbox.") + '</p>'
      : '';
    if (state.sandboxConfirm === "install") {
      return '<div class="modal-backdrop"><div class="modal-card" role="dialog" aria-modal="true" aria-label="Install coding sandbox" tabindex="-1" data-role="sandbox-confirm-dialog"><h2 class="modal-title">Install coding sandbox?</h2>' +
        '<p class="modal-body">Requires Cloudflare Workers Paid. The first image build can take several minutes because Cloudflare builds the Ubuntu-based coding image. Disabling later does not remove the Container application or image, so retained infrastructure may continue to exist in your account.</p>' +
        (state.sandboxError ? '<p class="field-error" role="alert" aria-live="assertive" tabindex="-1" data-role="sandbox-confirm-error">' + esc(state.sandboxError) + '</p>' : '') +
        busyStatus +
        '<div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="sandbox-confirm-cancel"' + (busy ? " disabled" : "") + '>Not now</button><span class="spacer"></span><button type="button" class="btn btn-primary" data-action="sandbox-install-confirm"' + (busy ? " disabled" : "") + '>' + (state.sandboxSaving === "install" ? "Requesting&hellip;" : "Request installation") + '</button></div></div></div>';
    }
    return '<div class="modal-backdrop"><div class="modal-card" role="dialog" aria-modal="true" aria-label="Enable coding sandbox" tabindex="-1" data-role="sandbox-confirm-dialog"><h2 class="modal-title">Enable coding sandbox?</h2>' +
      '<p class="modal-body">First verify the rollout at Cloudflare dashboard &rarr; Containers &rarr; Container applications. Open this Worker&rsquo;s Sandbox application and confirm its latest rollout reports ready.</p>' +
      '<label class="conn-tool"><span class="import-check' + (state.sandboxReadyAttested ? " on" : "") + '"><input type="checkbox" data-action="sandbox-ready-attestation" ' + (state.sandboxReadyAttested ? "checked " : "") + (busy ? "disabled " : "") + 'aria-label="I confirmed the Container application is ready"></span><span class="tool-body"><span class="tool-name">I confirmed the Container application is ready</span></span></label>' +
      (state.sandboxError ? '<p class="field-error" role="alert" aria-live="assertive" tabindex="-1" data-role="sandbox-confirm-error">' + esc(state.sandboxError) + '</p>' : '') +
      busyStatus +
      '<div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="sandbox-confirm-cancel"' + (busy ? " disabled" : "") + '>Go back</button><span class="spacer"></span><button type="button" class="btn btn-primary" data-action="sandbox-enable-confirm"' + (!state.sandboxReadyAttested || busy ? " disabled" : "") + '>' + (state.sandboxSaving === "enable" ? "Enabling&hellip;" : "Enable coding sandbox") + '</button></div></div></div>';
  }

  function focusAction(action) {
    var control = document.querySelector('[data-action="' + action + '"]');
    if (control && control.focus) control.focus();
  }

  function focusTeamActionMenu() {
    var control = document.querySelector('[data-action="team-status-action"]');
    if (control && control.focus) control.focus();
  }

  function focusTeamRoleControl(membershipId) {
    var controls = document.querySelectorAll('[data-action="team-role-select"]');
    for (var index = 0; index < controls.length; index += 1) {
      if (controls[index].getAttribute("data-membership") === membershipId) {
        if (controls[index].focus) controls[index].focus();
        return;
      }
    }
  }

  function focusTeamActionTrigger(membershipId) {
    var controls = document.querySelectorAll('[data-action="team-actions-toggle"]');
    for (var index = 0; index < controls.length; index += 1) {
      if (controls[index].getAttribute("data-membership") === membershipId) {
        if (controls[index].focus) controls[index].focus();
        return;
      }
    }
  }

  function focusSlackDisconnectDialog() {
    var dialog = document.querySelector('[data-role="slack-disconnect-dialog"]');
    if (dialog && dialog.focus) dialog.focus();
  }

  function focusGithubDisconnectDialog() {
    var dialog = document.querySelector('[data-role="github-disconnect-dialog"]');
    if (dialog && dialog.focus) dialog.focus();
  }

  function focusSlackLiveRegion(role) {
    var region = document.querySelector('[data-role="' + role + '"]');
    if (region && region.focus) region.focus();
  }

  // ---- Connected funnel (card 04) ------------------------------------------

  function funnelHtml() {
    return '<div class="empty" style="align-items:center; text-align:center; gap:14px; padding:46px 32px;">' +
      '<h1 class="page-title" style="font-size:1.1875rem;">Publish an Agent to start</h1>' +
      '<p class="hint" style="max-width:452px; font-size:0.875rem; line-height:1.55;">Channels grant reach only. Open an Agent and choose the Slack Channels where its handle should work.</p>' +
      '<button type="button" class="btn btn-primary" style="margin-top:4px; padding:9px 18px;" data-action="open-profiles">Open Agents</button>' +
      '<p class="hint">Want proof right now? DM <span class="mono" style="color:var(--text-2);">' + slackMentionHtml() + '</span> &mdash; direct messages already work.</p>' +
      '</div>';
  }

  function connectionDetailsHtml() {
    var conn = state.slack;
    if (!conn) return "";
    return '<details class="advanced"><summary>Connection details</summary>' +
      '<div style="padding-bottom:14px;">' + slackCredentialsWellHtml(conn) + '</div></details>';
  }

  // ---- Add-channel (dropdown-driven, main panel) ---------------------------

  function isSlackConnected() {
    return !!(state.slack && state.slack.connected);
  }

  function slackReconnectRequired(detail) {
    return ["binding_mismatch", "binding_reconnect_required", "gateway_binding_missing", "gateway_binding_mismatch", "gateway_not_connected"].indexOf(String(detail || "")) >= 0;
  }

  function slackConnectionPresentation() {
    if (!isSlackConnected() || (state.slack && state.slack.health === "revoked")) {
      return { key: "disconnected", label: "Not connected" };
    }
    if (state.slack && state.slack.health && state.slack.health !== "healthy") {
      if (slackReconnectRequired(state.slack.healthDetail)) {
        return { key: "attention", label: "Reconnect required" };
      }
      return { key: "attention", label: "Needs attention" };
    }
    return { key: "connected", label: "Connected" };
  }

  function slackDisplayName() {
    return "Chickpea";
  }

  function slackMentionText() {
    return "@" + slackDisplayName();
  }

  function slackMentionHtml() {
    return "@" + esc(slackDisplayName());
  }

  // The connected workspace id/name come from the channels proxy first (it
  // backfills and always returns them when connected), then the connection card.
  function connectedTeamId() {
    if (state.slackChannels && state.slackChannels.teamId) return state.slackChannels.teamId;
    if (state.slack && state.slack.teamId) return state.slack.teamId;
    return "";
  }

  function loadAgentConnections(agentId) {
    var workspaceId = connectedTeamId();
    if (state.connectionAccountsSupported === false) {
      state.agentConnections = { agentId: agentId, workspaceId: workspaceId, attached: [], available: [], managedCatalog: [], managedCanConfigure: false, managedConfigurationReadOnly: false, loading: false, error: "", notice: "", legacyFallback: true };
      render();
      return Promise.resolve();
    }
    var requestState = { agentId: agentId, workspaceId: workspaceId, attached: [], available: [], managedCatalog: [], managedCanConfigure: false, managedConfigurationReadOnly: false, loading: true, error: "", notice: "" };
    state.agentConnections = requestState;
    render();
    if (!workspaceId) {
      state.agentConnections.loading = false;
      state.agentConnections.error = "Connect Slack before adding Agent connections.";
      render();
      return Promise.resolve();
    }
    return api("/admin/api/agents/" + encodeURIComponent(agentId) + "/connections?workspaceId=" + encodeURIComponent(workspaceId)).then(function (body) {
      if (state.agentConnections !== requestState) return;
      state.agentConnections.attached = body.attached || [];
      state.agentConnections.available = body.available || [];
      state.agentConnections.managedCatalog = body.managedConnectors && body.managedConnectors.catalog || [];
      state.agentConnections.managedCanConfigure = !!(body.managedConnectors && body.managedConnectors.canConfigure);
      state.agentConnections.managedConfigurationReadOnly = !!(body.managedConnectors && body.managedConnectors.configurationReadOnly);
      // Older servers predate the availability field and supported only the
      // managed gallery behavior. Current servers report it explicitly so OSS
      // deployments without Composio retain native Google OAuth setup.
      state.agentConnections.managedGoogleAvailable = !body.managedConnectors ||
        body.managedConnectors.composio === true;
      state.agentConnections.loading = false;
      state.agentConnections.error = "";
      state.connectionAccountsSupported = true;
      restoreManagedAuthorization(agentId);
      render();
    }).catch(function (error) {
      if (state.agentConnections !== requestState) return;
      state.agentConnections.loading = false;
      state.agentConnections.legacyFallback = !!(error && error.status === 404);
      if (state.agentConnections.legacyFallback) state.connectionAccountsSupported = false;
      state.agentConnections.error = (error && (error.serverMessage || error.message)) || "Could not load connections.";
      render();
    });
  }

  function loadAgentSchedules(agentId) {
    var requestState = { agentId: agentId, viewerMembershipId: "", schedules: [], members: [], loading: true, busy: "", error: "", notice: "" };
    state.agentSchedules = requestState;
    render();
    return api("/admin/api/agents/" + encodeURIComponent(agentId) + "/schedules", { cache: "no-store" }).then(function (body) {
      if (state.agentSchedules !== requestState) return;
      state.agentSchedules.schedules = body.schedules || [];
      state.agentSchedules.members = body.members || [];
      state.agentSchedules.viewerMembershipId = body.viewerMembershipId || "";
      state.agentSchedules.loading = false;
      state.agentSchedules.error = "";
      render();
    }).catch(function (error) {
      if (state.agentSchedules !== requestState) return;
      state.agentSchedules.loading = false;
      state.agentSchedules.error = (error && (error.serverMessage || error.message)) || "Could not load schedules.";
      render();
    });
  }

  function reassignAgentSchedule(scheduleId, expectedRevision) {
    var schedules = state.agentSchedules;
    var membershipId = schedules.viewerMembershipId || "";
    if (!membershipId || schedules.busy) return;
    schedules.busy = scheduleId;
    schedules.error = "";
    schedules.notice = "";
    render();
    return postJson(
      "/admin/api/agents/" + encodeURIComponent(schedules.agentId) + "/schedules/" + encodeURIComponent(scheduleId) + "/reassign",
      "POST",
      { runsAsMembershipId: membershipId, expectedAuthorityRevision: Number(expectedRevision) }
    ).then(function (body) {
      var notice = body && body.routine && body.routine.state === "paused"
        ? "Schedule authority updated. This routine is still paused."
        : "Schedule authority updated and paused work resumed.";
      return loadAgentSchedules(schedules.agentId).then(function () {
        if (state.agentSchedules.agentId !== schedules.agentId) return;
        state.agentSchedules.notice = notice;
        render();
      });
    }).catch(function (error) {
      schedules.busy = "";
      schedules.error = (error && (error.serverMessage || error.message)) || "Could not update Runs as.";
      render();
    });
  }

  function newConnectionAccountForm() {
    state.connectorGallerySearch = "";
    state.connectionAccountForm = {
      ownerKind: "team",
      kind: "api",
      authMode: "credential",
      presetId: "",
      preset: null,
      apiEditor: null,
      mcpEditor: null,
      apiSubdomain: "",
      providerId: "",
      label: "",
      purpose: "",
      url: "",
      capabilities: "",
      credential: "",
      oauthClientId: "",
      oauthClientSecret: "",
      busy: false,
      error: ""
    };
    render();
  }

  function newConnectionAccountFormFromPreset(presetId, preferredOwnerKind) {
    var googleService = googleServicePresetById(presetId);
    var managedPreset = managedPresetById(presetId);
    var managedCandidate = managedPreset || googleService;
    var managedDescriptor = managedCandidate && managedConnectorDescriptorById(managedCandidate.id);
    if (managedCandidate && managedDescriptor && !managedConnectorLaneReady(managedDescriptor, "read")) {
      openComposioSetup(managedCandidate, managedDescriptor, preferredOwnerKind);
      return;
    }
    if (managedCandidate && managedDescriptor && managedConnectorLaneReady(managedDescriptor, "read")) {
      state.connectionAccountForm = {
        ownerKind: preferredOwnerKind === "member" ? "member" : "team",
        kind: "managed",
        authMode: "composio",
        presetId: managedCandidate.id,
        preset: managedCandidate,
        managedToolkit: managedDescriptor.toolkit,
        managedAccess: "read",
        providerId: managedDescriptor.providerId,
        label: managedCandidate.name,
        busy: false,
        error: ""
      };
      state.connectorGallerySearch = "";
      render();
      return;
    }
    var preset = googleService && googleService.connectionPresetId
      ? presetById(googleService.connectionPresetId)
      : presetById(presetId);
    if (!preset) return;
    if (googleService && googleService.service) {
      var googleEditor = apiEditorFromPreset(preset);
      googleEditor.googleAccess = { gmail: "off", calendar: "off", drive: "off" };
      googleEditor.googleAccess[googleService.service] = "read";
      syncGoogleApiPolicy(googleEditor);
      state.connectionAccountForm = {
        ownerKind: preferredOwnerKind === "member" ? "member" : "team",
        kind: "api",
        authMode: "google_oauth",
        presetId: googleService.id,
        preset: googleService,
        apiEditor: googleEditor,
        mcpEditor: null,
        apiSubdomain: "",
        providerId: "google",
        label: googleService.name,
        purpose: "",
        url: "",
        capabilities: "",
        credential: "",
        oauthClientId: "",
        oauthClientSecret: "",
        busy: false,
        error: ""
      };
      state.connectorGallerySearch = "";
      render();
      return;
    }
    var lanes = presetLanes(preset);
    if (lanes.api && !lanes.mcp) {
      var apiEditor = apiEditorFromPreset(preset);
      state.connectionAccountForm = {
        ownerKind: preferredOwnerKind === "member" ? "member" : "team",
        kind: "api",
        authMode: isGoogleWorkspaceEditor(apiEditor) ? "google_oauth" : "credential",
        presetId: preset.id,
        preset: preset,
        apiEditor: apiEditor,
        mcpEditor: null,
        apiSubdomain: apiConnectionSubdomain(apiEditor),
        providerId: preset.id,
        label: preset.name,
        purpose: "",
        url: "",
        capabilities: "",
        credential: "",
        oauthClientId: "",
        oauthClientSecret: "",
        busy: false,
        error: ""
      };
    } else {
      var mcpEditor = editorFromPreset(preset);
      state.connectionAccountForm = {
        ownerKind: preferredOwnerKind === "member" ? "member" : "team",
        kind: "mcp",
        authMode: mcpEditor.authMode,
        presetId: preset.id,
        preset: preset,
        apiEditor: null,
        mcpEditor: mcpEditor,
        apiSubdomain: "",
        providerId: preset.id,
        label: preset.name,
        purpose: "",
        url: mcpEditor.url,
        capabilities: "",
        credential: "",
        oauthClientId: "",
        oauthClientSecret: "",
        busy: false,
        error: ""
      };
    }
    state.connectorGallerySearch = "";
    render();
  }

  function connectionAccountCapabilities(form) {
    return String(form.capabilities || "").split(",").map(function (value) { return value.trim(); }).filter(Boolean);
  }

  function connectionAccountProviderId(form) {
    return String(form.providerId || form.label || "custom").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128);
  }

  function createConnectionAccount() {
    var form = state.connectionAccountForm;
    var agentId = state.profileDraft && state.profileDraft.id;
    if (!form || !agentId || form.busy) return;
    if (form.kind === "managed") {
      if (!managedConnectorDescriptorByToolkit(form.managedToolkit)) {
        form.error = "This managed connector is unavailable.";
        render();
        return;
      }
      startManagedAuthorization({
        workspaceId: state.agentConnections.workspaceId,
        ownerKind: form.ownerKind === "member" ? "member" : "team",
        toolkit: form.managedToolkit,
        access: form.managedAccess === "write" ? "write" : "read"
      }, form.preset && form.preset.name || "Managed connector");
      return;
    }
    var providerId = connectionAccountProviderId(form);
    var label = String(form.label || "").trim();
    var rawUrl = String(form.url || "").trim();
    var googleOauth = form.kind === "api" && form.authMode === "google_oauth";
    var mcpOauth = form.kind === "mcp" && form.authMode === "oauth";
    var presetApi = form.kind === "api" && form.apiEditor;
    var presetMcp = form.kind === "mcp" && form.mcpEditor;
    var credentialOptional = !!(form.preset && form.preset.auth && form.preset.auth.optional === true);
    var credentialRequired = !googleOauth && !credentialOptional && (
      form.kind === "api" ||
      (presetMcp && (presetMcp.authMode === "bearer" || (presetMcp.headerNames || []).length > 0))
    );
    if (!providerId) form.error = "Provider is required.";
    else if (!label) form.error = "Account label is required.";
    else if (!googleOauth && !presetApi && !rawUrl) form.error = form.kind === "mcp" ? "Server URL is required." : "API base URL is required.";
    else if (googleOauth && providerId !== "google") form.error = "Google OAuth connections must use the google provider.";
    else if (googleOauth && (!String(form.oauthClientId || "").trim() || !String(form.oauthClientSecret || "").trim())) form.error = "Google OAuth client ID and secret are required.";
    else if (credentialRequired && !String(form.credential || "").trim()) form.error = "Enter the credential for this connection.";
    else if (presetMcp && presetMcp.presetId === "supabase" && !validSupabaseProjectRef(presetMcp.supabaseProjectRef)) form.error = "Enter a valid Supabase project reference.";
    else if (presetMcp && presetMcp.presetId === "sentry" && !sentryScopeFromUrl(presetMcp.url)) form.error = "Enter valid lowercase Sentry organization and project slugs.";
    else if (presetMcp && presetMcp.presetId === "sentry" && presetMcp.sentryProjectSlug && !presetMcp.sentryOrganizationSlug) form.error = "Enter a Sentry organization before a project.";
    else form.error = "";
    var parsedUrl = null;
    if (!form.error && !googleOauth && !presetApi) {
      try { parsedUrl = new URL(rawUrl); } catch (error) { form.error = "Enter a valid https URL."; }
      if (parsedUrl && parsedUrl.protocol !== "https:") form.error = "Connection URLs must use https.";
    }
    if (!form.error && presetApi && presetApi.hostTemplate) {
      var subdomain = String(form.apiSubdomain || "").trim().toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
        form.error = "Enter the workspace subdomain from your service URL.";
      } else {
        var templateParts = apiConnectionHostTemplateParts(presetApi);
        if (!templateParts.valid) {
          form.error = "This connector's workspace URL template is invalid.";
        } else {
          presetApi.allowedHosts = [templateParts.prefix + subdomain + templateParts.suffix];
        }
      }
    }
    if (form.error) { render(); return; }
    var capabilities = connectionAccountCapabilities(form);
    var connectionId = providerId.slice(0, 48) || "custom";
    var body = {
      workspaceId: state.agentConnections.workspaceId,
      ownerKind: form.ownerKind === "member" ? "member" : "team",
      providerId: providerId,
      label: label,
      purpose: String(form.purpose || "").trim() || undefined,
      credential: String(form.credential || "").trim() || undefined,
      allowedCapabilities: capabilities
    };
    if (form.kind === "mcp") {
      var sourceMcp = presetMcp || {
        id: connectionId,
        displayName: label,
        url: parsedUrl.toString(),
        transport: "streamable-http",
        authMode: body.credential ? "bearer" : "none",
        headerNames: [],
        discoveredTools: [],
        allowedTools: []
      };
      body.mcp = {
        id: connectionId,
        displayName: label,
        url: sourceMcp.url,
        transport: sourceMcp.transport,
        authMode: sourceMcp.authMode,
        headerNames: (sourceMcp.headerNames || []).slice(),
        enabled: true,
        lifecycleStatus: "pending",
        statusText: "",
        discoveredTools: (sourceMcp.discoveredTools && sourceMcp.discoveredTools.length
          ? sourceMcp.discoveredTools
          : capabilities.map(function (name) { return { name: name }; })).slice(),
        allowedTools: (sourceMcp.allowedTools && sourceMcp.allowedTools.length
          ? sourceMcp.allowedTools
          : capabilities).slice()
      };
      if (sourceMcp.oauthScope) body.mcp.oauthScope = sourceMcp.oauthScope;
      if (form.preset && !googleServicePresetById(form.presetId)) body.mcp.presetId = form.preset.id;
      if (form.preset && form.preset.auth && form.preset.auth.kind === "header") {
        body.mcp.credentialHeaderName = form.preset.auth.headerName;
        if (form.preset.auth.valuePrefix) body.mcp.credentialValuePrefix = form.preset.auth.valuePrefix;
        if (form.preset.auth.optional === true) body.mcp.credentialOptional = true;
      }
    } else if (googleOauth) {
      body.providerId = "google";
      delete body.credential;
      var googleEditor = form.apiEditor;
      if (!googleEditor) {
        googleEditor = apiEditorFromPreset(presetById("google-workspace"));
        googleEditor.googleAccess = { gmail: "read", calendar: "off", drive: "off" };
        syncGoogleApiPolicy(googleEditor);
      }
      body.api = {
        id: "google-workspace",
        displayName: label,
        allowedHosts: googleEditor.allowedHosts.slice(),
        pathPrefixes: googleEditor.pathPrefixes.slice(),
        headerName: googleEditor.headerName,
        headerValuePrefix: googleEditor.headerValuePrefix,
        allowedMethods: API_CONNECTION_METHODS.filter(function (_method, index) { return googleEditor.methodChecked[index]; }),
        enabled: true,
        authMode: "oauth",
        oauthProvider: "google",
        oauthScopes: googleEditor.oauthScopes.slice(),
        oauthAppType: "external",
        lifecycleStatus: "pending",
        statusText: "Not connected",
        presetId: "google-workspace"
      };
    } else if (presetApi) {
      body.api = {
        id: connectionId,
        displayName: label,
        allowedHosts: presetApi.allowedHosts.slice(),
        pathPrefixes: presetApi.pathPrefixes.slice(),
        headerName: presetApi.headerName,
        headerValuePrefix: presetApi.headerValuePrefix,
        allowedMethods: API_CONNECTION_METHODS.filter(function (_method, index) { return presetApi.methodChecked[index]; }),
        enabled: true,
        authMode: "credential",
        presetId: presetApi.presetId
      };
    } else {
      var path = parsedUrl.pathname || "/";
      while (path.length > 1 && path.charAt(path.length - 1) === "/") path = path.slice(0, -1);
      body.api = {
        id: connectionId,
        displayName: label,
        allowedHosts: [parsedUrl.hostname],
        pathPrefixes: [path],
        headerName: "Authorization",
        headerValuePrefix: "Bearer ",
        allowedMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
        enabled: true,
        authMode: "credential"
      };
    }
    form.busy = true;
    render();
    var prepare = Promise.resolve();
    if (presetMcp && !mcpOauth) {
      presetMcp.bearerToken = presetMcp.authMode === "bearer" ? body.credential || "" : "";
      presetMcp.headerValues = (presetMcp.headerNames || []).map(function () { return body.credential || ""; });
      prepare = postJson("/admin/api/agents/" + encodeURIComponent(agentId) + "/mcp/test", "POST", connectionTestBody(presetMcp)).then(function (tested) {
        if (!tested || !tested.ok) throw new Error((tested && tested.message) || "Could not connect to this MCP server.");
        var tools = (tested.tools || []).map(function (tool) {
          return { name: tool.name, title: tool.title, description: tool.description };
        });
        body.mcp.discoveredTools = tools;
        body.mcp.allowedTools = tools.map(function (tool) { return tool.name; });
        body.allowedCapabilities = body.mcp.allowedTools.slice();
      });
    }
    prepare.then(function () {
      return postJson("/admin/api/agents/" + encodeURIComponent(agentId) + "/connections", "POST", body);
    }).then(function (created) {
      if (googleOauth) {
        var accountId = created && created.account && created.account.id;
        if (!accountId) throw new Error("Connection response was missing its account.");
        return postJson("/admin/api/agents/" + encodeURIComponent(agentId) + "/connections/" + encodeURIComponent(accountId) + "/oauth/api/client", "PUT", {
          provider: "google",
          clientId: String(form.oauthClientId || "").trim(),
          clientSecret: String(form.oauthClientSecret || "").trim()
        }).then(function () {
          return startConnectionAccountOAuth(accountId, true);
        });
      }
      if (mcpOauth) {
        var mcpAccountId = created && created.account && created.account.id;
        if (!mcpAccountId) throw new Error("Connection response was missing its account.");
        return startConnectionAccountOAuth(mcpAccountId, true, "mcp");
      }
      state.connectionAccountForm = null;
      return loadAgentConnections(agentId);
    }).then(function (result) {
      if (result && result.oauthStarted) return;
      state.agentConnections.notice = label + " is connected to this Agent.";
      render();
    }).catch(function (error) {
      if (!state.connectionAccountForm) return;
      state.connectionAccountForm.busy = false;
      state.connectionAccountForm.error = (error && (error.serverMessage || error.message)) || "Could not create the connection.";
      render();
    });
  }

  function attachConnectionAccount(accountId) {
    var agentId = state.profileDraft && state.profileDraft.id;
    if (!agentId) return;
    postJson("/admin/api/agents/" + encodeURIComponent(agentId) + "/connections/" + encodeURIComponent(accountId) + "/attach", "POST", { allowedCapabilities: [] }).then(function () {
      return loadAgentConnections(agentId);
    }).catch(function (error) {
      state.agentConnections.error = (error && (error.serverMessage || error.message)) || "Could not add that connection.";
      render();
    });
  }

  function startConnectionAccountOAuth(accountId, fromCreate, lane) {
    var agentId = state.profileDraft && state.profileDraft.id;
    if (!agentId) return Promise.reject(new Error("Save the Agent before signing in."));
    var oauthRoute = lane === "mcp" ? "/oauth/mcp/start" : "/oauth/api/start";
    return postJson("/admin/api/agents/" + encodeURIComponent(agentId) + "/connections/" + encodeURIComponent(accountId) + oauthRoute, "POST", {}).then(function (body) {
      var authorizationUrl;
      try { authorizationUrl = new URL(String(body && body.authorizationUrl || "")); } catch (error) { throw new Error("OAuth start returned an invalid URL."); }
      if (authorizationUrl.protocol !== "https:") throw new Error("OAuth authorization must use https.");
      if (fromCreate) state.connectionAccountForm = null;
      location.assign(authorizationUrl.href);
      return { oauthStarted: true };
    }).catch(function (error) {
      if (fromCreate && state.connectionAccountForm) throw error;
      state.agentConnections.error = (error && (error.serverMessage || error.message)) || "Could not start sign-in.";
      render();
      return { oauthStarted: false };
    });
  }

  function managedAuthorizationStorageKey(agentId) {
    return "chickpea.managed-authorization.v1:" + String(agentId || "");
  }

  function persistManagedAuthorization(value) {
    try {
      if (value && value.agentId) {
        sessionStorage.setItem(managedAuthorizationStorageKey(value.agentId), JSON.stringify({
          agentId: value.agentId,
          toolkit: value.toolkit || "",
          label: value.label || "Managed connector",
          authorizationUrl: value.authorizationUrl,
          pollUrl: value.pollUrl,
          expiresAt: value.expiresAt,
          startedAt: value.startedAt,
          returnToSettings: !!value.returnToSettings,
          popupBlocked: !!value.popupBlocked
        }));
      }
    } catch (_) { /* session storage is an optional refresh convenience */ }
  }

  function clearManagedAuthorization(agentId) {
    try { sessionStorage.removeItem(managedAuthorizationStorageKey(agentId)); } catch (_) {}
    state.managedAuthorization = null;
  }

  function restoreManagedAuthorization(agentId) {
    if (!agentId || state.managedAuthorization) return;
    try {
      var raw = sessionStorage.getItem(managedAuthorizationStorageKey(agentId));
      if (!raw) return;
      var parsed = JSON.parse(raw);
      var authorizationUrl = new URL(String(parsed.authorizationUrl || ""));
      if (parsed.agentId !== agentId || authorizationUrl.protocol !== "https:" ||
          !String(parsed.pollUrl || "").startsWith("/admin/api/agents/") ||
          Number(parsed.expiresAt || 0) <= Date.now()) {
        sessionStorage.removeItem(managedAuthorizationStorageKey(agentId));
        return;
      }
      state.managedAuthorization = {
        agentId: agentId,
        toolkit: String(parsed.toolkit || ""),
        label: String(parsed.label || "Managed connector"),
        authorizationUrl: authorizationUrl.href,
        pollUrl: String(parsed.pollUrl),
        expiresAt: Number(parsed.expiresAt),
        startedAt: Number(parsed.startedAt) > 0
          ? Number(parsed.startedAt)
          : Number(parsed.expiresAt) - 30 * 60 * 1000,
        status: "waiting",
        error: "",
        pollScheduled: false,
        pollAttempts: 0,
        returnToSettings: !!parsed.returnToSettings,
        popupBlocked: !!parsed.popupBlocked
      };
      pollManagedAuthorization();
    } catch (_) {
      try { sessionStorage.removeItem(managedAuthorizationStorageKey(agentId)); } catch (_) {}
    }
  }

  function openManagedAuthorizationTab(url) {
    var opened = null;
    try { opened = window.open(url, "_blank", "noopener,noreferrer"); } catch (_) { opened = null; }
    return !!opened;
  }

  function startManagedAuthorization(body, label, context) {
    var form = state.connectionAccountForm;
    var agentId = context && context.agentId || state.profileDraft && state.profileDraft.id;
    if (!agentId || state.managedAuthorization) return;
    if (form) { form.busy = true; form.error = ""; }
    state.agentConnections.error = "";
    render();
    postJson(
      "/admin/api/agents/" + encodeURIComponent(agentId) + "/connections/managed/start",
      "POST",
      body
    ).then(function (response) {
      var authorizationUrl;
      try { authorizationUrl = new URL(String(response && response.authorizationUrl || "")); } catch (_) { throw new Error("Managed sign-in returned an invalid URL."); }
      if (authorizationUrl.protocol !== "https:") throw new Error("Managed sign-in must use https.");
      var pollUrl = String(response && response.pollUrl || "");
      if (!pollUrl.startsWith("/admin/api/agents/")) throw new Error("Managed sign-in returned an invalid status URL.");
      var descriptor = "toolkit" in body ? managedConnectorDescriptorByToolkit(body.toolkit) : null;
      state.connectionAccountForm = null;
      state.managedAuthorization = {
        agentId: agentId,
        toolkit: descriptor && descriptor.toolkit || "",
        label: label || descriptor && descriptor.label || "Managed connector",
        authorizationUrl: authorizationUrl.href,
        pollUrl: pollUrl,
        expiresAt: Date.now() + 30 * 60 * 1000,
        startedAt: Date.now(),
        status: "waiting",
        error: "",
        pollScheduled: false,
        pollAttempts: 0,
        popupBlocked: !openManagedAuthorizationTab(authorizationUrl.href),
        returnToSettings: !!(context && context.returnToSettings)
      };
      persistManagedAuthorization(state.managedAuthorization);
      render();
      pollManagedAuthorization();
    }).catch(function (error) {
      if (form && state.connectionAccountForm === form) {
        form.busy = false;
        form.error = (error && (error.serverMessage || error.message)) || "Could not start managed sign-in.";
      } else if (context && context.returnToSettings) {
        state.connectionInventory.error = (error && (error.serverMessage || error.message)) || "Could not start managed sign-in.";
      } else {
        state.agentConnections.error = (error && (error.serverMessage || error.message)) || "Could not start managed sign-in.";
      }
      render();
    });
  }

  function scheduleManagedAuthorizationPoll(current) {
    if (!current || state.managedAuthorization !== current || current.pollScheduled || current.status !== "waiting") return;
    current.pollScheduled = true;
    var delay = current.pollAttempts < 20 ? 1500 : current.pollAttempts < 38 ? 5000 : 15000;
    window.setTimeout(function () {
      if (state.managedAuthorization !== current) return;
      current.pollScheduled = false;
      pollManagedAuthorization();
    }, delay);
  }

  function pollManagedAuthorization() {
    var current = state.managedAuthorization;
    if (!current || current.status === "checking") return;
    if (Date.now() >= current.expiresAt) {
      current.status = "failed";
      current.error = "This sign-in link expired. Start again to create a fresh link.";
      render();
      return;
    }
    if (Date.now() - current.startedAt >= 5 * 60 * 1000) {
      current.status = "failed";
      current.error = "Still waiting for approval. Finish sign-in, then check again.";
      render();
      return;
    }
    current.status = "checking";
    current.pollAttempts += 1;
    return postJson(current.pollUrl, "POST", {}).then(function (body) {
      if (state.managedAuthorization !== current) return;
      if (body && body.status === "connected") {
        var agentId = current.agentId;
        var label = current.label;
        var returnToSettings = current.returnToSettings;
        var connectedAccountId = body.account && body.account.id;
        clearManagedAuthorization(agentId);
        if (returnToSettings) {
          return loadConnectionInventory(state.settingsLoadGeneration).then(function () {
            state.connectionInventory.notice = label + " is connected again.";
            render();
          });
        }
        return loadAgentConnections(agentId).then(function () {
          if (state.agentConnections.agentId !== agentId) return;
          var connectedEntry = state.agentConnections.attached.find(function (entry) {
            return entry.account && entry.account.id === connectedAccountId;
          });
          if (connectedEntry && connectedEntry.account.lifecycle === "pending" &&
              managedResourceDefinitions(connectedEntry.account).length > 0) {
            startManagedResourceSelection(connectedEntry.account.id);
            return;
          }
          state.agentConnections.notice = label + " is connected and ready for this Agent.";
          render();
        });
      }
      current.error = "";
      current.status = "waiting";
      render();
      scheduleManagedAuthorizationPoll(current);
    }).catch(function (error) {
      if (state.managedAuthorization !== current) return;
      if (error && error.status === 409 &&
          (error.message === "managed_authorization_invalid" ||
            error.message === "managed_authorization_terminal" ||
            error.message === "managed_authorization_stale_provider")) {
        clearManagedAuthorization(current.agentId);
        var staleProvider = error.message === "managed_authorization_stale_provider";
        if (current.returnToSettings) {
          state.connectionInventory.error = staleProvider
            ? "The connector configuration changed. Start the reconnection again."
            : error.message === "managed_authorization_terminal"
            ? "The provider did not complete that sign-in. Start the reconnection again."
            : "That sign-in is no longer active. Start the reconnection again.";
        } else {
          state.agentConnections.error = staleProvider
            ? "The connector configuration changed. Start the connection again."
            : error.message === "managed_authorization_terminal"
            ? "The provider did not complete that sign-in. Start the connection again."
            : "That sign-in is no longer active. Start the connection again.";
        }
        render();
        return;
      }
      if (error && (error.status === 503 || error.status >= 500)) {
        current.status = "waiting";
        current.error = "Sign-in check is temporarily unavailable. Chickpea will keep trying.";
        render();
        scheduleManagedAuthorizationPoll(current);
        return;
      }
      current.status = "failed";
      current.error = (error && error.serverMessage) || "Sign-in could not be checked. Try again.";
      render();
    });
  }

  function cancelManagedAuthorization() {
    var current = state.managedAuthorization;
    if (!current || current.status === "cancelling") return;
    current.status = "cancelling";
    current.error = "";
    render();
    postJson(
      "/admin/api/agents/" + encodeURIComponent(current.agentId) + "/connections/managed/cancel",
      "POST",
      {}
    ).then(function () {
      clearManagedAuthorization(current.agentId);
      render();
    }).catch(function (error) {
      if (state.managedAuthorization !== current) return;
      current.status = "failed";
      current.error = (error && (error.serverMessage || error.message)) || "Could not cancel this sign-in safely.";
      render();
    });
  }

  function reconnectManagedConnection(accountId) {
    var agentId = state.profileDraft && state.profileDraft.id;
    if (!agentId || !accountId) return;
    var entry = (state.agentConnections.attached || []).concat(
      (state.agentConnections.available || []).map(function (account) { return { account: account }; })
    ).find(function (candidate) { return candidate.account && candidate.account.id === accountId; });
    startManagedAuthorization(
      { workspaceId: state.agentConnections.workspaceId, connectionAccountId: accountId },
      entry && entry.account ? connectionAccountDisplayName(entry.account) : "Managed connector"
    );
  }

  function reconnectSettingsConnectionAccount(accountId, agentId) {
    if (!accountId || !agentId || state.managedAuthorization) return;
    var entry = (state.connectionInventory.accounts || []).find(function (candidate) {
      return candidate.account && candidate.account.id === accountId;
    });
    if (!entry || !entry.account || !entry.account.policy || entry.account.policy.kind !== "managed") return;
    state.connectionInventory.error = "";
    state.connectionInventory.notice = "";
    startManagedAuthorization(
      { workspaceId: connectedTeamId(), connectionAccountId: accountId },
      entry.account.label || entry.account.providerId || "Managed connector",
      { agentId: agentId, returnToSettings: true }
    );
  }

  function detachConnectionAccount(accountId) {
    var agentId = state.profileDraft && state.profileDraft.id;
    if (!agentId) return;
    var detachPath = "/admin/api/agents/" + encodeURIComponent(agentId) + "/connections/" + encodeURIComponent(accountId);
    function detachWithCleanupRetry(allowRetry) {
      return api(detachPath, { method: "DELETE" }).catch(function (error) {
        if (allowRetry && error && error.payload && error.payload.error === "connection_schedule_changed") {
          return api(detachPath, { method: "DELETE" });
        }
        throw error;
      });
    }
    detachWithCleanupRetry(true).then(function () {
      return loadAgentConnections(agentId);
    }).catch(function (error) {
      state.agentConnections.error = (error && (error.serverMessage || error.message)) || "Could not remove that connection from the Agent.";
      render();
    });
  }

  function revokeConnectionAccount(accountId) {
    var label = "this account";
    var managed = false;
    var knownAccounts = (state.agentConnections.attached || [])
      .concat((state.agentConnections.available || []).map(function (account) { return { account: account }; }))
      .concat(state.connectionInventory.accounts || []);
    knownAccounts.some(function (entry) {
      if (entry.account && entry.account.id === accountId) {
        label = connectionAccountDisplayName(entry.account);
        managed = Boolean(entry.account.policy && entry.account.policy.kind === "managed");
        return true;
      }
      return false;
    });
    var confirmation = managed
      ? "Disconnect " + label + "? Chickpea will remove access immediately, pause dependent schedules, and delete the stored managed account. The provider may still list the authorization until you remove it from the provider’s account settings."
      : "Disconnect " + label + "? Every Agent using it will lose access and dependent schedules will pause.";
    if (!window.confirm(confirmation)) return;
    var revokePath = "/admin/api/connections/" + encodeURIComponent(accountId) + "/revoke";
    function revokeWithCleanupRetry(allowRetry) {
      return postJson(revokePath, "POST", {}).catch(function (error) {
        if (allowRetry && error && error.payload && error.payload.error === "connection_schedule_changed") {
          return postJson(revokePath, "POST", {});
        }
        throw error;
      });
    }
    revokeWithCleanupRetry(true).then(function () {
      if (primarySection() === "settings" && state.settingsSection === "connectors") {
        return loadConnectionInventory(state.settingsLoadGeneration);
      }
      return loadAgentConnections(state.profileDraft.id);
    }).then(function () {
      var notice = managed
          ? label + " was disconnected. To fully revoke provider access, remove the authorization in the provider’s account settings."
          : label + " was disconnected.";
      if (primarySection() === "settings" && state.settingsSection === "connectors") {
        state.connectionInventory.notice = notice;
      } else {
        state.agentConnections.notice = notice;
      }
      render();
    }).catch(function (error) {
      if (primarySection() === "settings" && state.settingsSection === "connectors") {
        state.connectionInventory.error = (error && (error.serverMessage || error.message)) || "Could not disconnect that account.";
      } else {
        state.agentConnections.error = (error && (error.serverMessage || error.message)) || "Could not disconnect that account.";
      }
      render();
    });
  }

  function connectedTeamName() {
    if (state.slackChannels && state.slackChannels.teamName) return state.slackChannels.teamName;
    if (state.slack && state.slack.teamName) return state.slack.teamName;
    return connectedTeamId() || "your workspace";
  }

  function defaultAgentName() {
    var agent = defaultAgent();
    return agent ? agent.name : "an Agent";
  }

  // The profile a newly added channel will get: the one carried in from the
  // profile page's "Add a new channel with this profile", else the Default.
  function addChannelAgentName() {
    var carried = agentById(state.addChannelAgentId);
    return carried ? carried.name : defaultAgentName();
  }

  function findSlackChannel(channelId) {
    var channels = (state.slackChannels && state.slackChannels.channels) || [];
    return channels.find(function (channel) { return channel.id === channelId; }) || null;
  }

  function addChannelButtonHtml(classes) {
    var disabled = !isSlackConnected();
    return '<button type="button" class="' + classes + '" data-action="toggle-add-channel"' +
      (disabled ? ' disabled title="Connect @Chickpea first"' : '') + '>Add channel</button>';
  }

  function inviteReminderHtml() {
    if (!state.addChannelInvite) return "";
    return '<div class="empty" style="border-left:2px solid var(--ember);"><p class="field-label">Invite the connected Slack app to finish</p>' +
      '<p class="hint">' + esc(state.addChannelInvite) + '</p></div>';
  }

  function channelOptionsHtml() {
    var channels = (state.slackChannels && state.slackChannels.channels) || [];
    if (channels.length === 0) {
      return '<option value="">No channels found &mdash; invite the connected Slack app, then Refresh</option>';
    }
    var selected = state.addChannelSelected || channels[0].id;
    // Grouped PUBLIC / PRIVATE (native optgroups). No lock emoji: privacy is
    // conveyed by the group, and the trailing note flags a channel Chickpea has not
    // been invited to (it will not hear mentions there until invited).
    var pub = [];
    var priv = [];
    channels.forEach(function (channel) {
      var note = channel.isMember ? "" : "  \\u00B7 not a member";
      var lead = channel.isPrivate ? "" : "# ";
      var option = '<option value="' + esc(channel.id) + '"' + (channel.id === selected ? " selected" : "") + '>' +
        esc(lead + channel.name + note) + '</option>';
      (channel.isPrivate ? priv : pub).push(option);
    });
    var html = "";
    if (pub.length) html += '<optgroup label="Public">' + pub.join("") + '</optgroup>';
    if (priv.length) html += '<optgroup label="Private">' + priv.join("") + '</optgroup>';
    return html;
  }

  function addChannelPanelHtml() {
    if (!state.addChannelOpen) return "";
    var head = '<div class="section-head"><div><h2 class="section-title">Publish ' + esc(addChannelAgentName()) + '</h2>' +
      '<p class="hint">Choose a Slack Channel where this Agent’s handle should work. Existing Agent grants stay in place.</p></div>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="cancel-add-channel">Cancel</button></div>';
    if (!isSlackConnected()) {
      return '<section class="section">' + head +
        '<div class="empty"><p class="field-label">Connect @Chickpea first</p>' +
        '<p class="hint">Resume the private deployment setup link, or use scoped recovery to repair the Slack installation.</p></div></section>';
    }
    // Workspace — locked to the install (card 05). Never an editable field once
    // teamId is known; the "locked" chip makes the constraint plain.
    var workspaceRow = '<div class="field"><label class="field-label">Workspace</label>' +
      '<div class="bundle-row"><span class="b-name">' + esc(connectedTeamName()) + '</span>' +
      '<span class="b-meta">' + esc(connectedTeamId()) + '</span><span class="spacer"></span>' +
      '<span class="chip">locked</span></div>' +
      '<p class="hint">Locked to the workspace Chickpea is installed in. To use another, reinstall Chickpea there.</p></div>';
    var refreshBtn = '<button type="button" class="btn btn-soft btn-sm i-lead" data-action="refresh-channels" title="Refresh channel list">' + icon("arrow-path") + 'Refresh</button>';
    var selector;
    if (state.slackChannelsLoading) {
      selector = '<div class="field"><label class="field-label">Channel</label><p class="hint">Loading channels&hellip;</p></div>';
    } else if (state.slackChannelsError) {
      var staleAuthorization = state.slackChannelsError.code === "missing_scope";
      selector = '<div class="field"><label class="field-label">Channel</label>' +
        '<p class="field-error">' + esc(state.slackChannelsError.text) + '</p>' +
        (staleAuthorization
          ? '<div style="display:flex; gap:8px; flex-wrap:wrap;">' +
            slackScopeReinstallLinkHtml() +
            slackScopeCredentialRepairHtml() + '</div>'
          : '<div>' + refreshBtn + '</div>') + '</div>';
    } else if (state.addChannelManual) {
      selector = '<div class="field"><label class="field-label" for="add-channel-manual">Channel ID</label>' +
        '<input class="input mono" id="add-channel-manual" name="manualChannelId" value="' + esc(state.channelFormDraft.channelId || "") + '" placeholder="C0123ABC" data-action="manual-channel-input">' +
        '<p class="hint">It is still checked against ' + esc(connectedTeamName()) + ' when you add it. ' +
        '<button type="button" class="link-btn" data-action="toggle-manual-channel">Pick from the list instead</button></p></div>';
    } else {
      var truncated = state.slackChannels && state.slackChannels.truncated
        ? '<p class="chan-opt-note">Showing the first channels only &mdash; use &ldquo;enter ID manually&rdquo; for anything not listed.</p>'
        : "";
      selector = '<div class="field"><label class="field-label" for="add-channel-select">Channel</label>' +
        '<div style="display:flex; gap:8px; align-items:center;">' +
        '<span class="select-wrap" style="flex:1;">' +
        '<select class="input" id="add-channel-select" name="channelSelect" data-action="select-channel-option">' + channelOptionsHtml() + '</select>' +
        icon("chevron-down", "select-caret") + '</span>' +
        refreshBtn + '</div>' +
        truncated +
        '<p class="hint">Don\\'t see it? Invite the connected Slack app to the channel, then click Refresh. ' +
        '<button type="button" class="link-btn" data-action="toggle-manual-channel">Enter ID manually</button></p></div>';
    }
    var foot = '<div class="save-bar" style="justify-content:flex-start;">' +
      '<button type="submit" class="btn btn-primary btn-sm">Publish Agent</button>' +
      (state.addChannelError ? '<p class="field-error">' + esc(state.addChannelError) + '</p>' : "") + '</div>';
    return '<section class="section">' + head +
      '<form data-action="add-channel-form" style="display:flex; flex-direction:column; gap:16px;">' +
      workspaceRow + selector + foot + '</form></section>';
  }

  // ---- Slack-connection wizard (first-run) ---------------------------------

  function slackSourceBadge(source) {
    if (source === "env") return '<span class="badge badge-on"><span class="dot"></span>Via environment</span> <span class="hint">Read-only &mdash; configured via environment; takes precedence over values stored here.</span>';
    if (source === "stored") return '<span class="badge badge-on"><span class="dot"></span>Stored</span> <span class="hint">Saved from this wizard.</span>';
    return '<span class="badge badge-off"><span class="dot"></span>Missing</span>';
  }

  function slackCredentialsWellHtml(conn) {
    return '<div class="well"><dl>' +
      '<div class="kv"><dt>Bot token</dt><dd>' + slackSourceBadge(conn.credentials.botToken) + '</dd></div>' +
      '<div class="kv"><dt>Signing secret</dt><dd>' + slackSourceBadge(conn.credentials.signingSecret) + '</dd></div>' +
      '<div class="kv"><dt>Bot user ID</dt><dd>' + slackSourceBadge(conn.credentials.botUserId) + (conn.credentials.botUserId === "missing" ? ' <span class="hint">Resolved automatically (auth.test) once a bot token exists.</span>' : "") + '</dd></div>' +
      '</dl></div>';
  }

  function slackStepperHtml() {
    return '<section class="section"><div class="section-head"><div><h2 class="section-title">Slack setup incomplete</h2>' +
      '<p class="hint">Resume the private deployment setup link, or use the scoped recovery flow to repair this installation. Bot tokens are never pasted into Admin.</p></div>' +
      '<span class="badge badge-off"><span class="dot"></span>Not connected</span></div></section>';
  }

  function slackErrorText(message, detail, serverMessage) {
    if (message === "slack_unreachable") return "Could not reach the Slack API. Check connectivity and try again.";
    if (message === "slack_gateway_unreachable" && slackReconnectRequired(detail)) return "This deployment is no longer linked to the shared Slack app, or its approving member can no longer manage Agent handles. Reconnect as a current Slack Owner or Admin.";
    if (message === "slack_gateway_unreachable") return "The shared Slack connection is temporarily unavailable. Retry now; if it continues, open Slack setup and use Add to Slack again.";
    if (message === "slack_auth_failed") return "Slack rejected the installed bot credential.";
    if (message === "slack_missing_scopes") return "The Slack installation is missing required permissions. Use the scoped recovery flow to repair it.";
    return serverMessage || (detail ? message + ": " + detail : message);
  }

  function channelGrantRosterHtml(channel) {
    var grants = channel && Array.isArray(channel.grants) ? channel.grants : [];
    var rows = grants.map(function (grant) {
      var agent = agentById(grant.agentId);
      var name = grant.agentName || (agent && agent.name) || grant.agentId;
      var handle = agent && agent.slackPresence && agent.slackPresence.normalizedHandle;
      var status = grant.status === "active" ? "Active" : "Needs attention";
      return '<div class="channel-agent-hero"><span class="agent-roster-icon variant-' + agentIconVariant(grant.agentId) + '" aria-hidden="true">' + icon("robot") + '</span>' +
        '<div class="channel-agent-copy"><span class="agent-kicker">Agent grant</span><h2>' + esc(name) + '</h2>' +
        '<p class="channel-agent-intro">' + esc(handle ? "Mention @" + handle + " to start a thread with this Agent." : "Finish the Agent handle before using it in Slack.") + '</p>' +
        '<span class="channel-agent-meta">' + esc(status) + ' · managed on the Agent</span></div>' +
        '<div class="channel-agent-actions"><button type="button" class="btn btn-soft btn-sm" data-action="open-profiles" data-agent="' + esc(grant.agentId) + '">View Agent</button></div></div>';
    }).join("");
    if (!rows) {
      rows = '<div class="empty channel-agent-empty"><p class="field-label">No Agents published here</p>' +
        '<p class="hint">Open an Agent and add this Channel from its Channels tab. Publishing is additive, so Agents never replace one another.</p></div>';
    }
    return '<section class="section channel-agent-section" aria-label="Agent grants"><div class="section-head"><div><h2 class="section-title">Agents available here</h2>' +
      '<p class="hint">Channel members can invoke any listed Agent. Remove or add reach from each Agent’s Channels tab.</p></div></div>' + rows + '</section>';
  }

  function channelTryHtml(assignment) {
    var deepLink = "https://app.slack.com/client/" + encodeURIComponent(assignment.workspaceId) + "/" + encodeURIComponent(assignment.channelId);
    var noticeClass = state.channelTryError ? " error" : "";
    return '<section class="section channel-try-section"><div class="channel-try-card"><div class="channel-try-copy"><span class="agent-kicker">Try it in Slack</span><p class="channel-try-prompt">' + esc(ONBOARDING_PROMPT) + '</p><span class="hint">A real Slack reply is the proof that these Channel grants are ready.</span><span class="channel-try-status' + noticeClass + '" role="status">' + esc(state.channelTryNotice) + '</span></div>' +
      '<div class="channel-try-actions"><button type="button" class="btn btn-soft" data-action="copy-channel-prompt">Copy prompt</button><a class="btn btn-primary" href="' + esc(deepLink) + '" target="_blank" rel="noopener noreferrer">Open ' + esc(channelLabel(assignment)) + '</a></div></div></section>';
  }

  // ---- Profiles master-detail view (cards 09-12) ---------------------------

  function profilesMainHtml() {
    if (state.profileScreen === "create") return profileCreateHtml();
    if (state.profileScreen === "edit" && state.profileDraft) return profileEditHtml();
    return profileOverviewHtml();
  }

  function agentHasDmDefault(agentId) {
    var agent = agentById(agentId);
    return !!(agent && agent.isWorkspaceDefault);
  }

  function channelGrantsForAgent(agentId) {
    var agent = agentById(agentId);
    var hasProjection = !!(agent && agent.whereItWorks && Array.isArray(agent.whereItWorks.channels));
    var projected = hasProjection ? agent.whereItWorks.channels : [];
    // An authoritative empty projection means the Agent has no Channel reach.
    // Falling back to the pre-mutation grant cache here briefly resurrected
    // archived placements until the next full page reload.
    if (hasProjection) {
      return projected.map(function (grant) {
        return {
          workspaceId: grant.workspaceId,
          channelId: grant.channelId,
          channelLabel: grant.channelName || grant.channelId,
          status: grant.status
        };
      });
    }
    return state.grants.filter(function (grant) {
      return grant.agentId === agentId;
    }).map(function (grant) {
      if (normalizeChannelLabel(grant.channelLabel)) return grant;
      var channel = (state.channelIndex || []).find(function (candidate) {
        return candidate.workspaceId === grant.workspaceId && candidate.channelId === grant.channelId;
      }) || projected.find(function (candidate) {
        return candidate.workspaceId === grant.workspaceId && candidate.channelId === grant.channelId;
      });
      return channel && channel.channelName
        ? Object.assign({}, grant, { channelLabel: channel.channelName })
        : grant;
    });
  }

  // ---- Overview (card 09) --------------------------------------------------

  function profileOverviewHtml() {
    var cards = state.agents.map(profileCardHtml).join("");
    return '<div class="main-head"><div style="display:flex; flex-direction:column; gap:6px;">' +
      '<span class="agent-kicker">Workspace teammates</span><h1 class="page-title">Agents</h1>' +
      '<p class="hint" style="max-width:58ch;">Agents hold reusable instructions, models, capabilities, Slack presence, Channel reach, and memory.</p>' +
      '</div><button type="button" class="btn btn-primary" style="flex-shrink:0;" data-action="new-profile">New Agent</button></div>' +
      '<section class="section"><div class="section-head"><div><h2 class="section-title">Your Agents</h2><p class="hint">Everything Chickpea can be in this workspace.</p></div></div>' +
      (cards || '<div class="empty"><p class="field-label">No Agents yet</p><p class="hint">Create one, then add it to a Channel.</p></div>') +
      '</section>';
  }

  function profileCardHtml(agent) {
    var dm = agentHasDmDefault(agent.id);
    var concrete = channelGrantsForAgent(agent.id);
    var roleBadge = dm ? '<span class="badge badge-role"><span class="dot"></span>DM default</span>' : "";
    var stateBadge = agent.enabled
      ? '<span class="badge badge-on"><span class="dot"></span>Enabled</span>'
      : '<span class="badge badge-off"><span class="dot"></span>Disabled</span>';
    var modelPart = agent.model ? '<span class="mono">' + esc(agent.model) + '</span>' : "No model pinned";
    var usage = "used in " + channelCountLabel(concrete.length) + (dm ? " + DMs" : "");
    var handle = (agent.slackPresence && agent.slackPresence.normalizedHandle) || handleFromAgentName(agent.name);
    var meta = modelPart + " &middot; " + usage + " &middot; @" + esc(handle);
    return '<div class="pcard"><div class="pcard-head"><span class="pcard-name">' + esc(agent.name) + '</span>' + roleBadge + stateBadge + '</div>' +
      '<div class="pcard-foot"><span class="hint">' + meta + '</span><span class="spacer"></span>' +
      '<button type="button" class="btn btn-soft btn-sm" data-action="edit-profile" data-agent="' + esc(agent.id) + '">' + (agent.canEdit === false ? "View" : "Edit") + '</button></div></div>';
  }

  // ---- Shared form pieces (create + edit) ----------------------------------

  function modelFieldHtml(draft) {
    var model = draft.model || "";
    if (draft.canEdit === false) {
      return '<div class="field"><span class="field-label">Model</span><div class="input mono" aria-label="Agent model">' + esc(model || "No model pinned") + '</div></div>';
    }
    var warning = modelWarning(model);
    var open = state.modelPickerOpen;
    // Click-to-open combobox (F6): the input is always the current pin; clicking
    // or focusing it opens the grouped options popover below, and typing filters.
    // The popover is a positioned overlay so it never reflows the form.
    return '<div class="field"><label class="field-label" for="p-model">Model</label>' +
      '<div class="model-combo">' +
      '<input class="input mono model-combo-input" id="p-model" name="model" type="text" value="' + esc(model) + '" autocomplete="off" role="combobox" aria-expanded="' + (open ? "true" : "false") + '" aria-haspopup="listbox" placeholder="Pick a model &mdash; none pinned" data-action="profile-model">' +
      icon("chevron-down", "model-combo-caret") +
      (open ? modelPickerHtml(model) : "") +
      '</div>' +
      '<p class="hint">Suggestions come from your providers in <button type="button" class="link-btn" data-action="open-settings">Settings &nearr;</button></p>' +
      (warning ? '<p class="field-error">' + esc(warning) + '</p>' : "") +
      '</div>';
  }

  // Custom-skill rules mirror the server-side valibot schema so an inline error
  // is helpful instead of a generic 400 on save.
  var SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  function validateSkillEditor(editor, skills) {
    var name = String(editor.name || "").trim();
    var description = String(editor.description || "").trim();
    var instructions = String(editor.instructions || "").trim();
    if (!name) return "Name is required.";
    if (name.length > 64) return "Name must be 64 characters or fewer.";
    if (!SKILL_NAME_RE.test(name)) return "Use lowercase letters, digits, and single hyphens (e.g. release-notes).";
    if (!description) return "Description is required.";
    if (description.length > 1024) return "Description must be 1024 characters or fewer.";
    if (!instructions) return "Instructions are required.";
    var duplicate = (skills || []).some(function (skill, index) {
      return index !== editor.index && skill.name === name;
    });
    if (duplicate) return "Another skill already uses that name.";
    return "";
  }

  function skillEditorFormHtml(editor) {
    var isNew = editor.index === null || editor.index === undefined;
    return '<div class="skill-form">' +
      '<div class="field"><label class="field-label" for="skill-name">Name</label>' +
      '<input class="input mono" id="skill-name" type="text" value="' + esc(editor.name) + '" placeholder="release-notes" data-action="skill-field-name">' +
      '<p class="hint">Lowercase letters, digits, and single hyphens. The model always sees this name.</p></div>' +
      '<div class="field"><label class="field-label" for="skill-desc">Description</label>' +
      '<input class="input" id="skill-desc" type="text" value="' + esc(editor.description) + '" placeholder="What this skill does, in one line." data-action="skill-field-description">' +
      '<p class="hint">One line. The model always sees this alongside the name.</p></div>' +
      '<div class="field"><label class="field-label" for="skill-instr">Instructions</label>' +
      '<textarea class="textarea mono" id="skill-instr" placeholder="Markdown instructions the model loads only when it uses this skill." data-action="skill-field-instructions">' + esc(editor.instructions) + '</textarea>' +
      '<p class="hint">Markdown. Loads only when the skill is used, so it can be long.</p></div>' +
      (editor.error ? '<p class="field-error">' + esc(editor.error) + '</p>' : "") +
      '<div class="skill-form-actions">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="skill-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="skill-save-row">' + (isNew ? "Add skill" : "Save skill") + '</button></div></div>';
  }

  // Human fallback text per SkillImportError code, used when the 502 carried no
  // message (error.serverMessage). Keyed by the code the server puts in body.error
  // (which the api() helper surfaces as error.message).
  function skillImportFallback(code) {
    if (code === "not_found") return "Could not find that repo or skill. Check the link and try again.";
    if (code === "rate_limited" || code === "github_rate_limited") return "GitHub rate limit hit. Try again in a little while.";
    if (code === "repository_not_found_or_inaccessible") return "Repository not found or not accessible. Check the source and GitHub App access.";
    if (code === "github_access_unavailable") return "GitHub App access could not be verified. Check GitHub settings and retry.";
    if (code === "github_error" || code === "github_unavailable") return "GitHub had trouble with that request. Try again in a moment.";
    if (code === "unrecognized_source") return "That does not look like a repo, a GitHub URL, or a skills.sh link.";
    return "Could not import skills from that source.";
  }

  function skillImportGithubHelperHtml() {
    if (!state.githubStatusLoaded) {
      return '<div class="import-source-tools"><p class="hint"><span class="spinner"></span> Checking GitHub connection&hellip;</p></div>';
    }
    var status = state.githubStatus;
    if (status && status.mode === "app" && (status.installations || []).length > 0) {
      return '<div class="import-source-tools"><p class="hint">Paste any GitHub source, or pick a repository this deployment&rsquo;s GitHub App can access.</p>' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="import-browse-open">Browse GitHub</button></div>';
    }
    var connectedWithoutBrowse = status && status.mode === "app";
    var reason = connectedWithoutBrowse
      ? "Repository discovery is unavailable, but an exact private owner/repo can still resolve when the App has access."
      : "Connect GitHub in Settings to browse or import private repositories.";
    var pasteScope = connectedWithoutBrowse ? "Paste any public or private GitHub repository. " : "Paste any public GitHub repository. ";
    return '<div class="import-source-tools"><p class="hint">' + pasteScope + esc(reason) + '</p>' +
      '<button type="button" class="link-btn" data-action="open-settings" data-section="github-settings">GitHub settings &nearr;</button></div>';
  }

  // Both repo browsers offer the same account chooser; only the actions and the
  // cancel/empty copy differ.
  function repoAccountChoicesHtml(config) {
    var choices = (config.installations || []).map(function (installation) {
      var count = installation.repoCount == null ? "Repository count unavailable" : installation.repoCount + " repositories";
      return '<button type="button" class="btn btn-ghost repo-account-choice" data-action="' + config.action + '" data-installation="' + esc(installation.id) + '" data-account="' + esc(installation.accountLogin) + '">' +
        '<span class="repo-avatar">' + esc(String(installation.accountLogin || "?").slice(0, 1)) + '</span>' +
        '<span style="display:flex; flex-direction:column; align-items:flex-start;"><span class="field-label">' + esc(installation.accountLogin) + '</span><span class="hint">' + esc(count) + '</span></span></button>';
    }).join("");
    if (!choices) choices = '<p class="hint">' + config.emptyCopy + '</p>';
    return '<div class="repo-account-choices"><span class="tiny-label">Choose an account or organization</span>' + choices +
      '<div><button type="button" class="btn btn-ghost btn-sm" data-action="' + config.cancelAction + '">' + config.cancelLabel + '</button></div></div>';
  }

  // The four-way loading/error/empty/list branch both repo browsers render.
  function repoBrowserListHtml(slot, rowsHtml, retryAction, emptyCopy) {
    if (slot.loading) {
      return '<div class="empty"><p class="hint"><span class="spinner"></span> Loading repositories&hellip;</p></div>';
    }
    if (slot.error) {
      return '<div class="empty"><p class="field-error" role="alert">' + esc(slot.error) + '</p><button type="button" class="btn btn-soft btn-sm" data-action="' + retryAction + '">Retry</button></div>';
    }
    if (!rowsHtml) return '<div class="empty"><p class="hint">' + emptyCopy + '</p></div>';
    return '<div class="repo-picker-list">' + rowsHtml + '</div>';
  }

  function skillImportBrowseAccountsHtml() {
    return repoAccountChoicesHtml({
      installations: (state.githubStatus && state.githubStatus.installations) || [],
      action: "import-browse-account",
      cancelAction: "import-browse-cancel",
      cancelLabel: "Cancel browsing",
      emptyCopy: "No GitHub App installations are available."
    });
  }

  function skillImportBrowseRepositoriesHtml(browse) {
    var totalCount = Number(browse.totalCount || 0);
    var sourceHint = 'This installation has ' + totalCount + ' repositories. Type to search.';
    if (browse.truncated) sourceHint += ' Not every repository is shown — type more of a name or paste exact owner/repo.';
    var rows = (browse.repos || []).map(function (repo) {
      return '<button type="button" class="repo-picker-row import-browse-row" data-action="import-browse-select" data-repo="' + esc(repo.fullName) + '">' +
        icon("repository") + '<span class="repo-name mono">' + esc(repo.fullName) + '</span>' +
        (repo.private ? '<span class="badge badge-off">Private</span>' : "") + '</button>';
    }).join("");
    var list = repoBrowserListHtml(
      browse,
      rows,
      "import-browse-retry",
      "No repositories match this search. You can still paste exact owner/repo above."
    );
    return '<div class="repo-picker import-browse-picker" role="dialog" aria-label="Browse repositories for ' + esc(browse.accountLogin) + '">' +
      '<div><p class="repo-picker-title">Browse ' + esc(browse.accountLogin) + '</p><p class="hint">' + esc(sourceHint) + '</p></div>' +
      '<input class="input mono" id="skill-import-browse-search" type="search" value="' + esc(browse.query) + '" placeholder="Search repositories" data-action="import-browse-search" autocomplete="off">' +
      list + '<div class="repo-picker-foot"><span class="hint">Choosing a repository fills the source field above.</span><span class="spacer"></span>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="import-browse-cancel">Cancel browsing</button></div></div>';
  }

  function skillImportBrowseHtml(imp) {
    var browse = imp.browse;
    if (!browse) return "";
    return '<div class="import-browse-host">' + (browse.chooseAccount
      ? skillImportBrowseAccountsHtml()
      : skillImportBrowseRepositoriesHtml(browse)) + '</div>';
  }

  // Repository searches redraw only their local browser. Rebuilding the full
  // profile would throw away the page and list scroll positions and blur the
  // search input on every debounced response.
  function rerenderSkillImportBrowse() {
    var imp = state.skillImport;
    var browse = imp && imp.browse;
    var host = document.querySelector(".import-browse-host");
    if (!imp || !browse || !host) { render(); return; }
    var listBefore = host.querySelector(".repo-picker-list");
    var scrollTop = listBefore ? listBefore.scrollTop : 0;
    host.innerHTML = browse.chooseAccount
      ? skillImportBrowseAccountsHtml()
      : skillImportBrowseRepositoriesHtml(browse);
    var listAfter = host.querySelector(".repo-picker-list");
    if (listAfter) listAfter.scrollTop = scrollTop;
  }

  // The picker rows shown after "Find skills" resolves. resolution.skills is
  // third-party content, so every field is esc()'d — a description could smuggle
  // a script-closing tag or an onerror img.
  function skillImportPickerHtml(imp) {
    var resolution = imp.resolution;
    var skills = resolution.skills || [];
    var selected = imp.selected || [];
    var repo = esc(resolution.owner) + "/" + esc(resolution.repo);
    var count = skills.length;
    var summary = "Found " + count + " skill" + (count === 1 ? "" : "s") + " in " + repo;
    var notes = "";
    if (resolution.capped) {
      notes += ' <span class="import-note">showing the first ' + count + " &mdash; narrow with owner/repo@skill</span>";
    }
    if (resolution.skipped > 0) {
      notes += ' <span class="import-note">(' + resolution.skipped + " skipped &mdash; missing a name or description)</span>";
    }
    var allSelected = count > 0 && selected.every(function (on) { return on; });
    var rows = skills.map(function (skill, index) {
      var on = !!selected[index];
      var badge = skill.hasScripts
        ? '<span class="badge-src import-scripts">has scripts &middot; won&rsquo;t run yet</span>'
        : "";
      return '<label class="import-row' + (on ? " on" : "") + '">' +
        '<span class="import-check' + (on ? " on" : "") + '"><input type="checkbox" data-action="import-row-toggle" data-index="' + index + '" ' + (on ? "checked" : "") + ' aria-label="Import ' + esc(skill.name) + '"></span>' +
        '<span class="import-body"><span class="import-name">' + esc(skill.name) + badge + '</span>' +
        '<span class="import-desc">' + esc(skill.description) + '</span></span></label>';
    }).join("");
    var listOrEmpty = count > 0
      ? '<div class="import-list">' + rows + '</div>'
      : '<p class="hint">No importable skills were found here.</p>';
    var actions = '<div class="skill-form-actions">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="import-cancel">Cancel</button>' +
      (count > 0 ? '<button type="button" class="btn btn-primary btn-sm" data-action="import-add">Add selected</button>' : "") + '</div>';
    var selectAll = count > 0
      ? '<button type="button" class="link-btn" data-action="import-select-all">' + (allSelected ? "Clear all" : "Select all") + "</button>"
      : "";
    var source = resolution.source || null;
    var sourceDisclosure = "";
    if (source) {
      var isPrivate = source.visibility === "private";
      var access = source.access === "github_app"
        ? "Read through the connected GitHub App. "
        : "Read from GitHub without authentication. ";
      sourceDisclosure = '<div class="import-disclosure"><span class="badge-src">' + (isPrivate ? "Private repository" : "Public repository") + '</span>' +
        '<span>' + access + 'Selected instructions are copied into this Agent as a snapshot and may be sent to its configured model when the skill is used. Scripts and assets are excluded.</span>' +
        '<span>Importing does not grant the Agent access to the repository. Configure ongoing runtime access separately in the Repositories tab.</span></div>';
    }
    return '<div class="import-summary"><span>' + summary + notes + '</span>' + selectAll + "</div>" +
      sourceDisclosure + listOrEmpty + actions;
  }

  function skillImportPanelHtml(imp) {
    // Before "Find skills" resolves: the source input + Find/Cancel actions.
    if (!imp.resolution) {
      var findLabel = imp.loading ? "Finding&hellip;" : "Find skills";
      return '<div class="skill-form import-panel">' +
        '<div class="field"><label class="field-label" for="import-source">Import from a URL</label>' +
        '<input class="input mono" id="import-source" type="text" value="' + esc(imp.source) + '" placeholder="owner/repo, a GitHub URL, or a skills.sh link" data-action="import-source">' +
        '<p class="hint">Paste a repo, a GitHub link, or a skills.sh page. Narrow to one skill with owner/repo@skill.</p></div>' +
        skillImportGithubHelperHtml() + skillImportBrowseHtml(imp) +
        (imp.error ? '<p class="field-error">' + esc(imp.error) + '</p>' : "") +
        '<div class="skill-form-actions">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="import-cancel">Cancel</button>' +
        '<button type="button" class="btn btn-primary btn-sm"' + (imp.loading ? " disabled" : "") + ' data-action="import-find">' + findLabel + '</button></div></div>';
    }
    // After it resolves: the picker (with an inline error area for a retry-less
    // add that hit a snag — kept for parity, though add is local-only).
    return '<div class="skill-form import-panel">' +
      (imp.error ? '<p class="field-error">' + esc(imp.error) + '</p>' : "") +
      skillImportPickerHtml(imp) + "</div>";
  }

  function ownerMemoryMatches(ownerKind, workspaceId, ownerId) {
    var memory = state.ownerMemory;
    return memory.ownerKind === ownerKind && memory.workspaceId === workspaceId && memory.ownerId === ownerId;
  }

  function ownerMemoryPanelHtml(ownerKind, ownerId, ownerLabel, assignedAgentName) {
    var workspaceId = connectedTeamId() || "workspace";
    var memory = state.ownerMemory;
    var ownerName = ownerLabel || "this Agent";
    var reach = "One shared memory follows " + ownerName + " everywhere it works, including Channels and direct messages.";
    if (!ownerId) {
      return '<div class="empty"><p class="field-label">Save this Agent to add memory</p><p class="hint">Memory belongs to the durable Agent.</p></div>';
    }
    if (!ownerMemoryMatches(ownerKind, workspaceId, ownerId)) {
      return '<div class="empty"><p class="field-label">Loading memory&hellip;</p><p class="hint">' + esc(reach) + '</p></div>';
    }
    var status = memory.error
      ? '<p class="owner-memory-status error" role="alert">' + esc(memory.error) + '</p>'
      : '<p class="owner-memory-status" role="status" aria-live="polite">' + esc(memory.notice || (memory.dirty ? "Unsaved memory changes" : "")) + '</p>';
    if (memory.loading && !memory.detail) {
      return '<div class="empty"><p class="field-label">Loading memory&hellip;</p><p class="hint">' + esc(reach) + '</p></div>' + status;
    }
    if (!memory.detail || !memory.draft) {
      return '<div class="empty"><p class="field-label">Memory is unavailable</p><p class="hint">' + esc(reach) + '</p><button type="button" class="btn btn-soft btn-sm" data-action="owner-memory-retry">Retry</button></div>' + status;
    }
    var entry = memory.detail ? memory.detail.entry : null;
    var draft = memory.draft || {
      description: entry ? entry.description || "" : "Current Agent memory",
      type: entry ? entry.type || "project" : "project",
      body: entry ? entry.body || "" : ""
    };
    return '<div class="owner-memory-intro"><p class="hint">' + esc(reach) + '</p></div>' +
      '<section class="owner-memory-editor"><div class="owner-memory-form">' +
      '<div class="field"><label class="field-label" for="owner-memory-body">Memory</label><textarea class="textarea" id="owner-memory-body" rows="14" placeholder="What should this Agent remember?" data-action="owner-memory-body">' + esc(draft.body) + '</textarea><p class="hint">This is the Agent’s complete durable memory. It follows the Agent into DMs and every granted Channel, and the Agent may update it while it works.</p></div>' +
      (memory.conflict ? '<div class="callout"><span>Your draft is preserved because this memory changed elsewhere.</span><button type="button" class="btn btn-soft btn-sm" data-action="owner-memory-use-latest">Load latest</button></div>' : '') +
      '<div class="owner-memory-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="owner-memory-discard"' + (!memory.dirty || memory.busy ? " disabled" : "") + '>Discard</button><button type="button" class="btn btn-primary btn-sm" data-action="owner-memory-save"' + (!memory.dirty || memory.busy ? " disabled" : "") + '>' + (memory.busy === "save" || memory.busy === "create" ? "Saving&hellip;" : "Save memory") + '</button></div></div></section>' + status;
  }

  function agentSchedulesPanelHtml(draft) {
    var schedules = state.agentSchedules;
    if (!draft || !draft.id) {
      return '<div class="empty"><p class="field-label">Save this Agent to add schedules</p><p class="hint">Scheduled work always belongs to one Agent and one Runs as member.</p></div>';
    }
    if (schedules.agentId !== draft.id || schedules.loading) {
      return '<div class="empty"><p class="hint">Loading Agent schedules&hellip;</p></div>';
    }
    var status = schedules.error
      ? '<p class="error" role="alert">' + esc(schedules.error) + ' <button type="button" class="btn btn-soft btn-sm" data-action="agent-schedules-retry">Retry</button></p>'
      : schedules.notice ? '<p class="hint" role="status">' + esc(schedules.notice) + '</p>' : '';
    if (!schedules.schedules.length) {
      return status + '<div class="empty"><p class="field-label">No scheduled work</p><p class="hint">Ask this Agent in Slack to schedule a recurring or one-time task. The destination, required connections, and Runs as authority are saved together.</p></div>';
    }
    var rows = schedules.schedules.map(function (entry) {
      var reference = entry.reference || {};
      var routine = entry.routine || {};
      var runsAs = entry.runsAs || {};
      var needsAttention = reference.state === "needs_attention" || routine.state === "paused";
      var canTakeOver = !!schedules.viewerMembershipId && schedules.viewerMembershipId !== reference.runsAsMembershipId;
      var repairablePause = ["schedule_authority_missing", "assignment_missing", "creator_ineligible", "credential_unavailable"].indexOf(routine.pausedReason || "") >= 0;
      var canResume = !!schedules.viewerMembershipId && schedules.viewerMembershipId === reference.runsAsMembershipId &&
        (reference.state === "needs_attention" || routine.state === "paused" && repairablePause);
      var scheduleAction = canTakeOver || canResume
        ? '<button type="button" class="btn btn-soft btn-sm" data-action="agent-schedule-reassign" data-schedule-id="' + esc(reference.scheduleId) + '" data-revision="' + Number(reference.revision || 0) + '"' + (schedules.busy ? ' disabled' : '') + '>' + (canResume ? 'Resume future runs' : 'Take over future runs') + '</button>'
        : '<span class="hint">' + (schedules.viewerMembershipId ? 'Runs as you' : 'Runs as authority unavailable') + '</span>';
      return '<article class="connection-account-row"><div class="connection-account-copy"><div><strong>' + esc(routine.name || reference.scheduleId) + '</strong> ' +
        '<span class="badge ' + (needsAttention ? 'badge-off' : 'badge-on') + '">' + esc(needsAttention ? "Needs attention" : (routine.state || reference.state || "active")) + '</span></div>' +
        '<p class="hint">' + esc(routine.description || "Scheduled Agent work") + '</p>' +
        '<p class="hint"><strong>Runs as:</strong> ' + esc(runsAs.displayName || runsAs.contactEmail || reference.runsAsMembershipId || "Unavailable") +
        ' &middot; <strong>Destination:</strong> ' + esc(reference.channelId || "") +
        ' &middot; <strong>Connections:</strong> ' + Number((reference.requiredConnectionAccountIds || []).length) + '</p>' +
        (routine.pausedReason ? '<p class="error">Paused: ' + esc(routine.pausedReason) + '</p>' : '') + '</div>' +
        '<div class="connection-account-actions">' + scheduleAction + '</div></article>';
    }).join("");
    return status + '<p class="hint ptab-hint">Each schedule uses this Agent\\'s instructions and memory. Team connections are shared; personal connections always resolve as the named member.</p><div class="connection-account-list">' + rows + '</div>';
  }

  // ---- Capability tabs (Instructions / Skills / Connections / Repositories / Memory / Schedules) -

  // One panel is visible at a time; the other three stay MOUNTED but [hidden] so
  // their form fields survive re-renders and collectProfileDraft() keeps
  // reading p-instr regardless of the active tab. The same tray serves create
  // and edit so every profile capability is reachable before the first save.
  function profileTabsHtml(draft) {
    var active = state.profileTab || "instructions";
    var readOnly = draft.canEdit === false;
    // An open inline editor (or import panel, or an async test result landing
    // in it) on a NON-active tab gets an attention dot — the panel is
    // [hidden], so without the dot the user would never see what's in flight.
    var attention = {
      instructions: false,
      skills: !!(state.skillEditor || state.skillImport),
      connections: !!(state.connectionEditor || state.apiConnectionEditor),
      repositories: !!(state.repositoryPicker || state.repositoryAddOpen),
      memory: !!state.ownerMemory.dirty,
      schedules: !!state.agentSchedules.error
    };
    var repositoryCount = enabledRepositoryGrants(draft).length;
    var tabs = [
      { id: "instructions", label: "Instructions", count: 0, icon: "pencil", tone: "instructions", description: "The role, priorities, and boundaries this Agent follows everywhere it works." },
      { id: "skills", label: "Skills", count: (draft.skills || []).filter(function (skill) { return skill.enabled; }).length, icon: "sparkle", tone: "skill", description: "Repeatable ways this Agent knows how to help." },
      { id: "connections", label: "Connections", count: state.agentConnections.agentId === draft.id && !state.agentConnections.legacyFallback ? state.agentConnections.attached.length : (draft.mcpServers || []).length + (draft.apiConnections || []).length, icon: "check", tone: "connector", description: "Team and personal accounts this Agent can use." },
      { id: "repositories", label: "Repositories", count: repositoryCount, icon: "repository", tone: "repository", description: "Code and documentation this Agent can work with." },
      { id: "memory", label: "Memory", count: 0, icon: "robot", tone: "memory", description: "Durable context this Agent can use wherever it works." },
      { id: "schedules", label: "Schedules", count: state.agentSchedules.agentId === draft.id ? state.agentSchedules.schedules.length : 0, icon: "clock", tone: "schedule", description: "Recurring and one-time work owned by this Agent." }
    ];
    var bar = tabs.map(function (tab) {
      var on = tab.id === active;
      return '<button type="button" id="ptab-' + tab.id + '" class="ptab' + (on ? " on" : "") + '" role="tab" aria-selected="' + (on ? "true" : "false") + '" tabindex="' + (on ? "0" : "-1") + '" aria-controls="ptab-panel-' + tab.id + '" data-action="profile-tab" data-tab="' + tab.id + '">' + tab.label +
        (tab.count ? '<span class="ptab-count">' + tab.count + '</span>' : "") +
        (!on && attention[tab.id] ? '<span class="ptab-dot" aria-hidden="true"></span>' : "") + '</button>';
    }).join("");
    function panel(tab, html) {
      if (readOnly && tab.id === "memory") {
        html = '<p class="hint">Only Agent editors can view or change durable memory for this Agent.</p>';
      }
      if (readOnly && tab.id === "schedules") {
        html = '<p class="hint">Only Agent editors can manage schedules and Runs as authority for this Agent.</p>';
      }
      var body = readOnly
        ? '<fieldset class="agent-readonly-fields" disabled>' + html + '</fieldset>'
        : html;
      return '<div class="ptab-panel" id="ptab-panel-' + tab.id + '" role="tabpanel" aria-labelledby="ptab-' + tab.id + '"' + (tab.id === active ? "" : " hidden") + '>' +
        '<div class="agent-tab-head"><span class="agent-tab-icon semantic-icon tone-' + tab.tone + '" aria-hidden="true">' + icon(tab.icon) + '</span><div><h2>' + tab.label + '</h2><p>' + tab.description + '</p></div></div>' + body + '</div>';
    }
    return '<section class="agent-tabs-card">' +
      '<div class="ptab-tray">' +
      '<div class="ptabs" role="tablist" aria-label="Agent setup">' + bar + '</div>' +
      panel(tabs[0], instructionsPanelHtml(draft, state.profileScreen === "create")) +
      panel(tabs[1], skillsPanelHtml(draft)) +
      panel(tabs[2], connectionsPanelHtml(draft)) +
      panel(tabs[3], repositoriesPanelHtml(draft)) +
      panel(tabs[4], ownerMemoryPanelHtml("agent", draft.id, draft.name)) +
      panel(tabs[5], agentSchedulesPanelHtml(draft)) +
      '</div>' +
      '</section>';
  }

  function instructionsPanelHtml(draft, showPlaceholder) {
    return '<div class="field agent-instructions-editor">' + profileInstructionsFieldHtml(draft, showPlaceholder) +
      '<p class="agent-instructions-guidance">' + icon("check") + '<span>These instructions follow the Agent across every permitted Channel and DM.</span></p></div>';
  }

  function skillsPanelHtml(draft) {
    var skills = draft.skills || [];
    var editor = state.skillEditor;
    var imp = state.skillImport;
    var rows = skills.map(function (skill, index) {
      if (isSuggestedSkillSnapshot(skill)) return "";
      // The row's editor opens in place; hide the row that is being edited so the
      // form takes its slot (a new-skill editor renders below the whole list).
      if (editor && editor.index === index) return skillEditorFormHtml(editor);
      return '<div class="skill-row">' +
        '<div class="sk-body"><span class="sk-name">' + esc(skill.name) + '<span class="badge-src">custom</span></span>' +
        '<span class="sk-desc">' + esc(skill.description) + '</span></div>' +
        '<span class="toggle"><span class="thumb"></span><input type="checkbox" data-action="skill-toggle" data-index="' + index + '" ' + (skill.enabled ? "checked" : "") + ' aria-label="Skill enabled"></span>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="skill-edit" data-index="' + index + '">Edit</button>' +
        '<button type="button" class="x-btn" data-action="skill-remove" data-index="' + index + '" aria-label="Remove skill">&times;</button></div>';
    }).join("");
    var list = rows ? '<section class="configured-skills"><h3>Your skills</h3><div class="skill-list">' + rows + '</div></section>' : "";
    // A new-skill editor (index === null) renders below the list, not in a row.
    var newForm = (editor && (editor.index === null || editor.index === undefined)) ? '<div class="skill-list">' + skillEditorFormHtml(editor) + '</div>' : "";
    // The import panel takes the place of the action buttons while it is open,
    // mirroring the inline skill editor. Only one of editor/import is ever open.
    var importPanel = imp ? '<div class="skill-list">' + skillImportPanelHtml(imp) + '</div>' : "";
    var addButtons = (editor || imp)
      ? ""
      : '<div class="skill-actions"><button type="button" class="btn btn-soft btn-sm i-lead" data-action="skill-new">' +
        '<svg class="ic" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M8.75 3.75a.75.75 0 0 0-1.5 0v3.5h-3.5a.75.75 0 0 0 0 1.5h3.5v3.5a.75.75 0 0 0 1.5 0v-3.5h3.5a.75.75 0 0 0 0-1.5h-3.5v-3.5Z"/></svg>New skill</button>' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="import-skills">Import from URL</button></div>';
    var build = '<div class="skill-build"><div class="skill-build-copy"><strong>Build your own</strong>Write a skill from scratch or import any public GitHub source.</div>' + addButtons + '</div>';

    var activeCategory = SUGGESTED_SKILL_CATEGORIES.some(function (category) { return category.id === state.suggestedSkillCategory; })
      ? state.suggestedSkillCategory
      : "featured";
    var category = SUGGESTED_SKILL_CATEGORIES.find(function (item) { return item.id === activeCategory; }) || SUGGESTED_SKILL_CATEGORIES[0];
    function configuredSuggestion(suggestion) {
      var index = suggestedSkillIndex(skills, suggestion);
      return index >= 0 ? skills[index] : null;
    }
    function visibleSuggestion(suggestion) {
      return activeCategory === "featured" ? suggestion.featured : suggestion.categories.indexOf(activeCategory) >= 0;
    }
    var categoryNav = SUGGESTED_SKILL_CATEGORIES.map(function (item) {
      var count = SUGGESTED_SKILL_CATEGORY_COUNTS[item.id] || 0;
      return '<button type="button" class="suggested-category" role="tab" data-action="suggested-skill-category" data-category="' + item.id + '" aria-selected="' + (item.id === activeCategory ? "true" : "false") + '">' +
        esc(item.label) + '<span class="suggested-category-count">' + count + '</span></button>';
    }).join("");
    var suggestedRows = SUGGESTED_SKILLS.filter(visibleSuggestion).map(function (suggestion) {
      var configured = configuredSuggestion(suggestion);
      var enabled = !!(configured && configured.enabled);
      var nameInUse = !configured && skills.some(function (skill) { return skill.name === suggestion.name; });
      return '<div class="suggested-skill-row' + (enabled ? ' is-on' : '') + '">' +
        '<div class="suggested-skill-copy"><div class="suggested-skill-title"><strong>' + esc(suggestion.title) + '</strong>' +
        '<span class="suggested-skill-slug">' + esc(suggestion.displaySlug) + '</span>' +
        '<a class="suggested-skill-byline" href="' + esc(suggestion.sourceUrl) + '" target="_blank" rel="noopener noreferrer">by ' + esc(suggestion.source) + '</a>' +
        (enabled ? '<span class="suggested-skill-state">On</span>' : (nameInUse ? '<span class="suggested-skill-state is-blocked">Name in use</span>' : '')) + '</div>' +
        '<div class="suggested-skill-description">' + esc(suggestion.description) + '</div></div>' +
        '<span class="toggle"><span class="thumb"></span><input type="checkbox" data-action="suggested-skill-toggle" data-skill-id="' + suggestion.id + '" ' + (enabled ? "checked" : "") + (nameInUse ? " disabled" : "") + ' aria-label="' + (nameInUse ? esc(suggestion.title) + ' unavailable because the name is in use' : 'Enable ' + esc(suggestion.title)) + '"></span></div>';
    }).join("");
    var enabledSuggestions = SUGGESTED_SKILLS.filter(function (suggestion) {
      var configured = configuredSuggestion(suggestion);
      return !!(configured && configured.enabled);
    }).length;
    var suggested = '<section class="suggested-skills"><div class="suggested-skills-head"><div><h3>Suggested skills</h3>' +
      '<p>Start with a focused set, or browse by the kind of work this Agent should help with.</p></div>' +
      '<span class="suggested-on-count" aria-live="polite">' + enabledSuggestions + (enabledSuggestions === 1 ? ' skill on' : ' skills on') + '</span></div>' +
      '<div class="suggested-category-nav" role="tablist" aria-label="Skill categories">' + categoryNav + '</div>' +
      '<div class="suggested-catalog-head"><strong>' + esc(category.label) + '</strong><span class="suggested-catalog-summary">' + esc(category.id === "featured" ? (SUGGESTED_SKILL_CATEGORY_COUNTS.featured || 0) + " starting points from " + SUGGESTED_SKILLS.length + " available skills" : category.summary) + '</span></div>' +
      '<div class="suggested-skill-list" role="tabpanel">' + suggestedRows + '</div>' +
      '<p class="suggested-disclosure">' + icon("copy") + '<span>Turning a suggestion on copies its current instructions into this Agent as a snapshot. Turning it off removes that copied snapshot. No scripts, references, plugin behavior, or future updates come with it.</span></p></section>';
    return build + newForm + importPanel + list + suggested;
  }

  /* ---- Connections (remote MCP servers) ---------------------------------- */

  // slugify a displayName into a connection id (lowercase, non-alnum -> '-',
  // trimmed, max 64). Used only for NEW connections; the id is immutable on edit
  // and becomes the mcp__<id>__ tool prefix. Secret keys add the profile id so
  // the same connection slug can safely exist on multiple profiles.
  function connectionSlug(name) {
    var slug = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug.slice(0, 64);
  }

  // Existing profiles already have an immutable id. During profile creation,
  // derive the same prospective id saveProfile will persist so Test connection
  // can resolve the correct profile-scoped environment override.
  function connectionAgentId() {
    var draft = state.profileDraft;
    return draft && draft.id ? draft.id : slugId(draft && draft.name);
  }

  // Parse the URL host for the card meta line — client-side new URL() is fine
  // here (this is browser JS), and a malformed URL just falls back to the raw
  // string so a half-typed connection still renders.
  function connectionHost(url) {
    try { return new URL(url).host; } catch (_) { return String(url || ""); }
  }

  function presetById(id) {
    return (CONNECTOR_PRESETS || []).find(function (preset) { return preset.id === id; });
  }

  function googleServicePresetById(id) {
    return (GOOGLE_WORKSPACE_SERVICE_PRESETS || []).find(function (preset) { return preset.id === id; });
  }

  function googleServicePresetByService(service) {
    return (GOOGLE_WORKSPACE_SERVICE_PRESETS || []).find(function (preset) { return preset.service === service; });
  }

  function managedPresetById(id) {
    return (MANAGED_CONNECTOR_PRESETS || []).find(function (preset) { return preset.id === id; });
  }

  function managedConnectorDescriptorByToolkit(toolkit) {
    var configured = (state.agentConnections.managedCatalog || []).find(function (descriptor) {
      return descriptor && descriptor.toolkit === toolkit;
    });
    if (configured) return configured;
    var preset = (GOOGLE_WORKSPACE_SERVICE_PRESETS || []).find(function (candidate) {
      return candidate.managedToolkit === toolkit;
    });
    return fallbackManagedConnectorDescriptor(preset);
  }

  function managedConnectorDescriptorById(id) {
    var configured = (state.agentConnections.managedCatalog || []).find(function (descriptor) {
      return descriptor && descriptor.id === id;
    });
    if (configured) return configured;
    var managedPreset = managedPresetById(id);
    if (managedPreset) return managedConnectorDescriptorByToolkit(managedPreset.managedToolkit);
    return fallbackManagedConnectorDescriptor(googleServicePresetById(id));
  }

  function fallbackManagedConnectorDescriptor(preset) {
    // Deep links are consumed only after the Agent's connector state loads.
    // Still fail closed while availability is unknown so an OSS deployment
    // can never render a Composio form that will only fail on submit.
    if (!preset || !preset.service || state.agentConnections.managedGoogleAvailable !== true) return null;
    var ready = { status: "ready", missingConfiguration: [] };
    return {
      id: preset.id,
      toolkit: preset.managedToolkit,
      providerId: "google",
      label: preset.name,
      description: preset.description,
      securityDescription: "Google sign-in opens through Composio. Chickpea stores only the connected-account reference and this Agent's capability ceiling, not Google refresh tokens or a Google OAuth client secret.",
      access: { read: ready, write: ready }
    };
  }

  function managedConnectorLaneReady(descriptor, lane) {
    return !!(descriptor && descriptor.access && descriptor.access[lane] &&
      descriptor.access[lane].status === "ready");
  }

  function managedConnectorMissingCodes(descriptor, lane) {
    var availability = descriptor && descriptor.access && descriptor.access[lane];
    return availability && availability.missingConfiguration || [];
  }

  function managedConnectorReadiness(descriptor, lane) {
    if (managedConnectorLaneReady(descriptor, lane)) return { label: "Ready", kind: "ready" };
    var codes = managedConnectorMissingCodes(descriptor, lane);
    if (codes.indexOf("provider_prerequisite_missing") >= 0) {
      return { label: "Additional setup required", kind: "prerequisite" };
    }
    return {
      label: state.agentConnections.managedCanConfigure
        ? (state.agentConnections.managedConfigurationReadOnly ? "Preparation required" : "Setup required")
        : "Owner setup required",
      kind: "setup"
    };
  }

  function openComposioSetup(preset, descriptor, preferredOwnerKind) {
    if (!preset || !descriptor) return;
    state.composioSetup = {
      presetId: preset.id,
      toolkit: descriptor.toolkit,
      label: preset.name,
      description: preset.description || descriptor.description || "",
      ownerKind: preferredOwnerKind === "member" ? "member" : "team",
      canConfigure: !!state.agentConnections.managedCanConfigure,
      deploymentManaged: !!state.agentConnections.managedConfigurationReadOnly,
      key: "",
      phase: "idle",
      error: "",
      returnFocusPresetId: preset.id
    };
    render();
    window.setTimeout(function () {
      var focusTarget = document.querySelector('[data-role="composio-setup-dialog"] input') ||
        document.querySelector('[data-role="composio-setup-dialog"] button');
      if (focusTarget && focusTarget.focus) focusTarget.focus();
    }, 0);
  }

  function hasLegacyTokenMcpConnection(providerId) {
    var draft = state.profileDraft || {};
    var legacy = (draft.mcpServers || []).some(function (connection) {
      return connection && connection.presetId === providerId &&
        (connection.authMode === "bearer" || (connection.headerNames || []).length > 0);
    });
    if (legacy) return true;
    return (state.agentConnections.attached || []).concat(state.agentConnections.available || []).some(function (entry) {
      var account = entry && entry.account ? entry.account : entry;
      var policy = account && account.policy;
      return account && account.providerId === providerId && policy && policy.kind === "mcp" &&
        (policy.authMode === "bearer" || (policy.headerNames || []).length > 0);
    });
  }

  function googleWorkspaceConnection(draft) {
    return ((draft && draft.apiConnections) || []).find(function (conn) {
      return conn.id === "google-workspace" || conn.presetId === "google-workspace";
    });
  }

  function presetLanes(preset) {
    return {
      mcp: !!preset && typeof preset.url === "string",
      api: !!preset && !!preset.api
    };
  }

  function connectorMonogram(name) {
    var words = String(name || "").match(/[A-Za-z0-9]+/g) || [];
    if (!words.length) return "?";
    if (words.length > 1) return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
    return words[0].slice(0, 2).toUpperCase();
  }

  function connectorLogoHtml(preset) {
    var logo = (CONNECTOR_LOGOS || {})[preset.logoId || preset.id];
    if (logo && logo.raster) {
      return '<span class="conn-logo conn-logo-raster">' + logo.svg + '</span>';
    }
    if (logo && logo.full) {
      return '<span class="conn-logo conn-logo-img conn-logo-full">' + logo.svg + '</span>';
    }
    if (logo) {
      return '<span class="conn-logo conn-logo-img"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="color:' + esc(preset.accent) + '">' + logo.svg + '</svg></span>';
    }
    return '<span class="conn-logo conn-logo-mono" style="background:' + esc(preset.accent) + '">' + esc(connectorMonogram(preset.name)) + '</span>';
  }

  function connectorGalleryHtml(accountMode, reusableAccounts, attachedAccounts, showCatalog) {
    // Legacy Agent-owned connections use preset ids as unique connection ids,
    // so only that lane hides presets already in use. Reusable accounts may
    // intentionally connect the same provider more than once.
    var draft = state.profileDraft || {};
    var connectedPresetIds = {};
    if (!accountMode) {
      (draft.mcpServers || []).forEach(function (conn) { if (conn.presetId) connectedPresetIds[conn.presetId] = true; });
      (draft.apiConnections || []).forEach(function (conn) { if (conn.presetId) connectedPresetIds[conn.presetId] = true; });
    }
    var googleConnection = googleWorkspaceConnection(draft);
    var googleAccess = googleAccessFromScopes(googleConnection ? googleConnection.oauthScopes : []);
    var q = String(state.connectorGallerySearch || "").trim().toLowerCase();
    var catalog = REUSABLE_CONNECTOR_PRESETS || [];
    var reusable = (reusableAccounts || []).filter(function (account) {
      return account.lifecycle !== "revoked";
    });
    var accountPresets = accountMode
      ? reusable.concat(attachedAccounts || []).map(connectionAccountPreset).filter(Boolean)
      : [];
    var connectedAccountPresetIds = new Set(accountPresets.map(function (preset) { return preset.id; }));
    var catalogVisible = showCatalog !== false;
    var shown = (catalogVisible ? catalog : []).filter(function (preset) {
      var googleService = googleServicePresetById(preset.id);
      var managedPreset = managedPresetById(preset.id);
      if (googleService) {
        var managedDescriptor = managedConnectorDescriptorById(googleService.id);
        if (!accountMode &&
            (!googleService.service || googleAccess[googleService.service] !== "off")) return false;
      } else if (managedPreset) {
        var managedDescriptor = managedConnectorDescriptorById(managedPreset.id);
        if (!accountMode) return false;
      } else if (!accountMode && connectedPresetIds[preset.id]) {
        return false;
      }
      if (accountMode && connectedAccountPresetIds.has(preset.id)) return false;
      var searchText = (preset.name + " " + (preset.description || "")).toLowerCase();
      return !q || searchText.indexOf(q) >= 0;
    }).sort(function (a, b) {
      var an = a.name.toLowerCase();
      var bn = b.name.toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    var rows = shown.map(function (preset) {
      var googleService = googleServicePresetById(preset.id);
      var managedPreset = managedPresetById(preset.id);
      if (accountMode) {
        var managedDescriptor = (googleService || managedPreset) && managedConnectorDescriptorById(preset.id);
        var readiness = managedDescriptor ? managedConnectorReadiness(managedDescriptor, "read") : null;
        var stateLabel = readiness && readiness.kind !== "ready" ? readiness.label : "No account";
        var actionLabel = readiness && readiness.kind !== "ready" ? "Set up" : "Connect";
        return '<div class="connection-account-row connection-catalog-row">' + connectorLogoHtml(preset) +
          '<span class="connection-account-copy"><span class="connection-account-name">' + esc(preset.name) + '</span>' +
          '<span class="connection-account-identity">' + esc(preset.description || "Connect an account.") + '</span></span>' +
          '<span class="connection-account-state' + (readiness && readiness.kind !== "ready" ? ' connection-account-state-warn' : '') + '">' + esc(stateLabel) + '</span>' +
          '<span class="connection-capability-placeholder" aria-hidden="true"></span>' +
          '<button type="button" class="btn btn-soft btn-sm connection-row-action" data-action="connection-account-preset" data-preset="' + esc(preset.id) + '">' + esc(actionLabel) + '</button>' +
          '<span class="connection-row-menu-placeholder" aria-hidden="true"></span></div>';
      }
      var lanes = (googleService || managedPreset) ? { mcp: false, api: true } : presetLanes(preset);
      var laneLabel = [lanes.mcp ? "MCP" : "", lanes.api ? "API" : ""].filter(function (label) { return !!label; }).join(" ");
      var description = preset.description ? '<span class="gallery-row-desc">' + esc(preset.description) + '</span>' : "";
      var actionLabel = googleService && googleConnection ? "Enable" : "Connect";
      var rowClass = description ? "gallery-row gallery-row-described" : "gallery-row";
      return '<div class="' + rowClass + '">' + connectorLogoHtml(preset) +
        '<span class="gallery-row-copy"><span class="gallery-row-name">' + esc(preset.name) + '</span>' + description + '</span>' +
        '<span class="gallery-lane">' + laneLabel + '</span>' +
        '<span class="gallery-row-spacer"></span>' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="conn-preset" data-preset="' + esc(preset.id) + '">' + actionLabel + '</button></div>';
    }).join("");
    var matchingAccounts = reusable.filter(function (account) {
      if (!q) return true;
      var identity = account.identity && (account.identity.accountName || account.identity.workspaceName) || "";
      var preset = connectionAccountPreset(account);
      var policy = account.policy || {};
      var searchText = [
        account.label,
        identity,
        account.purpose || "",
        preset && preset.name || "",
        account.providerId || "",
        policy.toolkit || "",
      ].join(" ").toLowerCase();
      return searchText.indexOf(q) >= 0;
    });
    var accountRows = accountMode ? matchingAccounts.map(function (account) {
      return connectionAccountRowHtml(account, false);
    }).join("") : "";
    var combinedRows = accountRows + rows;
    var custom = accountMode
      ? '<div class="connection-account-row connection-catalog-row"><span class="conn-logo conn-logo-mono" style="background:var(--ember)">+</span>' +
        '<span class="connection-account-copy"><span class="connection-account-name">Custom connection</span><span class="connection-account-identity">Connect another API or MCP server.</span></span>' +
        '<span class="connection-account-state">No account</span><span class="connection-capability-placeholder" aria-hidden="true"></span>' +
        '<button type="button" class="btn btn-soft btn-sm connection-row-action" data-action="connection-account-new">Connect</button><span class="connection-row-menu-placeholder" aria-hidden="true"></span></div>'
      : '<div class="gallery-row"><span class="conn-logo conn-logo-mono" style="background:var(--ember)">+</span>' +
        '<span class="gallery-row-name">Custom connection</span><span class="gallery-row-spacer"></span>' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="conn-custom">Connect</button></div>';
    var customMatches = accountMode && catalogVisible && (!q || "custom connection connect another api mcp server".indexOf(q) >= 0);
    var listRows = combinedRows + (customMatches ? custom : "");
    var list = listRows
      ? '<div class="' + (accountMode ? "connection-account-list" : "gallery-list") + '">' + listRows + '</div>'
      : (!catalogVisible
          ? '<div class="connection-empty">No reusable accounts yet.</div>'
          : q
          ? '<div class="gallery-empty">No connectors match &ldquo;' + esc(state.connectorGallerySearch) + '&rdquo;.</div>'
          : '<div class="gallery-empty">Every prepackaged connector is already added.</div>');
    return (catalogVisible ? '<input class="input" id="conn-gallery-search-input" type="text" autocomplete="off" placeholder="Search connectors" value="' + esc(state.connectorGallerySearch || "") + '" data-action="conn-gallery-search" aria-label="Search connectors">' : "") +
      '<div class="' + (accountMode ? "connection-section-head" : "gallery-head") + '">' + (accountMode ? "<h3>Available</h3>" : "<span>Available</span>") + '<span class="' + (accountMode ? "connection-section-count" : "gallery-head-count") + '">' + (shown.length + matchingAccounts.length + (customMatches ? 1 : 0)) + '</span></div>' +
      list + (accountMode ? "" : custom);
  }

  function connectionStatusPill(conn) {
    if (conn.lifecycleStatus === "ready") {
      var n = (conn.allowedTools || []).length;
      return '<span class="conn-pill conn-pill-on"><span class="badge"><span class="dot"></span></span>Connected &middot; ' + n + ' tool' + (n === 1 ? "" : "s") + '</span>';
    }
    if (conn.lifecycleStatus === "failed") {
      return '<span class="conn-pill conn-pill-warn">' + esc(conn.statusText || "Connection failed") + '</span>';
    }
    return '<span class="conn-pill conn-pill-off">' + esc(conn.statusText || "Not tested") + '</span>';
  }

  function apiConnectionStatusPill(conn) {
    if (conn.authMode !== "oauth") return "";
    if (conn.lifecycleStatus === "ready") {
      return '<span class="conn-pill conn-pill-on"><span class="badge"><span class="dot"></span></span>Connected</span>';
    }
    if (conn.lifecycleStatus === "failed") {
      return '<span class="conn-pill conn-pill-warn">' + esc(conn.statusText || "Connection failed") + '</span>';
    }
    return '<span class="conn-pill conn-pill-off">' + esc(conn.statusText || "Not connected") + '</span>';
  }

  function isPersistedReadyOAuthEditor(editor) {
    return !!editor && editor.authMode === "oauth" && editor.lifecycleStatus === "ready" &&
      editor.index !== null && editor.index !== undefined;
  }

  function selectedConnectionToolNames(editor) {
    var checked = editor.checked || [];
    return (editor.discoveredTools || []).filter(function (_tool, index) {
      return checked[index] !== false;
    }).map(function (tool) { return tool.name; });
  }

  function sameToolNames(left, right) {
    if (left.length !== right.length) return false;
    return left.every(function (name) { return right.indexOf(name) >= 0; });
  }

  function oauthToolAccessChanged(editor) {
    if (!isPersistedReadyOAuthEditor(editor)) return false;
    return !sameToolNames(selectedConnectionToolNames(editor), editor.savedAllowedTools || []);
  }

  // The segmented transport control. STDIO is present but greyed (disabled) with
  // the "Not supported on Cloudflare Workers" title, per the locked decision.
  function transportSegmentHtml(active) {
    function seg(value, label, disabled) {
      var on = active === value && !disabled;
      return '<button type="button" class="' + (on ? "on" : "") + '"' +
        (disabled ? ' disabled title="Not supported on Cloudflare Workers"' : ' data-action="conn-transport" data-transport="' + value + '"') +
        '>' + label + '</button>';
    }
    return '<div class="seg" role="group" aria-label="Transport">' +
      seg("streamable-http", "Streamable HTTP", false) +
      seg("sse", "SSE", false) +
      seg("stdio", "STDIO", true) + "</div>";
  }

  // The discovered-tools checkbox list rendered after a successful Test. Every
  // tool defaults checked; editor.checked is the parallel bool[] the operator
  // toggles. The count line mirrors the card pill.
  function connectionToolsHtml(editor) {
    var tools = editor.discoveredTools || [];
    if (!tools.length) return "";
    var checked = editor.checked || [];
    var savedOAuth = isPersistedReadyOAuthEditor(editor);
    var accessChanged = oauthToolAccessChanged(editor);
    var rows = tools.map(function (tool, index) {
      var on = checked[index] !== false;
      var meta = tool.description ? '<span class="tool-desc">' + esc(tool.description) + '</span>' : "";
      return '<label class="conn-tool">' +
        '<span class="import-check' + (on ? " on" : "") + '"><input type="checkbox" data-action="conn-tool-toggle" data-index="' + index + '" ' + (on ? "checked" : "") + (editor.toolAccessSaving ? " disabled" : "") + ' aria-label="Allow ' + esc(tool.name) + '"></span>' +
        '<span class="tool-body"><span class="tool-name">' + esc(tool.name) + '</span>' + meta + '</span></label>';
    }).join("");
    var count = tools.length;
    var hint = savedOAuth
      ? (accessChanged
        ? "Review your changes, then save tool access once."
        : "Tool access is already saved. Uncheck any tools you don&rsquo;t want Chickpea to use.")
      : "All checked by default. Uncheck write-capable tools you don&rsquo;t need.";
    return '<div class="field"><label class="field-label">Discovered tools &mdash; Connected &middot; ' + count + ' tool' + (count === 1 ? "" : "s") + '</label>' +
      '<p class="hint">' + hint + '</p>' +
      '<div class="conn-tools">' + rows + '</div></div>';
  }

  // The header repeater rows (name + value). The value input is password-type; a
  // stored value shows the "•••• stored" placeholder (the value itself is never
  // echoed back from the server, so the box is empty until re-typed).
  function connectionHeadersHtml(editor) {
    var names = editor.headerNames || [];
    var values = editor.headerValues || [];
    var sources = (editor.sources && editor.sources.headers) || {};
    var rows = names.map(function (name, index) {
      var storedHere = sources[name] && sources[name] !== "missing";
      var placeholder = storedHere ? "\\u2022\\u2022\\u2022\\u2022 stored" : "Header value \\u2014 stored, never returned by the API";
      return '<div class="conn-header-row">' +
        '<input class="input mono" type="text" value="' + esc(name) + '" placeholder="X-Api-Key" aria-label="Header name" data-action="conn-header-name" data-index="' + index + '">' +
        '<input class="input mono" type="password" autocomplete="off" value="' + esc(values[index] || "") + '" placeholder="' + placeholder + '" aria-label="Header value" data-action="conn-header-value" data-index="' + index + '">' +
        '<button type="button" class="x-btn" data-action="conn-header-remove" data-index="' + index + '" aria-label="Remove header">&times;</button></div>';
    }).join("");
    return '<div class="field"><label class="field-label">Custom headers</label>' + rows +
      '<div><button type="button" class="btn btn-ghost btn-sm" data-action="conn-header-add">Add header</button></div></div>';
  }

  function connectionEditorCompletionHtml(editor) {
    var isNew = editor.index === null || editor.index === undefined;
    var savedOAuth = isPersistedReadyOAuthEditor(editor);
    var accessChanged = oauthToolAccessChanged(editor);
    var testDisabled = !String(editor.url || "").trim() ||
      (editor.authMode === "oauth" && isNew) || !!editor.oauthStarting;
    var toolsHtml = connectionToolsHtml(editor);
    var testError = editor.testError ? '<p class="field-error">' + esc(editor.testError) + '</p>' : "";
    var testLabel = editor.testing
      ? "Testing&hellip;"
      : (editor.authMode === "oauth" && editor.lifecycleStatus === "failed"
        ? "Retry verification"
        : (editor.lifecycleStatus === "ready" ? "Re-test connection" : "Test connection"));
    var saveLabel = isNew
      ? "Add connection"
      : (savedOAuth ? (editor.toolAccessSaving ? "Saving&hellip;" : "Save tool access") : "Save connection");
    var saveButton = (isNew && editor.authMode === "oauth") || (savedOAuth && !accessChanged)
      ? ""
      : '<button type="button" class="btn btn-primary btn-sm" data-action="conn-save-row"' + (editor.toolAccessSaving ? " disabled" : "") + '>' + saveLabel + '</button>';
    var cancelLabel = savedOAuth && !accessChanged && !state.profileDirty ? "Done" : "Cancel";
    return '<div><button type="button" class="btn btn-soft btn-sm" data-action="conn-test"' + (testDisabled ? " disabled" : "") + '>' + testLabel + '</button>' + testError + '</div>' +
      toolsHtml +
      (editor.toolAccessError ? '<p class="field-error" role="alert">' + esc(editor.toolAccessError) + '</p>' : "") +
      (editor.error ? '<p class="field-error">' + esc(editor.error) + '</p>' : "") +
      '<div class="skill-form-actions">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="conn-cancel">' + cancelLabel + '</button>' +
      saveButton + '</div>';
  }

  function oauthAccountHtml(editor) {
    if (editor.authMode !== "oauth" || editor.lifecycleStatus !== "ready") return "";
    var identity = editor.identity || {};
    var workspaceName = identity.workspaceName ||
      (editor.presetId === "supabase" && editor.supabaseProjectRef ? editor.supabaseProjectRef : editor.displayName);
    var account = identity.accountName
      ? '<span class="oauth-account-detail">Connected as ' + esc(identity.accountName) + '</span>'
      : '<span class="oauth-account-detail">OAuth verified</span>';
    return '<div class="oauth-account" role="status">' +
      '<div class="oauth-account-copy"><span class="oauth-account-status">Connected</span>' +
      '<span class="oauth-account-name">' + esc(workspaceName) + '</span>' + account + '</div>' +
      '<div class="oauth-account-actions">' +
      '<button type="button" class="link-btn" data-action="conn-oauth-start">Reconnect</button>' +
      '<button type="button" class="link-btn" data-action="conn-oauth-disconnect">Disconnect</button></div></div>';
  }

  function oauthConnectionHtml(editor, preset) {
    if (editor.lifecycleStatus === "ready") return oauthAccountHtml(editor);
    var providerName = (preset && preset.name) || editor.displayName || "provider";
    var hint = (preset && preset.tokenDocsHint) || ("Sign in to " + providerName + " and choose the access Chickpea should receive.");
    var label = editor.oauthStarting
      ? "Opening " + esc(providerName) + "&hellip;"
      : "Sign into " + esc(providerName);
    var setupBlocked = preset && preset.id === "supabase" && !validSupabaseProjectRef(editor.supabaseProjectRef);
    return '<div class="field"><p class="hint">' + esc(hint) + '</p>' +
      '<button type="button" class="btn btn-primary btn-sm oauth-signin" data-action="conn-oauth-start"' + (editor.oauthStarting || setupBlocked ? " disabled" : "") + '>' +
      (preset ? connectorLogoHtml(preset) : "") + '<span>' + label + '</span></button>' +
      (editor.oauthError ? '<p class="field-error" role="alert">' + esc(editor.oauthError) + '</p>' : "") + '</div>';
  }

  function validSupabaseProjectRef(value) {
    return /^[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$/.test(String(value || "").trim());
  }

  function supabaseSetupFromUrl(value) {
    try {
      var url = new URL(String(value || ""));
      if (url.origin !== "https://mcp.supabase.com" || url.pathname !== "/mcp") return null;
      var allowed = { project_ref: true, read_only: true };
      var entries = Array.from(url.searchParams.entries());
      if (entries.some(function (entry) { return !allowed[entry[0]]; })) return null;
      if (url.searchParams.getAll("project_ref").length > 1 || url.searchParams.getAll("read_only").length > 1) return null;
      var projectRef = String(url.searchParams.get("project_ref") || "").trim();
      var readOnlyValue = url.searchParams.get("read_only");
      if (readOnlyValue !== null && readOnlyValue !== "true") return null;
      return { projectRef: projectRef, readOnly: readOnlyValue === "true" };
    } catch (_) {
      return null;
    }
  }

  function syncSupabaseUrl(editor) {
    var url = new URL("https://mcp.supabase.com/mcp");
    var projectRef = String(editor.supabaseProjectRef || "").trim();
    if (projectRef) url.searchParams.set("project_ref", projectRef);
    if (editor.supabaseReadOnly !== false) url.searchParams.set("read_only", "true");
    editor.url = url.href;
  }

  function validSentrySlug(value) {
    return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(value || "").trim());
  }

  function sentryScopeFromUrl(value) {
    try {
      var url = new URL(String(value || ""));
      if (url.origin !== "https://mcp.sentry.dev" || url.search || url.hash) return null;
      var parts = url.pathname.split("/").filter(function (part) { return !!part; });
      if (parts[0] !== "mcp" || parts.length > 3) return null;
      var organizationSlug = parts[1] || "";
      var projectSlug = parts[2] || "";
      if (organizationSlug && !validSentrySlug(organizationSlug)) return null;
      if (projectSlug && (!organizationSlug || !validSentrySlug(projectSlug))) return null;
      return { organizationSlug: organizationSlug, projectSlug: projectSlug };
    } catch (_) {
      return null;
    }
  }

  function syncSentryUrl(editor) {
    var url = "https://mcp.sentry.dev/mcp";
    var organizationSlug = String(editor.sentryOrganizationSlug || "").trim();
    var projectSlug = String(editor.sentryProjectSlug || "").trim();
    if (organizationSlug) url += "/" + encodeURIComponent(organizationSlug);
    if (organizationSlug && projectSlug) url += "/" + encodeURIComponent(projectSlug);
    editor.url = url;
  }

  function sentrySetupHtml(editor, actionPrefix) {
    var prefix = actionPrefix || "conn";
    return '<div class="form-grid"><div class="field"><label class="field-label">Organization slug <span class="hint">(optional)</span></label>' +
      '<input class="input mono" autocomplete="off" value="' + esc(editor.sentryOrganizationSlug || "") + '" placeholder="acme" data-action="' + prefix + '-sentry-organization"></div>' +
      '<div class="field"><label class="field-label">Project slug <span class="hint">(optional)</span></label>' +
      '<input class="input mono" autocomplete="off" value="' + esc(editor.sentryProjectSlug || "") + '" placeholder="web-app" data-action="' + prefix + '-sentry-project"></div></div>' +
      '<p class="hint">Leave both blank for all approved Sentry access, enter an organization to scope to it, or enter both to scope every request to one project.</p>';
  }

  function supabaseSetupHtml(editor) {
    var readOnly = editor.supabaseReadOnly !== false;
    return '<div class="field"><label class="field-label" for="conn-supabase-project-ref">Project reference</label>' +
      '<input class="input mono" id="conn-supabase-project-ref" type="text" autocomplete="off" value="' + esc(editor.supabaseProjectRef || "") + '" placeholder="abcdefghijklmnopqrst" data-action="conn-supabase-project-ref">' +
      '<p class="hint">Find this in Supabase project Settings &rarr; General. This keeps account-wide tools out of the connection.</p></div>' +
      '<div class="field"><label class="field-label">Database access</label>' +
      '<div class="seg" role="group" aria-label="Supabase database access">' +
      '<button type="button" class="' + (readOnly ? "on" : "") + '" data-action="conn-supabase-access" data-access="read-only">Read-only</button>' +
      '<button type="button" class="' + (!readOnly ? "on" : "") + '" data-action="conn-supabase-access" data-access="read-write">Read and write</button></div>' +
      '<p class="hint">Read-only is recommended. Enable writes only for a project where Chickpea may safely change schema and data.</p></div>';
  }

  function connectionRecommendedBodyHtml(editor) {
    var preset = editor.preset;
    var bearerStored = editor.sources && editor.sources.bearer && editor.sources.bearer !== "missing";
    var tokenHtml = "";
    if (preset.auth.kind === "none") {
      tokenHtml = '<p class="hint">No token needed.</p>';
    } else if (preset.auth.kind === "bearer") {
      var bearerPlaceholder = bearerStored ? "\\u2022\\u2022\\u2022\\u2022 stored" : preset.auth.placeholder;
      tokenHtml = '<div class="field"><label class="field-label">API key</label>' +
        '<input class="input mono" type="password" autocomplete="off" value="' + esc(editor.bearerToken || "") + '" placeholder="' + esc(bearerPlaceholder) + '" data-action="conn-field-bearer"></div>';
    } else if (preset.auth.kind === "header") {
      var headerName = preset.auth.headerName;
      var headerSources = (editor.sources && editor.sources.headers) || {};
      var headerStored = headerSources[headerName] && headerSources[headerName] !== "missing";
      var headerPlaceholder = headerStored ? "\\u2022\\u2022\\u2022\\u2022 stored" : preset.auth.placeholder;
      tokenHtml = '<div class="field"><label class="field-label">API key</label>' +
        '<input class="input mono" type="password" autocomplete="off" value="' + esc((editor.headerValues || [])[0] || "") + '" placeholder="' + esc(headerPlaceholder) + '" data-action="conn-header-value" data-index="0"></div>';
    } else {
      tokenHtml = oauthConnectionHtml(editor, preset);
    }
    var setupHtml = preset.id === "supabase"
      ? supabaseSetupHtml(editor)
      : (preset.oauthPathScope === "sentry-org-project" ? sentrySetupHtml(editor, "conn") : "");
    var docsHtml = preset.auth.kind !== "oauth" && preset.tokenDocsHint ? '<p class="hint">' + esc(preset.tokenDocsHint) + '</p>' : "";
    if (preset.auth.kind !== "oauth" && preset.tokenDocsUrl) {
      docsHtml += '<a class="hint-link" href="' + esc(preset.tokenDocsUrl) + '" target="_blank" rel="noopener noreferrer">Where do I find this?</a>';
    }
    var notesHtml = preset.notes ? '<p class="hint">' + esc(String(preset.notes).replace(/profile/gi, "Agent")) + '</p>' : "";
    return '<div class="conn-recommended-head">' +
      connectorLogoHtml(preset) +
      '<span class="field-label">' + esc(preset.name) + '</span>' +
      '<span class="conn-url-chip mono">' + esc(connectionHost(editor.url)) + '</span></div>' +
      setupHtml + tokenHtml + docsHtml + notesHtml + connectionEditorCompletionHtml(editor);
  }

  function connectionEditorFormHtml(editor) {
    var bearerStored = editor.sources && editor.sources.bearer && editor.sources.bearer !== "missing";
    var bearerPlaceholder = bearerStored ? "\\u2022\\u2022\\u2022\\u2022 stored" : "Paste token \\u2014 stored, never returned by the API";
    var authHtml = '<div class="field"><label class="field-label" for="conn-auth">Authentication</label>' +
      '<div class="select-wrap"><select class="input" id="conn-auth" data-action="conn-auth">' +
      '<option value="none"' + (editor.authMode === "none" ? " selected" : "") + '>None</option>' +
      '<option value="bearer"' + (editor.authMode === "bearer" ? " selected" : "") + '>Bearer token</option>' +
      '<option value="oauth"' + (editor.authMode === "oauth" ? " selected" : "") + '>OAuth</option>' +
      '</select></div>';
    if (editor.authMode === "bearer") {
      authHtml += '<input class="input mono" type="password" autocomplete="off" style="margin-top:8px;" value="' + esc(editor.bearerToken || "") + '" placeholder="' + bearerPlaceholder + '" aria-label="Bearer token" data-action="conn-field-bearer">';
    }
    authHtml += "</div>";
    var viewToggle = editor.preset ? '<div class="seg conn-view-seg" role="group" aria-label="Setup mode">' +
      '<button type="button" class="' + (editor.view === "recommended" ? "on" : "") + '" data-action="conn-view" data-view="recommended">Recommended</button>' +
      '<button type="button" class="' + (editor.view !== "recommended" ? "on" : "") + '" data-action="conn-view" data-view="advanced">Advanced</button></div>' : "";
    if (editor.preset && editor.view === "recommended") {
      return '<div class="skill-form">' + viewToggle + connectionRecommendedBodyHtml(editor) + '</div>';
    }
    var oauthScopeHtml = editor.authMode === "oauth" && !editor.preset
      ? '<details class="advanced conn-oauth-advanced"><summary>Advanced</summary><div class="adv-rows">' +
        '<div class="field"><label class="field-label" for="conn-oauth-scope">Scope (optional)</label>' +
        '<input class="input mono" id="conn-oauth-scope" type="text" autocomplete="off" value="' + esc(editor.oauthScope || "") + '" placeholder="e.g. read write" data-action="conn-field-oauth-scope">' +
        '<p class="hint">Leave blank to use the default access requested by the provider.</p></div></div></details>'
      : "";
    var advancedOAuthHtml = editor.authMode === "oauth"
      ? oauthScopeHtml + oauthConnectionHtml(editor, editor.preset || presetById(editor.presetId) || null)
      : "";
    return '<div class="skill-form">' + viewToggle +
      '<div class="field"><label class="field-label" for="conn-name">Name</label>' +
      '<input class="input" id="conn-name" type="text" value="' + esc(editor.displayName) + '" placeholder="Linear" data-action="conn-field-name"></div>' +
      '<div class="field"><label class="field-label" for="conn-url">Server URL</label>' +
      '<input class="input mono" id="conn-url" type="text" value="' + esc(editor.url) + '" placeholder="https://mcp.example.com/mcp" data-action="conn-field-url">' +
      '<p class="hint">https only. The tool prefix is ' + esc(editor.id || connectionSlug(editor.displayName) || "id") + '.</p></div>' +
      '<div class="field"><label class="field-label">Transport</label>' + transportSegmentHtml(editor.transport) + '</div>' +
      authHtml +
      advancedOAuthHtml +
      connectionHeadersHtml(editor) +
      connectionEditorCompletionHtml(editor) + '</div>';
  }

  // Client-side validation mirroring the server valibot schema so an inline error
  // shows before the save round-trips.
  function validateConnectionEditor(editor, servers) {
    var name = String(editor.displayName || "").trim();
    if (!name) return "Name is required.";
    if (name.length > 80) return "Name must be 80 characters or fewer.";
    var url = String(editor.url || "").trim();
    if (!url) return "Server URL is required.";
    // NOTE: a regex with slashes cannot appear in this template literal (the
    // escaped slashes collapse into a // comment at render time), so match the
    // https scheme with a plain prefix check instead.
    if (url.slice(0, 8).toLowerCase() !== "https://") return "MCP server URLs must use https.";
    var id = editor.id || connectionSlug(name);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return "Name must contain at least one letter or digit.";
    var duplicate = (servers || []).some(function (server, index) {
      return index !== editor.index && server.id === id;
    });
    if (duplicate) return "Another connection already uses that name.";
    if (editor.presetId === "supabase" && editor.preset && !validSupabaseProjectRef(editor.supabaseProjectRef)) {
      return "Enter a valid Supabase project reference before signing in.";
    }
    if (editor.presetId === "sentry" && editor.preset) {
      if (!sentryScopeFromUrl(editor.url)) {
        return "Enter valid lowercase Sentry organization and project slugs.";
      }
      if (editor.sentryProjectSlug && !editor.sentryOrganizationSlug) {
        return "Enter a Sentry organization before a project.";
      }
    }
    return "";
  }

  function legacyGithubConnectionNoticeHtml(conn) {
    if (!conn || conn.presetId !== "github") return "";
    return '<span class="conn-meta">GitHub now lives in the <button type="button" class="link-btn" data-action="profile-tab" data-tab="repositories">Repositories tab</button></span>';
  }

  function connectionAccountPreset(account) {
    var policy = account && account.policy || {};
    var presets = REUSABLE_CONNECTOR_PRESETS || [];
    if (policy.kind === "managed") {
      var byToolkit = presets.find(function (preset) { return preset.managedToolkit === policy.toolkit; });
      if (byToolkit) return byToolkit;
      var descriptor = managedConnectorDescriptorByToolkit(policy.toolkit);
      if (descriptor) {
        var byDescriptor = presets.find(function (preset) { return preset.id === descriptor.id; });
        if (byDescriptor) return byDescriptor;
      }
    }
    if (policy.kind === "mcp" && policy.presetId) {
      var byMcpPreset = presets.find(function (preset) {
        if (preset.id !== policy.presetId || typeof preset.url !== "string") return false;
        try {
          var actual = new URL(policy.url);
          var expected = new URL(preset.url);
          var actualPath = actual.pathname.endsWith("/") ? actual.pathname.slice(0, -1) : actual.pathname;
          var expectedPath = expected.pathname.endsWith("/") ? expected.pathname.slice(0, -1) : expected.pathname;
          return actual.origin === expected.origin && actualPath === expectedPath;
        } catch (error) { return false; }
      });
      if (byMcpPreset) return byMcpPreset;
    }
    if (policy.kind === "api" && policy.presetId) {
      var byApiPreset = presets.find(function (preset) {
        if (preset.id !== policy.presetId || !preset.api) return false;
        var expectedHosts = preset.api.hosts || [];
        var actualHosts = policy.allowedHosts || [];
        var hostsMatch = actualHosts.length > 0 && actualHosts.every(function (actualHost) {
          return expectedHosts.some(function (expectedHost) {
            if (!preset.api.hostTemplate) return actualHost.toLowerCase() === expectedHost.toLowerCase();
            var marker = "your-subdomain";
            var index = expectedHost.indexOf(marker);
            if (index < 0) return false;
            var prefix = expectedHost.slice(0, index);
            var suffix = expectedHost.slice(index + marker.length);
            if (!actualHost.startsWith(prefix) || !actualHost.endsWith(suffix)) return false;
            var variable = actualHost.slice(prefix.length, actualHost.length - suffix.length);
            return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(variable);
          });
        });
        var expectedMethods = preset.api.methods || [];
        var methodsMatch = (policy.allowedMethods || []).every(function (method) {
          return expectedMethods.indexOf(method) >= 0;
        });
        return hostsMatch && methodsMatch;
      });
      if (byApiPreset) return byApiPreset;
    }
    return null;
  }

  function connectionAccountLogoHtml(account) {
    var preset = connectionAccountPreset(account);
    if (preset) return connectorLogoHtml(preset);
    // Do not route a custom account through connectorLogoHtml: that helper
    // resolves ids against the branded catalog. A caller-controlled provider
    // id or label must always remain a neutral, clearly custom connection.
    return '<span class="conn-logo conn-logo-mono" style="background:#8b6b2e">' +
      esc(connectorMonogram(account.label || "Connection")) + '</span>';
  }

  function connectionAccountOwnerLabel(account) {
    return account.ownerKind === "member" ? "Personal" : "Team";
  }

  function connectionAccountDisplayName(account) {
    var preset = connectionAccountPreset(account);
    var label = String(account.label || "Connection").replace(/\\s+·\\s+(?:Personal|Team)$/i, "");
    if (preset && label.toLowerCase() === preset.name.toLowerCase()) return preset.name;
    return label;
  }

  function connectionAccountIdentity(account) {
    var policy = account.policy || {};
    if (policy.kind === "mcp") return connectionHost(policy.url || "") || "";
    if (policy.kind === "api") return policy.allowedHosts && policy.allowedHosts[0] || "";
    var identity = account.identity && (account.identity.accountName || account.identity.workspaceName);
    if (identity) return identity;
    if (account.policy && account.policy.kind !== "managed" && account.purpose) return account.purpose;
    return "";
  }

  function humanizeCapabilityId(id) {
    var parts = String(id || "").split(".").filter(function (part) { return !!part; });
    var useful = parts.slice(Math.max(0, parts.length - 2)).join(" ").replace(/[_-]+/g, " ");
    return useful ? useful.charAt(0).toUpperCase() + useful.slice(1) : "Available action";
  }

  function connectionAccountCapabilityItems(account) {
    var policy = account && account.policy || {};
    if (policy.kind === "managed") {
      var descriptor = managedConnectorDescriptorByToolkit(policy.toolkit);
      var definitions = descriptor && descriptor.capabilities || [];
      return (policy.allowedCapabilities || []).map(function (id) {
        var definition = definitions.find(function (candidate) { return candidate.id === id; });
        return {
          id: id,
          label: definition && definition.description || humanizeCapabilityId(id),
          lane: definition && (definition.accessLane === "read" || definition.accessLane === "write")
            ? definition.accessLane
            : null
        };
      });
    }
    if (policy.kind === "mcp") {
      var discovered = policy.discoveredTools || [];
      return (policy.allowedTools || []).map(function (name) {
        var tool = discovered.find(function (candidate) { return candidate.name === name; });
        return { id: name, label: tool && tool.description || humanizeCapabilityId(name), lane: null };
      });
    }
    return (policy.allowedMethods || []).map(function (method) {
      var normalizedMethod = String(method || "").toUpperCase();
      var lane = normalizedMethod === "GET" || normalizedMethod === "HEAD" || normalizedMethod === "OPTIONS"
        ? "read"
        : normalizedMethod === "POST" || normalizedMethod === "PUT" || normalizedMethod === "PATCH" || normalizedMethod === "DELETE"
          ? "write"
          : null;
      return { id: method, label: method + " requests to approved paths", lane: lane };
    });
  }

  function connectionAccountCapabilitiesHtml(account, capabilityOverride, attached) {
    var capabilityAccount = account;
    if (account.policy && account.policy.kind === "managed" && Array.isArray(capabilityOverride)) {
      capabilityAccount = Object.assign({}, account, {
        policy: Object.assign({}, account.policy, { allowedCapabilities: capabilityOverride.slice() })
      });
    }
    var items = connectionAccountCapabilityItems(capabilityAccount);
    if (!items.length) return '<span class="connection-capability-placeholder" aria-hidden="true"></span>';
    var name = connectionAccountDisplayName(account);
    var rows = items.map(function (item) {
      return '<li><span class="connection-capability-description">' + esc(item.label) + '</span>' +
        (item.lane ? '<span class="connection-capability-effect' + (item.lane === "write" ? " connection-capability-effect-write" : "") + '">' + esc(item.lane === "write" ? "Write" : "Read") + '</span>' : "") + '</li>';
    }).join("");
    var grant = managedGrantSummaryHtml(account);
    return '<details class="connection-capabilities"><summary aria-label="Show ' + items.length + ' ' + esc(name) + ' ' + (items.length === 1 ? "capability" : "capabilities") + '">' +
      items.length + ' ' + (items.length === 1 ? "capability" : "capabilities") + '</summary>' +
      '<div class="connection-capabilities-popover"><h4>' + esc(name) + ' capabilities</h4>' +
      '<p>' + (attached ? "What this Agent can do with this account." : "This is the maximum this account can do. Each Agent can be given less access.") + '</p>' +
      '<ul class="connection-capability-list">' + rows + '</ul>' +
      (grant ? '<p class="connection-capability-grant">' + grant + '</p>' : '') + '</div></details>';
  }

  function managedGrantSummaryHtml(account) {
    var policy = account && account.policy || {};
    var summary = policy.kind === "managed" && policy.grantSummary;
    if (!summary || !Array.isArray(summary.items)) return "";
    var labels = summary.items.slice(0, 3).map(function (item) {
      return item && item.label ? item.label : "Untitled";
    });
    var suffix = summary.truncated || summary.items.length > labels.length ? " and more" : "";
    return '<span>Provider grant: ' + esc(labels.length ? labels.join(", ") + suffix : "no pages currently listed") + '</span>';
  }

  function managedResourceDefinitions(account) {
    var policy = account && account.policy;
    if (!policy || policy.kind !== "managed") return [];
    var descriptor = managedConnectorDescriptorByToolkit(policy.toolkit);
    return descriptor && descriptor.resources || [];
  }

  function managedResourceSelectionLabel(account) {
    var definitions = managedResourceDefinitions(account);
    if (!definitions.length) return "";
    return definitions.length === 1 ? definitions[0].label : "resources";
  }

  function startManagedResourceSelection(accountId) {
    var entry = (state.agentConnections.attached || []).find(function (candidate) {
      return candidate.account && candidate.account.id === accountId;
    });
    if (!entry) return;
    var definitions = managedResourceDefinitions(entry.account);
    if (!definitions.length) return;
    var editor = {
      accountId: accountId,
      expectedRevision: entry.account.revision,
      definitions: definitions,
      options: {},
      selected: Object.assign({}, entry.binding && entry.binding.resourceConstraints || {}),
      notice: "",
      loading: true,
      busy: false,
      error: ""
    };
    state.managedResourceEditor = editor;
    render();
    function loadPage(definition, cursor, collected, seen, seenCursors, pageCount) {
      if (cursor && seenCursors[cursor]) {
        return Promise.reject(new Error("Resource discovery returned a repeated cursor."));
      }
      if (cursor) seenCursors[cursor] = true;
      var path = "/admin/api/agents/" + encodeURIComponent(state.agentConnections.agentId) +
        "/connections/" + encodeURIComponent(accountId) + "/managed/resources?workspaceId=" +
        encodeURIComponent(state.agentConnections.workspaceId) + "&resourceKey=" +
        encodeURIComponent(definition.key) + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
      return api(path, { cache: "no-store" }).then(function (body) {
        var resources = body && body.resources || [];
        resources.forEach(function (resource) {
          if (resource && resource.handle && !seen[resource.handle]) {
            seen[resource.handle] = true;
            collected.push({ handle: resource.handle, label: resource.label || resource.handle });
          }
        });
        if (body && body.nextCursor && collected.length < 2000 && pageCount + 1 < 20) {
          return loadPage(definition, body.nextCursor, collected, seen, seenCursors, pageCount + 1);
        }
        return {
          resources: collected.slice(0, 2000),
          truncated: !!(body && body.nextCursor)
        };
      });
    }
    Promise.all(definitions.map(function (definition) {
      return loadPage(definition, "", [], {}, {}, 0).then(function (result) {
        editor.options[definition.key] = result.resources;
        return result.truncated;
      });
    })).then(function (truncatedGroups) {
      if (state.managedResourceEditor !== editor) return;
      var removedSelections = 0;
      definitions.forEach(function (definition) {
        var available = new Set((editor.options[definition.key] || []).map(function (option) {
          return option.handle;
        }));
        var previous = editor.selected[definition.key] || [];
        var retained = previous.filter(function (handle) { return available.has(handle); });
        removedSelections += previous.length - retained.length;
        editor.selected[definition.key] = retained;
      });
      var notices = [];
      if (removedSelections) {
        notices.push(removedSelections + " previously selected " +
          (removedSelections === 1 ? "resource is" : "resources are") +
          " no longer available in this list and " +
          (removedSelections === 1 ? "was" : "were") + " removed.");
      }
      if (truncatedGroups.some(Boolean)) {
        notices.push("Only the first 20 pages or 2,000 resources are shown. Narrow provider access if the resource you need is missing.");
      }
      editor.notice = notices.join(" ");
      editor.loading = false;
      render();
    }).catch(function (error) {
      if (state.managedResourceEditor !== editor) return;
      editor.loading = false;
      editor.error = (error && (error.serverMessage || error.message)) || "Could not load available resources.";
      render();
    });
  }

  function toggleManagedResourceSelection(key, handle, checked) {
    var editor = state.managedResourceEditor;
    if (!editor || editor.busy) return;
    var definition = editor.definitions.find(function (candidate) { return candidate.key === key; });
    if (!definition) return;
    var selected = (editor.selected[key] || []).slice();
    if (checked) {
      selected = definition.multiple
        ? selected.indexOf(handle) >= 0 ? selected : selected.concat([handle])
        : [handle];
    } else {
      selected = selected.filter(function (candidate) { return candidate !== handle; });
    }
    editor.selected[key] = selected;
    editor.error = "";
    render();
  }

  function managedResourceSelectionComplete(editor) {
    return editor.definitions.every(function (definition) {
      return !definition.required || (editor.selected[definition.key] || []).length > 0;
    });
  }

  function saveManagedResourceSelection() {
    var editor = state.managedResourceEditor;
    if (!editor || editor.busy || !managedResourceSelectionComplete(editor)) return;
    editor.busy = true;
    editor.error = "";
    render();
    postJson(
      "/admin/api/agents/" + encodeURIComponent(state.agentConnections.agentId) +
        "/connections/" + encodeURIComponent(editor.accountId) + "/managed/resources",
      "POST",
      {
        workspaceId: state.agentConnections.workspaceId,
        expectedRevision: editor.expectedRevision,
        resourceConstraints: editor.selected
      }
    ).then(function () {
      state.managedResourceEditor = null;
      state.agentConnections.notice = "Resource access saved. The selected connector is ready for this Agent.";
      return loadAgentConnections(state.agentConnections.agentId);
    }).catch(function (error) {
      if (state.managedResourceEditor !== editor) return;
      editor.busy = false;
      editor.error = (error && (error.serverMessage || error.message)) || "Could not save resource access.";
      render();
    });
  }

  function managedResourceEditorHtml(account) {
    var editor = state.managedResourceEditor;
    if (!editor || editor.accountId !== account.id) return "";
    if (editor.loading) return '<div class="skill-form"><p class="hint">Loading available resources&hellip;</p></div>';
    var groups = editor.definitions.map(function (definition) {
      var options = editor.options[definition.key] || [];
      var selected = editor.selected[definition.key] || [];
      var choices = options.length ? options.map(function (option) {
        var checked = selected.indexOf(option.handle) >= 0;
        return '<label class="conn-tool"><span class="import-check' + (checked ? " on" : "") + '"><input type="' + (definition.multiple ? "checkbox" : "radio") + '" name="managed-resource-' + esc(definition.key) + '" data-action="connection-account-resource-toggle" data-resource-key="' + esc(definition.key) + '" data-resource-handle="' + esc(option.handle) + '" ' + (checked ? "checked " : "") + (editor.busy ? "disabled " : "") + '></span><span class="tool-body"><span class="tool-name">' + esc(option.label) + '</span></span></label>';
      }).join("") : '<p class="hint">No accessible resources were returned. Confirm provider access, then reconnect if needed.</p>';
      return '<div class="field"><label class="field-label">' + esc(definition.label) + (definition.required ? " · required" : "") + '</label><div class="conn-tools">' + choices + '</div></div>';
    }).join("");
    var complete = managedResourceSelectionComplete(editor);
    return '<div class="skill-form">' + groups +
      (editor.notice ? '<p class="hint" role="status">' + esc(editor.notice) + '</p>' : '') +
      (editor.error ? '<p class="field-error" role="alert">' + esc(editor.error) + '</p>' : '') +
      '<div class="skill-form-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="connection-account-resource-cancel"' + (editor.busy ? " disabled" : "") + '>Cancel</button><button type="button" class="btn btn-primary btn-sm" data-action="connection-account-resource-save"' + (!complete || editor.busy ? " disabled" : "") + '>' + (editor.busy ? "Saving&hellip;" : "Save access") + '</button></div></div>';
  }

  function connectionAccountRowHtml(entry, attached) {
    var account = attached ? entry.account : entry;
    var identity = connectionAccountIdentity(account);
    var owner = connectionAccountOwnerLabel(account);
    var displayName = connectionAccountDisplayName(account);
    var oauthAction = account.policy && account.policy.authMode === "oauth" && account.lifecycle !== "ready"
      ? '<button type="button" class="btn btn-primary btn-sm connection-row-action" data-action="' + (account.policy.kind === "mcp" ? "connection-account-mcp-oauth-start" : "connection-account-oauth-start") + '" data-connection-id="' + esc(account.id) + '">Sign in</button>'
      : "";
    var managedResources = managedResourceDefinitions(account);
    var bindingResources = attached && entry.binding && entry.binding.resourceConstraints || {};
    var missingRequiredBindingResource = attached && managedResources.some(function (definition) {
      return definition.required && !(bindingResources[definition.key] || []).length;
    });
    var pendingResourceSelection = managedResources.length > 0 &&
      (account.lifecycle === "pending" || missingRequiredBindingResource);
    var managedAction = account.policy && account.policy.kind === "managed" &&
      account.lifecycle !== "ready" && account.lifecycle !== "revoked" &&
      (account.lifecycle === "needs_attention" || !pendingResourceSelection)
      ? '<button type="button" class="btn btn-primary btn-sm connection-row-action" data-action="connection-account-managed-reconnect" data-connection-id="' + esc(account.id) + '">Reconnect</button>'
      : "";
    var pendingResourceAction = attached && pendingResourceSelection
      ? '<button type="button" class="btn btn-primary btn-sm connection-row-action" data-action="connection-account-resource-open" data-connection-id="' + esc(account.id) + '">Choose</button>'
      : "";
    var regularAction = attached
      ? '<span class="connection-row-action-placeholder" aria-hidden="true"></span>'
      : '<button type="button" class="btn btn-primary btn-sm connection-row-action" data-action="connection-account-attach" data-connection-id="' + esc(account.id) + '">Add</button>';
    var action = managedAction || oauthAction || pendingResourceAction || regularAction;
    var status = account.lifecycle === "ready"
      ? (attached ? '<span class="connection-account-state-placeholder" aria-hidden="true"></span>' : '<span class="connection-account-state connection-account-state-ready">Account ready</span>')
      : '<span class="connection-account-state connection-account-state-warn">' + esc({
          pending: "Setup required",
          needs_attention: "Needs attention",
          revoked: "Disconnected"
        }[account.lifecycle] || "Needs attention") + '</span>';
    var menuItems = [];
    if (attached) {
      menuItems.push('<button type="button" data-action="connection-account-detach" data-connection-id="' + esc(account.id) + '">Remove from this Agent</button>');
      if (managedResources.length && (!pendingResourceSelection || managedAction || oauthAction)) {
        menuItems.push('<button type="button" data-action="connection-account-resource-open" data-connection-id="' + esc(account.id) + '">' + (pendingResourceSelection ? "Choose " : "Change ") + esc(managedResourceSelectionLabel(account)) + '</button>');
      }
    }
    menuItems.push('<button type="button" class="danger" data-action="connection-account-revoke" data-connection-id="' + esc(account.id) + '">Disconnect account&hellip;</button>');
    var menu = '<details class="connection-row-menu"><summary aria-label="More actions for ' + esc(displayName) + '">&#8943;</summary>' +
      '<div class="connection-row-menu-panel">' + menuItems.join("") + '</div></details>';
    var resourceEditor = managedResourceEditorHtml(account);
    return '<div class="connection-account-row connection-account-row-' + (attached ? "attached" : "available") + '">' +
      connectionAccountLogoHtml(account) +
      '<span class="connection-account-copy"><span class="connection-account-name">' + esc(displayName) + '</span>' +
      '<span class="connection-account-identity">' + (identity ? esc(identity) + ' &middot; ' : '') + owner + '</span></span>' +
      status + connectionAccountCapabilitiesHtml(account, attached && entry.binding ? entry.binding.allowedCapabilities : null, attached) + action + menu +
      (resourceEditor ? '<div class="connection-row-editor">' + resourceEditor + '</div>' : '') + '</div>';
  }

  function connectionAccountEndpointHtml(form, preset, oauth) {
    if (oauth) return '';
    var hostTemplate = !!(form.apiEditor && form.apiEditor.hostTemplate);
    var supabase = !!(form.mcpEditor && form.mcpEditor.presetId === "supabase");
    var sentry = !!(form.mcpEditor && form.mcpEditor.presetId === "sentry");
    if (sentry) return sentrySetupHtml(form.mcpEditor, "connection-account");
    if (preset && !hostTemplate && !supabase) return '';
    var label = form.kind === "mcp"
      ? (supabase ? "Project reference" : "Server URL")
      : (hostTemplate ? "Workspace subdomain" : "API base URL");
    var value = hostTemplate
      ? form.apiSubdomain
      : (supabase ? form.mcpEditor.supabaseProjectRef : form.url);
    var placeholder = hostTemplate
      ? "acme"
      : (supabase ? "abcdefghijklmnopqrst" : "https://api.example.com/v1");
    var action = hostTemplate
      ? "connection-account-subdomain"
      : (supabase ? "connection-account-supabase-ref" : "connection-account-url");
    return '<div class="field"><label class="field-label">' + label + '</label><input class="input mono" value="' + esc(value) + '" placeholder="' + placeholder + '" data-action="' + action + '"></div>';
  }

  function connectionAccountCredentialHtml(form, preset, oauth, mcpOauth) {
    if (oauth) {
      return '<div class="form-grid"><div class="field"><label class="field-label">Google OAuth client ID</label><input class="input mono" value="' + esc(form.oauthClientId || "") + '" autocomplete="off" data-action="connection-account-oauth-client-id"></div><div class="field"><label class="field-label">Google OAuth client secret</label><input class="input mono" type="password" value="' + esc(form.oauthClientSecret || "") + '" autocomplete="off" data-action="connection-account-oauth-client-secret"></div></div><p class="hint">Use the OAuth client for this Chickpea deployment. The client secret is write-only.</p>';
    }
    if (mcpOauth) {
      return '<p class="hint">You will sign in with ' + esc(preset ? preset.name : "the provider") + ' after adding this connection.</p>';
    }
    if (form.mcpEditor && form.mcpEditor.authMode === "none" && !(form.mcpEditor.headerNames || []).length) {
      return '<p class="hint">This server does not require a credential.</p>';
    }
    var placeholder = form.apiEditor && form.apiEditor.credentialPlaceholder
      ? form.apiEditor.credentialPlaceholder
      : (preset && preset.auth && preset.auth.placeholder
        ? preset.auth.placeholder
        : "Paste a token");
    var optional = !!(preset && preset.auth && preset.auth.optional === true);
    return '<div class="field"><label class="field-label">Credential' + (optional ? ' <span class="hint">(optional)</span>' : '') + '</label><input class="input mono" type="password" autocomplete="off" value="' + esc(form.credential) + '" placeholder="' + esc(placeholder) + '" data-action="connection-account-credential"><p class="conn-security">' + (optional ? 'Leave blank to use the provider’s anonymous limits. ' : '') + 'Stored once outside the Agent record and never returned to this browser.</p></div>';
  }

  function connectionAccountAccessHtml(form) {
    var googleService = googleServicePresetById(form.presetId);
    if (form.kind === "managed") {
      var managedAccess = form.managedAccess === "write" ? "write" : "read";
      var managedDescriptor = managedConnectorDescriptorByToolkit(form.managedToolkit);
      var writeDisabled = !managedConnectorLaneReady(managedDescriptor, "write");
      return '<div class="field"><label class="field-label">Access</label><div class="seg" role="group" aria-label="' + esc(form.preset && form.preset.name || "Managed connector") + ' access">' +
        '<button type="button" class="' + (managedAccess === "read" ? "on" : "") + '" data-action="connection-account-managed-access" data-access="read">Read-only</button>' +
        '<button type="button" class="' + (managedAccess === "write" ? "on" : "") + '" data-action="connection-account-managed-access" data-access="write"' + (writeDisabled ? ' disabled aria-disabled="true"' : '') + '>Read and write</button></div>' +
        (writeDisabled ? '<p class="hint">Write access is not configured for this connector.</p>' : '') + '</div>';
    }
    if (googleService && form.apiEditor) {
      var googleAccess = form.apiEditor.googleAccess[googleService.service] || "read";
      return '<div class="field"><label class="field-label">Access</label><div class="seg" role="group" aria-label="' + esc(googleService.name) + ' access">' +
        '<button type="button" class="' + (googleAccess === "read" ? "on" : "") + '" data-action="connection-account-google-access" data-access="read">Read-only</button>' +
        '<button type="button" class="' + (googleAccess === "write" ? "on" : "") + '" data-action="connection-account-google-access" data-access="write">Read and write</button></div></div>';
    }
    if (form.mcpEditor && form.mcpEditor.presetId === "supabase") {
      var readOnly = form.mcpEditor.supabaseReadOnly !== false;
      return '<div class="field"><label class="field-label">Database access</label><div class="seg" role="group" aria-label="Supabase database access">' +
        '<button type="button" class="' + (readOnly ? "on" : "") + '" data-action="connection-account-supabase-access" data-access="read-only">Read-only</button>' +
        '<button type="button" class="' + (!readOnly ? "on" : "") + '" data-action="connection-account-supabase-access" data-access="read-write">Read and write</button></div>' +
        '<p class="hint">Read-only is recommended. Enable writes only for a project where Chickpea may safely change schema and data.</p></div>';
    }
    return '';
  }

  function connectionAccountFormHtml() {
    var form = state.connectionAccountForm;
    if (!form) return '';
    var busy = !!form.busy;
    if (form.kind === "managed") {
      var managedPreset = form.preset;
      var managedDescriptor = managedConnectorDescriptorByToolkit(form.managedToolkit);
      var managedSecurityCopy = managedDescriptor && managedDescriptor.securityDescription &&
        !/composio/i.test(managedDescriptor.securityDescription)
        ? managedDescriptor.securityDescription
        : "Sign-in opens in a secure hosted tab. Chickpea stores the connected-account reference and this Agent’s capability ceiling, not provider refresh tokens.";
      return '<div class="skill-form"><div class="form-grid"><div class="field"><label class="field-label">Who uses this account?</label><span class="select-wrap"><select class="input" data-action="connection-account-owner"><option value="team"' + (form.ownerKind === "team" ? " selected" : "") + '>Team connection</option><option value="member"' + (form.ownerKind === "member" ? " selected" : "") + '>My connection</option></select>' + icon("chevron-down", "select-caret") + '</span><p class="hint">Team connections can be reused by Agents across the workspace. Personal connections are available only when you invoke the Agent.</p></div><div></div></div>' +
        '<div class="conn-title" style="margin-bottom:16px;">' + connectorLogoHtml(managedPreset) + '<div><strong>' + esc(managedPreset.name) + '</strong><p class="hint">' + esc(managedPreset.description || "") + '</p></div></div>' +
        connectionAccountAccessHtml(form) +
        '<p class="conn-security">' + esc(managedSecurityCopy) + '</p>' +
        (form.error ? '<div class="err" role="alert">' + esc(form.error) + '</div>' : '') +
        '<div class="skill-form-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="connection-account-cancel"' + (busy ? " disabled" : "") + '>Cancel</button><button type="button" class="btn btn-primary btn-sm" data-action="connection-account-create"' + (busy ? " disabled" : "") + '>' + (busy ? "Opening sign-in&hellip;" : "Continue to sign in") + '</button></div></div>';
    }
    var oauth = form.kind === "api" && form.authMode === "google_oauth";
    var mcpOauth = form.kind === "mcp" && form.authMode === "oauth";
    var preset = form.preset;
    var managedGoogleAvailable = state.agentConnections.managedGoogleAvailable !== false;
    var authHtml = !preset && form.kind === "api" ? '<div class="field"><label class="field-label">Authentication</label><span class="select-wrap"><select class="input" data-action="connection-account-auth"><option value="credential"' + (form.authMode !== "google_oauth" ? " selected" : "") + '>API token</option>' + (!managedGoogleAvailable ? '<option value="google_oauth"' + (form.authMode === "google_oauth" ? " selected" : "") + '>Google OAuth</option>' : '') + '</select>' + icon("chevron-down", "select-caret") + '</span><p class="hint">' + (managedGoogleAvailable ? 'Use a managed Google connector for Google OAuth.' : 'This deployment uses its own Google OAuth client credentials.') + '</p></div>' : '';
    var endpointHtml = connectionAccountEndpointHtml(form, preset, oauth);
    var credentialHtml = connectionAccountCredentialHtml(form, preset, oauth, mcpOauth);
    var accessHtml = connectionAccountAccessHtml(form);
    var presetHead = preset ? '<div class="conn-title" style="margin-bottom:16px;">' + connectorLogoHtml(preset) + '<div><strong>' + esc(preset.name) + '</strong><p class="hint">' + esc(preset.description || "") + '</p></div></div>' : '';
    var capabilitiesHtml = preset ? '' : '<div class="field"><label class="field-label">' + (form.kind === "mcp" ? "Allowed tools" : "Capabilities") + '</label><input class="input mono" value="' + esc(form.capabilities) + '" placeholder="tickets.read, tickets.update" data-action="connection-account-capabilities"><p class="hint">Comma-separated names. This becomes the Agent binding’s maximum authority.</p></div>';
    var oauthMigrationHtml = mcpOauth && preset && (preset.id === "sentry" || preset.id === "intercom") && hasLegacyTokenMcpConnection(preset.id)
      ? '<p class="hint">This adds OAuth beside the existing token connection. Review the discovered tools, bind and verify the OAuth account, then explicitly disconnect the token account when migration is complete.</p>'
      : '';
    return '<div class="skill-form"><div class="form-grid"><div class="field"><label class="field-label">Who uses this account?</label><span class="select-wrap"><select class="input" data-action="connection-account-owner"><option value="team"' + (form.ownerKind === "team" ? " selected" : "") + '>Team connection</option><option value="member"' + (form.ownerKind === "member" ? " selected" : "") + '>My connection</option></select>' + icon("chevron-down", "select-caret") + '</span><p class="hint">Team connections can be reused by Agents across the workspace. Personal connections are available only when you invoke the Agent.</p></div>' +
      (!preset ? '<div class="field"><label class="field-label">Connection type</label><span class="select-wrap"><select class="input" data-action="connection-account-kind"><option value="api"' + (form.kind === "api" ? " selected" : "") + '>REST API</option><option value="mcp"' + (form.kind === "mcp" ? " selected" : "") + '>MCP server</option></select>' + icon("chevron-down", "select-caret") + '</span></div>' : '<div></div>') + '</div>' +
      presetHead +
      authHtml +
      '<div class="form-grid">' + (!preset ? '<div class="field"><label class="field-label">Provider</label><input class="input" value="' + esc(form.providerId) + '" placeholder="zendesk" data-action="connection-account-provider"></div>' : '') +
      '<div class="field"><label class="field-label">Account label</label><input class="input" value="' + esc(form.label) + '" placeholder="Work Zendesk" data-action="connection-account-label"><p class="hint">People can say “use my work account” to select this connection.</p></div></div>' +
      '<div class="field"><label class="field-label">Purpose</label><input class="input" value="' + esc(form.purpose) + '" placeholder="Support tickets for the Acme team" data-action="connection-account-purpose"></div>' +
      endpointHtml +
      accessHtml +
      capabilitiesHtml +
      credentialHtml +
      (preset && preset.tokenDocsUrl ? '<p class="hint"><a href="' + esc(preset.tokenDocsUrl) + '" target="_blank" rel="noopener noreferrer">Open setup instructions &#8599;</a>' + (preset.tokenDocsHint ? ' &middot; ' + esc(preset.tokenDocsHint) : '') + '</p>' : '') +
      (preset && preset.notes ? '<p class="hint">' + esc(preset.notes) + '</p>' : '') +
      oauthMigrationHtml +
      (form.error ? '<div class="err" role="alert">' + esc(form.error) + '</div>' : '') +
      '<div class="skill-form-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="connection-account-cancel"' + (busy ? " disabled" : "") + '>Cancel</button><button type="button" class="btn btn-primary btn-sm" data-action="connection-account-create"' + (busy ? " disabled" : "") + '>' + (busy ? "Connecting&hellip;" : ((oauth || mcpOauth) ? "Continue to sign in" : "Connect and add")) + '</button></div></div>';
  }

  function connectionsPanelHtml(draft) {
    if (!draft.id) {
      return '<p class="hint ptab-hint">Save this Agent first, then add Team connections or your personal accounts.</p>';
    }
    var accounts = state.agentConnections;
    if (accounts.agentId !== draft.id || accounts.loading) {
      if (state.connectionAccountsSupported === null && draft.mcpServers !== undefined) {
        return legacyConnectionsPanelHtml(draft);
      }
      return '<p class="hint ptab-hint">Loading connections&hellip;</p>';
    }
    if (accounts.legacyFallback) return legacyConnectionsPanelHtml(draft);
    if (accounts.error) {
      return '<div class="callout" role="alert"><span>' + esc(accounts.error) + '</span><button type="button" class="btn btn-soft btn-sm" data-action="connection-account-retry">Retry</button></div>';
    }
    var attached = accounts.attached || [];
    var available = accounts.available || [];
    var attachedHtml = attached.length
      ? '<div class="connection-account-list">' + attached.map(function (entry) { return connectionAccountRowHtml(entry, true); }).join("") + '</div>'
      : '<div class="connection-empty">No connections in this Agent yet.</div>';
    var notice = accounts.notice ? '<div class="oauth-return ok" role="status">' + esc(accounts.notice) + '</div>' : '';
    var create = connectionAccountFormHtml();
    var gallery = connectorGalleryHtml(
      true,
      available,
      attached.map(function (entry) { return entry.account; }),
      !state.connectionAccountForm
    );
    var attachedSection = '<section class="connection-state-section"><div class="connection-section-head"><h3>In this Agent</h3><span class="connection-section-count">' + attached.length + '</span></div>' + attachedHtml + '</section>';
    var availableSection = gallery ? '<section class="connection-state-section">' + gallery + '</section>' : '';
    return oauthReturnNoticeHtml(draft) + notice +
      '<div class="connection-state-stack">' + attachedSection + availableSection + '</div>' +
      (create ? '<div style="margin-top:16px;">' + create + '</div>' : '');
  }

  function legacyConnectionsPanelHtml(draft) {
    var servers = draft.mcpServers || [];
    var apiConnections = draft.apiConnections || [];
    var editor = state.connectionEditor;
    var apiEditor = state.apiConnectionEditor;
    var mcpRows = servers.map(function (conn, index) {
      if (editor && editor.index === index) return connectionEditorFormHtml(editor);
      var transportLabel = conn.transport === "sse" ? "SSE" : "Streamable HTTP";
      var connPreset = conn.presetId ? presetById(conn.presetId) : null;
      var nameHtml = connPreset
        ? '<span class="conn-title">' + connectorLogoHtml(connPreset) + '<span class="sk-name" style="font-family:inherit;">' + esc(conn.displayName) + '</span></span>'
        : '<span class="sk-name" style="font-family:inherit;">' + esc(conn.displayName) + '</span>';
      return '<div class="skill-row conn-row">' +
        '<div class="sk-body">' + nameHtml +
        '<span class="gallery-lane">MCP</span>' +
        '<span class="conn-host">' + esc(connectionHost(conn.url)) + '</span>' +
        '<span class="conn-meta"><span class="badge-src">' + transportLabel + '</span>' + connectionStatusPill(conn) + '</span>' +
        legacyGithubConnectionNoticeHtml(conn) + '</div>' +
        '<span class="toggle"><span class="thumb"></span><input type="checkbox" data-action="conn-toggle" data-index="' + index + '" ' + (conn.enabled ? "checked" : "") + ' aria-label="Connection enabled"></span>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="conn-edit" data-index="' + index + '">Edit</button>' +
        '<button type="button" class="x-btn" data-action="conn-remove" data-index="' + index + '" aria-label="Remove connection">&times;</button></div>';
    }).join("");
    var apiRows = apiConnections.map(function (conn, index) {
      if (apiEditor && apiEditor.index === index) return apiConnectionEditorFormHtml(apiEditor);
      var connPreset = conn.presetId ? presetById(conn.presetId) : null;
      var nameHtml = connPreset
        ? '<span class="conn-title">' + connectorLogoHtml(connPreset) + '<span class="sk-name" style="font-family:inherit;">' + esc(conn.displayName) + '</span></span>'
        : '<span class="sk-name" style="font-family:inherit;">' + esc(conn.displayName) + '</span>';
      return '<div class="skill-row conn-row">' +
        '<div class="sk-body">' + nameHtml +
        '<span class="gallery-lane">API</span>' +
        '<span class="conn-host">' + esc(apiConnectionHostSummary(conn)) + '</span>' +
        '<span class="conn-meta">' + apiConnectionStatusPill(conn) + '</span>' +
        googleServiceSummaryHtml(conn) +
        legacyGithubConnectionNoticeHtml(conn) + '</div>' +
        '<span class="toggle"><span class="thumb"></span><input type="checkbox" data-action="apiconn-toggle" data-index="' + index + '" ' + (conn.enabled ? "checked" : "") + ' aria-label="API connection enabled"></span>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="apiconn-edit" data-index="' + index + '">Edit</button>' +
        '<button type="button" class="x-btn" data-action="apiconn-remove" data-index="' + index + '" aria-label="Remove API connection">&times;</button></div>';
    }).join("");
    var rows = mcpRows + apiRows;
    var list = rows ? '<div class="skill-list">' + rows + '</div>' : "";
    var createForm = "";
    if (state.customConnectionLane) {
      var customEditorForm = state.customConnectionLane === "api"
        ? apiConnectionEditorFormHtml(apiEditor)
        : connectionEditorFormHtml(editor);
      createForm = '<div class="skill-list">' + customConnectionLaneTabHtml() + customEditorForm + '</div>';
    } else if (editor && (editor.index === null || editor.index === undefined) && editor.presetId) {
      createForm = '<div class="skill-list">' + connectionEditorFormHtml(editor) + '</div>';
    } else if (apiEditor && (apiEditor.index === null || apiEditor.index === undefined) && apiEditor.presetId) {
      createForm = '<div class="skill-list">' + apiConnectionEditorFormHtml(apiEditor) + '</div>';
    }
    var gallery = editor || apiEditor || state.customConnectionLane ? "" : connectorGalleryHtml();
    var hint = 'MCP servers and REST APIs this Agent can call.';
    var security = '<p class="conn-security">Your Agent stores connection policy and tool approvals only &mdash; tokens live in the settings store and are never returned by the API.</p>';
    return oauthReturnNoticeHtml(draft) + '<p class="hint ptab-hint">' + hint + '</p>' + list + createForm + gallery + security;
  }

  function oauthReturnNoticeHtml(draft) {
    var result = state.oauthReturn;
    if (!result || result.agentId !== draft.id) return "";
    var lane = result.lane === "api" ? "api" : "mcp";
    var connection = (lane === "api" ? (draft.apiConnections || []) : (draft.mcpServers || [])).find(function (entry) {
      return entry.id === result.connectionId;
    });
    var accountEntry = (state.agentConnections.attached || []).find(function (entry) {
      return entry.account && entry.account.id === result.connectionId;
    });
    var account = accountEntry && accountEntry.account;
    var presetId = connection && connection.presetId
      ? connection.presetId
      : result.connectionId;
    var preset = presetById(presetId);
    var name = account ? account.label : (connection ? connection.displayName : (preset ? preset.name : "The connection"));
    var message;
    var statusClass = "ok";
    var role = "status";
    if (result.status === "connected") {
      // A callback success is one-shot evidence about the connection row that
      // returned. Never reinterpret it as success after that row is removed.
      if (!connection && !account) return "";
      var identity = account ? account.identity : (connection && connection.identity);
      var targetName = identity && (identity.workspaceName || identity.accountName)
        ? (identity.workspaceName || identity.accountName)
        : name;
      if (account) {
        message = "Connected to " + targetName + ". This " + (account.ownerKind === "member" ? "personal" : "team") + " account is ready for the Agent.";
      } else if (lane === "api") {
        message = "Connected to " + targetName + ". The selected Google services are ready to use.";
      } else {
        var toolCount = connection ? (connection.allowedTools || []).length : 0;
        message = "Connected to " + targetName + ". " + toolCount + " tool" + (toolCount === 1 ? "" : "s") + " enabled.";
      }
    } else if (result.status === "cancelled") {
      message = name + " authorization was cancelled. Your saved connection was not changed; you can try again when ready.";
      statusClass = "error";
      role = "alert";
    } else if (result.status === "verification_failed") {
      message = name + " was authorized, but Chickpea could not verify the connection. No tools were enabled. Retry verification below.";
      statusClass = "error";
      role = "alert";
    } else {
      var existingConnectionActive = account ? account.lifecycle === "ready" : (connection &&
        connection.lifecycleStatus === "ready" &&
        (lane === "api" || (connection.allowedTools || []).length > 0));
      message = existingConnectionActive
        ? name + " reconnect failed. Your existing connection is still active."
        : name + " authorization failed. Sign in again to retry.";
      statusClass = "error";
      role = "alert";
    }
    return '<div class="oauth-return ' + statusClass + '" role="' + role + '">' + esc(message) + '</div>';
  }

  function repositoryOwner(fullName) {
    var slash = String(fullName || "").indexOf("/");
    return slash > 0 ? String(fullName).slice(0, slash) : "";
  }

  function enabledRepositoryGrants(draft) {
    return (draft.repositories || []).filter(function (grant) { return grant && grant.enabled; });
  }

  function repositoryGroups(draft) {
    var groups = new Map();
    enabledRepositoryGrants(draft).forEach(function (grant) {
      var accountLogin = grant.installationId === null
        ? (repositoryOwner(grant.fullName) || grant.accountLogin)
        : grant.accountLogin;
      var key = grant.installationId === null ? "legacy:" + accountLogin : "app:" + grant.installationId;
      var group = groups.get(key);
      if (!group) {
        group = { installationId: grant.installationId, accountLogin: accountLogin, grants: [] };
        groups.set(key, group);
      }
      group.grants.push(grant);
    });
    return Array.from(groups.values()).sort(function (left, right) {
      return String(left.accountLogin).localeCompare(String(right.accountLogin));
    });
  }

  function repositoryGrantMatchesPicker(grant, picker) {
    if (grant.installationId === picker.installationId) return true;
    // Older grants may carry no installation id. Once the same account is
    // managed through an App installation, adopt those explicit rows so an
    // Apply pass can bind them to the installation after verifying access.
    return grant.installationId === null &&
      grant.allRepos !== true &&
      repositoryOwner(grant.fullName) === picker.accountLogin;
  }

  function repositoryAccountChoicesHtml(status) {
    if (!state.repositoryAddOpen || !status || status.mode !== "app") return "";
    return repoAccountChoicesHtml({
      installations: status.installations || [],
      action: "repo-manage",
      cancelAction: "repo-add-cancel",
      cancelLabel: "Cancel",
      emptyCopy: "No GitHub App installations are available yet. Install the app on an account or organization, then refresh."
    });
  }

  // Redraw the open picker in place, preserving the repo list's scroll
  // position (a full render() rebuilds the page and resets it to the top).
  // Falls back to a full render when the picker host isn't in the DOM.
  function rerenderRepositoryPicker() {
    var host = document.querySelector(".repo-picker-host");
    if (!host || !state.repositoryPicker) { render(); return; }
    var listBefore = host.querySelector(".repo-picker-list");
    var scrollTop = listBefore ? listBefore.scrollTop : 0;
    host.innerHTML = repositoryPickerHtml();
    var listAfter = host.querySelector(".repo-picker-list");
    if (listAfter) listAfter.scrollTop = scrollTop;
  }

  function repositoryPickerHtml() {
    var picker = state.repositoryPicker;
    if (!picker) return "";
    var totalCount = Number(picker.totalCount || 0);
    var sourceHint = 'This installation has ' + totalCount + ' repositories. Type to search.';
    if (picker.truncated) {
      sourceHint += ' Not every repository is shown — type more of a name to narrow the search.';
    }
    var selectedNames = new Set(picker.selectedFullNames || []);
    var rows = (picker.repos || []).map(function (repo) {
      var checked = selectedNames.has(repo.fullName);
      return '<label class="repo-picker-row"><input type="checkbox" data-action="repo-select" data-repo="' + esc(repo.fullName) + '" ' + (checked ? "checked" : "") + '>' +
        icon("repository") + '<span class="repo-name mono">' + esc(repo.fullName) + '</span>' +
        (repo.private ? '<span class="badge badge-off">Private</span>' : "") + '</label>';
    }).join("");
    var list = repoBrowserListHtml(picker, rows, "repo-picker-retry", "No repositories match this search.");
    var selectedCount = (picker.selectedFullNames || []).length;
    var retainedCount = state.profileDraft ? (state.profileDraft.repositories || []).filter(function (grant) {
      return !repositoryGrantMatchesPicker(grant, picker);
    }).length : 0;
    var exceedsLimit = retainedCount + selectedCount > 200;
    return '<div class="repo-picker" role="dialog" aria-label="Manage repositories for ' + esc(picker.accountLogin) + '">' +
      '<div><p class="repo-picker-title">Manage ' + esc(picker.accountLogin) + '</p><p class="hint">' + esc(sourceHint) + '</p></div>' +
      '<input class="input mono" id="repo-picker-search" type="search" value="' + esc(picker.query) + '" placeholder="Search repositories" data-action="repo-search" autocomplete="off">' +
      list +
      '<div class="repo-picker-foot"><span class="hint">' + selectedCount + ' repo' + (selectedCount === 1 ? "" : "s") + ' selected</span><span class="spacer"></span>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="repo-picker-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="repo-picker-apply"' + (exceedsLimit ? " disabled" : "") + '>Apply</button></div>' +
      (exceedsLimit ? '<p class="field-error">An Agent can select at most 200 repository grants.</p>' : "") + '</div>';
  }

  function repositoryGroupHtml(group) {
    var allRepositories = group.grants.some(function (grant) { return grant.allRepos === true; });
    var explicit = group.grants.filter(function (grant) { return grant.allRepos !== true; });
    var selectionLabel = allRepositories
      ? "All repositories"
      : explicit.length + " repositor" + (explicit.length === 1 ? "y" : "ies");
    var rows = allRepositories
      ? '<p class="hint">Every repository in this installation is available to this Agent.</p>'
      : explicit.map(function (grant) {
        return '<div class="repo-row">' + icon("repository") + '<span class="repo-name mono">' + esc(grant.fullName) + '</span><span class="spacer"></span>' +
          '<button type="button" class="x-btn" data-action="repo-remove" data-repository-id="' + esc(grant.id) + '" aria-label="Remove ' + esc(grant.fullName) + '">&times;</button></div>';
      }).join("");
    if (!rows) rows = '<p class="hint">No repositories selected for this account.</p>';
    // Older grants without an installation id can be adopted by a matching
    // App account. A group with no valid target keeps its rows but gets a hint
    // instead of a dead Manage button.
    var mode = state.githubStatus ? state.githubStatus.mode : "none";
    var manage = "";
    if (mode === "app") {
      var installations = (state.githubStatus && state.githubStatus.installations) || [];
      var target = null;
      installations.forEach(function (installation) {
        if (group.installationId !== null && installation.id === group.installationId) target = installation;
      });
      if (!target) {
        installations.forEach(function (installation) {
          if (!target && installation.accountLogin === group.accountLogin) target = installation;
        });
      }
      manage = target
        ? '<button type="button" class="btn btn-soft btn-sm" data-action="repo-manage" data-installation="' + esc(target.id) + '" data-account="' + esc(target.accountLogin) + '">Manage</button>'
        : '<span class="hint">Install the GitHub App on ' + esc(group.accountLogin) + ' to manage these.</span>';
    }
    var allToggle = group.installationId === null ? "" :
      '<label class="repo-all-label"><span class="toggle"><span class="thumb"></span><input type="checkbox" data-action="repo-all" data-installation="' + esc(group.installationId) + '" data-account="' + esc(group.accountLogin) + '" ' + (allRepositories ? "checked" : "") + ' aria-label="All repositories for ' + esc(group.accountLogin) + '"></span><span class="field-label">All repositories</span></label>';
    return '<details class="repo-group" open><summary><span class="repo-avatar">' + esc(String(group.accountLogin || "?").slice(0, 1)) + '</span>' +
      '<span class="repo-group-name">' + esc(group.accountLogin) + '</span><span class="repo-group-count">' + esc(selectionLabel) + '</span></summary>' +
      '<div class="repo-group-body"><div class="repo-group-actions">' + allToggle + manage + '</div>' +
      (allRepositories ? rows : '<div class="repo-rows">' + rows + '</div>') + '</div></details>';
  }

  function repositoryFooterHtml(status) {
    if (!status || status.mode !== "app") return "";
    var addAccount = status.appSlug
      ? '<a class="btn btn-ghost btn-sm" href="https://github.com/apps/' + esc(encodeURIComponent(status.appSlug)) + '/installations/new" target="_blank" rel="noopener noreferrer">+ Add a GitHub account or org</a>'
      : '<button type="button" class="btn btn-ghost btn-sm" data-action="open-settings" data-section="github-settings">+ Add a GitHub account or org</button>';
    return '<div class="repo-footer">' + addAccount + '<span class="hint">Return here and refresh after installing.</span>' +
      '<button type="button" class="btn btn-soft btn-sm i-lead" data-action="github-refresh">' + icon("arrow-path") + 'Refresh</button></div>';
  }

  function repositoriesPanelHtml(draft) {
    var capabilityHint = '<p class="hint ptab-hint">Coding runs in a sandbox when this Agent has enabled repository grants and the install-wide tier is on.</p>';
    if (!state.githubStatusLoaded) {
      return capabilityHint + '<div class="empty"><p class="hint">Loading GitHub connection&hellip;</p></div>';
    }
    var status = state.githubStatus;
    if (!status) {
      return capabilityHint + '<div class="empty"><p class="field-error" role="alert">' + esc(state.githubError || "Could not load GitHub settings.") + '</p>' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="github-refresh">Retry</button></div>';
    }
    if (status.mode !== "app") {
      return capabilityHint + '<div class="empty"><p class="field-label">Connect GitHub to give this Agent access to repositories.</p>' +
        '<button type="button" class="btn btn-primary" data-action="open-settings" data-section="github-settings">Connect GitHub</button></div>';
    }
    var groups = repositoryGroups(draft);
    var selectedCount = enabledRepositoryGrants(draft).length;
    var content;
    if (!selectedCount) {
      content = '<div class="empty"><p class="field-label">No repositories selected</p><p class="hint">Choose the repositories this Agent can read and change.</p>' +
        '<button type="button" class="btn btn-primary" data-action="repo-add">Add repositories</button></div>';
    } else {
      content = '<div class="repo-panel-head"><p class="hint ptab-hint">Repositories this Agent can work with.</p>' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="repo-add">Add repositories</button></div>' +
        '<div class="repo-groups">' + groups.map(repositoryGroupHtml).join("") + '</div>';
    }
    return capabilityHint + content + repositoryAccountChoicesHtml(status) +
      (state.repositoryPicker ? '<div class="repo-picker-host">' + repositoryPickerHtml() + '</div>' : "") +
      repositoryFooterHtml(status);
  }

  function customConnectionLaneTabHtml() {
    return '<div class="seg conn-view-seg" role="group" aria-label="Connection type">' +
      '<button type="button" class="' + (state.customConnectionLane === "mcp" ? "on" : "") + '" data-action="custom-lane" data-lane="mcp">MCP</button>' +
      '<button type="button" class="' + (state.customConnectionLane === "api" ? "on" : "") + '" data-action="custom-lane" data-lane="api">API</button></div>';
  }

  function apiConnectionMethodsHtml(editor) {
    var checked = editor.methodChecked || [];
    var rows = API_CONNECTION_METHODS.map(function (method, index) {
      var on = checked[index] === true;
      return '<label class="conn-tool">' +
        '<span class="import-check' + (on ? " on" : "") + '"><input type="checkbox" data-action="apiconn-method-toggle" data-index="' + index + '" ' + (on ? "checked" : "") + ' aria-label="Allow ' + method + '"></span>' +
        '<span class="tool-body"><span class="tool-name">' + method + '</span></span></label>';
    }).join("");
    return '<div class="field"><label class="field-label">Methods</label><div class="conn-tools">' + rows + '</div></div>';
  }

  function apiConnectionHostsHtml(editor) {
    var rows = (editor.allowedHosts || []).map(function (host, index) {
      return '<div class="conn-header-row">' +
        '<input class="input mono" type="text" value="' + esc(host) + '" placeholder="api.example.com" aria-label="Allowed host" data-action="apiconn-host-input" data-index="' + index + '">' +
        '<button type="button" class="x-btn" data-action="apiconn-host-remove" data-index="' + index + '" aria-label="Remove allowed host">&times;</button></div>';
    }).join("");
    var templateHint = editor.hostTemplate
      ? '<p class="hint conn-template-hint">Replace &ldquo;your-subdomain&rdquo; with your Zendesk subdomain before saving.</p>'
      : "";
    return '<div class="field"><label class="field-label">Allowed hosts</label>' + rows +
      '<p class="hint">Exact hostnames only (no wildcards).</p>' +
      templateHint +
      '<div><button type="button" class="btn btn-ghost btn-sm" data-action="apiconn-host-add">Add host</button></div></div>';
  }

  function apiConnectionPathsHtml(editor) {
    var rows = (editor.pathPrefixes || []).map(function (prefix, index) {
      return '<div class="conn-header-row">' +
        '<input class="input mono" type="text" value="' + esc(prefix) + '" placeholder="/v1" aria-label="Path prefix" data-action="apiconn-path-input" data-index="' + index + '">' +
        '<button type="button" class="x-btn" data-action="apiconn-path-remove" data-index="' + index + '" aria-label="Remove path prefix">&times;</button></div>';
    }).join("");
    return '<div class="field"><label class="field-label">Path prefixes <span class="hint">(optional)</span></label>' + rows +
      '<p class="hint">Leave empty to allow the whole host.</p>' +
      '<div><button type="button" class="btn btn-ghost btn-sm" data-action="apiconn-path-add">Add path prefix</button></div></div>';
  }

  function apiConnectionEditorCompletionHtml(editor) {
    var isNew = editor.index === null || editor.index === undefined;
    return (editor.error ? '<p class="field-error">' + esc(editor.error) + '</p>' : "") +
      '<div class="skill-form-actions">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="apiconn-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="apiconn-save-row">' + (isNew ? "Add connection" : "Save connection") + '</button></div>';
  }

  function apiConnectionHostTemplateParts(editor) {
    var templateHost = String(editor.hostTemplateHost || "");
    var marker = "your-subdomain";
    var markerIndex = templateHost.toLowerCase().indexOf(marker);
    if (markerIndex < 0) return { prefix: "", suffix: "", valid: false };
    return {
      prefix: templateHost.slice(0, markerIndex),
      suffix: templateHost.slice(markerIndex + marker.length),
      valid: true
    };
  }

  function apiConnectionSubdomain(editor) {
    var host = String((editor.allowedHosts || [])[0] || "");
    var templateHost = String(editor.hostTemplateHost || "");
    if (!host || host.toLowerCase() === templateHost.toLowerCase()) return "";
    var parts = apiConnectionHostTemplateParts(editor);
    if (!parts.valid) return "";
    var lowerHost = host.toLowerCase();
    var lowerPrefix = parts.prefix.toLowerCase();
    var lowerSuffix = parts.suffix.toLowerCase();
    if (lowerHost.slice(0, lowerPrefix.length) !== lowerPrefix) return "";
    if (lowerSuffix && lowerHost.slice(-lowerSuffix.length) !== lowerSuffix) return "";
    return host.slice(parts.prefix.length, lowerSuffix ? -parts.suffix.length : undefined);
  }

  function isGoogleWorkspaceEditor(editor) {
    return !!editor && editor.authMode === "oauth" && editor.oauthProvider === "google";
  }

  function googleAccessFromScopes(scopes) {
    var selected = scopes || [];
    var access = { gmail: "off", calendar: "off", drive: "off" };
    Object.keys(GOOGLE_WORKSPACE_SCOPES).forEach(function (service) {
      var options = GOOGLE_WORKSPACE_SCOPES[service];
      if (selected.indexOf(options.write) >= 0) access[service] = "write";
      else if (selected.indexOf(options.read) >= 0) access[service] = "read";
    });
    return access;
  }

  function googleServiceSummaryHtml(conn) {
    if (!conn || (conn.id !== "google-workspace" && conn.presetId !== "google-workspace")) return "";
    var access = googleAccessFromScopes(conn.oauthScopes || []);
    var chips = (GOOGLE_WORKSPACE_SERVICE_PRESETS || []).map(function (servicePreset) {
      var level = access[servicePreset.service];
      if (level === "off") return "";
      var levelLabel = level === "write" ? "Read and write" : "Read-only";
      return '<span class="google-service-chip">' + connectorLogoHtml(servicePreset) +
        '<span>' + esc(servicePreset.name) + '</span><span class="google-service-level">' + levelLabel + '</span></span>';
    }).filter(function (chip) { return !!chip; }).join("");
    return chips ? '<span class="google-service-summary" aria-label="Enabled Google services">' + chips + '</span>' : "";
  }

  function googleScopesFromEditor(editor) {
    var access = editor.googleAccess || {};
    var scopes = [];
    Object.keys(GOOGLE_WORKSPACE_SCOPES).forEach(function (service) {
      var level = access[service];
      if (level === "read" || level === "write") scopes.push(GOOGLE_WORKSPACE_SCOPES[service][level]);
    });
    return scopes;
  }

  function sameStringSet(left, right) {
    return left.length === right.length && left.every(function (value) { return right.indexOf(value) >= 0; });
  }

  function syncGoogleApiPolicy(editor) {
    if (!isGoogleWorkspaceEditor(editor)) return;
    var scopes = googleScopesFromEditor(editor);
    var hasGmail = scopes.indexOf(GOOGLE_WORKSPACE_SCOPES.gmail.read) >= 0 || scopes.indexOf(GOOGLE_WORKSPACE_SCOPES.gmail.write) >= 0;
    var hasCalendar = scopes.indexOf(GOOGLE_WORKSPACE_SCOPES.calendar.read) >= 0 || scopes.indexOf(GOOGLE_WORKSPACE_SCOPES.calendar.write) >= 0;
    var hasDrive = scopes.indexOf(GOOGLE_WORKSPACE_SCOPES.drive.read) >= 0 || scopes.indexOf(GOOGLE_WORKSPACE_SCOPES.drive.write) >= 0;
    var hasWrite = scopes.some(function (scope) {
      return scope === GOOGLE_WORKSPACE_SCOPES.gmail.write ||
        scope === GOOGLE_WORKSPACE_SCOPES.calendar.write ||
        scope === GOOGLE_WORKSPACE_SCOPES.drive.write;
    });
    editor.oauthScopes = scopes;
    editor.allowedHosts = [].concat(hasGmail ? ["gmail.googleapis.com"] : [], hasCalendar || hasDrive ? ["www.googleapis.com"] : []);
    editor.pathPrefixes = [].concat(
      hasGmail ? ["/gmail/v1/users/me"] : [],
      hasCalendar ? ["/calendar/v3"] : [],
      hasDrive ? ["/drive/v3"] : [],
      scopes.indexOf(GOOGLE_WORKSPACE_SCOPES.drive.write) >= 0 ? ["/upload/drive/v3"] : []
    );
    editor.headerName = "Authorization";
    editor.headerValuePrefix = "Bearer ";
    editor.methodChecked = API_CONNECTION_METHODS.map(function (method) {
      return hasWrite || method === "GET" || method === "HEAD";
    });
    if (editor.savedLifecycleStatus === "ready") {
      if (sameStringSet(scopes, editor.savedOAuthScopes || [])) {
        editor.lifecycleStatus = "ready";
        editor.statusText = editor.savedStatusText || "Connected";
        editor.identity = editor.savedIdentity || null;
      } else {
        editor.lifecycleStatus = "pending";
        editor.statusText = "Not connected";
        editor.identity = null;
      }
    }
  }

  function apiOAuthCallbackUrl() {
    var origin = typeof location.origin === "string" && location.origin
      ? location.origin
      : "http://localhost";
    return (origin.charAt(origin.length - 1) === "/" ? origin.slice(0, -1) : origin) + "/oauth/api/callback";
  }

  function googleAccessRowHtml(editor, service, label, note) {
    var access = (editor.googleAccess && editor.googleAccess[service]) || "off";
    var servicePreset = googleServicePresetByService(service);
    function option(value, text) {
      return '<button type="button" class="' + (access === value ? "on" : "") + '" data-action="apiconn-google-access" data-service="' + service + '" data-access="' + value + '">' + text + '</button>';
    }
    return '<div class="field"><label class="field-label google-access-label">' + (servicePreset ? connectorLogoHtml(servicePreset) : "") + '<span>' + label + '</span></label>' +
      '<div class="seg" role="group" aria-label="' + label + ' access">' +
      option("off", "Off") + option("read", "Read-only") + option("write", "Read and write") + '</div>' +
      '<p class="hint">' + note + '</p></div>';
  }

  function googleConnectedAccountHtml(editor) {
    if (editor.lifecycleStatus !== "ready") return "";
    var accountName = editor.identity && editor.identity.accountName
      ? editor.identity.accountName
      : "Google account";
    return '<div class="oauth-account" role="status">' +
      '<div class="oauth-account-copy"><span class="oauth-account-status">Connected</span>' +
      '<span class="oauth-account-name">' + esc(accountName) + '</span>' +
      '<span class="oauth-account-detail">Selected Google services are available to this Agent.</span></div>' +
      '<div class="oauth-account-actions">' +
      '<button type="button" class="link-btn" data-action="apiconn-oauth-start">Reconnect</button>' +
      '<button type="button" class="link-btn" data-action="apiconn-oauth-disconnect">Disconnect</button></div></div>';
  }

  function googleWorkspaceRecommendedBodyHtml(editor, preset) {
    var clientStored = editor.sources && editor.sources.oauthClient === "stored";
    var clientIdPlaceholder = clientStored ? "•••• stored" : "Google OAuth client ID";
    var clientSecretPlaceholder = clientStored ? "•••• stored" : "Google OAuth client secret";
    var appType = editor.oauthAppType === "external" ? "external" : "workspace-internal";
    var appTypeHint = appType === "external"
      ? "Personal and external apps may require Google verification. While the consent screen is in Testing, refresh authorization for these scopes may expire after seven days."
      : "Recommended for a Google Workspace organization: configure the consent screen as Internal so only members of that organization can sign in.";
    var signInLabel = editor.oauthStarting ? "Opening Google…" : (editor.lifecycleStatus === "ready" ? "Reconnect Google" : "Sign into Google");
    return '<div class="conn-recommended-head">' + connectorLogoHtml(preset) +
      '<span class="field-label">' + esc(preset.name) + '</span><span class="conn-url-chip mono">Google APIs</span></div>' +
      '<div class="oauth-account"><div class="oauth-account-copy"><span class="oauth-account-status">Account safety</span>' +
      '<span class="oauth-account-name">Use a dedicated Google account for Chickpea when possible.</span>' +
      '<span class="oauth-account-detail">Only grant the Gmail, Calendar, and Drive access this Agent needs.</span></div></div>' +
      googleConnectedAccountHtml(editor) +
      '<div class="field"><label class="field-label">Google app audience</label>' +
      '<div class="seg" role="group" aria-label="Google app audience">' +
      '<button type="button" class="' + (appType === "workspace-internal" ? "on" : "") + '" data-action="apiconn-google-app-type" data-app-type="workspace-internal">Workspace internal</button>' +
      '<button type="button" class="' + (appType === "external" ? "on" : "") + '" data-action="apiconn-google-app-type" data-app-type="external">Personal / external</button></div>' +
      '<p class="hint">' + esc(appTypeHint) + '</p></div>' +
      '<div class="field"><label class="field-label">Authorized redirect URI</label>' +
      '<input class="input mono" type="text" readonly value="' + esc(apiOAuthCallbackUrl()) + '" aria-label="Google OAuth redirect URI">' +
      '<p class="hint">Add this exact URI to the Web application OAuth client in Google Cloud.</p></div>' +
      '<div class="form-grid"><div class="field"><label class="field-label">Client ID</label>' +
      '<input class="input mono" type="password" autocomplete="off" value="' + esc(editor.oauthClientId || "") + '" placeholder="' + esc(clientIdPlaceholder) + '" data-action="apiconn-google-client-id"></div>' +
      '<div class="field"><label class="field-label">Client secret</label>' +
      '<input class="input mono" type="password" autocomplete="off" value="' + esc(editor.oauthClientSecret || "") + '" placeholder="' + esc(clientSecretPlaceholder) + '" data-action="apiconn-google-client-secret"></div></div>' +
      (clientStored ? '<p class="hint">Leave both fields blank to keep the stored OAuth client.</p>' : '') +
      '<p class="hint"><a class="hint-link" href="' + esc(editor.tokenDocsUrl || "https://console.cloud.google.com/apis/credentials") + '" target="_blank" rel="noopener noreferrer">Open Google Cloud credentials</a></p>' +
      '<div class="field"><label class="field-label">Google service access</label><p class="hint">These choices become both OAuth scopes and the server-enforced API allowlist.</p></div>' +
      googleAccessRowHtml(editor, "gmail", "Gmail", "Read and write can read mail, modify labels, archive messages, and move messages to trash; it cannot permanently delete mail.") +
      googleAccessRowHtml(editor, "calendar", "Calendar", "Read and write can create, update, and delete calendar events.") +
      googleAccessRowHtml(editor, "drive", "Drive", "Read and write uses Google Drive's broad file scope and can create, update, and delete accessible files.") +
      (editor.oauthError ? '<p class="field-error" role="alert">' + esc(editor.oauthError) + '</p>' : '') +
      (editor.error ? '<p class="field-error" role="alert">' + esc(editor.error) + '</p>' : '') +
      '<div class="skill-form-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="apiconn-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-primary btn-sm oauth-signin" data-action="apiconn-oauth-start"' + (editor.oauthStarting ? " disabled" : "") + '>' +
      connectorLogoHtml(preset) + '<span>' + signInLabel + '</span></button></div>';
  }

  function apiConnectionRecommendedBodyHtml(editor, preset) {
    if (isGoogleWorkspaceEditor(editor)) return googleWorkspaceRecommendedBodyHtml(editor, preset);
    var credentialStored = editor.sources && editor.sources.credential && editor.sources.credential !== "missing";
    var credentialPlaceholder = credentialStored ? "\\u2022\\u2022\\u2022\\u2022 stored" : (editor.credentialPlaceholder || "Paste credential \\u2014 stored, never returned by the API");
    var credentialHint = credentialStored ? '<p class="hint">Leave blank to keep the stored credential.</p>' : "";
    var tokenDocs = editor.tokenDocsHint ? '<p class="hint">' + esc(editor.tokenDocsHint) + '</p>' : "";
    if (editor.tokenDocsUrl) {
      tokenDocs += '<a class="hint-link" href="' + esc(editor.tokenDocsUrl) + '" target="_blank" rel="noopener noreferrer">Where do I find this?</a>';
    }
    var host = String((editor.allowedHosts || [])[0] || "").trim() || String(editor.hostTemplateHost || "");
    var subdomainHtml = editor.hostTemplate
      ? '<div class="field"><label class="field-label" for="apiconn-subdomain">Zendesk subdomain</label>' +
        '<input class="input mono" id="apiconn-subdomain" type="text" value="' + esc(apiConnectionSubdomain(editor)) + '" placeholder="your-subdomain" data-action="apiconn-field-subdomain"></div>'
      : "";
    return '<div class="conn-recommended-head">' +
      connectorLogoHtml(preset) +
      '<span class="field-label">' + esc(preset.name) + '</span>' +
      '<span class="conn-url-chip mono" data-role="apiconn-host-chip">' + esc(host) + '</span></div>' +
      subdomainHtml +
      '<div class="field"><label class="field-label">API key</label>' +
      '<input class="input mono" type="password" autocomplete="off" value="' + esc(editor.credential || "") + '" placeholder="' + esc(credentialPlaceholder) + '" data-action="apiconn-field-credential">' + credentialHint + tokenDocs + '</div>' +
      apiConnectionEditorCompletionHtml(editor);
  }

  function apiConnectionEditorFormHtml(editor) {
    var preset = editor.presetId ? presetById(editor.presetId) : null;
    var credentialStored = editor.sources && editor.sources.credential && editor.sources.credential !== "missing";
    var credentialPlaceholder = credentialStored ? "\\u2022\\u2022\\u2022\\u2022 stored" : (editor.credentialPlaceholder || "Paste credential \\u2014 stored, never returned by the API");
    var credentialHint = credentialStored ? '<p class="hint">Leave blank to keep the stored credential.</p>' : "";
    var tokenDocs = editor.tokenDocsHint ? '<p class="hint">' + esc(editor.tokenDocsHint) + '</p>' : "";
    if (editor.tokenDocsUrl) {
      tokenDocs += '<a class="hint-link" href="' + esc(editor.tokenDocsUrl) + '" target="_blank" rel="noopener noreferrer">Where do I find this?</a>';
    }
    var viewToggle = preset && !isGoogleWorkspaceEditor(editor) ? '<div class="seg conn-view-seg" role="group" aria-label="Setup mode">' +
      '<button type="button" class="' + (editor.view === "recommended" ? "on" : "") + '" data-action="apiconn-view" data-view="recommended">Recommended</button>' +
      '<button type="button" class="' + (editor.view !== "recommended" ? "on" : "") + '" data-action="apiconn-view" data-view="advanced">Advanced</button></div>' : "";
    if (preset && (editor.view === "recommended" || isGoogleWorkspaceEditor(editor))) {
      return '<div class="skill-form">' + viewToggle + apiConnectionRecommendedBodyHtml(editor, preset) + '</div>';
    }
    return '<div class="skill-form">' + viewToggle +
      '<div class="field"><label class="field-label" for="apiconn-name">Name</label>' +
      '<input class="input" id="apiconn-name" type="text" value="' + esc(editor.displayName) + '" placeholder="Issue tracker API" data-action="apiconn-field-name"></div>' +
      apiConnectionHostsHtml(editor) + apiConnectionPathsHtml(editor) +
      '<div class="form-grid"><div class="field"><label class="field-label" for="apiconn-header-name">Header name</label>' +
      '<input class="input mono" id="apiconn-header-name" type="text" value="' + esc(editor.headerName || "") + '" placeholder="Authorization" data-action="apiconn-field-header-name"></div>' +
      '<div class="field"><label class="field-label" for="apiconn-header-prefix">Value prefix</label>' +
      '<input class="input mono" id="apiconn-header-prefix" type="text" value="' + esc(editor.headerValuePrefix || "") + '" placeholder="Bearer " data-action="apiconn-field-header-prefix">' +
      '<p class="hint">The credential is appended to the prefix.</p></div></div>' +
      apiConnectionMethodsHtml(editor) +
      '<div class="field"><label class="field-label" for="apiconn-credential">Credential</label>' +
      '<input class="input mono" id="apiconn-credential" type="password" autocomplete="off" value="' + esc(editor.credential || "") + '" placeholder="' + esc(credentialPlaceholder) + '" data-action="apiconn-field-credential">' + credentialHint + tokenDocs + '</div>' +
      apiConnectionEditorCompletionHtml(editor) + '</div>';
  }

  function apiConnectionHostSummary(conn) {
    var hosts = conn.allowedHosts || [];
    if (!hosts.length) return "No hosts";
    if (hosts.length === 1) return hosts[0];
    return hosts[0] + " +" + (hosts.length - 1);
  }

  function validateApiConnectionEditor(editor, connections) {
    if (isGoogleWorkspaceEditor(editor)) syncGoogleApiPolicy(editor);
    var name = String(editor.displayName || "").trim();
    if (!name) return "Name is required.";
    if (name.length > 80) return "Name must be 80 characters or fewer.";
    var id = editor.id || connectionSlug(name);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return "Name must contain at least one letter or digit.";
    var duplicate = (connections || []).some(function (conn, index) { return index !== editor.index && conn.id === id; });
    if (duplicate) return "Another API connection already uses that name.";
    if (isGoogleWorkspaceEditor(editor)) {
      if (!(editor.oauthScopes || []).length) return "Choose access to at least one Google service.";
      var clientStored = editor.sources && editor.sources.oauthClient === "stored";
      var hasClientId = !!String(editor.oauthClientId || "").trim();
      var hasClientSecret = !!String(editor.oauthClientSecret || "").trim();
      if (hasClientId !== hasClientSecret) return "Enter both the Google OAuth client ID and client secret.";
      if (!clientStored && !hasClientId) return "Enter the Google OAuth client ID and client secret.";
    }
    var hosts = (editor.allowedHosts || []).map(function (host) { return String(host || "").trim(); }).filter(function (host) { return !!host; });
    if (!hosts.length) return "Add at least one allowed host.";
    var templateHost = String(editor.hostTemplateHost || "").toLowerCase();
    if (editor.hostTemplate && templateHost && hosts.some(function (host) { return host.toLowerCase() === templateHost; })) {
      return 'Replace "your-subdomain" with your Zendesk subdomain before saving.';
    }
    var headerName = String(editor.headerName || "").trim();
    if (!/^[A-Za-z0-9-]{1,128}$/.test(headerName)) return "Header name may contain only letters, digits, and hyphens.";
    var hasMethod = (editor.methodChecked || []).some(function (checked) { return checked === true; });
    if (!hasMethod) return "Select at least one method.";
    return "";
  }

  // The Remove-connection confirm modal. Rendered only while state.connectionRemove
  // is a valid index. Reuses the shared modal chrome.
  function connectionRemoveModalHtml() {
    if (state.connectionRemove === null || state.connectionRemove === undefined) return "";
    var draft = state.profileDraft;
    var servers = (draft && draft.mcpServers) || [];
    var conn = servers[state.connectionRemove];
    if (!conn) return "";
    var isOAuth = conn.authMode === "oauth";
    var title = isOAuth ? "Disconnect " + conn.displayName + "?" : "Remove " + conn.displayName + "?";
    var body = isOAuth
      ? "This disconnects the account and removes its tool approvals from this Agent. Chickpea's stored OAuth tokens and client registration are deleted when you save."
      : "This drops the connection and its tool approvals from this Agent. Its stored token and header values are deleted when you save.";
    return '<div class="modal-backdrop">' +
      '<div class="modal-card" role="dialog" aria-modal="true" aria-label="' + (isOAuth ? "Disconnect account" : "Remove connection") + '">' +
      '<h2 class="modal-title">' + esc(title) + '</h2>' +
      '<p class="modal-body">' + esc(body) + '</p>' +
      '<div class="modal-foot"><span class="spacer"></span>' +
      '<button type="button" class="btn btn-ghost" data-action="conn-remove-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-danger" data-action="conn-remove-confirm">' + (isOAuth ? "Disconnect and remove" : "Remove connection") + '</button>' +
      '</div></div></div>';
  }

  function apiConnectionRemoveModalHtml() {
    if (state.apiConnectionRemove === null || state.apiConnectionRemove === undefined) return "";
    var draft = state.profileDraft;
    var connections = (draft && draft.apiConnections) || [];
    var conn = connections[state.apiConnectionRemove];
    if (!conn) return "";
    var isOAuth = conn.authMode === "oauth";
    return '<div class="modal-backdrop">' +
      '<div class="modal-card" role="dialog" aria-modal="true" aria-label="' + (isOAuth ? "Disconnect account" : "Remove API connection") + '">' +
      '<h2 class="modal-title">' + (isOAuth ? "Disconnect " : "Remove ") + esc(conn.displayName) + '?</h2>' +
      '<p class="modal-body">' + (isOAuth
        ? "This disconnects the account and removes its API access policy. Chickpea's stored OAuth client and tokens are deleted when you save."
        : "This drops the API policy from this Agent. Its stored credential is deleted when you save.") + '</p>' +
      '<div class="modal-foot"><span class="spacer"></span>' +
      '<button type="button" class="btn btn-ghost" data-action="apiconn-remove-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-danger" data-action="apiconn-remove-confirm">' + (isOAuth ? "Disconnect and remove" : "Remove connection") + '</button>' +
      '</div></div></div>';
  }

  function profileNameFieldHtml(draft) {
    var err = state.profileError === "Name is required.";
    return '<div class="field"><label class="field-label" for="p-name">Name</label>' +
      '<input class="input" id="p-name" name="name" type="text" value="' + esc(draft.name) + '"' + (err ? ' style="outline:2px solid var(--danger); outline-offset:-1px;"' : "") + ' data-action="profile-name">' +
      '<p class="hint">The Agent name shown in Chickpea and in its Slack replies.</p>' +
      (err ? '<p class="field-error">Name is required.</p>' : "") + '</div>';
  }

  function handleFromAgentName(value) {
    var normalized = String(value || "agent").trim().toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "");
    return normalized || "agent";
  }

  function agentPresenceRecoveryHtml(draft) {
    var recovery = draft.slackPresenceRecovery;
    if (!recovery) return "";
    var steps = (recovery.steps || []).map(function (step) { return '<li>' + esc(step) + '</li>'; }).join("");
    return '<div class="callout" style="align-items:flex-start;">' + icon("exclamation-triangle", "ic-l g") +
      '<div><p class="field-label">' + esc(recovery.title) + '</p><p class="hint">' + esc(recovery.explanation) + '</p>' +
      (steps ? '<ol style="margin:12px 0 0; padding-left:20px;">' + steps + '</ol>' : '') +
      (recovery.note ? '<p class="hint" style="margin-top:10px;">' + esc(recovery.note) + '</p>' : '') +
      '<div style="display:flex; gap:8px; margin-top:12px;"><button type="button" class="btn btn-soft btn-sm" data-action="' + (recovery.actionKind === "reconnect" ? "slack-gateway-refresh" : "agent-presence-retry") + '"' + (state.profilePresenceMutation || state.slackConnectionBusy ? ' disabled' : '') + '>' + esc(recovery.actionLabel || "Retry") + '</button>' +
      (recovery.adminUrl ? '<a class="btn btn-ghost btn-sm" href="' + esc(recovery.adminUrl) + '" target="_blank" rel="noopener noreferrer">Open Slack admin</a>' : '') +
      '</div></div></div>';
  }

  function agentPresenceFieldsHtml(draft) {
    var readOnly = draft.canEdit === false;
    var presence = draft.slackPresence || {};
    var avatarUrl = presence.avatar && presence.avatar.url;
    var avatar = avatarUrl
      ? '<img class="agent-avatar-image" src="' + esc(avatarUrl) + '" alt="">'
      : '<span class="agent-avatar-fallback" aria-hidden="true">&#127793;</span>';
    var upload = readOnly
      ? '<span class="hint">Only Agent editors can replace this image.</span>'
      : draft.id
      ? (state.profilePresenceMutation
        ? '<button type="button" class="btn btn-soft btn-sm" disabled>Upload image</button>'
        : '<label class="btn btn-soft btn-sm" style="cursor:pointer;">Upload image<input type="file" accept="image/png,image/jpeg,image/webp" data-action="profile-avatar-upload" style="display:none;"></label>')
      : '<span class="hint">A distinct Chickpea avatar is generated when you create the Agent.</span>';
    return '<section class="agent-detail-card agent-presence-card">' +
      '<div class="agent-card-heading"><span class="agent-card-icon agent-slack-card-icon" role="img" aria-label="Slack"><span class="agent-slack-card-mark slack-logo-image" aria-hidden="true"></span></span><div><h2>In Slack</h2><p>How this Agent appears and is mentioned.</p></div></div>' +
      '<div class="agent-presence-grid">' +
      '<div class="field"><span class="field-label">Avatar</span><div class="agent-avatar-control">' + avatar + '<div class="agent-avatar-actions">' + upload +
      '<p class="hint">PNG, JPEG, or WebP up to 512 KB.</p></div></div></div>' +
      '<div class="field"><label class="field-label" for="p-handle">Handle</label>' +
      '<div class="agent-handle-control"><span class="agent-handle-prefix" aria-hidden="true">@</span><input class="input mono" id="p-handle" type="text" maxlength="80" value="' + esc(draft.handle || handleFromAgentName(draft.name)) + '" data-action="profile-handle"' + (readOnly ? " readonly" : "") + '></div></div></div>' +
      (draft.id ? "" : '<div class="field"><label class="field-label" for="p-description">Description</label><input class="input" id="p-description" type="text" maxlength="500" value="' + esc(draft.description || "") + '" placeholder="What teammates should use this Agent for" data-action="profile-description"' + (readOnly ? " readonly" : "") + '></div>') +
      (readOnly ? "" : agentPresenceRecoveryHtml(draft)) + '</section>';
  }

  function profileInstructionsFieldHtml(draft, showPlaceholder) {
    var err = state.profileError === "Agent instructions are required.";
    var placeholder = showPlaceholder
      ? ' placeholder="e.g. Answer teammates&rsquo; product questions in a warm, concise voice. When you&rsquo;re unsure, say so and point to #support instead of guessing."'
      : "";
    return '<textarea class="textarea" id="p-instr" name="instructions" aria-label="Agent instructions"' + (err ? ' style="outline:2px solid var(--danger); outline-offset:-1px;"' : "") + placeholder + ' data-action="profile-instructions">' + esc(draft.instructions) + '</textarea>' +
      (err ? '<p class="field-error">Agent instructions are required.</p>' : "");
  }

  function profileGenericErrorHtml() {
    if (!state.profileError) return "";
    if (state.profileError === "Name is required." || state.profileError === "Agent instructions are required.") return "";
    return '<div class="field-error" role="alert" aria-live="polite">' + esc(state.profileError) +
      (state.profileConflict ? ' <button type="button" class="btn btn-soft btn-sm" data-action="reload-profile">Reload latest Agent</button>' : '') + '</div>';
  }

  // ---- Create (card 10) ----------------------------------------------------

  function profileCreateHtml() {
    var draft = state.profileDraft || newProfileDraft();
    var duplicateNote = draft.duplicateSourceName
      ? '<div class="callout"><div><p class="field-label">Copied from ' + esc(draft.duplicateSourceName) + '</p><p class="hint">Behavior and skills are copied. Channel access, connections, repositories, memory, and schedules stay separate until you grant them.</p></div></div>'
      : '';
    return '<div style="display:flex; flex-direction:column; gap:6px;">' +
      '<button type="button" class="link-btn" style="align-self:flex-start;" data-action="profiles-back">&larr; Agents</button>' +
      '<span class="agent-kicker">Agent</span><h1 class="page-title">New Agent</h1>' +
      '<p class="hint">Define reusable behavior first. After saving, add this Agent to a Channel and try it in Slack.</p></div>' + duplicateNote +
      '<section class="section"><div class="section-head"><div><h2 class="section-title">Details</h2></div></div>' +
      '<div class="form-grid">' +
      profileNameFieldHtml(draft) +
      modelFieldHtml(draft) +
      '</div></section>' +
      agentPresenceFieldsHtml(draft) +
      profileTabsHtml(draft) +
      agentAdvancedHtml(draft) +
      '<div class="save-bar">' + profileGenericErrorHtml() +
      '<button type="button" class="btn btn-ghost" data-action="cancel-create">Cancel</button>' +
      '<button type="button" class="btn btn-primary" data-action="save-profile">Create Agent</button></div>';
  }

  // ---- Edit (card 11) + edge states (card 12) ------------------------------

  function profileDeletionState(draft) {
    var dm = agentHasDmDefault(draft.id);
    var concrete = channelGrantsForAgent(draft.id);
    var liveRoots = draft.deletion && Array.isArray(draft.deletion.liveSnapshotRoots) ? draft.deletion.liveSnapshotRoots.length : 0;
    var projectedBlocked = !!(draft.deletion && draft.deletion.blocked);
    var blocked = dm || concrete.length > 0 || projectedBlocked;
    var title = "This can\u2019t be undone.";
    var guidance = "Deleting this Agent cannot be undone.";
    if (dm) {
      title = "The DM default can\u2019t be deleted. Detach it everywhere first.";
      guidance = "Choose another workspace Default Agent and remove every Channel grant before deleting this Agent.";
    } else if (concrete.length) {
      title = "Detach it from every channel first.";
      guidance = "Detach it from every Channel before deleting this Agent.";
    } else if (liveRoots) {
      title = "This Agent still has live Slack threads. Wait for them to expire first.";
      guidance = "Wait for its live Slack threads to expire before deleting this Agent.";
    } else if (projectedBlocked) {
      title = "Remove every Channel grant and default routing reference first.";
      guidance = "Remove every Channel grant and choose another workspace Default Agent before deleting this Agent.";
    }
    return { blocked: blocked, title: title, guidance: guidance };
  }

  function agentLifecycleHtml(draft) {
    var open = !!state.profileOverflowOpen;
    var archived = draft.lifecycle === "archived";
    var lifecycleAction = archived ? "restore-profile" : "archive-profile";
    var lifecycleLabel = archived ? "Restore Agent" : "Archive Agent";
    var replacementCandidates = state.agents.filter(function (agent) {
      return agent.id !== draft.id && agent.lifecycle !== "archived" && agent.enabled !== false;
    });
    if (!archived && draft.isWorkspaceDefault && !state.profileReplacementDefaultAgentId && replacementCandidates.length) {
      state.profileReplacementDefaultAgentId = replacementCandidates[0].id;
    }
    var replacement = !archived && draft.isWorkspaceDefault
      ? '<label class="agent-overflow-guidance" for="replacement-default-agent">Default Agent after archive</label>' +
        '<span class="select-wrap"><select class="input" id="replacement-default-agent" data-action="replacement-default-agent">' +
        (replacementCandidates.length
          ? replacementCandidates.map(function (agent) {
              return '<option value="' + esc(agent.id) + '"' + (state.profileReplacementDefaultAgentId === agent.id ? " selected" : "") + '>' + esc(agent.name) + '</option>';
            }).join("")
          : '<option value="">Create another active Agent first</option>') +
        '</select></span>'
      : "";
    var readOnly = draft.canEdit === false;
    var menu = open
      ? '<div class="agent-overflow-menu" role="menu" aria-label="Agent lifecycle actions">' +
        (readOnly ? "" : replacement +
        '<button type="button" class="agent-overflow-menuitem' + (archived ? "" : " danger") + '" role="menuitem" data-action="' + lifecycleAction + '"' + (state.profilePresenceMutation || (!archived && draft.isWorkspaceDefault && !replacementCandidates.length) ? " disabled" : "") + '>' + lifecycleLabel + '</button>') +
        '<button type="button" class="agent-overflow-menuitem" role="menuitem" data-action="duplicate-profile" data-agent="' + esc(draft.id) + '">Duplicate Agent</button>' +
        (readOnly ? '<p class="agent-overflow-guidance">You can duplicate this Agent into an editable copy.</p>' : '<p class="agent-overflow-guidance">' + (archived
          ? "Restoring re-enables the same Slack handle, Channel access, and schedules paused by the archive."
          : "Archiving disables the Slack handle, removes Channel access, and pauses schedules. It can be restored later.") + '</p>') + '</div>'
      : "";
    return '<div class="agent-profile-header-actions">' +
      '<span class="agent-status-chip ' + (archived ? "disabled" : "enabled") + '"><span aria-hidden="true"></span>' + (archived ? "Archived" : "Active") + '</span>' +
      '<div class="agent-overflow"><button type="button" class="agent-overflow-trigger" data-action="agent-overflow-toggle" aria-label="Actions for ' + esc(draft.name || "Agent") + '" aria-haspopup="menu" aria-expanded="' + (open ? "true" : "false") + '">' + icon("ellipsis") + '</button>' + menu + '</div></div>';
  }

  function profileEditHtml() {
    var draft = state.profileDraft;
    // The name lives in the title with an inline rename affordance (pencil →
    // input; Enter/blur commit, Escape reverts) — there is no Name field below.
    var readOnly = draft.canEdit === false;
    var titleRow = !readOnly && state.profileRenaming
      ? '<input class="input page-title-input" id="p-name" name="name" type="text" value="' + esc(draft.name) + '" aria-label="Agent name" data-action="profile-name">'
      : '<span class="title-row"><h1 class="page-title">' + esc(draft.name || "Agent") + '</h1>' +
        (readOnly ? "" : '<button type="button" class="rename-btn" data-action="profile-rename" aria-label="Rename Agent">' + icon("pencil") + '</button>') + '</span>';
    var replyIdentityLabel = "@" + ((draft.slackPresence && draft.slackPresence.normalizedHandle) || draft.handle || handleFromAgentName(draft.name));
    var description = String(draft.description || "").trim();
    var descriptionText = description || (readOnly ? "No description" : "Add a description");
    var descriptionRow = !readOnly && state.profileDescriptionEditing
      ? '<div class="agent-description-row"><input class="input agent-description-input" id="p-description" type="text" maxlength="500" value="' + esc(draft.description || "") + '" placeholder="What teammates should use this Agent for" aria-label="Agent description" data-action="profile-description"></div>'
      : '<div class="agent-description-row' + (description ? "" : " is-empty") + '"><p class="agent-profile-intro" title="' + esc(descriptionText) + '" aria-label="' + esc(descriptionText) + '">' + esc(descriptionText) + '</p>' +
        (readOnly ? "" : '<button type="button" class="rename-btn" data-action="profile-description-edit" aria-label="Edit Agent description">' + icon("pencil") + '</button>') + '</div>';
    return '<div class="agent-profile-page">' +
      '<button type="button" class="link-btn agent-roster-back" style="align-self:flex-start;" data-action="profiles-back">&larr; All Agents</button>' +
      '<header class="agent-profile-header"><div class="agent-profile-heading"><span class="agent-kicker">Agent</span>' + titleRow + '</div>' + agentLifecycleHtml(draft) + '</header>' +
      descriptionRow +
      (readOnly ? '<div class="callout agent-readonly-note"><div><p class="field-label">Read-only Agent</p><p class="hint">You can use this Agent in its permitted Channels or duplicate it into your own editable Agent.</p></div></div>' : "") +
      profileGenericErrorHtml() +
      disableConfirmHtml(draft) +
      agentPresenceFieldsHtml(draft) +
      profileTabsHtml(draft) +
      usedInHtml(draft, readOnly, replyIdentityLabel) +
      '<section class="agent-detail-card agent-model-card"><div class="agent-card-heading"><span class="agent-card-icon semantic-icon tone-model" aria-hidden="true">' + icon("robot") + '</span><div><h2>Model</h2><p>The intelligence this Agent uses for every response. Changes apply to new threads.</p></div></div><div class="agent-model-row">' + modelFieldHtml(draft) + '</div></section>' +
      (readOnly ? '<fieldset class="agent-readonly-fields" disabled>' + agentAdvancedHtml(draft) + '</fieldset>' : agentAdvancedHtml(draft)) +
      (readOnly ? "" : '<div class="save-bar-sticky' + (state.profileDirty ? "" : " is-clean") + (saveBarCueActive() ? " cue" : "") + '">' +
      '<div class="save-bar-inner">' +
      '<p class="save-note">&#9679; Unsaved changes &mdash; applies to new threads</p>' +
      '<button type="button" class="btn btn-ghost" data-action="discard-profile">Discard</button>' +
      '<button type="button" class="btn btn-primary" data-action="save-profile">Save changes</button>' +
      '</div></div>') +
      '<div aria-hidden="true" style="height:56px"></div></div>';
  }

  function agentAdvancedHtml(draft) {
    var sandboxReady = enabledRepositoryGrants(draft).length > 0;
    var readOnly = draft.canEdit === false;
    return '<details class="advanced agent-advanced-card"><summary>' + icon("gear") + '<span>Advanced</span></summary><div class="channel-advanced-content">' +
      '<div class="agent-advanced-row agent-advanced-policy-row"><span><strong id="p-edit-policy-label">Who can edit</strong><small class="hint">Choose who can change this Agent&rsquo;s behavior, access, and appearance.</small></span><span class="select-wrap agent-advanced-select"><select class="input" id="p-edit-policy" aria-labelledby="p-edit-policy-label" data-action="profile-edit-policy"' + (readOnly ? " disabled" : "") + '>' +
      '<option value="creator_and_admins"' + (draft.editPolicy !== "all_workspace_members" ? " selected" : "") + '>Creator and workspace admins</option>' +
      '<option value="all_workspace_members"' + (draft.editPolicy === "all_workspace_members" ? " selected" : "") + '>Any workspace member</option></select>' + icon("chevron-down", "select-caret") + '</span></div>' +
      '<div class="agent-advanced-row"><span><strong>Coding sandbox</strong><small class="hint">Run code and work with granted repositories in an isolated environment.</small></span><span class="badge ' + (sandboxReady ? "badge-on" : "badge-off") + '"><span class="dot"></span>' + (sandboxReady ? "Available" : "Needs repository") + '</span><button type="button" class="btn btn-soft btn-sm" data-action="open-settings" data-section="sandbox">Settings</button></div>' +
      '</div></details>';
  }

  function usedInHtml(draft, readOnly, replyIdentityLabel) {
    var concrete = channelGrantsForAgent(draft.id);
    var canEditChannels = !readOnly && draft.lifecycle !== "archived";
    var channelRows = '<div class="where-list">';
    concrete.forEach(function (assignment) {
      var label = normalizeChannelLabel(assignment.channelLabel) || assignment.channelId;
      channelRows += '<div class="where-entry"><button type="button" class="where-channel-row" data-action="open-channel-from-profile" data-workspace="' + esc(assignment.workspaceId) + '" data-channel="' + esc(assignment.channelId) + '"><span class="where-channel-hash" aria-hidden="true">#</span><span class="where-channel-name">' + esc(label) + '</span><span class="where-channel-open" aria-hidden="true">&nearr;</span></button>' +
        (canEditChannels ? '<button type="button" class="where-remove" data-action="detach-channel" data-workspace="' + esc(assignment.workspaceId) + '" data-channel="' + esc(assignment.channelId) + '" data-label="' + esc(label) + '" aria-label="Remove this Agent from #' + esc(label) + '">' + icon("x-mark") + '</button>' : "") + '</div>';
    });
    channelRows += '</div>';
    var heading = '<div class="agent-card-heading"><span class="agent-card-icon semantic-icon tone-channel" aria-hidden="true">' + icon("hash") + '</span><div><h2>Where it works</h2><p>Choose the Channels where people can mention this Agent.</p></div></div>';
    var picker = canEditChannels ? attachPickerHtml(draft) + attachNoticeHtml() : "";
    if (!concrete.length) {
      var empty = draft.lifecycle === "archived"
        ? '<div class="agent-channel-empty agent-channel-empty-readonly"><div><strong>' + esc(draft.name || "This Agent") + ' is archived</strong><p>Restore this Agent before adding it to Channels.</p></div></div>'
        : readOnly
        ? '<div class="agent-channel-empty agent-channel-empty-readonly"><div><strong>' + esc(draft.name || "This Agent") + ' isn&rsquo;t in any Channels yet</strong><p>An editor can choose its first Channel when it is ready.</p></div></div>'
        : '<div class="agent-channel-empty"><span class="agent-channel-empty-icon" aria-hidden="true">#</span><div><strong>Make ' + esc(draft.name || "this Agent") + ' mentionable</strong><p>Choose its first Slack Channel. People in that Channel can then mention ' + esc(replyIdentityLabel) + '.</p></div><button type="button" class="btn btn-primary btn-sm" data-action="attach-open">Choose first channel</button></div>';
      return '<section class="agent-detail-card agent-placement-card"><div class="agent-placement-head">' + heading + '</div>' + empty + picker + '</section>';
    }
    return '<section class="agent-detail-card agent-placement-card"><div class="agent-placement-head">' + heading +
      (canEditChannels ? '<button type="button" class="btn btn-soft btn-sm" data-action="attach-open">Add to channels</button>' : "") +
      '</div><div class="agent-placement-body"><div class="agent-placement-label"><h3>Channels</h3><span class="agent-placement-count">' + esc(channelCountLabel(concrete.length)) + '</span></div>' + channelRows + '</div>' + picker + '</section>';
  }

  function channelNameLink(assignment) {
    return '<button type="button" class="link-btn" data-action="open-channel-from-profile" data-workspace="' + esc(assignment.workspaceId) + '" data-channel="' + esc(assignment.channelId) + '">' + esc(channelLabel(assignment)) + '</button>';
  }

  function joinChannelNames(assignments, linkify) {
    var parts = assignments.map(function (assignment) {
      return linkify
        ? channelNameLink(assignment)
        : '<b style="font-weight:500; color:var(--text);">' + esc(channelLabel(assignment)) + '</b>';
    });
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] + " and " + parts[1];
    return parts.slice(0, -1).join(", ") + ", and " + parts[parts.length - 1];
  }

  function attachNoticeHtml() {
    if (!state.attachNotice) return "";
    return '<div class="callout">' + icon("exclamation-triangle", "ic-l g") +
      '<span>' + esc(state.attachNotice) + '</span></div>';
  }

  // Every Slack Channel the current member can see, except Channels where this
  // Agent already has an active or pending grant. Many Agents may share one Channel.
  function attachCandidates(agentId) {
    var workspaceId = connectedTeamId();
    var channels = (state.slackChannels && state.slackChannels.channels) || [];
    if (!workspaceId) return [];
    var granted = new Set(channelGrantsForAgent(agentId).filter(function (grant) {
      return grant.workspaceId === workspaceId;
    }).map(function (grant) { return grant.channelId; }));
    return channels.map(function (channel) {
      return {
        channelId: channel.id,
        channelLabel: channel.name
      };
    }).filter(function (candidate) {
      return !granted.has(candidate.channelId);
    });
  }

  function attachPickerHtml(draft) {
    if (!state.attachPicker) return "";
    if (!isSlackConnected()) {
      return '<div class="bundle-row"><span class="hint">Connect @Chickpea first to list workspace channels.</span>' +
        '<span class="spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-action="attach-cancel">Close</button></div>';
    }
    if (state.slackChannelsError) {
      return '<div class="bundle-row"><span class="field-error">' + esc(state.slackChannelsError.text) + '</span>' +
        '<span class="spacer"></span>' +
        (state.slackChannelsError.code === "missing_scope"
          ? slackScopeReinstallLinkHtml() +
            slackScopeCredentialRepairHtml()
          : '<button type="button" class="btn btn-soft btn-sm" data-action="refresh-channels">Retry</button>') +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="attach-cancel">Close</button></div>';
    }
    if (state.slackChannelsLoading || !state.slackChannels) {
      return '<div class="bundle-row"><span class="hint">Loading workspace channels&hellip;</span>' +
        '<span class="spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-action="attach-cancel">Cancel</button></div>';
    }
    var candidates = attachCandidates(draft.id);
    if (!candidates.length) {
      return '<div class="bundle-row"><span class="hint">All available Slack Channels already use this Agent.</span>' +
        '<span class="spacer"></span>' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="attach-new-channel" data-agent="' + esc(draft.id) + '">Add a new Channel with this Agent</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="attach-cancel">Close</button></div>';
    }
    var options = candidates.map(function (candidate) {
      return '<option value="' + esc(candidate.channelId) + '"' +
        (candidate.channelId === state.attachChannelSelected ? " selected" : "") + '>' + esc(channelLabel(candidate)) + '</option>';
    }).join("");
    var truncated = state.slackChannels.truncated
      ? '<span class="hint">Showing the first workspace channels.</span>' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="attach-new-channel" data-agent="' + esc(draft.id) + '">Add a new channel</button>'
      : "";
    return '<div class="bundle-row"><span class="select-wrap"><select class="input" data-role="attach-channel" data-action="attach-channel-option" aria-label="Channel to attach">' + options + '</select>' + icon("chevron-down", "select-caret") + '</span>' +
      '<button type="button" class="btn btn-soft btn-sm i-lead" data-action="refresh-channels" title="Refresh channel list">' + icon("arrow-path") + 'Refresh</button>' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="attach-channel-confirm">Attach</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="attach-cancel">Cancel</button>' + truncated +
      (state.attachError ? '<span class="field-error">' + esc(state.attachError) + '</span>' : "") + '</div>';
  }

  function disableConfirmHtml(draft) {
    if (!state.disableConfirm) return "";
    var dm = agentHasDmDefault(draft.id);
    var concrete = channelGrantsForAgent(draft.id);
    var scope;
    if (concrete.length && dm) {
      scope = "It stops answering in " + joinChannelNames(concrete, false) + " and in direct messages right away.";
    } else if (concrete.length) {
      scope = "It stops answering in " + joinChannelNames(concrete, false) + " right away.";
    } else if (dm) {
      scope = "It stops answering direct messages right away.";
    } else {
      scope = "It stops answering right away.";
    }
    return '<div class="callout">' + icon("exclamation-triangle", "ic-l g") + '<span>Disable ' + esc(draft.name || "this Agent") + '? ' + scope + ' Threads already underway finish on the config they started with.</span></div>' +
      '<div style="display:flex; gap:10px;"><button type="button" class="btn btn-soft btn-sm" data-action="disable-keep">Keep enabled</button><button type="button" class="btn btn-danger btn-sm" data-action="disable-confirm">Disable everywhere</button></div>';
  }

  // Map a /admin/api/models provider id to the admin id under which its dynamic
  // model list + favorites are keyed (state.providerModels / state.favorites).
  // The binding-backed "cloudflare" provider keys its data as "workers-ai"; the
  // REST "cloudflare-workers-ai" provider is skipped in the picker entirely (the
  // keyless binding provider is the one the picker surfaces on Cloudflare).
  function pickerAdminIdFor(providerId) {
    if (providerId === "cloudflare") return "workers-ai";
    if (providerId === "cloudflare-workers-ai") return null;
    return providerId;
  }

  // The picker's per-provider group label is user-facing and never leaks the
  // internal src path. "cloudflare" shows as "workers-ai"; every other provider
  // keeps its own id.
  function pickerGroupLabel(providerId) {
    return providerId === "cloudflare" ? "workers-ai" : providerId;
  }

  // Translate the RuntimeModelProvider.source string into a user-facing phrase.
  // The runtime emits "registered in src/app.ts" for a stored/registered key —
  // that internal path must never reach the UI, so it maps to "via your key".
  // A "via ENV_VAR" source collapses to "via environment"; the binding phrase is
  // already user-facing and passes through.
  function pickerSourcePhrase(source) {
    if (!source) return "";
    if (source === "Workers AI binding") return "Workers AI binding";
    if (source === "registered in src/app.ts") return "via your key";
    if (source.indexOf("via ") === 0) return "via environment";
    return source;
  }

  // Build the dynamic specifier list for one configured picker provider.
  // anthropic/openai render their FULL live model list (prefix "anthropic/" /
  // "openai/"); openrouter/workers-ai render only starred FAVORITES ("openrouter/"
  // / "cloudflare/"). A dynamic source that is not yet fetched (null) or whose
  // fetch failed falls back to the provider's static suggestions, so the group is
  // never empty mid-load or offline. openModelPicker kicks the lazy fetches.
  function pickerModelsFor(provider, adminId) {
    var suggestions = (provider.suggestions || []).slice();
    if (adminId === "anthropic" || adminId === "openai") {
      var live = state.providerModels[adminId];
      if (live && state.providerModelsError[adminId] !== true) {
        return live.map(function (m) { return adminId + "/" + m.id; });
      }
      return suggestions;
    }
    if (adminId === "openrouter" || adminId === "workers-ai") {
      var favs = state.favorites[adminId];
      var prefix = adminId === "workers-ai" ? "cloudflare/" : "openrouter/";
      if (favs != null) {
        return favs.map(function (favId) { return prefix + favId; });
      }
      // Favorites not yet loaded: fall back to static suggestions mid-load.
      return suggestions;
    }
    // Any other (custom) provider: static suggestions only.
    return suggestions;
  }

  function modelPickerHtml(current) {
    var filter = (state.modelPickerFilter || "").toLowerCase();
    var html = '<div class="combo-list" role="listbox">';
    var rendered = false;
    var sawConfigured = false;
    state.models.providers.forEach(function (provider) {
      if (!provider.configured) return;
      if (provider.id === "cloudflare" && providerSummaryById("workers-ai").enabled === false) return;
      var adminId = pickerAdminIdFor(provider.id);
      // Skip the REST cloudflare-workers-ai provider — the keyless binding
      // "cloudflare" provider is the one the picker surfaces.
      if (adminId == null) return;
      sawConfigured = true;
      var models = pickerModelsFor(provider, adminId);
      if (filter) {
        models = models.filter(function (model) { return model.toLowerCase().indexOf(filter) >= 0; });
      }
      if (!models.length) return;
      rendered = true;
      var label = pickerGroupLabel(provider.id);
      var phrase = pickerSourcePhrase(provider.source);
      html += '<div class="combo-group">' + esc(label) + (phrase ? '<span class="src">· ' + esc(phrase) + '</span>' : "") + '</div>';
      models.forEach(function (model) {
        html += '<button type="button" class="combo-opt ' + (current === model ? "active" : "") + '" data-action="pick-model" data-model="' + esc(model) + '">' + esc(model) + '</button>';
      });
    });
    // Owner-approved affordance: a pinned Settings action row below the combo
    // foot, persistent across every filter state (the moment of need is an open
    // dropdown missing the model you want). Settings itself lands with the
    // model-providers build.
    var settingsRow = '<div class="combo-settings"><button type="button" class="link-btn" data-action="open-settings">Manage providers &amp; models in Settings &nearr;</button></div>';
    if (!rendered) {
      if (sawConfigured) {
        return html + '<div class="combo-foot">Star models in Settings to add picker shortcuts, or type any provider/model specifier.</div>' + settingsRow + '</div>';
      }
      return html + '<div class="combo-group">no providers configured</div><div class="combo-foot">No provider keys on this install yet. Type any provider/model specifier to pin one now, or set <span class="mono" style="color:var(--text-2);">SLACK_TAG_MODEL</span> (<span class="mono" style="color:var(--text-2);">provider/model</span>) as an offline/dev fallback so an unpinned Agent still replies.</div>' + settingsRow + '</div>';
    }
    return html + settingsRow + '</div>';
  }

  // ---- Audit Logs > Memory -------------------------------------------------

  function channelAuditSectionHtml(assignment) {
    var currentKey = assignment.workspaceId + ":" + assignment.channelId;
    var scheduledCurrent = state.channelScheduledKey === currentKey;
    var scheduled = scheduledCurrent && state.channelScheduledRoutines ? state.channelScheduledRoutines : [];
    var active = scheduled.filter(function (routine) { return routine.state === "active" && routine.deletedAt == null; })
      .sort(function (left, right) {
        return Number(left.nextRunAt == null ? Number.MAX_SAFE_INTEGER : left.nextRunAt) -
          Number(right.nextRunAt == null ? Number.MAX_SAFE_INTEGER : right.nextRunAt);
      });
    var scheduledCount = scheduledCurrent && state.channelScheduledLoading
      ? "Loading scheduled work&hellip;"
      : scheduledCurrent && state.channelScheduledError
        ? "Scheduled work unavailable"
        : active.length + " active " + (active.length === 1 ? "routine" : "routines");
    var scheduledNote;
    if (scheduledCurrent && state.channelScheduledError) {
      scheduledNote = esc(state.channelScheduledError);
    } else if (!active.length) {
      scheduledNote = "No active routines. Create one naturally in Slack.";
    } else {
      scheduledNote = active.slice(0, 2).map(function (routine) {
        return '<span><strong>' + esc(routine.name) + '</strong> &middot; next ' + esc(formatScheduledDate(routine.nextRunAt, routine.timezone)) + '</span>';
      }).join('<br>') + (active.length > 2 ? '<br><span>+' + (active.length - 2) + ' more</span>' : '');
    }
    var scheduledRow = '<div class="bundle-row channel-memory-row"><div class="channel-memory-summary">' +
      '<span class="channel-memory-total">' + scheduledCount + '</span><span class="channel-routine-preview">' + scheduledNote + '</span></div>' +
      '<span class="spacer"></span><button type="button" class="btn btn-soft btn-sm" data-action="open-channel-scheduled"' +
      ' data-workspace="' + esc(assignment.workspaceId) + '" data-channel="' + esc(assignment.channelId) + '"' +
      ' aria-label="Review scheduled work for ' + esc(channelLabel(assignment)) + '">Review scheduled work</button></div>';
    return '<section class="section channel-audit-section"><div class="section-head"><div><h2 class="section-title">Scheduled work</h2>' +
      '<p class="hint">Review routines that run in this Channel.</p></div></div>' +
      '<div class="channel-audit-rows">' + scheduledRow + '</div></section>';
  }

  function auditTabsHtml() {
    return '<div class="audit-tabs" role="tablist" aria-label="Audit domains">' +
      '<button type="button" class="audit-tab active" role="tab" aria-selected="true" data-action="audit-tab-scheduled">Scheduled work</button>' +
      '<button type="button" class="audit-tab" role="tab" disabled aria-disabled="true" title="Coming later">Network events</button>' +
      '</div>';
  }

  function scheduledWorkRailHtml() {
    var html = '<nav class="rail audit-rail" aria-label="Scheduled routines"><div class="rail-context">' +
      '<div class="rail-head"><span class="section-eyebrow">Audit logs</span></div>' +
      '<div class="platform-row active"><span class="platform-logo slack-logo-image" aria-hidden="true"></span>Slack</div>';
    if (state.scheduledLoading && !state.scheduledRoutines) {
      return html + '<div class="empty" style="margin:8px; padding:12px;"><p class="hint">Loading routines&hellip;</p></div></div>' + sectionSwitcherHtml() + '</nav>';
    }
    if (state.scheduledError && !state.scheduledRoutines) {
      return html + '<div class="empty" style="margin:8px; padding:12px;"><p class="field-error">' + esc(state.scheduledError) + '</p><button type="button" class="btn btn-ghost btn-sm" data-action="scheduled-retry">Retry</button></div></div>' + sectionSwitcherHtml() + '</nav>';
    }
    var routines = state.scheduledRoutines || [];
    var filterLabel = scheduledStateFilterLabel(state.scheduledFilters.state);
    html += '<div class="ws-row">Scheduled work</div>' +
      '<button type="button" class="chan-item active" data-action="scheduled-back-list">' +
      '<span class="chan-name">' + esc(filterLabel) + '</span><span class="chan-meta">' + Number(routines.length) + ' matching</span></button>';
    return html + '</div>' + sectionSwitcherHtml() + '</nav>';
  }

  function scheduledChannelLabel(workspaceId, channelId) {
    var channel = (state.channelIndex || []).find(function (candidate) {
      return candidate.workspaceId === workspaceId && candidate.channelId === channelId;
    });
    return "#" + normalizeChannelLabel(channel && channel.channelName || channelId || "channel");
  }

  function scheduledStatusBadge(status) {
    var on = status === "active" || status === "running" || status === "succeeded" || status === "delivered" || status === "enabled";
    return '<span class="badge ' + (on ? "badge-on" : "badge-off") + '">' + (on ? '<span class="dot"></span>' : '') + esc(String(status || "unknown").replace(/_/g, " ")) + '</span>';
  }

  function scheduledCapabilityHtml(capability) {
    if (!capability) return '';
    if (capability.enabled) return '';
    var title = "Scheduling unavailable on this target";
    var detail = "This installation is running on Node. Routine definitions remain inspectable, but automatic scheduling is Cloudflare-only in this release.";
    var limits = state.scheduledLimits;
    var summary = limits ? '<p class="hint" style="margin:5px 0 0;">Minimum ' + Number(limits.minimumIntervalMinutes) +
      ' minutes · ' + Number(limits.concurrentDeploymentRuns) + ' concurrent runs · ' +
      Number(limits.scheduledStartsPerDay) + ' scheduled starts/day · ' + Number(limits.retentionDays) + '-day history.</p>' : '';
    var bounds = limits ? '<details class="scheduled-capability-limits"><summary>View all limits</summary><p class="hint">Hard bounds: ' +
      Number(limits.activeDeployment) + ' active per deployment · ' + Number(limits.activeChannel) + ' per channel · ' +
      Number(limits.scheduledStartsPerRoutinePerDay) + ' scheduled starts/routine/day · ' +
      Number(limits.scheduledStartsPerDay) + ' scheduled + ' + Number(limits.runNowStartsPerDay) + ' run-now starts/deployment/day · ' +
      Number(limits.totalStartsRollingDay) + ' total starts/rolling day · ' + Number(limits.concurrentDeploymentRuns) + ' concurrent runs · minimum ' + Number(limits.minimumIntervalMinutes) +
      ' minutes · ' + Number(limits.occurrenceDeadlineMinutes) + '-minute deadline · ' + Number(limits.retentionDays) + '-day run/audit retention.</p></details>' : '';
    return '<details class="scheduled-capability"><summary><span class="scheduled-capability-summary"><strong>Deployment-wide scheduling</strong><span class="hint">Availability and limits for every routine in this installation</span></span>' + scheduledStatusBadge(capability.enabled ? "enabled" : capability.reason) + '</summary>' +
      '<div class="scheduled-capability-copy"><strong>' + esc(title) + '</strong><p class="hint" style="margin:3px 0 0;">' + esc(detail) + '</p>' + summary + bounds + '</div></details>';
  }

  function scheduledFiltersHtml() {
    var filters = state.scheduledFilters;
    var selected = filters.channelId
      ? "channel|" + filters.workspaceId + "|" + filters.channelId
      : filters.workspaceId
        ? "workspace|" + filters.workspaceId
        : "";
    var workspaces = [];
    (state.channelIndex || []).forEach(function (channel) {
      var workspace = workspaces.find(function (candidate) { return candidate.id === channel.workspaceId; });
      if (!workspace) { workspace = { id: channel.workspaceId, channels: [] }; workspaces.push(workspace); }
      if (!workspace.channels.some(function (candidate) { return candidate.channelId === channel.channelId; })) {
        workspace.channels.push({
          workspaceId: channel.workspaceId,
          channelId: channel.channelId,
          channelLabel: channel.channelName || channel.channelId
        });
      }
    });
    if (filters.workspaceId && !workspaces.some(function (workspace) { return workspace.id === filters.workspaceId; })) {
      workspaces.push({ id: filters.workspaceId, channels: [] });
    }
    var options = '<option value=""' + (!selected ? ' selected' : '') + '>All</option>' + workspaces.map(function (workspace) {
      var workspaceValue = "workspace|" + workspace.id;
      var workspaceOption = '<option value="' + esc(workspaceValue) + '"' + (selected === workspaceValue ? ' selected' : '') + '>' + esc(railGroupLabel(workspace.id)) + ' · entire workspace</option>';
      var channelOptions = workspace.channels.map(function (assignment) {
        var value = "channel|" + workspace.id + "|" + assignment.channelId;
        return '<option value="' + esc(value) + '"' + (selected === value ? ' selected' : '') + '>Channel: ' + esc(channelLabel(assignment)) + ' · ' + esc(railGroupLabel(workspace.id)) + '</option>';
      }).join("");
      if (filters.channelId && filters.workspaceId === workspace.id && !workspace.channels.some(function (assignment) { return assignment.channelId === filters.channelId; })) {
        var fallbackValue = "channel|" + workspace.id + "|" + filters.channelId;
        channelOptions += '<option value="' + esc(fallbackValue) + '" selected>Channel: #' + esc(filters.channelId) + ' · ' + esc(railGroupLabel(workspace.id)) + '</option>';
      }
      return workspaceOption + channelOptions;
    }).join("");
    var selectedState = filters.state || "current";
    var stateOptions = [
      ["current", "Current"],
      ["active", "Active"],
      ["paused", "Paused"],
      ["completed", "Completed"],
      ["disabled", "Disabled"],
      ["all", "All"]
    ].map(function (option) {
      return '<option value="' + option[0] + '"' + (selectedState === option[0] ? ' selected' : '') + '>' + option[1] + '</option>';
    }).join("");
    return '<div class="scheduled-filters" aria-label="Scheduled work filters">' +
      '<label class="field"><span class="field-label">Status</span><span class="select-wrap"><select class="input" data-action="scheduled-filter-state">' + stateOptions + '</select><span class="select-caret">' + icon("chevron-down") + '</span></span></label>' +
      '<label class="field"><span class="field-label">Scope</span><span class="select-wrap"><select class="input" data-action="scheduled-filter-scope">' + options + '</select><span class="select-caret">' + icon("chevron-down") + '</span></span></label></div>';
  }

  function scheduledStateFilterLabel(value) {
    var labels = { current: "Current routines", active: "Active routines", paused: "Paused routines", completed: "Completed routines", disabled: "Disabled routines", all: "All routines" };
    return labels[value] || labels.current;
  }

  function scheduledRoutineName(routine) {
    var name = String(routine && routine.name || "").trim();
    return name || "Name unavailable";
  }

  function scheduledWorkMainHtml() {
    var head = '<div class="audit-main-head"><div><h1 class="page-title">Audit logs</h1><p class="hint scheduled-page-intro">View scheduled routines and keep track of all scheduled work.</p></div></div>' + auditTabsHtml();
    var capability = scheduledCapabilityHtml(state.scheduledCapability);
    if (state.scheduledLoading && !state.scheduledRoutines) return head + '<div class="empty"><p class="hint">Loading scheduled work&hellip;</p></div>' + capability;
    if (state.scheduledError && !state.scheduledRoutines) return head + '<div class="empty"><p class="field-error">' + esc(state.scheduledError) + '</p><button type="button" class="btn btn-ghost" data-action="scheduled-retry">Retry</button></div>' + capability;
    if (!state.scheduledInspector) return head + scheduledFiltersHtml() + scheduledRoutineListHtml(state.scheduledRoutines || []) + capability + scheduledLiveHtml();
    if (state.scheduledDetailLoading || !state.scheduledDetail) {
      return head + '<button type="button" class="btn btn-ghost btn-sm scheduled-detail-back" data-action="scheduled-back-summary">&larr; Back to routine summary</button>' +
        '<div class="empty"><p class="hint">Loading routine detail&hellip;</p></div>' + scheduledLiveHtml();
    }
    var detail = state.scheduledDetail;
    var routine = detail.routine;
    var detailHead = '<button type="button" class="btn btn-ghost btn-sm scheduled-detail-back" data-action="scheduled-back-summary">&larr; Back to routine summary</button>' +
      '<div class="scheduled-detail-head"><div><span class="section-eyebrow">Routine detail</span><h2 class="page-title" style="margin-top:4px;">' + esc(scheduledRoutineName(routine)) + '</h2><p class="hint">' + esc(scheduledChannelLabel(routine.workspaceId, routine.channelId)) + ' · ' + esc(routine.description || "No description available") + '</p></div>' + scheduledStatusBadge(routine.state) + '</div>' +
      scheduledDetailTabsHtml(detail);
    var tab = state.scheduledDetailTab;
    var content = tab === "runs"
      ? scheduledRunsHtml(detail.runs || [], routine)
      : tab === "activity"
        ? scheduledActivityHtml(detail)
        : scheduledOverviewHtml(detail);
    return head + detailHead + content + scheduledLiveHtml();
  }

  function scheduledRoutineListHtml(routines) {
    if (!routines.length) {
      return '<section aria-label="Scheduled work"><div class="scheduled-table-wrap"><table class="scheduled-table"><thead><tr><th>Name</th><th>Scope</th><th>Schedule</th><th>Status</th><th>Last run</th><th>Next run</th><th aria-label="Actions"></th></tr></thead><tbody><tr><td colspan="7" style="text-align:center; color:var(--text-3);">No scheduled work yet.</td></tr></tbody></table></div></section>';
    }
    var rows = routines.map(function (routine) {
      var routineName = scheduledRoutineName(routine);
      var nameUnavailable = routineName === "Name unavailable";
      var schedule = routine.triggerKind === "once"
        ? "One time" + (routine.nextRunAt ? " · " + formatScheduledDate(routine.nextRunAt, routine.timezone) : routine.lastScheduledAt ? " · " + formatScheduledDate(routine.lastScheduledAt, routine.timezone) : "")
        : formatScheduledSchedule(routine);
      var pauseAction = routine.state === "active"
        ? '<button type="button" class="btn btn-ghost btn-sm" role="menuitem" data-action="scheduled-list-control" data-control="pause" data-routine="' + esc(routine.id) + '">Pause</button>'
        : routine.state === "paused"
          ? '<button type="button" class="btn btn-ghost btn-sm" role="menuitem" data-action="scheduled-list-control" data-control="resume" data-routine="' + esc(routine.id) + '">Resume</button>'
          : '';
      return '<tr><td><button type="button" class="scheduled-name-button' + (nameUnavailable ? ' unavailable' : '') + '" data-action="select-scheduled-routine" data-routine="' + esc(routine.id) + '"' + (nameUnavailable ? ' title="The name is unavailable for this legacy routine."' : '') + '>' + esc(routineName) + '</button></td>' +
        '<td>Channel: ' + esc(scheduledChannelLabel(routine.workspaceId, routine.channelId)) + '</td>' +
        '<td>' + esc(schedule) + '</td>' +
        '<td><span class="scheduled-table-state ' + esc(routine.state) + '">' + esc(String(routine.state || "unknown").replace(/_/g, " ")) + '</span></td>' +
        '<td>' + esc(routine.lastFinishedAt ? formatScheduledDate(routine.lastFinishedAt, routine.timezone) : "Never") + '</td>' +
        '<td>' + esc(routine.nextRunAt ? formatScheduledDate(routine.nextRunAt, routine.timezone) : "—") + '</td>' +
        '<td><details class="scheduled-row-actions"><summary aria-label="Routine actions">&vellip;</summary><div class="scheduled-row-menu" role="menu">' +
        '<button type="button" class="btn btn-ghost btn-sm" role="menuitem" data-action="select-scheduled-routine" data-routine="' + esc(routine.id) + '">View details</button>' + pauseAction +
        (routine.state !== "deleted" ? '<button type="button" class="btn btn-danger btn-sm" role="menuitem" data-action="scheduled-list-delete" data-routine="' + esc(routine.id) + '">Delete</button>' : '') +
        '</div></details></td></tr>';
    }).join("");
    return '<section aria-label="Scheduled work"><div class="scheduled-table-wrap"><table class="scheduled-table"><thead><tr><th>Name</th><th>Scope</th><th>Schedule</th><th>Status</th><th>Last run</th><th>Next run</th><th aria-label="Actions"></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="scheduled-table-footer"><span>Showing 1&ndash;' + Number(routines.length) + ' of ' + Number(routines.length) + '</span><span>Page 1 of 1</span></div></section>';
  }

  function scheduledRoutineSummaryModalHtml() {
    if (!state.scheduledSelection || state.scheduledInspector || state.scheduledDeleteConfirm) return '';
    if (state.scheduledDetailLoading || !state.scheduledDetail) {
      return '<div class="modal-backdrop"><div class="modal-card scheduled-summary-modal" role="dialog" aria-modal="true" aria-label="Routine details"><div class="scheduled-summary-head"><div><h2 class="modal-title">Routine details</h2></div><button type="button" class="scheduled-summary-close" data-action="scheduled-summary-close" aria-label="Close">&times;</button></div><p class="hint">Loading routine details&hellip;</p></div></div>';
    }
    var routine = state.scheduledDetail.routine;
    return '<div class="modal-backdrop"><div class="modal-card scheduled-summary-modal" role="dialog" aria-modal="true" aria-labelledby="scheduled-summary-title">' +
      '<div class="scheduled-summary-head"><div><h2 class="modal-title" id="scheduled-summary-title">' + esc(scheduledRoutineName(routine)) + '</h2><p class="scheduled-summary-scope">Channel: ' + esc(scheduledChannelLabel(routine.workspaceId, routine.channelId)) + '</p></div><button type="button" class="scheduled-summary-close" data-action="scheduled-summary-close" aria-label="Close">&times;</button></div>' +
      '<div class="scheduled-summary-section"><span class="field-label">Prompt</span><p class="scheduled-summary-prompt">' + esc(routine.taskText == null ? "The task body was removed with this routine." : routine.taskText) + '</p></div>' +
      '<div class="scheduled-summary-section"><span class="field-label">Schedule</span><p class="scheduled-summary-prompt">' + esc(formatScheduledSchedule(routine)) + '</p></div>' +
      '<div class="scheduled-summary-grid">' +
      scheduledMeta("Status", String(routine.state || "unknown").replace(/_/g, " "), false) +
      scheduledMeta("Last run", routine.lastFinishedAt ? formatScheduledDate(routine.lastFinishedAt, routine.timezone) : "Never", false) +
      scheduledMeta("Next run", routine.nextRunAt ? formatScheduledDate(routine.nextRunAt, routine.timezone) : "—", false) +
      scheduledMeta("Created", formatScheduledDay(routine.createdAt, routine.timezone), false) + '</div>' +
      '<div class="scheduled-summary-foot"><button type="button" class="btn btn-ghost btn-sm" data-action="scheduled-open-inspector">View run history and activity</button><span class="spacer"></span><button type="button" class="btn btn-soft btn-sm" data-action="scheduled-summary-close">Close</button></div></div></div>';
  }

  function scheduledDetailTabsHtml(detail) {
    var runCount = (detail.runs || []).length;
    var activityCount = (detail.revisions || []).length + (detail.events || []).length;
    function tab(value, label, count) {
      var active = state.scheduledDetailTab === value;
      return '<button type="button" class="scheduled-detail-tab' + (active ? " active" : "") + '" role="tab" aria-selected="' + (active ? "true" : "false") + '" data-action="scheduled-detail-tab" data-tab="' + value + '">' + label + (count == null ? '' : ' <span class="scheduled-detail-count">' + Number(count) + '</span>') + '</button>';
    }
    return '<div class="scheduled-detail-tabs" role="tablist" aria-label="Routine detail sections">' + tab("overview", "Overview", null) + tab("runs", "Run history", runCount) + tab("activity", "Activity", activityCount) + '</div>';
  }

  function scheduledOverviewHtml(detail) {
    var routine = detail.routine;
    var currentRevision = (detail.revisions || []).find(function (revision) { return Number(revision.version) === Number(routine.version); });
    var provenance = currentRevision && currentRevision.provenance;
    var controls = '';
    if (routine.state === "active") controls += '<button type="button" class="btn btn-soft btn-sm" data-action="scheduled-control" data-control="pause">Pause</button>';
    if (routine.state === "paused") controls += '<button type="button" class="btn btn-primary btn-sm" data-action="scheduled-control" data-control="resume">Resume</button>';
    if (routine.state !== "disabled" && routine.state !== "completed" && routine.state !== "deleted") controls += '<button type="button" class="btn btn-soft btn-sm" data-action="scheduled-control" data-control="disable">Disable</button>';
    if (routine.state !== "deleted") controls += '<button type="button" class="btn btn-danger btn-sm" data-action="scheduled-delete-open">Delete</button>';
    return '<section class="scheduled-card scheduled-definition"><div class="memory-editor-head"><div><h3 class="section-title">Schedule and task</h3><p class="hint">The saved definition for this routine.</p></div></div>' +
      '<div class="scheduled-meta">' +
      scheduledMeta(routine.triggerKind === "once" ? "Scheduled for" : "Schedule", formatScheduledSchedule(routine), false) + scheduledMeta("Timezone", routine.timezone, false) +
      scheduledMeta("Next run", formatScheduledDate(routine.nextRunAt, routine.timezone), false) + scheduledMeta("Last finished", formatScheduledDate(routine.lastFinishedAt, routine.timezone), false) +
      scheduledMeta("Output", routine.outputPolicy, false) + scheduledMeta("Daily starts", Number(routine.projectedDailyStarts || 0), false) + '</div>' +
      '<div class="scheduled-definition-grid"><div class="scheduled-definition-panel"><span class="field-label">Saved task</span>' +
      (routine.taskText == null ? '<p class="hint">The task body was removed with this routine.</p>' : '<div class="scheduled-task">' + esc(routine.taskText) + '</div>') + '</div>' +
      '<div class="scheduled-definition-panel"><span class="field-label">Source Slack request</span>' +
      (provenance && provenance.requestText ? '<div class="scheduled-task">' + esc(provenance.requestText) + '</div>' : '<p class="hint">Source request was not retained for this legacy revision.</p>') + '</div></div>' +
      '<details class="scheduled-technical"><summary>Access and technical details</summary><div class="memory-banner" style="margin-top:10px;"><strong>Authority</strong><br>' + esc(scheduledAuthorityCopy(routine)) + '</div><div class="scheduled-meta">' +
      scheduledMeta("Routine ID", routine.id, true) + scheduledMeta("Version", "v" + Number(routine.version), true) +
      scheduledMeta("Workspace", routine.workspaceId, true) + scheduledMeta("Channel", scheduledChannelLabel(routine.workspaceId, routine.channelId) + " (" + routine.channelId + ")", false) +
      scheduledMeta("Creator", routine.creatorUserId, true) + scheduledMeta("Trigger", routine.triggerKind, false) +
      (routine.triggerKind === "once" ? '' : scheduledMeta("Cron", routine.scheduleInput, true)) +
      (provenance && provenance.sourceRoutineId ? scheduledMeta("Cloned from", provenance.sourceRoutineId + (provenance.sourceRoutineVersion ? " · v" + Number(provenance.sourceRoutineVersion) : ""), true) : '') +
      (provenance ? scheduledMeta("Slack event", provenance.eventId || "—", true) + scheduledMeta("Request hash", provenance.requestHash || "—", true) : '') + '</div></details>' +
      '<div class="scheduled-actions">' + controls.replace(/<button /g, '<button ' + (state.scheduledBusy ? 'disabled ' : '')) + '</div></section>';
  }

  function scheduledActivityHtml(detail) {
    return '<div class="scheduled-activity-intro"><h3 class="section-title">History for this routine</h3><p class="hint">Definition revisions and audit events below belong only to ' + esc(scheduledRoutineName(detail.routine)) + '.</p></div>' +
      scheduledRevisionsHtml(detail.revisions || []) + scheduledEventsHtml(detail.events || []);
  }

  function scheduledMeta(label, value, mono) {
    return '<div class="scheduled-meta-item"><span class="field-label">' + esc(label) + '</span><span' + (mono ? ' class="mono"' : '') + '>' + esc(value == null ? "—" : value) + '</span></div>';
  }

  function scheduledAuthorityCopy(routine) {
    if (routine.authorityMode === "live_channel_v1") {
      return "Each occurrence re-resolves current Channel membership, Agent, connectors, credentials, repository grants, and policy. It has the same authority as a live @mention in the owning Channel; saved or fetched content cannot widen that authority.";
    }
    return "Authority mode: " + String(routine.authorityMode || "unknown") + ". Access is resolved again when each occurrence starts.";
  }

  function scheduledRevisionsHtml(revisions) {
    return '<section class="scheduled-card"><h2 class="section-title">Revision history</h2>' + (!revisions.length ? '<p class="hint">No revisions retained.</p>' : '<div class="scheduled-revisions">' + revisions.slice().reverse().map(function (revision) {
      var operation = revision.definition ? "definition saved" : "content removed";
      return '<div class="scheduled-revision"><span class="mono">v' + Number(revision.version) + '</span><strong>' + esc(operation) + '</strong><span class="spacer"></span><span class="hint">' + esc(formatScheduledDate(revision.createdAt)) + ' · ' + esc(revision.actorClass || "system") + '</span></div>';
    }).join("") + '</div>') + '</section>';
  }

  function scheduledRunsHtml(runs, routine) {
    var body = !runs.length ? '<p class="hint">No occurrences have been admitted yet.</p>' : runs.map(function (run) {
      var tokens = [run.inputTokens, run.outputTokens].some(function (value) { return value != null; })
        ? String(Number(run.inputTokens || 0) + Number(run.outputTokens || 0)) + " input + output tokens"
        : "Usage unavailable";
      var delivery = run.suppressedAsNoOp ? "No post (no-op)" : String(run.deliveryStatus || "none").replace(/_/g, " ");
      var receipt = scheduledDeliveryLink(run, routine);
      return '<article class="scheduled-run"><div class="scheduled-run-head"><strong>' + esc(formatScheduledDate(run.scheduledFor, routine.timezone)) + '</strong><span class="spacer"></span>' + scheduledStatusBadge(run.status) + '</div>' +
        (run.publicError ? '<p class="field-error" style="margin:0;">' + esc(run.publicError) + '</p>' : '') +
        '<div class="scheduled-run-grid">' +
        scheduledRunMeta("Trigger", run.triggerSource || "scheduled", false) +
        scheduledRunMeta("Started", formatScheduledDate(run.startedAt, routine.timezone), false) +
        scheduledRunMeta("Finished", formatScheduledDate(run.finishedAt, routine.timezone), false) +
        scheduledRunMeta("Model", run.model || "unresolved", false) +
        scheduledRunMeta("Usage", tokens, false) +
        scheduledRunMeta("Tools", Number(run.toolCallCount || 0), false) +
        scheduledRunMeta("Cost", formatScheduledCost(run), false) +
        scheduledRunMeta("Delivery", delivery, false, esc(delivery) + (receipt ? ' · ' + receipt : '')) + '</div>' +
        '<details class="scheduled-run-tech scheduled-technical"><summary>Technical details</summary><div class="scheduled-run-grid">' +
        scheduledRunMeta("Run ID", run.id, true) + scheduledRunMeta("Access hash", run.resolvedAccessHash || "unresolved", true) +
        scheduledRunMeta("Flue run", run.flueRunId || "not admitted", true) + scheduledRunMeta("Trace", run.traceId || "unavailable", true) +
        '</div></details></article>';
    }).join("");
    return '<section class="scheduled-card"><div class="memory-editor-head"><div><h3 class="section-title">Run history for this routine</h3><p class="hint">Each row is one triggered execution of ' + esc(scheduledRoutineName(routine)) + '.</p></div><span class="badge badge-off">' + Number(runs.length) + '</span></div>' + body + '</section>';
  }

  function scheduledRunMeta(label, value, mono, htmlValue) {
    return '<div class="scheduled-run-item"><span class="field-label">' + esc(label) + '</span><span class="scheduled-run-value' + (mono ? ' mono' : '') + '">' +
      (htmlValue || esc(value == null ? "—" : value)) + '</span></div>';
  }

  function scheduledDeliveryLink(run, routine) {
    var channel = String(run.deliveryChannelId || routine.channelId || "");
    var timestamp = String(run.deliveryMessageTs || "");
    if (!/^[A-Z0-9]+$/.test(channel) || !/^\\d+\\.\\d+$/.test(timestamp)) return '';
    var href = "https://slack.com/archives/" + encodeURIComponent(channel) + "/p" + timestamp.replace(".", "");
    return '<a class="hint-link" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">Open message</a>';
  }

  function formatScheduledCost(run) {
    if (run.costEstimate == null) return "unavailable";
    return Number(run.costEstimate).toFixed(6) + (run.costUnit ? " " + run.costUnit : "");
  }

  function scheduledEventsHtml(events) {
    return '<section class="scheduled-card"><h2 class="section-title">Audit trail</h2>' + (!events.length ? '<p class="hint">No retained events.</p>' : '<div class="scheduled-revisions">' + events.map(function (event) {
      return '<div class="scheduled-revision"><strong>' + esc(String(event.eventType || "event").replace(/_/g, " ")) + '</strong><span>' + scheduledStatusBadge(event.outcome) + '</span><span class="spacer"></span><span class="hint">' + esc(formatScheduledDate(event.createdAt)) + ' · ' + esc(event.actorClass || "system") + '</span></div>';
    }).join("") + '</div>') + '</section>';
  }

  function scheduledLiveHtml() {
    return '<div class="scheduled-live" role="status" aria-live="polite">' + esc(state.scheduledNotice || state.scheduledError) + '</div>';
  }

  function formatScheduledDate(value, timezone) {
    if (value == null) return "—";
    var date = new Date(Number(value));
    if (!Number.isFinite(date.getTime())) return "Unknown time";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: timezone || undefined,
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
        timeZoneName: timezone ? "short" : undefined,
      }).format(date).replace(/, (?=\\d{1,2}:\\d{2})/, " at ");
    } catch (_error) {
      return date.toLocaleString();
    }
  }

  function formatScheduledDay(value, timezone) {
    if (value == null) return "—";
    var date = new Date(Number(value));
    if (!Number.isFinite(date.getTime())) return "Unknown date";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: timezone || undefined,
        month: "short", day: "numeric", year: "numeric",
      }).format(date);
    } catch (_error) {
      return date.toLocaleDateString();
    }
  }

  function formatScheduledSchedule(routine) {
    if (routine.triggerKind === "once") return "One time · " + formatScheduledDate(routine.nextRunAt == null ? routine.lastScheduledAt : routine.nextRunAt, routine.timezone);
    var parts = String(routine.scheduleInput || "").trim().split(/\\s+/);
    if (parts.length !== 5) return String(routine.scheduleInput || "—");
    var minute = parts[0], hour = parts[1], dayOfMonth = parts[2], month = parts[3], dayOfWeek = parts[4];
    var zone = scheduledTimezoneLabel(routine.timezone);
    var step = /^\\*\\/(\\d+)$/.exec(minute);
    if (step && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      return "Every " + Number(step[1]) + " minutes · " + zone;
    }
    if (/^\\d+$/.test(minute) && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      return Number(minute) === 0 ? "Every hour · " + zone : "Hourly at :" + String(minute).padStart(2, "0") + " · " + zone;
    }
    if (/^\\d+$/.test(minute) && /^\\d+$/.test(hour) && dayOfMonth === "*" && month === "*") {
      var clockHour = Number(hour), suffix = clockHour >= 12 ? "PM" : "AM";
      var clock = (clockHour % 12 || 12) + ":" + String(minute).padStart(2, "0") + " " + suffix;
      if (dayOfWeek === "*") return "Every day at " + clock + " " + zone;
      if (dayOfWeek === "1-5" || dayOfWeek === "MON-FRI") return "Weekdays at " + clock + " " + zone;
      var weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      if (/^[0-6]$/.test(dayOfWeek)) return "Every " + weekdays[Number(dayOfWeek)] + " at " + clock + " " + zone;
    }
    return String(routine.scheduleInput || "—");
  }

  function scheduledTimezoneLabel(timezone) {
    return ({
      "America/Los_Angeles": "Pacific",
      "America/Denver": "Mountain",
      "America/Chicago": "Central",
      "America/New_York": "Eastern",
      "UTC": "UTC",
    })[timezone] || String(timezone || "UTC");
  }

  function scheduledDeleteModalHtml() {
    if (!state.scheduledDeleteConfirm || !state.scheduledDetail) return '';
    var routine = state.scheduledDetail.routine;
    return '<div class="modal-backdrop"><div class="modal-card" role="dialog" aria-modal="true" aria-label="Delete routine">' +
      '<h2 class="modal-title">Delete ' + esc(routine.name) + '?</h2>' +
      '<p class="modal-body">This permanently removes the saved task from the routine and its retained revisions, disables future occurrences, and keeps only body-free audit metadata and run records. Existing Slack messages, provider logs, backups, and Flue transcripts may still retain prior content; Chickpea cannot retract them.</p>' +
      '<div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="scheduled-delete-cancel">Cancel</button><span class="spacer"></span><button type="button" class="btn btn-danger" data-action="scheduled-delete-confirm"' + (state.scheduledBusy ? " disabled" : "") + '>Delete permanently</button></div></div></div>';
  }

  function openScheduledWork(routineId) {
    state.view = "audit";
    state.profileScreen = "list";
    state.auditDomain = "scheduled-work";
    state.scheduledSelection = routineId || "";
    state.scheduledDetail = null;
    state.scheduledInspector = false;
    state.scheduledDetailTab = "overview";
    state.scheduledError = "";
    state.scheduledNotice = "";
    render();
    loadScheduledRoutines();
  }

  function openChannelScheduledWork(workspaceId, channelId) {
    state.scheduledFilters = {
      workspaceId: workspaceId || "",
      channelId: channelId || "",
      state: "current"
    };
    state.scheduledRoutines = null;
    openScheduledWork("");
  }

  function loadChannelScheduledRoutines(workspaceId, channelId) {
    var key = workspaceId + ":" + channelId;
    state.channelScheduledKey = key;
    state.channelScheduledRoutines = null;
    state.channelScheduledLoading = true;
    state.channelScheduledError = "";
    var path = "/admin/api/audit/scheduled_work/routines?workspaceId=" + encodeURIComponent(workspaceId) +
      "&channelId=" + encodeURIComponent(channelId) + "&limit=20";
    return api(path).then(function (body) {
      if (state.channelScheduledKey !== key) return;
      state.channelScheduledRoutines = body.routines || [];
      state.channelScheduledLoading = false;
      render();
    }).catch(function (error) {
      if (state.channelScheduledKey !== key) return;
      state.channelScheduledLoading = false;
      state.channelScheduledError = error.serverMessage || error.message || "Could not load scheduled work.";
      render();
    });
  }

  function scheduledListPath() {
    var query = new URLSearchParams();
    var filters = state.scheduledFilters;
    if (filters.workspaceId) query.set("workspaceId", filters.workspaceId.trim());
    if (filters.channelId) query.set("channelId", filters.channelId.trim());
    if (filters.state) query.set("state", filters.state);
    var encoded = query.toString();
    return "/admin/api/audit/scheduled_work/routines" + (encoded ? "?" + encoded : "");
  }

  function loadScheduledRoutines() {
    if (state.scheduledLoading) return Promise.resolve();
    state.scheduledLoading = true;
    state.scheduledError = "";
    render();
    return api(scheduledListPath()).then(function (body) {
      state.scheduledRoutines = body.routines || [];
      state.scheduledCapability = body.capability || null;
      state.scheduledLimits = body.limits || null;
      state.scheduledLoading = false;
      render();
      if (state.scheduledSelection) return loadScheduledDetail(state.scheduledSelection);
    }).catch(function (error) {
      state.scheduledLoading = false;
      state.scheduledError = error.serverMessage || error.message || "Could not load scheduled work.";
      render();
    });
  }

  function selectScheduledRoutine(routineId) {
    if (!routineId || state.scheduledBusy) return Promise.resolve();
    state.scheduledSelection = routineId;
    state.scheduledDetail = null;
    state.scheduledInspector = false;
    state.scheduledDetailTab = "overview";
    state.scheduledNotice = "";
    state.scheduledError = "";
    render();
    return loadScheduledDetail(routineId);
  }

  function closeScheduledSummary() {
    state.scheduledSelection = "";
    state.scheduledDetail = null;
    state.scheduledInspector = false;
    state.scheduledDetailTab = "overview";
    state.scheduledNotice = "";
    state.scheduledError = "";
    render();
  }

  function controlScheduledRoutineFromList(routineId, action) {
    if (state.scheduledBusy || !["pause", "resume"].includes(action)) return;
    var routine = (state.scheduledRoutines || []).find(function (candidate) { return candidate.id === routineId; });
    if (!routine) return;
    state.scheduledBusy = action;
    state.scheduledError = "";
    state.scheduledNotice = "";
    render();
    api("/admin/api/audit/scheduled_work/routines/" + encodeURIComponent(routine.id) + "/control", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": scheduledMutationKey(action) },
      body: JSON.stringify({ action: action, expectedVersion: Number(routine.version) })
    }).then(function () {
      state.scheduledBusy = "";
      state.scheduledNotice = "Routine " + action + (action.endsWith("e") ? "d" : "ed") + ".";
      state.scheduledRoutines = null;
      render();
      return loadScheduledRoutines();
    }).catch(function (error) {
      state.scheduledBusy = "";
      state.scheduledError = error.status === 409
        ? "This routine changed in another session. The list has been refreshed."
        : error.serverMessage || error.message || "Could not update this routine.";
      state.scheduledRoutines = null;
      render();
      return loadScheduledRoutines();
    });
  }

  function openScheduledDeleteFromList(routineId) {
    if (!routineId || state.scheduledBusy) return;
    selectScheduledRoutine(routineId).then(function () {
      if (state.scheduledSelection !== routineId || !state.scheduledDetail) return;
      state.scheduledDeleteConfirm = true;
      render();
    });
  }

  function loadScheduledDetail(routineId) {
    if (!routineId) return Promise.resolve();
    state.scheduledDetailLoading = true;
    state.scheduledError = "";
    render();
    return api("/admin/api/audit/scheduled_work/routines/" + encodeURIComponent(routineId)).then(function (body) {
      if (state.scheduledSelection !== routineId) return;
      state.scheduledDetail = body;
      state.scheduledCapability = body.capability || state.scheduledCapability;
      state.scheduledLimits = body.limits || state.scheduledLimits;
      state.scheduledDetailLoading = false;
      render();
    }).catch(function (error) {
      if (state.scheduledSelection !== routineId) return;
      state.scheduledDetailLoading = false;
      state.scheduledError = error.serverMessage || error.message || "Could not load this routine.";
      render();
    });
  }

  function scheduledMutationKey(action) {
    return "admin-ui:routine:" + action + ":" + Date.now() + ":" + Math.random().toString(36).slice(2);
  }

  function controlScheduledRoutine(action) {
    if (!state.scheduledDetail || state.scheduledBusy) return;
    var routine = state.scheduledDetail.routine;
    state.scheduledBusy = action;
    state.scheduledError = "";
    state.scheduledNotice = "";
    render();
    api("/admin/api/audit/scheduled_work/routines/" + encodeURIComponent(routine.id) + "/control", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": scheduledMutationKey(action) },
      body: JSON.stringify({
        action: action,
        expectedVersion: Number(routine.version),
        ...(action === "delete" ? { acknowledgeIrreversible: true } : {})
      })
    }).then(function (body) {
      state.scheduledBusy = "";
      state.scheduledDeleteConfirm = false;
      if (action === "delete") {
        state.scheduledSelection = "";
        state.scheduledDetail = null;
        state.scheduledInspector = false;
        state.scheduledNotice = "Routine deleted. The saved task was irreversibly removed.";
      } else {
        state.scheduledNotice = "Routine " + action + (action.endsWith("e") ? "d" : "ed") + ".";
        if (state.scheduledDetail) state.scheduledDetail.routine = body.routine;
      }
      state.scheduledRoutines = null;
      render();
      return loadScheduledRoutines();
    }).catch(function (error) {
      state.scheduledBusy = "";
      state.scheduledError = error.status === 409
        ? "This routine changed in another session. Reloaded the latest version; review it before trying again."
        : error.serverMessage || error.message || "Could not update this routine.";
      state.scheduledDeleteConfirm = false;
      render();
      if (error.status === 409) return loadScheduledDetail(routine.id);
    });
  }

  function loadOwnerMemory(ownerKind, workspaceId, ownerId, keepSelection) {
    workspaceId = workspaceId || "workspace";
    if (!ownerKind || !ownerId) return Promise.resolve();
    var memory = state.ownerMemory;
    var sameOwner = ownerMemoryMatches(ownerKind, workspaceId, ownerId);
    if (sameOwner && memory.dirty) return Promise.resolve();
    var requestId = memory.requestId + 1;
    state.ownerMemory = {
      ownerKind: ownerKind,
      workspaceId: workspaceId,
      ownerId: ownerId,
      detail: null,
      draft: null,
      dirty: false,
      loading: true,
      busy: "load",
      error: "",
      notice: sameOwner && keepSelection ? memory.notice : "",
      conflict: null,
      requestId: requestId
    };
    render();
    return api("/admin/api/agents/" + encodeURIComponent(ownerId) + "/memory", { cache: "no-store" }).then(function (body) {
      var current = state.ownerMemory;
      if (current.requestId !== requestId || !ownerMemoryMatches(ownerKind, workspaceId, ownerId)) return;
      var saved = body.memory || { agentId: ownerId, body: "", revision: 0 };
      var entry = {
        entryId: "memory",
        description: "Current Agent memory",
        type: "project",
        body: saved.body || "",
        version: Number(saved.revision || 0),
        status: "active"
      };
      current.detail = { entry: entry };
      current.draft = { description: entry.description, type: entry.type, body: entry.body };
      current.loading = false;
      current.busy = "";
      render();
    }).catch(function (error) {
      var current = state.ownerMemory;
      if (current.requestId !== requestId || !ownerMemoryMatches(ownerKind, workspaceId, ownerId)) return;
      current.loading = false;
      current.busy = "";
      current.error = error.serverMessage || error.message || "Could not load memory.";
      render();
    });
  }

  function markOwnerMemoryDirty() {
    var memory = state.ownerMemory;
    memory.dirty = true;
    memory.error = "";
    memory.notice = "";
    memory.conflict = null;
    var save = document.querySelector('[data-action="owner-memory-save"]');
    var discard = document.querySelector('[data-action="owner-memory-discard"]');
    if (save) save.disabled = false;
    if (discard) discard.disabled = false;
  }

  function saveOwnerMemoryEntry() {
    var memory = state.ownerMemory;
    if (!memory.draft || !memory.dirty || memory.busy) return;
    if (!memory.detail) return;
    var entry = memory.detail.entry;
    var ownerKey = memory.ownerKind + ":" + memory.workspaceId + ":" + memory.ownerId;
    memory.busy = "save";
    memory.error = "";
    memory.notice = "";
    render();
    return api("/admin/api/agents/" + encodeURIComponent(memory.ownerId) + "/memory", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: entry.version, body: memory.draft.body })
    }).then(function (body) {
      var current = state.ownerMemory;
      if (ownerKey !== current.ownerKind + ":" + current.workspaceId + ":" + current.ownerId) return;
      var saved = body.memory;
      current.detail = { entry: { entryId: "memory", description: "Current Agent memory", type: "project", body: saved.body || "", version: saved.revision, status: "active" } };
      current.draft = { description: "Current Agent memory", type: "project", body: saved.body || "" };
      current.dirty = false;
      current.busy = "";
      current.notice = "Memory saved.";
      render();
    }).catch(function (error) {
      var current = state.ownerMemory;
      if (ownerKey !== current.ownerKind + ":" + current.workspaceId + ":" + current.ownerId) return;
      current.busy = "";
      if (error.payload && error.payload.error === "memory_version_conflict") {
        current.error = "This memory changed elsewhere. Your draft is preserved.";
        current.conflict = { currentVersion: error.payload.currentVersion };
      } else {
        current.error = error.serverMessage || error.message || "Could not save memory.";
      }
      render();
    });
  }

  function discardOwnerMemoryDraft() {
    var memory = state.ownerMemory;
    var entry = memory.detail ? memory.detail.entry : null;
    memory.draft = {
      description: entry ? entry.description || "Current Agent memory" : "Current Agent memory",
      type: entry ? entry.type || "project" : "project",
      body: entry ? entry.body || "" : ""
    };
    memory.dirty = false;
    memory.error = "";
    memory.notice = "Draft discarded.";
    memory.conflict = null;
    render();
  }

  function openAuditLogs(storeId, channelId, entryId) {
    openScheduledWork("");
  }

  var STAR_PATH = "M8 1.75a.75.75 0 0 1 .692.462l1.41 3.393 3.664.293a.75.75 0 0 1 .428 1.317l-2.791 2.39.853 3.575a.75.75 0 0 1-1.117.812L8 11.799l-3.139 1.905a.75.75 0 0 1-1.117-.812l.853-3.575-2.791-2.39a.75.75 0 0 1 .428-1.317l3.664-.293 1.41-3.393A.75.75 0 0 1 8 1.75Z";

  function starIcon(on) {
    if (on) {
      return '<svg class="ic" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="' + STAR_PATH + '"/></svg>';
    }
    return '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="' + STAR_PATH + '"/></svg>';
  }

  function isFavoriteProvider(id) { return id === "openrouter" || id === "workers-ai"; }
  function favoritesFor(id) { return state.favorites[id] || []; }
  function provUiFor(id) { return state.provUi[id] || (state.provUi[id] = {}); }
  function favUiFor(id) { return state.favUi[id] || (state.favUi[id] = {}); }

  function providerSummaryById(id) {
    var list = (state.settings && state.settings.providers) || [];
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) return list[i]; }
    return { id: id, status: "missing", modelCount: null };
  }

  function providerMeta(id) {
    if (id === "anthropic") return { name: "Anthropic", sub: "Claude models", frag: "anthropic/*", suffix: "", env: "ANTHROPIC_API_KEY" };
    if (id === "openai") return { name: "OpenAI", sub: "GPT models", frag: "openai/*", suffix: "", env: "OPENAI_API_KEY" };
    if (id === "openrouter") return { name: "OpenRouter", sub: "Any model", frag: "openrouter/*", suffix: "", env: "OPENROUTER_API_KEY" };
    if (id === "workers-ai") return { name: "Workers AI", sub: "Cloudflare models", frag: "cloudflare/*", suffix: " via the Workers AI binding", env: "" };
    return { name: id, sub: "Custom provider", frag: id + "/*", suffix: "", env: "" };
  }

  // Mirrors the server's modelBelongsToProvider so the remove-key confirmation
  // names the exact profiles that lose their provider (cards 14 State 3).
  function modelBelongsToProvider(model, provider) {
    if (!model) return false;
    if (provider === "workers-ai") return model.indexOf("cloudflare/") === 0 || model.indexOf("cloudflare-workers-ai/") === 0;
    return model.indexOf(provider + "/") === 0;
  }

  function pinnedProfilesForProvider(id) {
    return state.agents.filter(function (agent) { return modelBelongsToProvider(agent.model, id); });
  }

  function providerModelCount(id, summary) {
    var loaded = state.providerModels[id];
    if (loaded && loaded.length != null) return loaded.length;
    return summary && summary.modelCount != null ? summary.modelCount : null;
  }

  function githubErrorHtml() {
    return state.githubError
      ? '<p class="field-error" role="alert">' + esc(state.githubError) + '</p>'
      : "";
  }

  function githubManifestFormHtml() {
    if (!state.githubManifestOpen) return "";
    var busy = state.githubBusy === "manifest";
    return '<div class="prov-body"><form data-action="github-manifest-form" style="display:flex; flex-direction:column; gap:12px;">' +
      '<div class="field"><label class="field-label" for="github-org">GitHub organization <span class="hint">(optional)</span></label>' +
      '<input id="github-org" class="input mono" name="org" type="text" autocomplete="organization" placeholder="your-org" value="' + esc(state.githubOrg) + '" data-action="github-org-input"' + (busy ? " disabled" : "") + '>' +
      '<p class="hint">Leave blank to create the app under your personal GitHub account.</p></div>' +
      githubErrorHtml() +
      '<div class="prov-actions" style="margin-left:0;"><button type="button" class="btn btn-ghost btn-sm" data-action="github-manifest-cancel"' + (busy ? " disabled" : "") + '>Cancel</button>' +
      (busy
        ? '<button type="submit" class="btn btn-primary btn-sm" disabled><span class="spinner"></span>Preparing GitHub&hellip;</button>'
        : '<button type="submit" class="btn btn-primary btn-sm">Continue to GitHub &nearr;</button>') + '</div></form></div>';
  }

  function githubDisconnectPanelHtml() {
    return '<div class="danger-panel"><div class="danger-copy"><span class="danger-title">Disconnect GitHub</span>' +
      '<span class="hint">Removes stored GitHub App credentials from Chickpea. Environment-configured App credentials stay active, and repository selections on Agents stay saved.</span></div>' +
      '<button type="button" class="btn btn-danger" data-action="github-disconnect-open"' + (state.githubBusy ? " disabled" : "") + '>Disconnect</button></div>';
  }

  function githubNoneHtml() {
    var manifestBody = githubManifestFormHtml();
    return '<div class="prov-row"><div class="prov-head"><div class="prov-id"><span class="prov-name">GitHub App</span>' +
      '<span class="prov-sub">Required for repository access and the coding sandbox &middot; scoped installations and short-lived tokens</span></div>' +
      '<div class="prov-actions"><button type="button" class="btn btn-primary btn-sm" data-action="github-manifest-open"' + (state.githubBusy ? " disabled" : "") + '>Create GitHub App</button></div></div>' + manifestBody + '</div>';
  }

  function githubAppHtml(status) {
    var installations = status.installations || [];
    var installationRows = installations.map(function (installation) {
      var repoCount = installation.repoCount == null ? null : Number(installation.repoCount);
      var repoLabel = repoCount == null ? "Repository count unavailable" : repoCount + " repositor" + (repoCount === 1 ? "y" : "ies");
      return '<div class="prov-row"><div class="prov-head"><div class="github-installation-copy">' +
        '<span class="github-installation-name">' + esc(installation.accountLogin) + '</span>' +
        '<span class="github-installation-meta"><span class="badge badge-off">' + esc(installation.accountType) + '</span><span class="hint">' + esc(repoLabel) + '</span></span></div>' +
        '<span class="badge badge-on"><span class="dot"></span>Connected</span></div></div>';
    }).join("");
    var slug = status.appSlug || "";
    var none = !installations.length;
    // With zero installations the install step IS the next action, so the
    // button leads (primary) and drops the confusing "another".
    var installAction = slug
      ? '<a class="btn ' + (none ? "btn-primary" : "btn-soft") + ' btn-sm" href="https://github.com/apps/' + esc(encodeURIComponent(slug)) + '/installations/new" target="_blank" rel="noopener noreferrer">' + (none ? "Add repository access" : "Install on another account") + ' &nearr;</a>'
      : '<span class="hint">The app slug is unavailable, so the install page cannot be opened from here.</span>';
    return '<div class="well"><div class="kv"><dt>App slug</dt><dd>' + (slug ? '<span class="mono">' + esc(slug) + '</span>' : '<span class="hint">Unavailable</span>') + '</dd></div>' +
      '<div class="kv"><dt>Accounts with access</dt><dd>' + installations.length + '</dd></div>' +
      '<p class="hint" style="margin:6px 0 0;">The app is registered on GitHub. To let it reach any repositories, add it to your GitHub account or an org and choose which repos it can use &mdash; each account you add shows up below.</p></div>' +
      (installations.length
        ? '<div class="github-installations">' + installationRows + '</div>'
        : status.installationsUnavailable
          ? '<div class="empty"><p class="field-error" role="alert">GitHub rejected the stored App credentials, so accounts cannot be listed.</p><p class="hint">Refresh to retry, or disconnect below and set the app up again.</p></div>'
          : '<div class="empty"><p class="field-label">No repository access yet</p><p class="hint">Add the app to your GitHub account or an organization and pick the repos it can use, then refresh.</p></div>') +
      '<div class="action-well">' + installAction +
      '<button type="button" class="btn btn-ghost btn-sm i-lead" data-action="github-refresh"' + (state.githubBusy ? " disabled" : "") + '>' + (state.githubBusy === "refresh" ? '<span class="spinner"></span>Refreshing&hellip;' : icon("arrow-path") + 'Refresh') + '</button>' +
      (state.githubError ? '<span class="inline-status error" role="alert">' + esc(state.githubError) + '</span>' : "") + '</div>' +
      githubDisconnectPanelHtml();
  }

  function githubSectionHtml() {
    var status = state.githubStatus;
    var badge = status && status.mode === "app"
      ? '<span class="badge badge-on"><span class="dot"></span>Connected</span>'
      : '<span class="badge badge-off"><span class="dot"></span>Not connected</span>';
    var head = '<div class="section-head"><div><h2 class="section-title">GitHub</h2>' +
      '<p class="hint">Connect GitHub once, then grant repository access per Agent.</p></div>' + badge + '</div>';
    if (!state.githubStatusLoaded) {
      return '<section class="section" id="github-settings">' + head + '<p class="hint">Loading GitHub settings&hellip;</p></section>';
    }
    if (!status) {
      return '<section class="section" id="github-settings">' + head + githubErrorHtml() +
        '<div><button type="button" class="btn btn-soft btn-sm i-lead" data-action="github-refresh">' + icon("arrow-path") + 'Retry</button></div></section>';
    }
    var body;
    if (status.mode === "app") body = githubAppHtml(status);
    else body = githubNoneHtml();
    return '<section class="section" id="github-settings">' + head + body + '</section>';
  }

  function sandboxSectionHtml() {
    var status = state.sandboxStatus;
    var badge = '<span class="badge badge-off">Unavailable</span>';
    if (status) {
      if (status.target === "node") badge = '<span class="badge badge-off">Unsupported on Node</span>';
      else if (!status.installed && status.installRequested) badge = '<span class="badge badge-off">Redeploy required</span>';
      else if (!status.installed && status.storedEnabled) badge = '<span class="badge badge-off">Not installed; saved On state</span>';
      else if (!status.installed) badge = '<span class="badge badge-off">Not installed in this deployment</span>';
      else if (status.storedEnabled && (!status.githubConnected || !status.repositoryGrantReady)) badge = '<span class="badge badge-off">On, setup required</span>';
      else if (status.storedEnabled) badge = '<span class="badge badge-on"><span class="dot"></span>On</span>';
      else badge = '<span class="badge badge-off">Installed but off</span>';
    }
    var head = '<div class="section-head"><div><h2 class="section-title">Coding sandbox</h2>' +
      '<p class="hint">An optional Cloudflare Container for repository-backed coding tasks. Ordinary Chickpea and Slack replies do not need it.</p></div>' + badge + '</div>';
    if (!state.sandboxLoaded) {
      return '<section class="section" id="sandbox-settings">' + head + '<p class="hint">Loading sandbox settings&hellip;</p></section>';
    }
    if (!status) {
      return '<section class="section" id="sandbox-settings">' + head +
        '<p class="field-error" role="alert">' + esc(state.sandboxError || "Could not load sandbox settings.") + '</p>' +
        '<div><button type="button" class="btn btn-soft btn-sm i-lead" data-action="sandbox-refresh">' + icon("arrow-path") + 'Retry</button></div></section>';
    }
    var disabled = state.sandboxSaving ? " disabled" : "";
    var paidNote = status.workersPaidNote
      ? '<p class="hint">' + esc(status.workersPaidNote) + '</p>'
      : "";
    var live = state.sandboxError
      ? '<p class="field-error" role="alert" aria-live="assertive">' + esc(state.sandboxError) + '</p>'
      : state.sandboxNotice
        ? '<p class="inline-status ok" role="status" aria-live="polite">' + esc(state.sandboxNotice) + '</p>'
        : '';
    var progressLabels = {
      cancel: "Canceling the installation request.",
      check: "Checking the live deployment.",
      disable: "Disabling the coding sandbox.",
      advanced: "Saving advanced Sandbox settings."
    };
    var progress = state.sandboxSaving && progressLabels[state.sandboxSaving]
      ? '<p class="sr-only" role="status" aria-live="polite">' + progressLabels[state.sandboxSaving] + '</p>'
      : '';
    if (status.target === "node") {
      return '<section class="section" id="sandbox-settings">' + head +
        '<div class="callout"><p class="field-label">Cloudflare-only capability</p><p class="hint">Node and other non-Cloudflare installations use the standard in-memory bash sandbox. Chickpea never gives that sandbox the host filesystem or host git/SSH credentials.</p></div>' + live + '</section>';
    }

    var body = '';
    if (!status.installed && !status.installRequested) {
      body = status.storedEnabled
        ? '<div class="action-well"><div class="danger-copy"><span class="field-label">Saved On state from an earlier deployment</span><span class="hint">The Container is not installed, so this state is ineffective. Clear it before reinstalling so a later Sandbox redeploy cannot reactivate coding work implicitly.</span></div>' +
          '<button type="button" class="btn btn-soft" data-action="sandbox-cancel-install"' + disabled + '>' + (state.sandboxSaving === "cancel" ? "Clearing&hellip;" : "Clear saved state") + '</button></div>'
        : '<div class="action-well"><div class="danger-copy"><span class="field-label">Not installed in this deployment</span><span class="hint">The slim deployment does not build Ubuntu or create Container infrastructure. A Container application or image from an earlier install may still remain in Cloudflare until you remove it.</span></div>' +
          '<button type="button" class="btn btn-primary" data-action="sandbox-install-open"' + disabled + '>Install coding sandbox</button></div>';
    } else if (!status.installed) {
      body = '<div class="action-well"><div class="danger-copy"><span class="field-label">Redeploy required</span><span class="hint">Chickpea saved your request, but Chickpea cannot redeploy itself because deployment authority stays in your Cloudflare account.</span></div>' +
        '<button type="button" class="btn btn-primary" data-action="sandbox-check-again"' + disabled + '>' + (state.sandboxSaving === "check" ? "Checking&hellip;" : "Check again") + '</button>' +
        '<button type="button" class="btn btn-ghost" data-action="sandbox-cancel-install"' + disabled + '>' + (state.sandboxSaving === "cancel" ? "Canceling&hellip;" : "Cancel request") + '</button></div>' +
        '<div class="callout"><p class="field-label">Finish in Cloudflare</p><p class="hint">Open Cloudflare dashboard &rarr; Workers &amp; Pages &rarr; your Worker &rarr; Settings &rarr; Builds &rarr; Variables. Add the non-secret build variable below, then choose <b>Retry deployment</b>.</p><div class="team-link-row"><input class="input mono" id="sandbox-build-variable" readonly value="CHICKPEA_DEPLOY_PROFILE=sandbox" aria-label="Sandbox build variable"><button type="button" class="btn btn-soft btn-sm" data-action="sandbox-copy-profile"' + disabled + '>Copy variable</button></div><p class="hint">If Retry reuses the earlier core artifact, start a fresh dashboard build. Local or CI operators can instead run <span class="mono">npm run deploy:sandbox</span>. The first image build can take several minutes.</p></div>';
    } else {
      var prerequisite = '';
      if (!status.githubConnected) {
        prerequisite = '<button type="button" class="btn btn-primary" data-action="open-settings" data-section="github-settings">Connect GitHub</button>';
      } else if (!status.repositoryGrantReady) {
        prerequisite = '<button type="button" class="btn btn-primary" data-action="open-profiles">Manage repository access</button>';
      }
      var runtimeAction = prerequisite;
      if (!runtimeAction && !status.storedEnabled) {
        runtimeAction = '<button type="button" class="btn btn-primary" data-action="sandbox-enable-open"' + disabled + '>Enable coding sandbox</button>';
      }
      if (status.storedEnabled) {
        runtimeAction += '<button type="button" class="btn btn-soft" data-action="sandbox-disable"' + disabled + '>' + (state.sandboxSaving === "disable" ? "Disabling&hellip;" : "Disable") + '</button>';
      }
      var statusCopy = status.storedEnabled
        ? (prerequisite ? 'The saved runtime preference is on, but coding tasks cannot use the Container until setup is complete.' : 'Repository-backed coding tasks can use the Cloudflare Container.')
        : (prerequisite ? 'Complete the required repository setup before enabling.' : 'The Container is installed. Enable it only after Cloudflare reports the rollout ready.');
      body = '<div class="action-well"><div class="danger-copy"><span class="field-label">' + (status.storedEnabled ? (prerequisite ? "On, setup required" : "On") : "Installed but off") + '</span><span class="hint">' + statusCopy + '</span></div>' + runtimeAction + '</div>' +
        '<p class="hint">Disabling is immediate, but the Container application and image remain in Cloudflare and may retain costs. To remove them, disable first, remove <span class="mono">CHICKPEA_DEPLOY_PROFILE</span> from Builds, redeploy the core profile, verify normal Slack behavior, and then delete the retained Container application and image.</p>' +
        sandboxAdvancedHtml(disabled);
    }

    return '<section class="section" id="sandbox-settings">' + head + body + paidNote + live + progress + '</section>';
  }

  function sandboxAdvancedHtml(disabled) {
    var hostOptions = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"];
    var hostRows = hostOptions.map(function (host) {
      var checked = sandboxDraft.allowedHosts.indexOf(host) >= 0;
      return '<label class="conn-tool"><span class="import-check' + (checked ? " on" : "") + '">' +
        '<input type="checkbox" data-action="sandbox-host" data-host="' + esc(host) + '" ' + (checked ? "checked " : "") + disabled + ' aria-label="Allow ' + esc(host) + '"></span>' +
        '<span class="tool-body"><span class="tool-name">' + esc(host) + '</span></span></label>';
    }).join("");
    return '<details class="advanced"><summary>Advanced</summary><div class="adv-rows">' +
      '<div class="field"><label class="field-label" for="sandbox-instance-type">Instance type</label>' +
      '<input class="input mono" id="sandbox-instance-type" value="standard-1" readonly aria-readonly="true">' +
      '<p class="hint">Fixed by the Sandbox deployment profile.</p></div>' +
      '<div class="field" style="margin-top:14px;"><label class="field-label" for="sandbox-monthly-cap">Monthly session cap</label>' +
      '<input class="input mono" id="sandbox-monthly-cap" type="number" min="0" max="100000" step="1" value="' + esc(String(sandboxDraft.monthlySessionCap)) + '" data-action="sandbox-monthly-cap"' + disabled + '>' +
      '<p class="hint">New coding sessions decline cleanly at this UTC-month limit. Set to <span class="mono">0</span> for no cap.</p></div>' +
      '<div class="field" style="margin-top:14px;"><span class="field-label">Package registry access</span>' +
      '<p class="hint">GitHub access comes from Agent repository grants. These are the only optional package hosts.</p>' + hostRows + '</div>' +
      '</div></details>' +
      '<div><button type="button" class="btn btn-soft" data-action="sandbox-save"' + disabled + '>' + (state.sandboxSaving === "advanced" ? "Saving&hellip;" : "Save advanced settings") + '</button></div>';
  }

  function settingsMainHtml() {
    if (state.settingsSection === "slack") {
      return '<div class="section-head"><div><h1 class="page-title">Slack</h1><p class="hint">Manage the workspace installation and transport behavior. Agent handles and avatars live on each Agent.</p></div></div>' +
        slackWorkspaceSettingsHtml();
    }
    if (state.settingsSection === "connectors") {
      return '<div class="section-head"><div><h1 class="page-title">Connectors</h1><p class="hint">Configure managed integrations and review connected accounts for this Chickpea installation.</p></div></div>' + connectorsSettingsHtml();
    }
    var head = '<div style="display:flex; flex-direction:column; gap:6px;">' +
      '<h1 class="page-title">Settings</h1>' +
      '<p class="hint">Configure GitHub, model providers, and outbound internet access for the sandbox.</p></div>';
    var providerSection;
    if (state.settingsError) {
      providerSection = '<section class="section"><div class="section-head"><div><h2 class="section-title">Model providers</h2></div></div>' + modelCatalogStatusHtml() + '<p class="field-error">' + esc(state.settingsError) + '</p></section>';
    } else if (!state.settingsLoaded || !state.settings) {
      providerSection = '<section class="section"><div class="section-head"><div><h2 class="section-title">Model providers</h2></div></div>' + modelCatalogStatusHtml() + '<p class="hint">Loading providers&hellip;</p></section>';
    } else {
      var providers = (state.settings.providers || []).filter(function (provider) {
        // Workers AI is binding-only — shown on Cloudflare, hidden on Node.
        return provider.id !== "workers-ai" || IS_CLOUDFLARE;
      });
      var rows = providers.map(providerRowHtml).join("");
      providerSection = '<section class="section"><div class="section-head"><div><h2 class="section-title">Model providers</h2>' +
        '<p class="hint">Connect the API credentials Chickpea can use.</p></div></div>' +
        modelCatalogStatusHtml() + rows + '</section>';
    }
    return head +
      settingsPanelHtml("slack", slackWorkspaceSettingsHtml()) +
      settingsPanelHtml("connectors", connectorsSettingsHtml()) +
      settingsPanelHtml("providers", providerSection) +
      settingsPanelHtml("github", githubSectionHtml()) +
      settingsPanelHtml("sandbox", sandboxSectionHtml()) +
      settingsPanelHtml("outbound", egressSectionHtml());
  }

  function settingsPanelHtml(id, body) {
    return '<div class="settings-panel" data-settings-panel="' + id + '"' + (state.settingsSection === id ? '' : ' hidden') + '>' + body + '</div>';
  }

  function connectorPresetForToolkit(toolkit) {
    return (REUSABLE_CONNECTOR_PRESETS || []).find(function (preset) {
      var managed = managedPresetById(preset.id);
      var google = googleServicePresetById(preset.id);
      return (managed && managed.managedToolkit || google && google.managedToolkit) === toolkit;
    });
  }

  function connectorSettingsProviderHtml() {
    var settings = state.connectorSettings;
    var provider = settings.provider;
    var providerDescription = settings.canConfigure
      ? 'Some Chickpea connectors are managed by Composio. Add one project key to use them; Chickpea handles the standard authentication setup.'
      : 'Some Chickpea connectors use managed authentication. A Chickpea owner or admin can enable them for this installation.';
    var managedCatalogLabel = settings.canConfigure
      ? 'Composio-managed connectors'
      : 'Managed connectors';
    var head = '<section class="section managed-provider-section"><div class="section-head"><div><h2 class="section-title">Managed connectors</h2><p class="hint">' + providerDescription + '</p></div></div>';
    if (settings.loading) return head + '<p class="hint">Loading managed connector status&hellip;</p></section>';
    if (settings.error && !provider && !settings.recoveryMode) {
      return head + '<div class="callout" role="alert"><span>' + esc(settings.error) + '</span><button type="button" class="btn btn-soft btn-sm" data-action="connector-settings-retry-load">Retry</button></div></section>';
    }
    if (settings.error && !provider) {
      var recoveryRows = (settings.catalog || []).map(function (descriptor) {
        var preset = connectorPresetForToolkit(descriptor.toolkit) || { id: descriptor.id, name: descriptor.label, accent: "#8b6b2e" };
        return '<div class="managed-settings-row">' + connectorLogoHtml(preset) + '<span class="managed-settings-copy"><span class="connection-account-name">' + esc(descriptor.label) + '</span><span class="connection-account-identity">' + esc(descriptor.description || "") + '</span></span><span class="managed-readiness managed-readiness-prerequisite">Needs attention</span></div>';
      }).join("");
      var recoveryControls = settings.canConfigure
        ? '<div class="managed-key-form"><div class="field"><label class="field-label" for="connector-settings-key">Composio project key</label><input class="input mono" id="connector-settings-key" type="password" autocomplete="off" value="' + esc(settings.key || "") + '" data-action="connector-settings-key" aria-describedby="connector-settings-key-help"' + (settings.busy ? ' disabled' : '') + '><p class="hint" id="connector-settings-key-help">Add the current project key to repair this configuration. It is stored encrypted and never shown again. <a class="hint-link" href="https://dashboard.composio.dev" target="_blank" rel="noopener noreferrer">Open Composio &nearr;</a></p></div><div class="managed-provider-actions"><button type="button" class="btn btn-ghost danger-text" data-action="connector-settings-disable-open"' + (settings.busy ? ' disabled' : '') + '>Disable in Chickpea</button><button type="button" class="btn btn-primary" data-action="connector-settings-save"' + (settings.busy || !String(settings.key || "").trim() ? ' disabled' : '') + '>' + (settings.busy === "setup" ? 'Repairing&hellip;' : 'Validate and repair') + '</button></div></div>'
        : '<p class="managed-provider-guidance">A Chickpea owner or admin can repair this configuration.</p>';
      return head + '<div class="callout" role="alert"><span>' + esc(settings.error) + '</span><button type="button" class="btn btn-soft btn-sm" data-action="connector-settings-retry-load">Retry</button></div><div class="managed-provider-card"><div class="managed-provider-status"><span class="managed-provider-dot setup" aria-hidden="true"></span><div><strong>Configuration needs attention</strong><p class="hint">Replace the stored project key or disable managed connectors to recover.</p></div></div>' + recoveryControls + '</div>' + (recoveryRows ? '<div class="managed-settings-list" aria-label="' + managedCatalogLabel + '">' + recoveryRows + '</div>' : '') + '</section>';
    }
    if (!provider) return head + '<p class="field-error">Managed connector status is unavailable.</p></section>';
    var configured = provider.configured && provider.desiredState === "enabled";
    var statusLabel = provider.readOnly
      ? (configured ? "Configured by deployment" : "Deployment setup required")
      : configured
        ? "Connected"
        : "Not configured";
    var statusDetail = provider.readOnly
      ? (configured
          ? "This installation reads its project key from deployment configuration. It cannot be replaced or disabled in Admin."
          : "This hosted installation expects a deployment-managed project key. Add the secret binding before managed connectors can be used.")
      : configured
        ? "The project key is stored encrypted. Replace it only when rotating projects or credentials."
        : settings.canConfigure
          ? "Create a Composio project, then add its project key here."
          : "A Chickpea owner or admin can enable managed connectors for this installation.";
    var deploymentPreparationRequired = provider.readOnly && configured &&
      (settings.catalog || []).some(function (descriptor) {
        return !managedConnectorLaneReady(descriptor, "read");
      });
    var controls = "";
    if (!settings.canConfigure) {
      controls = '<p class="managed-provider-guidance">A Chickpea owner or admin can add or change this project key.</p>';
    } else if (deploymentPreparationRequired) {
      controls = '<div class="managed-provider-actions"><button type="button" class="btn btn-primary" data-action="connector-settings-retry">' +
        (settings.busy === "retry" ? 'Preparing&hellip;' : 'Prepare connector defaults') + '</button></div>';
    } else if (!provider.readOnly) {
      if (configured && !settings.editing) {
        controls = '<div class="managed-provider-actions"><button type="button" class="btn btn-soft" data-action="connector-settings-edit-key">Replace project key</button><button type="button" class="btn btn-ghost danger-text" data-action="connector-settings-disable-open">Disable in Chickpea</button></div>';
      } else {
        controls = '<div class="managed-key-form"><div class="field"><label class="field-label" for="connector-settings-key">' + (configured ? 'New Composio project key' : 'Composio project key') + '</label><input class="input mono" id="connector-settings-key" type="password" autocomplete="off" value="' + esc(settings.key || "") + '" data-action="connector-settings-key" aria-describedby="connector-settings-key-help"' + (settings.busy ? ' disabled' : '') + '><p class="hint" id="connector-settings-key-help">Stored encrypted and never shown again. In Composio, open Settings &rarr; Project Settings &rarr; API Keys. <a class="hint-link" href="https://dashboard.composio.dev" target="_blank" rel="noopener noreferrer">Open Composio &nearr;</a></p></div><div class="managed-provider-actions">' +
          (configured ? '<button type="button" class="btn btn-ghost" data-action="connector-settings-edit-cancel"' + (settings.busy ? ' disabled' : '') + '>Cancel</button>' : '') +
          '<button type="button" class="btn btn-primary" data-action="connector-settings-save"' + (settings.busy || !String(settings.key || "").trim() ? ' disabled' : '') + '>' + (settings.busy === "setup" ? 'Setting up&hellip;' : configured ? 'Validate and replace' : 'Validate and save') + '</button></div></div>';
      }
    }
    if (provider.reconciliationPending) {
      controls += '<div class="callout" role="status"><span>Chickpea is finishing connector reconciliation. Managed execution remains paused.</span>' +
        (settings.canConfigure ? '<button type="button" class="btn btn-soft btn-sm" data-action="connector-settings-retry">Retry</button>' : '') + '</div>';
    } else if (provider.lastSetupResult && provider.lastSetupResult.status !== "ready" && configured) {
      controls += '<div class="callout" role="alert"><span>Some connectors still need setup. Ready connectors remain available.</span><button type="button" class="btn btn-soft btn-sm" data-action="connector-settings-retry">Retry setup</button></div>';
    }
    var catalogRows = (settings.catalog || []).map(function (descriptor) {
      var preset = connectorPresetForToolkit(descriptor.toolkit) || { id: descriptor.id, name: descriptor.label, accent: "#8b6b2e" };
      var readiness = managedConnectorLaneReady(descriptor, "read")
        ? { label: "Ready", kind: "ready" }
        : managedConnectorMissingCodes(descriptor, "read").indexOf("provider_prerequisite_missing") >= 0
          ? { label: "Additional setup required", kind: "prerequisite" }
          : { label: configured ? "Setup required" : "Add project key", kind: "setup" };
      return '<div class="managed-settings-row">' + connectorLogoHtml(preset) + '<span class="managed-settings-copy"><span class="connection-account-name">' + esc(descriptor.label) + '</span><span class="connection-account-identity">' + esc(descriptor.description || "") + '</span></span><span class="managed-readiness managed-readiness-' + readiness.kind + '">' + esc(readiness.label) + '</span></div>';
    }).join("");
    return head + '<div class="managed-provider-card"><div class="managed-provider-status"><span class="managed-provider-dot ' + (configured ? 'ready' : 'setup') + '" aria-hidden="true"></span><div><strong>' + esc(statusLabel) + '</strong><p class="hint">' + esc(statusDetail) + '</p></div></div>' + controls +
      (settings.error ? '<div class="callout" role="alert"><span>' + esc(settings.error) + '</span><button type="button" class="btn btn-soft btn-sm" data-action="connector-settings-retry-load">Retry</button></div>' : '') +
      (settings.notice ? '<p class="oauth-return ok" role="status">' + esc(settings.notice) + '</p>' : '') + '</div>' +
      '<div class="managed-settings-list" aria-label="' + managedCatalogLabel + '">' + catalogRows + '</div></section>';
  }

  function connectorsSettingsHtml() {
    return connectorSettingsProviderHtml() + connectionInventoryHtml();
  }

  function connectorSettingsConfirmModalHtml() {
    var confirm = state.connectorSettings.confirm;
    if (!confirm) return "";
    var impact = state.connectorSettings.impact || { accounts: 0, schedules: 0 };
    var replacing = confirm === "replace";
    var title = replacing ? "Replace the Composio project key?" : "Disable managed connectors in Chickpea?";
    var detail = replacing
      ? "Chickpea will validate the new project before using it. If it belongs to a different project, preserved accounts will need to reconnect."
      : "Chickpea will pause managed execution and dependent schedules, but it will keep Agent bindings and remote Composio accounts so the same project can be reconnected later. A Runs as member must resume each affected schedule after connections recover.";
    return '<div class="modal-backdrop"><div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="connector-settings-confirm-title" tabindex="-1" data-role="connector-settings-confirm-dialog"><h2 class="modal-title" id="connector-settings-confirm-title">' + esc(title) + '</h2><p class="modal-body">' + esc(detail) + '</p><p class="managed-impact">Affects ' + Number(impact.accounts || 0) + ' connected account' + (Number(impact.accounts || 0) === 1 ? '' : 's') + ' and ' + Number(impact.schedules || 0) + ' schedule' + (Number(impact.schedules || 0) === 1 ? '' : 's') + '.</p><div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="connector-settings-confirm-cancel">Cancel</button><span class="spacer"></span><button type="button" class="btn ' + (replacing ? 'btn-primary' : 'btn-danger') + '" data-action="connector-settings-confirm-apply">' + (replacing ? 'Validate and replace' : 'Disable in Chickpea') + '</button></div></div></div>';
  }

  function connectionInventoryHtml() {
    var inventory = state.connectionInventory;
    var head = '<section class="section"><div class="section-head"><div><h2 class="section-title">Connected accounts</h2><p class="hint">Reconnect or disconnect accounts here. Add accounts and choose Agent access from an Agent.</p></div></div>';
    if (inventory.loading) return head + '<p class="hint">Loading connections&hellip;</p></section>';
    if (inventory.error) return head + '<div class="callout" role="alert"><span>' + esc(inventory.error) + '</span><button type="button" class="btn btn-soft btn-sm" data-action="connection-inventory-retry">Retry</button></div></section>';
    if (!inventory.accounts.length) return head + '<div class="empty-inline"><strong>No connections yet.</strong><span>Open an Agent, choose Connections, and connect the service it needs.</span></div></section>';
    var rows = inventory.accounts.map(function (entry) {
      var account = entry.account || {};
      var agents = entry.agents || [];
      var owner = account.ownerKind === "team" ? "Team" : "Personal";
      var accountLabel = String(account.label || account.providerId || "Connection");
      var redundantOwnerSuffix = " · " + owner;
      if (accountLabel.endsWith(redundantOwnerSuffix)) {
        accountLabel = accountLabel.slice(0, -redundantOwnerSuffix.length);
      }
      var status = account.lifecycle === "ready" ? "Connected" : "Needs attention";
      var agentLinks = agents.length ? agents.map(function (agent) {
        return '<button type="button" class="capability-pill" data-action="edit-profile" data-agent="' + esc(agent.id) + '">' + esc(agent.name || agent.id) + '</button>';
      }).join("") : '<span class="hint">Not used by an Agent</span>';
      var managedNeedsAttention = account.lifecycle !== "ready" && account.policy && account.policy.kind === "managed";
      var providerConfigured = state.connectorSettings.provider && state.connectorSettings.provider.configured;
      var managedReconnect = managedNeedsAttention && providerConfigured && entry.reconnectAgentId
        ? '<button type="button" class="btn btn-soft btn-sm" data-action="connection-inventory-reconnect" data-connection-id="' + esc(account.id) + '" data-agent-id="' + esc(entry.reconnectAgentId) + '">Reconnect</button>'
        : managedNeedsAttention && !providerConfigured && state.connectorSettings.canConfigure && !(state.connectorSettings.provider && state.connectorSettings.provider.readOnly)
          ? '<button type="button" class="btn btn-soft btn-sm" data-action="connection-inventory-provider-setup">Add project key</button>'
          : managedNeedsAttention && providerConfigured && !entry.reconnectAgentId
            ? '<span class="hint">Add this account to an Agent before reconnecting.</span>'
          : '';
      var actions = '<div class="connection-inventory-actions">' + managedReconnect + '<button type="button" class="btn btn-ghost btn-sm danger-text" data-action="connection-account-revoke" data-connection-id="' + esc(account.id) + '">Disconnect</button></div>';
      var detail = account.purpose
        ? '<p class="hint">' + esc(account.purpose) + '</p>'
        : account.policy && account.policy.kind === "managed"
          ? ''
          : '<p class="hint">' + esc(account.providerId || "Custom") + '</p>';
      return '<article class="connection-inventory-row"><div class="connection-account-copy"><div><strong>' + esc(accountLabel) + '</strong> <span class="badge-src">' + esc(owner) + '</span> <span class="badge ' + (account.lifecycle === "ready" ? "badge-on" : "badge-off") + '">' + esc(status) + '</span></div>' + detail + '<div class="where-list" aria-label="Agents using ' + esc(accountLabel) + '">' + agentLinks + '</div></div>' + actions + '</article>';
    }).join("");
    return head + (inventory.notice ? '<p class="oauth-return ok" role="status">' + esc(inventory.notice) + '</p>' : '') + '<div class="connection-account-list">' + rows + '</div></section>';
  }

  function modelCatalogStatusHtml() {
    var status = state.modelCatalog;
    var copy = "Loading model list status&hellip;";
    if (state.modelCatalogLoaded) {
      if (status) {
        if (status.mode === "bundled") copy = "Included with this Chickpea release";
        else if (status.source === "hosted") copy = "Models up to date &middot; revision " + Number(status.revision || 0);
        else copy = "Using models included with this Chickpea release";
      } else copy = "Model list status unavailable";
    }
    return '<div class="bundle-row model-catalog-status"><div class="danger-copy"><span class="field-label">Model list</span>' +
      '<span class="hint">' + copy + '</span></div>' +
      '<button type="button" class="btn btn-ghost btn-sm i-lead" data-action="model-catalog-refresh"' + (state.modelCatalogBusy ? " disabled" : "") + '>' +
      (state.modelCatalogBusy ? '<span class="spinner"></span>Refreshing&hellip;' : icon("arrow-path") + 'Refresh models') + '</button>' +
      (state.modelCatalogError ? '<span class="inline-status error" role="alert">' + esc(state.modelCatalogError) + '</span>' : "") + '</div>';
  }

  function egressSectionHtml() {
    var head = '<div class="section-head"><div><h2 class="section-title">Outbound access</h2>' +
      '<p class="hint">Controls the internet access available to sandbox <span class="mono">curl</span>. MCP connectors are separate and always work. Private and internal addresses are always blocked. <b>Allowlist</b> permits only the listed hosts; <b>Open</b> permits the whole internet; <b>Off</b> disables outbound access.</p></div></div>';
    if (!state.egressLoaded) {
      return '<section class="section">' + head + '<p class="hint">Loading outbound policy&hellip;</p></section>';
    }
    var mode = egressDraft.mode;
    var disabled = state.egressSaving ? " disabled" : "";
    var segment = '<div class="seg" role="group" aria-label="Outbound access mode">' +
      '<button type="button" class="' + (mode === "allowlist" ? "on" : "") + '" data-action="egress-mode" data-mode="allowlist"' + disabled + '>Allowlist</button>' +
      '<button type="button" class="' + (mode === "open" ? "on" : "") + '" data-action="egress-mode" data-mode="open"' + disabled + '>Open</button>' +
      '<button type="button" class="' + (mode === "off" ? "on" : "") + '" data-action="egress-mode" data-mode="off"' + disabled + '>Off</button></div>';
    var domains = "";
    if (mode === "allowlist") {
      var rows = egressDraft.domains.map(function (domain, index) {
        return '<div class="conn-header-row">' +
          '<input class="input" type="text" value="' + esc(domain) + '" placeholder="api.example.com" aria-label="Allowed host ' + (index + 1) + '" data-action="egress-domain-input" data-index="' + index + '"' + disabled + '>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-action="egress-domain-remove" data-index="' + index + '" aria-label="Remove allowed host"' + disabled + '>&times;</button></div>';
      }).join("");
      domains = '<div class="field"><label class="field-label">Allowed hosts</label>' + rows +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="egress-domain-add"' + disabled + '>' + icon("plus") + 'Add domain</button></div>';
    }
    return '<section class="section">' + head +
      '<div class="field"><label class="field-label">Mode</label>' + segment + '</div>' +
      domains +
      (state.egressError ? '<p class="field-error">' + esc(state.egressError) + '</p>' : "") +
      '<div><button type="button" class="btn btn-primary" data-action="egress-save"' + (state.egressSaving ? " disabled" : "") + '>' + (state.egressSaving ? "Saving&hellip;" : "Save") + '</button></div></section>';
  }

  function providerRowHtml(summary) {
    var id = summary.id;
    var meta = providerMeta(id);
    var ui = state.provUi[id] || {};
    if (isFavoriteProvider(id)) return favoriteProviderRowHtml(summary, ui, meta);
    var body = "";
    if (ui.removeOpen) body = removeConfirmHtml(id, summary);
    else if (ui.open) body = pasteBodyHtml(id, ui, meta);
    if (id === "openai") return openAiProviderRowHtml(summary, ui, body, meta);
    var head = '<div class="prov-head">' +
      '<div class="prov-id"><span class="prov-name">' + esc(meta.name) + '</span>' +
      '<span class="prov-sub">' + esc(meta.sub) + ' &middot; <span class="mono-frag">' + esc(meta.frag) + '</span>' + (meta.suffix ? esc(meta.suffix) : "") + '</span></div>' +
      providerStatusHtml(id, summary) +
      providerActionsHtml(id, summary, ui) +
      '</div>';
    return '<div class="prov-row">' + head + (body ? '<div class="prov-body">' + body + '</div>' : "") + '</div>';
  }

  function favoriteProviderRowHtml(summary, ui, meta) {
    var id = summary.id;
    var editor = "";
    if (ui.removeOpen) editor = removeConfirmHtml(id, summary);
    else if (ui.open) editor = pasteBodyHtml(id, ui, meta);
    var actions = id === "workers-ai"
      ? '<div class="fav-provider-controls"><label class="toggle"><span class="thumb"></span><input type="checkbox" data-action="workers-ai-enabled"' + (summary.enabled !== false ? " checked" : "") + ' aria-label="Use Workers AI in Agent model pickers"' + (ui.enabledBusy ? " disabled" : "") + '></label></div>'
      : providerActionsHtml(id, summary, ui);
    var head = '<div class="prov-head"><div class="prov-id fav-provider-id"><span class="prov-name">' + esc(meta.name) + '</span>' +
      favoriteProviderStatusHtml(id, summary) + '</div>' + actions + '</div>';
    var error = ui.enabledError
      ? '<div class="fav-provider-error"><p class="field-error" role="alert">' + esc(ui.enabledError) + '</p>' +
        (ui.enabledRetry ? '<button type="button" class="btn btn-ghost btn-sm" data-action="workers-ai-refresh"' + (ui.enabledBusy ? " disabled" : "") + '>Try again</button>' : "") + '</div>'
      : "";
    var body = editor
      ? '<div class="prov-body fav-provider-body fav-provider-editor">' + editor + '</div>'
      : favoriteProviderBodyHtml(id);
    return '<div class="prov-row fav-provider">' + head + error + body + '</div>';
  }

  function favoriteProviderStatusHtml(id, summary) {
    if (id === "workers-ai") {
      var enabled = summary.enabled !== false;
      return '<span class="badge ' + (enabled ? "badge-on" : "badge-off") + '"><span class="dot"></span>' + (enabled ? "On" : "Off") + '</span>';
    }
    if (summary.status === "stored" || summary.status === "env") {
      return '<span class="badge badge-on"><span class="dot"></span>Connected</span>';
    }
    return '<span class="badge badge-off"><span class="dot"></span>API key required</span>';
  }

  function openAiProviderRowHtml(summary, ui, apiEditor, meta) {
    var apiConnected = summary.status === "stored" || summary.status === "env";
    var apiBadge = '<span class="badge ' + (apiConnected ? "badge-on" : "badge-off") + '"><span class="dot"></span>' + (apiConnected ? "Connected" : "Not connected") + '</span>';
    var apiSource = summary.status === "env" ? "Environment managed" : summary.status === "stored" ? "Saved in Chickpea" : "Platform billing";
    var apiOption = '<div class="openai-auth-option"><div class="openai-auth-head">' +
      '<div class="openai-auth-copy"><span class="openai-auth-title">API key</span><span class="openai-auth-meta">' + esc(apiSource) + '</span></div>' +
      apiBadge + providerActionsHtml("openai", summary, ui) + '</div>' +
      (apiEditor ? '<div class="openai-auth-editor">' + apiEditor + '</div>' : "") + '</div>';
    var head = '<div class="prov-head"><div class="prov-id"><span class="prov-name">' + esc(meta.name) + '</span>' +
      '<span class="prov-sub">' + esc(meta.sub) + ' &middot; <span class="mono-frag">' + esc(meta.frag) + '</span></span></div></div>';
    return '<div class="prov-row">' + head + '<div class="prov-body"><div class="openai-auth-list">' + apiOption + '</div></div></div>';
  }

  function providerStatusHtml(id, summary) {
    var status = summary.status;
    var favCount = isFavoriteProvider(id) ? favoritesFor(id).length : null;
    var count = providerModelCount(id, summary);
    var chip;
    var parts;
    if (status === "env") {
      if (id === "workers-ai") {
        chip = '<span class="badge badge-on"><span class="dot"></span>Always available</span>';
        parts = ["Keyless", "billed in Neurons"];
      } else {
        chip = '<span class="badge badge-on"><span class="dot"></span>' + (id === "openai" ? "API key via environment" : "Via environment") + '</span>';
        parts = ["Read-only"];
      }
      if (count != null) parts.push(count + " models");
      if (favCount != null) parts.push(favCount + " in your picker");
    } else if (status === "stored") {
      chip = '<span class="badge badge-on"><span class="dot"></span>' + (id === "openai" ? "API key stored" : "Stored") + '</span>';
      parts = ["Saved here"];
      if (count != null) parts.push(count + " models available");
      if (favCount != null) parts.push(favCount + " in your picker");
    } else {
      return '<div class="prov-status"><span class="badge badge-off"><span class="dot"></span>' + (id === "openai" ? "API key missing" : "Missing") + '</span></div>';
    }
    return '<div class="prov-status">' + chip + '<span class="hint">' + esc(parts.join(" · ")) + '</span></div>';
  }

  function providerActionsHtml(id, summary, ui) {
    // Env-sourced keys (and the keyless Workers AI binding) are read-only.
    if (summary.status === "env") return "";
    if (ui.removeOpen) return "";
    if (ui.open) {
      return '<div class="prov-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="prov-cancel-key" data-provider="' + esc(id) + '">Cancel</button></div>';
    }
    if (summary.status === "stored") {
      return '<div class="prov-actions">' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="prov-change-key" data-provider="' + esc(id) + '">Change key</button>' +
        '<button type="button" class="btn btn-danger btn-sm" data-action="prov-remove" data-provider="' + esc(id) + '">Remove</button></div>';
    }
    return '<div class="prov-actions"><button type="button" class="btn btn-soft btn-sm" data-action="prov-add-key" data-provider="' + esc(id) + '">Add key</button></div>';
  }

  function validateEndpointPath(id) {
    return id === "openrouter" ? "GET /auth/key" : "GET /v1/models";
  }

  function pasteBodyHtml(id, ui, meta) {
    var busy = ui.busy;
    var placeholder = id === "anthropic" ? "sk-ant-..." : id === "openrouter" ? "sk-or-..." : "sk-...";
    var val = ui.key || "";
    var input = '<input class="input mono" type="password" autocomplete="off" placeholder="' + esc(placeholder) + '" value="' + esc(val) + '" aria-label="' + esc(meta.name) + ' API key" data-action="prov-key-input" data-provider="' + esc(id) + '"' +
      (busy ? ' disabled' : (ui.error ? ' style="outline:2px solid var(--danger); outline-offset:-1px;"' : '')) + '>';
    var btn = busy
      ? '<button type="button" class="btn btn-primary btn-sm" disabled><span class="spinner"></span>Validating&hellip;</button>'
      : '<button type="button" class="btn btn-primary btn-sm" data-action="prov-validate" data-provider="' + esc(id) + '">Validate &amp; save</button>';
    var html = '<div class="field"><label class="field-label">API key</label><div class="paste-row">' + input + btn + '</div>';
    if (busy) {
      html += '<p class="hint"><span class="spinner" style="vertical-align:-2px; margin-right:5px;"></span>' + validateBusyHint(id, meta) + '</p>';
    } else if (ui.error) {
      html += '<p class="field-error">' + esc(ui.error) + '</p>';
      if (ui.raw) html += '<div class="raw-error">' + esc(ui.raw) + '</div>';
      html += '<p class="hint">The provider\\'s own message is shown verbatim so you can tell a typo from a disabled key. It is never stored.</p>';
    } else {
      html += '<p class="hint">' + validateIdleHint(id, meta) + '</p>';
    }
    return html + '</div>';
  }

  function validateIdleHint(id, meta) {
    var envFrag = '<span class="mono" style="color:var(--text-2);">' + esc(meta.env) + '</span>';
    if (id === "openrouter") {
      return 'Validating calls OpenRouter\\'s <span class="mono" style="color:var(--text-2);">GET /auth/key</span> once to prove the key, then loads its model list in the same step. Stored like your Slack credentials; an ' + envFrag + ' in the environment would override it.';
    }
    return 'Validating calls ' + esc(meta.name) + '\\'s <span class="mono" style="color:var(--text-2);">GET /v1/models</span> once &mdash; it proves the key and loads the chat-model list in the same step. Stored like your Slack credentials; an ' + envFrag + ' in the environment would override it.';
  }

  function validateBusyHint(id, meta) {
    if (id === "openrouter") {
      return 'Calling <span class="mono" style="color:var(--text-2);">GET /auth/key</span> to prove the key and load OpenRouter\\'s model list&hellip; nothing is stored until it returns 200.';
    }
    return 'Calling <span class="mono" style="color:var(--text-2);">GET /v1/models</span> to prove the key and load ' + esc(meta.name) + '\\'s chat-model list&hellip; nothing is stored until it returns 200.';
  }

  function joinNames(names) {
    if (names.length === 0) return "";
    if (names.length === 1) return names[0];
    if (names.length === 2) return names[0] + " and " + names[1];
    return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
  }

  function removeConfirmHtml(id, summary) {
    var meta = providerMeta(id);
    var pinned = pinnedProfilesForProvider(id);
    var count = pinned.length;
    var names = joinNames(pinned.map(function (agent) {
      return '<span class="mono" style="color:var(--text);">' + esc(agent.name) + '</span>';
    }));
    var envNote = 'An <span class="mono" style="color:var(--text);">' + esc(meta.env) + '</span> in the environment, if set, still applies.';
    var lead = 'Remove the stored ' + esc(meta.name) + ' key? ';
    var consequence;
    if (count === 0) {
      consequence = lead + 'No Agents are pinned to an ' + esc(meta.name) + ' model right now, so nothing stops answering. ' + envNote;
    } else {
      consequence = lead + '<b style="font-weight:500; color:var(--text);">' + count + ' Agent' + (count === 1 ? "" : "s") + '</b> ' + (count === 1 ? "is" : "are") +
        ' pinned to an ' + esc(meta.name) + ' model &mdash; ' + names + '. They keep their pin, but until an ' + esc(meta.name) +
        ' key returns each fails at reply time: the thread gets one sanitized line &mdash; <i>&ldquo;I reached the Slack thread, but the model provider call failed before completion.&rdquo;</i> &mdash; and no provider error leaks to Slack. Re-pin them to another provider to keep answering. ' + envNote;
    }
    var errLine = summary && provUiFor(id).removeError ? '<p class="field-error">' + esc(provUiFor(id).removeError) + '</p>' : "";
    return '<div class="callout">' + icon("exclamation-triangle", "ic-l g") + '<span>' + consequence + '</span></div>' + errLine +
      '<div style="display:flex; gap:10px;">' +
      '<button type="button" class="btn btn-soft btn-sm" data-action="prov-remove-cancel" data-provider="' + esc(id) + '">Keep key</button>' +
      '<button type="button" class="btn btn-danger btn-sm" data-action="prov-remove-confirm" data-provider="' + esc(id) + '">Remove key</button></div>';
  }

  function favoriteProviderBodyHtml(id) {
    var ui = favUiFor(id);
    var favs = favoritesFor(id);
    var open = !!ui.open;
    var buttonLabel = open ? "Done" : (favs.length ? "Manage models" : "Choose models");
    var summary = '<div class="fav-summary"><div class="fav-summary-copy"><span class="fav-summary-title">Models</span>' +
      '<span class="fav-summary-count">' + favs.length + ' selected</span></div>' +
      '<button type="button" class="btn btn-soft btn-sm" data-action="fav-manager-toggle" data-provider="' + esc(id) + '" aria-expanded="' + (open ? "true" : "false") + '" aria-controls="fav-manager-' + esc(id) + '">' + buttonLabel + '</button></div>';
    return '<div class="prov-body fav-provider-body">' + summary +
      (open ? favManagerHtml(id) : "") + favSelectedHtml(id) + '</div>';
  }

  function favManagerHtml(id) {
    var query = (favUiFor(id).query) || "";
    var count = providerModelCount(id, providerSummaryById(id));
    var providerName = id === "openrouter" ? "OpenRouter" : "Workers AI";
    var search = '<input id="fav-search-' + esc(id) + '" class="input" type="search" value="' + esc(query) + '" placeholder="' + esc((count != null ? "Search " + count + " " : "Search ") + providerName + " models…") + '" aria-label="Search ' + providerName + ' models" data-action="fav-search" data-provider="' + esc(id) + '">';
    return '<div class="fav-manager" id="fav-manager-' + esc(id) + '">' + search +
      '<div id="fav-results-' + esc(id) + '">' + favResultsHtml(id) + '</div></div>';
  }

  function favResultsHtml(id) {
    var ui = favUiFor(id);
    var raw = (ui.query || "").trim();
    if (!raw) return "";
    var models = state.providerModels[id];
    if (models == null) {
      if (ui.error) return '<p class="fav-empty">' + esc(ui.error) + '</p>';
      return '<p class="fav-sub" style="padding:6px 0 3px;">Results</p><p class="fav-empty"><span class="spinner" style="vertical-align:-2px; margin-right:5px;"></span>Loading the live model list&hellip;</p>';
    }
    var query = raw.toLowerCase();
    var starred = favoritesFor(id);
    var matches = models.filter(function (model) {
      return model.id.toLowerCase().indexOf(query) >= 0 && starred.indexOf(model.id) < 0;
    }).slice(0, 20);
    var header = '<p class="fav-sub" style="padding:6px 0 3px;">Results for &ldquo;' + esc(raw) + '&rdquo;</p>';
    if (matches.length === 0) return header + '<p class="fav-empty">No unstarred matches.</p>';
    return header + '<div class="fav-list">' + matches.map(function (model) { return favRowHtml(id, model, false, true); }).join("") + '</div>';
  }

  function favSelectedHtml(id) {
    var favs = favoritesFor(id);
    if (favs.length === 0) return "";
    var models = state.providerModels[id] || [];
    var byId = {};
    models.forEach(function (model) { byId[model.id] = model; });
    var rows = favs.map(function (mid) { return favRowHtml(id, byId[mid] || { id: mid }, true, false); }).join("");
    return '<div class="fav-selected" id="fav-starred-' + esc(id) + '">' + rows + '</div>';
  }

  function favRowHtml(id, model, on, showMeta) {
    var metaHtml = "";
    if (showMeta && id === "openrouter") {
      var m = favMetaHtml(model);
      if (m) metaHtml = '<span class="fav-meta">' + m + '</span>';
    }
    return '<div class="fav-row">' +
      '<button type="button" class="star' + (on ? " on" : "") + '" data-action="fav-star" data-provider="' + esc(id) + '" data-model="' + esc(model.id) + '" aria-label="' + (on ? "Unstar" : "Star") + ' ' + esc(model.id) + '">' + starIcon(on) + '</button>' +
      '<span class="fav-model">' + esc(model.id) + '</span>' + metaHtml + '</div>';
  }

  function favMetaHtml(model) {
    var base = "";
    if (model.context_length != null) base = esc(formatCtx(model.context_length)) + " ctx";
    var price = formatPrice(model.pricing);
    if (price) return (base ? base + " · " : "") + '<span class="price">' + esc(price) + '</span> /M';
    return base;
  }

  function formatCtx(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\\.0$/, "") + "M";
    if (n >= 1000) return Math.round(n / 1000) + "K";
    return String(n);
  }

  function priceNum(value) {
    if (value == null) return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function formatPrice(pricing) {
    if (!pricing) return "";
    var prompt = priceNum(pricing.prompt);
    var completion = priceNum(pricing.completion);
    if (prompt == null && completion == null) return "";
    var p = prompt == null ? "?" : "$" + (prompt * 1000000).toFixed(2);
    var c = completion == null ? "?" : "$" + (completion * 1000000).toFixed(2);
    return p + " / " + c;
  }

  // ---- Settings: data loading + actions ------------------------------------

  function normalizeSettingsSection(value) {
    var aliases = {
      "model-settings": "providers",
      "connection-settings": "connectors",
      "connections": "connectors",
      "github-settings": "github",
      "sandbox-settings": "sandbox",
      "egress-settings": "outbound"
    };
    var section = aliases[String(value || "")] || String(value || "");
    return ["slack", "connectors", "providers", "github", "sandbox", "outbound"].includes(section) ? section : "providers";
  }

  function settingsLoadIsCurrent(generation) {
    return generation === undefined || generation === state.settingsLoadGeneration;
  }

  function renderSettingsLoad(generation) {
    if (settingsLoadIsCurrent(generation)) render();
  }

  function openSettings(sectionId) {
    var generation = ++state.settingsLoadGeneration;
    state.view = "settings";
    state.settingsSection = normalizeSettingsSection(sectionId || state.settingsSection);
    state.profileScreen = "list";
    state.disableConfirm = false;
    state.githubStatus = null;
    state.githubStatusLoaded = false;
    state.githubError = "";
    state.egressLoaded = false;
    state.sandboxLoaded = false;
    state.sandboxConfirm = "";
    state.sandboxReadyAttested = false;
    state.sandboxNotice = "";
    state.sandboxError = "";
    state.modelCatalogLoaded = false;
    state.modelCatalogError = "";
    if (state.settingsSection === "slack") {
      render();
      return;
    }
    if (state.settingsSection === "connectors") {
      state.connectionInventory = { accounts: [], loading: true, error: "" };
      state.connectorSettings.loading = true;
      state.connectorSettings.error = "";
      render();
      loadConnectionInventory(generation);
      loadConnectorSettings(generation);
      return;
    }
    render();
    loadSettings(generation).then(function () { renderSettingsLoad(generation); });
    loadModelCatalogStatus(generation).then(function () { renderSettingsLoad(generation); });
    loadGithubStatus(generation).then(function () { renderSettingsLoad(generation); });
    loadEgress(generation).then(function () { renderSettingsLoad(generation); });
    loadSandboxStatus(generation).then(function () { renderSettingsLoad(generation); });
  }

  function loadConnectionInventory(generation) {
    var workspaceId = connectedTeamId();
    if (!workspaceId) {
      state.connectionInventory = { accounts: [], loading: false, error: "Connect Slack before reviewing connections." };
      renderSettingsLoad(generation);
      return Promise.resolve();
    }
    state.connectionInventory.loading = true;
    state.connectionInventory.error = "";
    renderSettingsLoad(generation);
    return api("/admin/api/connections?workspaceId=" + encodeURIComponent(workspaceId), { cache: "no-store" }).then(function (body) {
      if (!settingsLoadIsCurrent(generation) || state.settingsSection !== "connectors") return;
      state.connectionInventory = { accounts: body.accounts || [], loading: false, error: "" };
      for (var index = 0; index < state.connectionInventory.accounts.length && !state.managedAuthorization; index += 1) {
        var inventoryEntry = state.connectionInventory.accounts[index];
        var resumeAgentId = inventoryEntry && (inventoryEntry.reconnectAgentId ||
          inventoryEntry.agents && inventoryEntry.agents[0] && inventoryEntry.agents[0].id);
        if (resumeAgentId) restoreManagedAuthorization(resumeAgentId);
      }
      render();
    }).catch(function (error) {
      if (!settingsLoadIsCurrent(generation) || state.settingsSection !== "connectors") return;
      state.connectionInventory = { accounts: [], loading: false, error: error.serverMessage || error.message || "Could not load connections." };
      render();
    });
  }

  function loadConnectorSettings(generation) {
    var current = state.connectorSettings;
    current.loading = true;
    current.error = "";
    current.recoveryMode = false;
    return api("/admin/api/settings/connectors/composio", { cache: "no-store" }).then(function (body) {
      if (!settingsLoadIsCurrent(generation) || state.settingsSection !== "connectors") return;
      current.provider = body.provider || null;
      current.catalog = body.catalog || [];
      current.canConfigure = !!body.canConfigure;
      current.recoveryMode = false;
      current.impact = body.impact || { accounts: 0, schedules: 0 };
      current.loading = false;
      render();
    }).catch(function (error) {
      if (!settingsLoadIsCurrent(generation) || state.settingsSection !== "connectors") return;
      current.loading = false;
      var recovery = error && error.payload && error.payload.recovery;
      if (recovery) {
        current.provider = null;
        current.recoveryMode = true;
        current.canConfigure = !!recovery.canConfigure;
        current.catalog = recovery.catalog || current.catalog || [];
      }
      current.error = connectorSettingsErrorMessage(error, "Could not load managed connector settings.");
      render();
    });
  }

  function saveConnectorSettingsKey(confirmed) {
    var current = state.connectorSettings;
    if (!current.canConfigure || current.busy || !String(current.key || "").trim()) return;
    if (current.provider && current.provider.configured && !confirmed) {
      current.confirm = "replace";
      render();
      return;
    }
    current.confirm = "";
    current.busy = "setup";
    current.error = "";
    current.notice = "";
    render();
    postJson("/admin/api/settings/connectors/composio/setup", "POST", { projectKey: String(current.key).trim() }).then(function (body) {
      current.provider = body.provider || current.provider;
      current.key = "";
      current.editing = false;
      current.busy = "";
      current.notice = "Managed connectors are configured. Ready connectors can now be connected from an Agent.";
      return loadConnectorSettings(state.settingsLoadGeneration);
    }).catch(function (error) {
      current.busy = "";
      current.error = error && error.message === "invalid_composio_project_key"
        ? "That project key was not accepted. Check it in Composio and try again."
        : connectorSettingsErrorMessage(error, "Could not configure managed connectors.");
      render();
    });
  }

  function retryConnectorSettingsSetup() {
    var current = state.connectorSettings;
    if (!current.canConfigure || current.busy) return;
    current.busy = "retry";
    current.error = "";
    current.notice = "";
    render();
    postJson("/admin/api/settings/connectors/composio/retry", "POST", {}).then(function (body) {
      current.provider = body.provider || current.provider;
      current.busy = "";
      current.notice = "Managed connector setup was checked again.";
      return loadConnectorSettings(state.settingsLoadGeneration);
    }).catch(function (error) {
      current.busy = "";
      current.error = connectorSettingsErrorMessage(error, "Could not retry managed connector setup.");
      render();
    });
  }

  function disableConnectorSettings() {
    var current = state.connectorSettings;
    if (!current.canConfigure || current.busy) return;
    current.confirm = "";
    current.busy = "disable";
    current.error = "";
    current.notice = "";
    render();
    postJson("/admin/api/settings/connectors/composio/disable", "POST", {}).then(function (body) {
      current.provider = body.provider || current.provider;
      current.busy = "";
      current.editing = false;
      current.key = "";
      current.notice = "Managed connectors are disabled in Chickpea. Remote accounts and Agent bindings were preserved.";
      return Promise.all([
        loadConnectorSettings(state.settingsLoadGeneration),
        loadConnectionInventory(state.settingsLoadGeneration)
      ]);
    }).catch(function (error) {
      current.busy = "";
      current.error = connectorSettingsErrorMessage(error, "Could not disable managed connectors.");
      render();
    });
  }

  function submitComposioSetup() {
    var setup = state.composioSetup;
    var agentId = state.profileDraft && state.profileDraft.id;
    if (!setup || !setup.canConfigure || !agentId || !String(setup.key || "").trim() ||
        setup.phase === "validating" || setup.phase === "preparing") return;
    setup.phase = "validating";
    setup.error = "";
    render();
    window.setTimeout(function () {
      if (state.composioSetup === setup && setup.phase === "validating") {
        setup.phase = "preparing";
        render();
      }
    }, 400);
    postJson("/admin/api/settings/connectors/composio/setup", "POST", {
      projectKey: String(setup.key).trim(),
      continuation: { agentId: agentId, toolkit: setup.toolkit }
    }).then(function () {
      return loadAgentConnections(agentId);
    }).then(function () {
      if (state.composioSetup !== setup) return;
      var descriptor = managedConnectorDescriptorByToolkit(setup.toolkit);
      if (!managedConnectorLaneReady(descriptor, "read")) {
        setup.phase = "selected_unavailable";
        setup.error = "This connector needs additional setup. Review its status in Settings, then retry.";
        render();
        return;
      }
      state.composioSetup = null;
      newConnectionAccountFormFromPreset(setup.presetId, setup.ownerKind);
    }).catch(function (error) {
      if (state.composioSetup !== setup) return;
      setup.phase = error && error.message === "invalid_composio_project_key" ? "invalid_key" : "transient_failure";
      setup.error = error && error.message === "invalid_composio_project_key"
        ? "That project key was not accepted. Check it in Composio and try again."
        : connectorSettingsErrorMessage(error, "Managed connector setup could not finish. Try again.");
      render();
    });
  }

  function connectorSettingsErrorMessage(error, fallback) {
    return error && error.serverMessage ? error.serverMessage : fallback;
  }

  function loadGithubStatus(generation) {
    var requestId = ++state.githubStatusRequestId;
    state.githubError = "";
    return api("/admin/api/github/status").then(function (body) {
      if (requestId !== state.githubStatusRequestId || !settingsLoadIsCurrent(generation)) return;
      state.githubStatus = body;
      state.githubStatusLoaded = true;
      state.githubBusy = "";
    }).catch(function (error) {
      if (requestId !== state.githubStatusRequestId || !settingsLoadIsCurrent(generation)) return;
      state.githubStatusLoaded = true;
      state.githubBusy = "";
      state.githubError = (error && (error.serverMessage || error.message)) || "Could not load GitHub settings.";
    });
  }

  function repositoryGrantHash(value) {
    var hash = 2166136261;
    var input = String(value || "");
    for (var index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
  }

  function uniqueRepositoryGrantId(fullName, installationId, usedIds) {
    var source = String(installationId);
    var slug = String(fullName || "all").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "repository";
    var base = "repo_" + source + "_" + slug + "_" + repositoryGrantHash(source + ":" + fullName);
    var candidate = base.slice(0, 128);
    var suffix = 2;
    while (usedIds.has(candidate)) {
      var ending = "_" + suffix;
      candidate = base.slice(0, 128 - ending.length) + ending;
      suffix += 1;
    }
    return candidate;
  }

  function focusInputAtEnd(inputId) {
    var input = document.getElementById(inputId);
    if (!input || !input.focus) return;
    input.focus();
    if (input.setSelectionRange) {
      var end = String(input.value || "").length;
      try { input.setSelectionRange(end, end); } catch (error) { /* ignore */ }
    }
  }

  function focusRepositorySearch() {
    if (state.profileTab !== "repositories") return;
    focusInputAtEnd("repo-picker-search");
  }

  function openRepositoryPicker(installationId, accountLogin) {
    if (!state.profileDraft) return;
    var selected = Array.from(new Set((state.profileDraft.repositories || []).filter(function (grant) {
      return grant.enabled && grant.allRepos !== true && repositoryGrantMatchesPicker(grant, {
        installationId: installationId,
        accountLogin: accountLogin
      });
    }).map(function (grant) { return grant.fullName; })));
    resetRepositoryTransientState();
    state.repositoryPicker = {
      installationId: installationId,
      accountLogin: accountLogin,
      query: "",
      repos: [],
      totalCount: 0,
      truncated: false,
      selectedFullNames: selected,
      loading: true,
      error: "",
      requestId: 0
    };
    repoPickerSearch.load();
  }

  function openRepositoryAdd() {
    var status = state.githubStatus;
    if (!status || status.mode !== "app") return;
    var installations = status.installations || [];
    if (installations.length === 1) {
      openRepositoryPicker(Number(installations[0].id), installations[0].accountLogin);
      return;
    }

    resetRepositoryTransientState();
    state.repositoryAddOpen = true;
    render();
  }

  function closeRepositoryPicker() {
    resetRepositoryTransientState();
    render();
  }

  function applyRepositoryPicker() {
    var picker = state.repositoryPicker;
    var draft = state.profileDraft;
    if (!picker || !draft) return;
    var selected = Array.from(new Set(picker.selectedFullNames || []));
    if (selected.length > 200) return;
    var current = draft.repositories || [];
    var sameSource = function (grant) {
      // The All-repositories toggle owns allRepos rows; Manage → Apply must
      // never silently replace one with an explicit (possibly empty) list.
      return grant.allRepos !== true && repositoryGrantMatchesPicker(grant, picker);
    };
    var retained = current.filter(function (grant) { return !sameSource(grant); });
    if (retained.length + selected.length > 200) return;
    var next = retained.slice();
    var usedIds = new Set(next.map(function (grant) { return grant.id; }));
    var priorByName = new Map();
    current.forEach(function (grant) {
      if (sameSource(grant) && grant.allRepos !== true) priorByName.set(grant.fullName, grant);
    });
    selected.forEach(function (fullName) {
      var prior = priorByName.get(fullName);
      // An older unbound selection may only be bound to the installation once
      // this picker session has SEEN the repo in its listing. Otherwise the App
      // may not have access, so the unconfirmed row keeps its prior shape.
      if (
        picker.installationId !== null &&
        prior && prior.installationId === null &&
        !(picker.seenFullNames && picker.seenFullNames[fullName])
      ) {
        usedIds.add(prior.id);
        next.push(prior);
        return;
      }
      var accountLogin = picker.accountLogin;
      var id = prior ? prior.id : uniqueRepositoryGrantId(fullName, picker.installationId, usedIds);
      usedIds.add(id);
      next.push({
        id: id,
        installationId: picker.installationId,
        accountLogin: accountLogin,
        fullName: fullName,
        enabled: true
      });
    });
    draft.repositories = next;
    resetRepositoryTransientState();
    markProfileDirty();
    render();
    // Apply reads as a commit but only edits the draft — pulse the save bar
    // every time, even when the draft was already dirty.
    cueSaveBar();
  }

  function removeRepositoryGrant(id) {
    if (!state.profileDraft) return;
    var repositories = state.profileDraft.repositories || [];
    var next = repositories.filter(function (grant) { return grant.id !== id; });
    if (next.length === repositories.length) return;
    state.profileDraft.repositories = next;
    markProfileDirty();
    render();
  }

  function toggleAllRepositories(installationId, accountLogin, checked) {
    if (!state.profileDraft || !Number.isInteger(installationId) || installationId < 1) return;
    var current = state.profileDraft.repositories || [];
    if (checked) {
      var retained = current.filter(function (grant) { return grant.installationId !== installationId; });
      var usedIds = new Set(retained.map(function (grant) { return grant.id; }));
      retained.push({
        id: uniqueRepositoryGrantId("all", installationId, usedIds),
        installationId: installationId,
        accountLogin: accountLogin,
        fullName: "",
        allRepos: true,
        enabled: true
      });
      state.profileDraft.repositories = retained;
    } else {
      state.profileDraft.repositories = current.filter(function (grant) {
        return !(grant.installationId === installationId && grant.allRepos === true);
      });
    }
    markProfileDirty();
    render();
  }

  function refreshGithubStatus() {
    if (state.githubBusy) return;
    state.githubBusy = "refresh";
    state.githubError = "";
    render();
    loadGithubStatus().then(render);
  }

  function submitGithubManifest(formData) {
    if (state.githubBusy) return;
    var org = String(formData.get("org") || "").trim();
    var targetName = "chickpea-github-manifest-" + Date.now();
    var manifestWindow = null;
    if (typeof window !== "undefined" && typeof window.open === "function") {
      manifestWindow = window.open("", targetName);
      if (manifestWindow) manifestWindow.opener = null;
    }
    state.githubOrg = org;
    state.githubBusy = "manifest";
    state.githubError = "";
    render();
    postJson("/admin/api/github/manifest", "POST", org ? { org: org } : {}).then(function (body) {
      if (!body || typeof body.target !== "string" || !body.manifest) throw new Error("GitHub manifest response was invalid.");
      var form = document.createElement("form");
      form.method = "post";
      form.action = body.target;
      form.target = manifestWindow ? targetName : "_blank";
      form.style.display = "none";
      var input = document.createElement("input");
      input.type = "hidden";
      input.name = "manifest";
      input.value = JSON.stringify(body.manifest);
      form.appendChild(input);
      (document.body || document.documentElement).appendChild(form);
      form.submit();
      if (form.remove) form.remove();
      state.githubBusy = "";
      state.githubManifestOpen = false;
      state.githubError = "";
      render();
    }).catch(function (error) {
      if (manifestWindow && typeof manifestWindow.close === "function") manifestWindow.close();
      state.githubBusy = "";
      state.githubError = (error && (error.serverMessage || error.message)) || "Could not start GitHub App setup.";
      render();
    });
  }

  function disconnectGithub() {
    if (state.githubBusy) return;
    state.githubStatusRequestId += 1;
    state.githubBusy = "disconnect";
    state.githubDisconnectError = "";
    render();
    api("/admin/api/github", { method: "DELETE" }).then(function () {
      state.githubBusy = "";
      state.githubDisconnectConfirm = false;
      state.githubDisconnectError = "";
      state.githubManifestOpen = false;
      state.githubStatus = null;
      state.githubStatusLoaded = false;
      render();
      return loadGithubStatus().then(render);
    }).catch(function (error) {
      state.githubBusy = "";
      state.githubDisconnectError = (error && (error.serverMessage || error.message)) || "Could not disconnect GitHub.";
      render();
    });
  }

  function loadSettings(generation) {
    var requestId = ++state.providerSettingsRequestId;
    state.settingsError = "";
    return api("/admin/api/providers").then(function (body) {
      if (requestId !== state.providerSettingsRequestId || !settingsLoadIsCurrent(generation)) return;
      state.settings = body;
      state.settingsLoaded = true;
      // Load favorites + the live model lists for the curated providers so their
      // managers render metas and counts. OpenRouter's list is public (no key);
      // Workers AI needs the binding, present only on the Cloudflare target.
      loadFavorites("openrouter");
      loadProviderModels("openrouter");
      if (IS_CLOUDFLARE) {
        loadFavorites("workers-ai");
        loadProviderModels("workers-ai");
      }
    }).catch(function (error) {
      if (requestId !== state.providerSettingsRequestId || !settingsLoadIsCurrent(generation)) return;
      state.settingsError = error.message;
      state.settingsLoaded = true;
    });
  }

  function loadModelCatalogStatus(generation) {
    var requestId = ++state.modelCatalogRequestId;
    state.modelCatalogError = "";
    return api("/admin/api/model-catalog").then(function (body) {
      if (requestId !== state.modelCatalogRequestId || !settingsLoadIsCurrent(generation)) return;
      state.modelCatalog = body;
      state.modelCatalogLoaded = true;
    }).catch(function (error) {
      if (requestId !== state.modelCatalogRequestId || !settingsLoadIsCurrent(generation)) return;
      state.modelCatalogLoaded = true;
      state.modelCatalogError = (error && (error.serverMessage || error.message)) || "Could not load the model list status.";
    });
  }

  function refreshModelCatalogFromSettings() {
    if (state.modelCatalogBusy) return;
    var requestId = ++state.modelCatalogRequestId;
    state.modelCatalogBusy = true;
    state.modelCatalogError = "";
    render();
    postJson("/admin/api/model-catalog/refresh", "POST", {}).then(function (body) {
      if (requestId !== state.modelCatalogRequestId) {
        state.modelCatalogBusy = false;
        render();
        return;
      }
      state.modelCatalogBusy = false;
      state.modelCatalogLoaded = true;
      state.modelCatalog = body.catalog || state.modelCatalog;
      if (body.refresh && body.refresh.status === "failed") {
        state.modelCatalogError = state.modelCatalog && state.modelCatalog.source === "hosted"
          ? "Refresh failed. Still using hosted catalog revision " + Number(state.modelCatalog.revision || 0) + "."
          : "Refresh failed. Still using the bundled model list.";
      } else if (body.refresh && body.refresh.status === "restart_required") {
        state.modelCatalogError = "The new model list is saved. Restart Chickpea to activate it.";
      }
      state.providerModels.openai = null;
      state.providerModels.anthropic = null;
      state.providerModelsError.openai = false;
      state.providerModelsError.anthropic = false;
      render();
      return refreshModels().then(render);
    }).catch(function (error) {
      if (requestId !== state.modelCatalogRequestId) {
        state.modelCatalogBusy = false;
        render();
        return;
      }
      state.modelCatalogBusy = false;
      state.modelCatalogError = (error && (error.serverMessage || error.message)) || "Could not refresh the model list.";
      render();
    });
  }

  function invalidateOpenAiProviderModels() {
    state.providerModels.openai = null;
    state.providerModelsError.openai = false;
    favUiFor("openai").error = "";
  }

  function seedEgressDraft(policy) {
    var domains = (policy.domains || []).slice();
    if (policy.mode === "allowlist" && domains.length === 0) domains.push("");
    egressDraft = { mode: policy.mode, domains: domains };
  }

  function loadEgress(generation) {
    state.egressError = "";
    return api("/admin/api/egress").then(function (body) {
      if (!settingsLoadIsCurrent(generation)) return;
      state.egress = body.policy;
      seedEgressDraft(body.policy);
      state.egressLoaded = true;
    }).catch(function (error) {
      if (!settingsLoadIsCurrent(generation)) return;
      state.egressError = (error && (error.serverMessage || error.message)) || "Could not load outbound access.";
      state.egressLoaded = true;
    });
  }

  function seedSandboxDraft(status) {
    sandboxDraft = {
      allowedHosts: (status.allowedHosts || []).slice(),
      monthlySessionCap: status.monthlySessionCapConfigured === false
        ? 200
        : (Number.isSafeInteger(status.monthlySessionCap) ? status.monthlySessionCap : 200)
    };
  }

  function loadSandboxStatus(generation) {
    state.sandboxError = "";
    return api("/admin/api/sandbox/status").then(function (body) {
      if (!settingsLoadIsCurrent(generation)) return;
      state.sandboxStatus = body;
      seedSandboxDraft(body);
      state.sandboxLoaded = true;
    }).catch(function (error) {
      if (!settingsLoadIsCurrent(generation)) return;
      state.sandboxStatus = null;
      state.sandboxError = (error && (error.serverMessage || error.message)) || "Could not load sandbox settings.";
      state.sandboxLoaded = true;
    });
  }

  function mutationErrorText(error, fallback) {
    return (error && (error.serverMessage || error.message)) || fallback;
  }

  function applySandboxStatus(body) {
    state.sandboxStatus = body;
    seedSandboxDraft(body);
  }

  function requestSandboxInstall() {
    if (state.sandboxSaving) return;
    state.sandboxSaving = "install";
    state.sandboxError = "";
    state.sandboxNotice = "";
    render();
    postJson("/admin/api/sandbox/install", "POST", {}).then(function (body) {
      applySandboxStatus(body);
      state.sandboxSaving = false;
      state.sandboxConfirm = "";
      state.sandboxNotice = "Installation requested. Redeploy required.";
      render();
    }).catch(function (error) {
      state.sandboxSaving = false;
      state.sandboxError = mutationErrorText(error, "Could not request Sandbox installation.");
      render();
    });
  }

  function cancelSandboxInstall() {
    if (state.sandboxSaving) return;
    var clearingSavedState = !!(state.sandboxStatus && state.sandboxStatus.storedEnabled && !state.sandboxStatus.installRequested);
    state.sandboxSaving = "cancel";
    state.sandboxError = "";
    state.sandboxNotice = "";
    render();
    api("/admin/api/sandbox/install", { method: "DELETE" }).then(function (body) {
      applySandboxStatus(body);
      state.sandboxSaving = false;
      state.sandboxNotice = clearingSavedState
        ? "Saved Sandbox state cleared. Coding Sandbox remains off."
        : "Installation request canceled. Coding Sandbox remains off.";
      render();
    }).catch(function (error) {
      state.sandboxSaving = false;
      state.sandboxError = mutationErrorText(error, "Could not cancel the installation request.");
      render();
    });
  }

  function checkSandboxInstall() {
    if (state.sandboxSaving) return;
    state.sandboxSaving = "check";
    state.sandboxError = "";
    state.sandboxNotice = "";
    render();
    api("/admin/api/sandbox/status").then(function (body) {
      applySandboxStatus(body);
      state.sandboxSaving = false;
      state.sandboxNotice = body.installed
        ? "Coding Sandbox installation found."
        : "No Sandbox binding yet. Finish the Cloudflare redeploy and check again.";
      render();
    }).catch(function (error) {
      state.sandboxSaving = false;
      state.sandboxError = mutationErrorText(error, "Could not check Sandbox installation.");
      render();
    });
  }

  function putSandbox(enabled, readinessConfirmed, action) {
    if (state.sandboxSaving) return;
    state.sandboxSaving = action;
    state.sandboxError = "";
    state.sandboxNotice = "";
    render();
    var body = {
      enabled: enabled,
      allowedHosts: sandboxDraft.allowedHosts.slice(),
      monthlySessionCap: sandboxDraft.monthlySessionCap
    };
    if (readinessConfirmed) body.readinessConfirmed = true;
    postJson("/admin/api/sandbox/status", "PUT", body).then(function (result) {
      applySandboxStatus(result);
      state.sandboxSaving = false;
      state.sandboxConfirm = "";
      state.sandboxReadyAttested = false;
      state.sandboxError = "";
      state.sandboxNotice = action === "enable"
        ? "Coding Sandbox enabled."
        : action === "disable"
          ? "Coding Sandbox disabled. Container infrastructure remains installed."
          : "Advanced Sandbox settings saved.";
      render();
    }).catch(function (error) {
      state.sandboxSaving = false;
      state.sandboxError = mutationErrorText(error, "Could not save Sandbox settings.");
      render();
    });
  }

  function saveSandbox() {
    if (state.sandboxSaving) return;
    state.sandboxSaving = "advanced";
    state.sandboxError = "";
    state.sandboxNotice = "";
    render();
    postJson("/admin/api/sandbox/status", "PATCH", {
      allowedHosts: sandboxDraft.allowedHosts.slice(),
      monthlySessionCap: sandboxDraft.monthlySessionCap
    }).then(function (result) {
      applySandboxStatus(result);
      state.sandboxSaving = false;
      state.sandboxError = "";
      state.sandboxNotice = "Advanced Sandbox settings saved.";
      render();
    }).catch(function (error) {
      state.sandboxSaving = false;
      state.sandboxError = mutationErrorText(error, "Could not save Sandbox settings.");
      render();
    });
  }

  function saveEgress() {
    if (state.egressSaving) return;
    var domains = egressDraft.domains.map(function (domain) { return domain.trim(); }).filter(Boolean);
    state.egressSaving = true;
    state.egressError = "";
    render();
    postJson("/admin/api/egress", "PUT", { mode: egressDraft.mode, domains: domains }).then(function (body) {
      state.egress = body.policy;
      seedEgressDraft(body.policy);
      state.egressSaving = false;
      state.egressError = "";
      render();
    }).catch(function (error) {
      state.egressSaving = false;
      state.egressError = (error && (error.serverMessage || error.message)) || "Could not save outbound access.";
      render();
    });
  }

  function loadFavorites(id) {
    return api("/admin/api/providers/" + encodeURIComponent(id) + "/favorites").then(function (body) {
      state.favorites[id] = body.favorites || [];
      if (state.view === "settings") render();
      else if (state.modelPickerOpen) renderPreservingPagePosition();
    }).catch(function () { /* keep prior favorites on failure */ });
  }

  function favModelsErrorText(id, error) {
    if (error && error.message === "workers_ai_credentials_required") {
      return "Workers AI needs the binding (or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID) to list models.";
    }
    return "Couldn't load the live model list. Try reopening Settings.";
  }

  function loadProviderModels(id) {
    return api("/admin/api/providers/" + encodeURIComponent(id) + "/models").then(function (body) {
      state.providerModels[id] = body.models || [];
      state.providerModelsError[id] = false;
      favUiFor(id).error = "";
      if (state.view === "settings") render();
      else if (state.modelPickerOpen) renderPreservingPagePosition();
    }).catch(function (error) {
      // Mark the fetch failed so the picker falls back to the provider's static
      // suggestions for this provider (offline), and the Settings manager shows
      // its own error string.
      state.providerModelsError[id] = true;
      favUiFor(id).error = favModelsErrorText(id, error);
      if (state.view === "settings") render();
      else if (state.modelPickerOpen) renderPreservingPagePosition();
    });
  }

  function refreshModelsRequired() {
    return api("/admin/api/models").then(function (body) { state.models = body; });
  }

  function refreshModels() {
    return refreshModelsRequired().catch(function () {});
  }

  function refreshWorkersAiModels() {
    var ui = provUiFor("workers-ai");
    if (ui.enabledBusy) return;
    ui.enabledBusy = true;
    ui.enabledError = "";
    ui.enabledRetry = false;
    render();
    return refreshModelsRequired().then(function () {
      ui.enabledBusy = false;
      ui.enabledError = "";
      ui.enabledRetry = false;
      render();
    }).catch(function () {
      ui.enabledBusy = false;
      ui.enabledError = "Workers AI is on, but its model suggestions could not be refreshed. Try again or reload this page.";
      ui.enabledRetry = true;
      render();
    });
  }

  function setWorkersAiEnabled(enabled) {
    var ui = provUiFor("workers-ai");
    if (ui.enabledBusy) return;
    // A providers GET started before this mutation must not overwrite the
    // confirmed response when it eventually resolves.
    state.providerSettingsRequestId += 1;
    ui.enabledBusy = true;
    ui.enabledError = "";
    ui.enabledRetry = false;
    render();
    postJson("/admin/api/providers/workers-ai/enabled", "PUT", { enabled: enabled }).then(function (body) {
      ui.enabledBusy = false;
      var summary = providerSummaryById("workers-ai");
      if (summary) summary.enabled = body.enabled;
      if (!body.enabled && state.models && state.models.providers) {
        state.models.providers = state.models.providers.filter(function (provider) { return provider.id !== "cloudflare"; });
        render();
        return;
      }
      return refreshWorkersAiModels();
    }).catch(function (error) {
      ui.enabledBusy = false;
      ui.enabledError = mutationErrorText(error, "Could not update Workers AI.");
      render();
    });
  }

  // Open the profile Model combobox (F6) and lazily fetch the dynamic lists it
  // renders (F5): the FULL model list for anthropic/openai and the starred
  // favorites for openrouter/workers-ai. The picker can open without ever
  // visiting Settings, so it kicks its own loads here, guarded so nothing
  // re-fetches. loadProviderModels/loadFavorites re-render while the picker is
  // open (state.modelPickerOpen).
  function openModelPicker() {
    if (state.modelPickerOpen) return;
    state.modelPickerOpen = true;
    state.modelPickerFilter = "";
    (state.models && state.models.providers ? state.models.providers : []).forEach(function (provider) {
      if (!provider.configured) return;
      var adminId = pickerAdminIdFor(provider.id);
      if (adminId == null) return;
      if (adminId === "anthropic" || adminId === "openai") {
        if (state.providerModels[adminId] == null) loadProviderModels(adminId);
      } else if (adminId === "openrouter" || adminId === "workers-ai") {
        // Favorites drive these groups; the model list is only needed by the
        // Settings favorites manager, not the picker, so load favorites only.
        if (state.favorites[adminId] == null) loadFavorites(adminId);
      }
    });
    renderPreservingPagePosition();
  }

  function closeModelPicker() {
    if (!state.modelPickerOpen) return;
    state.modelPickerOpen = false;
    state.modelPickerFilter = "";
    renderPreservingPagePosition();
  }

  // A keystroke in the Model input both pins the free-text value (draft) and
  // narrows the open picker to matching specifiers (F6 filter). Typing opens the
  // picker if it was closed. The shared in-place renderer preserves the input's
  // focus and caret across both this render and later async model-list renders.
  function filterModelPicker(target) {
    state.profileDraft.model = target.value;
    state.modelPickerFilter = target.value;
    markProfileDirty();
    if (!state.modelPickerOpen) { openModelPicker(); return; }
    renderPreservingPagePosition();
  }

  function openProviderPaste(id, mode) {
    var ui = provUiFor(id);
    ui.open = true;
    ui.mode = mode;
    ui.error = "";
    ui.raw = "";
    ui.removeOpen = false;
    render();
  }

  function closeProviderPaste(id) {
    var ui = provUiFor(id);
    ui.open = false;
    ui.error = "";
    ui.raw = "";
    ui.key = "";
    render();
  }

  function openProviderRemove(id) {
    var ui = provUiFor(id);
    ui.removeOpen = true;
    ui.removeError = "";
    ui.open = false;
    render();
  }

  function closeProviderRemove(id) {
    var ui = provUiFor(id);
    ui.removeOpen = false;
    ui.removeError = "";
    render();
  }

  function applyProviderKeyError(id, ui, error) {
    var meta = providerMeta(id);
    var code = error && error.message;
    if (code === "provider_key_rejected") {
      ui.error = meta.name + " rejected the key. Nothing was stored — re-copy it and try again.";
      var status = error.providerStatus != null ? error.providerStatus : "";
      ui.raw = validateEndpointPath(id) + " → " + (status ? status + " " : "") + (error.detail || "");
    } else if (code === "provider_unreachable") {
      ui.error = "Couldn't reach " + meta.name + " to validate the key. Check the connection and try again — nothing was stored.";
      ui.raw = "";
    } else if (code === "provider_models_failed" || code === "provider_key_missing") {
      ui.error = meta.name + " accepted the request but its model list failed to load. Nothing was stored — try again.";
      ui.raw = "";
    } else if (code === "provider_key_read_only") {
      ui.error = "An environment variable already provides this key, so it is read-only here.";
      ui.raw = "";
    } else {
      ui.error = (error && (error.serverMessage || error.message)) || "Could not validate the key.";
      ui.raw = "";
    }
  }

  function validateProviderKey(id) {
    var ui = provUiFor(id);
    var key = (ui.key || "").trim();
    if (!key) { ui.error = "Paste a key first."; ui.raw = ""; render(); return; }
    ui.busy = true;
    ui.error = "";
    ui.raw = "";
    render();
    postJson("/admin/api/providers/" + encodeURIComponent(id) + "/key", "POST", { key: key }).then(function () {
      ui.busy = false;
      ui.open = false;
      ui.key = "";
      ui.error = "";
      ui.raw = "";
      if (id === "openai") invalidateOpenAiProviderModels();
      // Refresh the provider list (status → Stored + count) and the picker's
      // suggestion source; the validate call primed the server model cache.
      return loadSettings().then(function () { refreshModels(); render(); });
    }).catch(function (error) {
      ui.busy = false;
      applyProviderKeyError(id, ui, error);
      render();
    });
  }

  function removeProviderKey(id) {
    var ui = provUiFor(id);
    api("/admin/api/providers/" + encodeURIComponent(id) + "/key", { method: "DELETE" }).then(function () {
      ui.removeOpen = false;
      ui.removeError = "";
      ui.open = false;
      ui.key = "";
      if (id === "openai") invalidateOpenAiProviderModels();
      return loadSettings().then(function () { refreshModels(); render(); });
    }).catch(function (error) {
      ui.removeError = (error && (error.serverMessage || error.message)) || "Could not remove the key.";
      render();
    });
  }

  function updateFavSearch(id, value) {
    favUiFor(id).query = value;
    // Re-render only the results container so the search input keeps focus.
    var container = document.getElementById("fav-results-" + id);
    if (container) container.innerHTML = favResultsHtml(id);
  }

  function toggleFavorite(id, model) {
    var current = favoritesFor(id).slice();
    var idx = current.indexOf(model);
    if (idx >= 0) current.splice(idx, 1);
    else current.push(model);
    // Optimistic update so the star flips immediately; persist, then reconcile.
    state.favorites[id] = current;
    render();
    postJson("/admin/api/providers/" + encodeURIComponent(id) + "/favorites", "PUT", { favorites: current }).then(function (body) {
      state.favorites[id] = body.favorites || current;
      refreshModels();
      render();
    }).catch(function () {
      // Reload the authoritative set so a failed write doesn't leave a wrong star.
      loadFavorites(id);
    });
  }

  function enabledBadge(enabled) {
    return '<span class="badge ' + (enabled ? "badge-on" : "badge-off") + '" style="margin-left:6px;"><span class="dot"></span>' + (enabled ? "Enabled" : "Disabled") + '</span>';
  }

  function modelLabel(agent) {
    return agent.model || "No model pinned";
  }

  function instructionLayersHtml(layers) {
    return layers.map(function (layer) {
      var ember = layer.source === "channel";
      var label = String(layer.label || "").toLowerCase() === "profile" ? "Agent" : layer.label;
      return '<span class="layer-tag ' + (ember ? "ember" : "") + '">' + esc(label) + '</span><span class="' + (ember ? "from-addendum" : "") + '">' + esc(layer.text) + '</span>';
    }).join("");
  }

  function providerBadges() {
    return state.models.providers.map(function (provider) {
      return '<span class="badge ' + (provider.configured ? "badge-on" : "badge-off") + '"><span class="dot"></span>' + esc(provider.id) + '</span>';
    }).join("");
  }

  function shortHash(hash) {
    return hash ? hash.slice(0, 6) + "..." + hash.slice(-4) : "pending";
  }

  function newProfileDraft() {
    // A blank profile starts empty (name + instructions are required, so the
    // ghost-example placeholder shows until the operator writes them).
    return {
      id: "",
      revision: 1,
      name: "",
      description: "",
      handle: "",
      editPolicy: "creator_and_admins",
      instructions: "",
      enabled: true,
      model: "",
      // New profiles carry no custom skills; the array is what the API persists.
      skills: [],
      // New profiles carry no Connections either; the array is what the API persists.
      mcpServers: [],
      apiConnections: [],
      repositories: [],
      pendingSecrets: {},
      removedConnections: [],
      pendingApiSecrets: {},
      removedApiConnections: []
    };
  }

  function cloneAgent(agent) {
    return {
      id: agent.id,
      revision: Number.isInteger(agent.revision) ? agent.revision : 1,
      name: agent.name,
      description: agent.description || "",
      handle: (agent.slackPresence && agent.slackPresence.requestedHandle) || handleFromAgentName(agent.name),
      editPolicy: agent.editPolicy || "creator_and_admins",
      lifecycle: agent.lifecycle || (agent.enabled ? "active" : "archived"),
      slackPresence: agent.slackPresence ? JSON.parse(JSON.stringify(agent.slackPresence)) : null,
      slackPresenceRecovery: agent.slackPresenceRecovery || null,
      whereItWorks: agent.whereItWorks ? JSON.parse(JSON.stringify(agent.whereItWorks)) : null,
      isWorkspaceDefault: !!agent.isWorkspaceDefault,
      canEdit: agent.canEdit !== false,
      instructions: agent.instructions,
      enabled: agent.enabled,
      model: agent.model || "",
      // Deep-copy each skill so the inline editor never mutates the shared
      // state.agents entry — a discard/reopen must show the persisted values.
      skills: (agent.skills || []).map(function (skill) {
        var copy = { name: skill.name, description: skill.description, instructions: skill.instructions, enabled: skill.enabled };
        if (skill.suggestedSkillId !== undefined) copy.suggestedSkillId = skill.suggestedSkillId;
        return copy;
      }),
      // Deep-copy each connection (policy only — never a secret) so the inline
      // editor never mutates the shared state.agents entry.
      mcpServers: (agent.mcpServers || []).map(cloneConnection),
      apiConnections: (agent.apiConnections || []).map(cloneApiConnection),
      repositories: (agent.repositories || []).map(function (grant) {
        var copy = {
          id: grant.id,
          installationId: grant.installationId,
          accountLogin: grant.accountLogin,
          fullName: grant.fullName,
          enabled: !!grant.enabled
        };
        if (grant.allRepos !== undefined) copy.allRepos = grant.allRepos;
        return copy;
      }),
      deletion: agent.deletion || null,
      pendingSecrets: {},
      removedConnections: [],
      pendingApiSecrets: {},
      removedApiConnections: []
    };
  }

  // Deep-copy one connection's POLICY fields (secrets never live in the agent
  // list). discoveredTools/allowedTools/headerNames are fresh arrays so an editor
  // never reaches through to the shared state.agents entry.
  function cloneConnection(conn) {
    var copy = {
      id: conn.id,
      displayName: conn.displayName,
      url: conn.url,
      transport: conn.transport || "streamable-http",
      authMode: conn.authMode || "none",
      headerNames: (conn.headerNames || []).slice(),
      enabled: !!conn.enabled,
      lifecycleStatus: conn.lifecycleStatus || "pending",
      statusText: conn.statusText || "",
      discoveredTools: (conn.discoveredTools || []).map(function (tool) {
        var t = { name: tool.name };
        if (tool.title !== undefined) t.title = tool.title;
        if (tool.description !== undefined) t.description = tool.description;
        return t;
      }),
      allowedTools: (conn.allowedTools || []).slice()
    };
    if (conn.oauthScope !== undefined) copy.oauthScope = conn.oauthScope;
    if (conn.lastCheckedAt !== undefined) copy.lastCheckedAt = conn.lastCheckedAt;
    if (conn.identity !== undefined) {
      copy.identity = {
        workspaceName: conn.identity.workspaceName,
        accountName: conn.identity.accountName
      };
    }
    if (conn.presetId !== undefined) copy.presetId = conn.presetId;
    return copy;
  }

  function cloneApiConnection(conn) {
    var copy = {
      id: conn.id,
      displayName: conn.displayName,
      allowedHosts: (conn.allowedHosts || []).slice(),
      pathPrefixes: (conn.pathPrefixes || []).slice(),
      headerName: conn.headerName,
      allowedMethods: (conn.allowedMethods || []).slice(),
      enabled: !!conn.enabled
    };
    if (conn.headerValuePrefix !== undefined) copy.headerValuePrefix = conn.headerValuePrefix;
    if (conn.presetId !== undefined) copy.presetId = conn.presetId;
    if (conn.authMode !== undefined) copy.authMode = conn.authMode;
    if (conn.oauthProvider !== undefined) copy.oauthProvider = conn.oauthProvider;
    if (conn.oauthScopes !== undefined) copy.oauthScopes = conn.oauthScopes.slice();
    if (conn.oauthAppType !== undefined) copy.oauthAppType = conn.oauthAppType;
    if (conn.lifecycleStatus !== undefined) copy.lifecycleStatus = conn.lifecycleStatus;
    if (conn.statusText !== undefined) copy.statusText = conn.statusText;
    if (conn.identity !== undefined) {
      copy.identity = {
        workspaceName: conn.identity.workspaceName,
        accountName: conn.identity.accountName
      };
    }
    // Server-resolved write-only credential source (stored/env/missing); carried
    // through so the editor reflects the real state, not a persisted-policy guess.
    if (conn.credentialSource !== undefined) copy.credentialSource = conn.credentialSource;
    if (conn.oauthClientSource !== undefined) copy.oauthClientSource = conn.oauthClientSource;
    if (conn.oauthTokenSource !== undefined) copy.oauthTokenSource = conn.oauthTokenSource;
    return copy;
  }

  function modelWarning(model) {
    if (!model || model.indexOf("/") < 1) return "";
    var provider = model.slice(0, model.indexOf("/"));
    var entry = state.models.providers.find(function (item) { return item.id === provider; });
    if (!entry) return "Free text accepted; provider not detected in this install.";
    if (provider === "openai" && entry.authMethods && entry.authMethods.activeMethod === "subscription") {
      if ((entry.suggestions || []).indexOf(model) < 0) {
        return "This OpenAI model is not available through the selected ChatGPT subscription.";
      }
      if (!entry.configured) {
        return "The selected ChatGPT subscription is not connected — OpenAI calls will fail until it is connected in Settings.";
      }
      return "";
    }
    // Known provider, no key: the pin will save, but every reply fails with a
    // sanitized provider error — say so here instead of letting it surprise.
    if (!entry.configured) return "No key for this provider yet — replies with this model will fail until one is added in Settings.";
    return "";
  }

  function slugId(name) {
    var slug = String(name || "profile").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!slug) slug = "profile";
    var id = "agent_" + slug;
    if (!agentById(id)) return id;
    return id + "_" + Date.now().toString(36);
  }

  // Bring a capability tab into view after a validation failure elsewhere on
  // the page, so the inline error is never hidden behind an inactive tab.
  function showProfileTab(tab) {
    var changed = state.profileTab !== tab;
    if (changed) {
      if (tab !== "skills") resetSkillImportBrowseTransientState();
      state.profileTab = tab;
      render();
    }
    if (changed && tab === "repositories" && !state.githubStatusLoaded) {
      loadGithubStatus().then(render);
    }
  }

  function collectProfileDraft() {
    var draft = state.profileDraft || newProfileDraft();
    var nameInput = document.getElementById("p-name");
    var handleInput = document.getElementById("p-handle");
    var descriptionInput = document.getElementById("p-description");
    var modelInput = document.getElementById("p-model");
    var instructionsInput = document.getElementById("p-instr");
    if (nameInput) draft.name = nameInput.value.trim();
    if (handleInput) draft.handle = handleInput.value.trim();
    if (descriptionInput) draft.description = descriptionInput.value.trim();
    if (modelInput) draft.model = modelInput.value.trim();
    if (instructionsInput) draft.instructions = instructionsInput.value.trim();
    state.profileDraft = draft;
    return draft;
  }

  // Profile edit dirty tracking mirrors the channel save bar: keystroke updates
  // skip a full render to preserve textarea focus, so the Save/Discard disabled
  // state is synced directly. On the create screen there is no Discard and the
  // primary button always stays enabled.
  function markProfileDirty() {
    var wasDirty = state.profileDirty;
    state.profileDirty = true;
    var discard = document.querySelector('[data-action="discard-profile"]');
    if (discard) discard.disabled = false;
    if (state.profileScreen === "edit") {
      var save = document.querySelector('[data-action="save-profile"]');
      if (save) save.disabled = false;
      // Reveal the sticky save bar without a full render (which would drop
      // textarea focus). The classList guard keeps the fake-DOM test harness,
      // whose querySelector stub has no classList, from throwing.
      var stickyBar = document.querySelector(".save-bar-sticky");
      if (stickyBar && stickyBar.classList) { stickyBar.classList.remove("is-clean"); }
      // Announce the bar the moment editing starts; already-dirty keystrokes
      // stay quiet so typing doesn't strobe.
      if (!wasDirty) cueSaveBar();
    }
  }

  function saveBarCueActive() {
    return !!state.saveBarCueAt && Date.now() - state.saveBarCueAt < 1500;
  }

  // Draw the eye to the pinned save bar: mark the cue in state (so a render
  // inside the same interaction keeps it) and animate the live element for
  // no-render paths. The class is removed directly afterwards — never via a
  // render, which would drop focus.
  function cueSaveBar() {
    state.saveBarCueAt = Date.now();
    var bar = document.querySelector(".save-bar-sticky");
    if (bar && bar.classList) {
      bar.classList.remove("cue");
      void bar.offsetWidth;
      bar.classList.add("cue");
    }
    // The fake-DOM test harness has no timers; the cue then simply expires
    // via saveBarCueAt on the next render instead.
    if (typeof setTimeout !== "function") return;
    setTimeout(function () {
      var current = document.querySelector(".save-bar-sticky");
      if (current && current.classList) current.classList.remove("cue");
    }, 1600);
  }

  function selectActive(workspaceId, channelId) {
    state.channelScreen = "detail";
    state.active = { workspaceId: workspaceId, channelId: channelId };
    state.channelTryRequestId += 1;
    state.channelTryNotice = "";
    state.channelTryError = false;
    state.channelFormDraft.workspaceId = workspaceId || state.channelFormDraft.workspaceId;
    state.dirty = false;
    state.saveError = "";
    // The invite reminder belongs to the just-added channel; drop it when the
    // operator navigates elsewhere.
    state.addChannelInvite = "";
    render();
  }

  var onboardingPollTimer = null;
  var onboardingPollRequest = false;

  function onboardingResponseSignature(value) {
    if (!value) return "";
    return [value.revision, value.stage, value.tryStartedAt, value.completedAt, value.agentId, value.redirectTo].join("|");
  }

  function loadOnboarding(shouldRender) {
    return api("/admin/api/onboarding").then(function (body) {
      var previousStage = state.onboarding && state.onboarding.stage;
      var changed = onboardingResponseSignature(state.onboarding) !== onboardingResponseSignature(body) || !!state.onboardingError;
      state.onboarding = body;
      state.onboardingError = "";
      if (previousStage === "try" && body.stage === "complete") {
        var destination = agentById(body.agentId) || defaultAgent();
        if (destination) {
          openProfileEditor(destination);
          return body;
        }
      }
      if (shouldRender !== false && changed) render();
      return body;
    }).catch(function (error) {
      if (error && error.message === "onboarding_not_found") {
        state.onboarding = null;
        state.onboardingError = "This install does not have an active setup journey.";
      } else {
        state.onboardingError = (error && (error.serverMessage || error.message)) || "Could not load setup.";
      }
      if (shouldRender !== false) render();
      return null;
    });
  }

  function syncOnboardingActivity() {
    var choose = state.view === "onboarding" && state.onboarding && state.onboarding.stage === "choose_channel";
    if (choose && !state.onboardingSlackConnected && isSlackConnected() && !state.slackChannels && !state.slackChannelsLoading) {
      loadSlackChannels(false);
    }
    var shouldPoll = state.view === "onboarding" && state.onboarding &&
      state.onboarding.stage === "try" && !state.onboardingError;
    if (!shouldPoll) {
      if (onboardingPollTimer && typeof clearTimeout === "function") clearTimeout(onboardingPollTimer);
      onboardingPollTimer = null;
      return;
    }
    if (onboardingPollTimer || onboardingPollRequest || typeof setTimeout !== "function") return;
    onboardingPollTimer = setTimeout(function () {
      onboardingPollTimer = null;
      onboardingPollRequest = true;
      loadOnboarding(true).finally(function () {
        onboardingPollRequest = false;
        syncOnboardingActivity();
      });
    }, 2500);
  }

  function startOnboardingTry(formData) {
    if (state.onboardingBusy || !state.onboarding || state.onboarding.stage !== "choose_channel") return;
    var channelId = String(formData.get("channelSelect") || state.onboardingChannelSelected || "").trim();
    var channel = findSlackChannel(channelId);
    var workspace = state.onboarding.workspace;
    var agent = state.agents.find(function (candidate) { return candidate.id === "agent_default"; }) || defaultAgent();
    if (!channel) {
      state.onboardingError = "Choose a channel.";
      render();
      return;
    }
    if (!workspace || !workspace.id || !agent) {
      state.onboardingError = "Setup is missing its workspace or base Agent. Refresh and try again.";
      render();
      return;
    }
    state.onboardingBusy = true;
    state.onboardingError = "";
    render();
    publishAgentToChannel(agent.id, workspace.id, channel.id).then(function (result) {
      if (!result || !result.grant || result.grant.status !== "active") {
        state.onboardingBusy = false;
        state.onboardingError = "Chickpea could not finish publishing the Agent to #" + channel.name + ". Review the recovery steps and retry.";
        render();
        return null;
      }
      if (result.agent) applyAgentMutation(result.agent, ["whereItWorks", "slackPresence", "slackPresenceRecovery"]);
      return postJson("/admin/api/onboarding/try", "POST", {
        expectedRevision: state.onboarding.revision,
        workspaceId: workspace.id,
        channelId: channel.id,
        channelName: channel.name
      });
    }).then(function (body) {
      if (!body) return;
      state.onboarding = body;
      state.onboardingBusy = false;
      state.onboardingChannelSelected = "";
      state.onboardingNotice = "";
      render();
    }).catch(function (error) {
      state.onboardingBusy = false;
      state.onboardingError = addChannelErrorText(error);
      render();
    });
  }

  function proceedFromOnboardingTry() {
    if (state.onboardingBusy || !state.onboarding || state.onboarding.stage !== "try") return;
    state.onboardingBusy = true;
    state.onboardingError = "";
    render();
    postJson("/admin/api/onboarding/complete", "POST", {
      expectedRevision: state.onboarding.revision
    }).then(function (body) {
      state.onboarding = body;
      state.onboardingBusy = false;
      var destination = agentById(body.agentId) || defaultAgent();
      if (destination) openProfileEditor(destination);
      else render();
    }).catch(function (error) {
      state.onboardingBusy = false;
      state.onboardingError = (error && (error.serverMessage || error.message)) || "Could not open the dashboard.";
      render();
    });
  }

  function copyOnboardingPrompt() {
    var copyFailed = function () {
      state.onboardingNotice = "Copy failed. Select the prompt and copy it manually.";
      render();
    };
    if (!navigator.clipboard || !navigator.clipboard.writeText) { copyFailed(); return; }
    try {
      Promise.resolve(navigator.clipboard.writeText(ONBOARDING_PROMPT)).then(function () {
        state.onboardingNotice = "Prompt copied.";
        render();
      }).catch(copyFailed);
    } catch (_) { copyFailed(); }
  }

  function copyChannelPrompt() {
    var requestId = state.channelTryRequestId + 1;
    state.channelTryRequestId = requestId;
    var workspaceId = state.active && state.active.workspaceId;
    var channelId = state.active && state.active.channelId;
    var isCurrentChannel = function () {
      return state.channelTryRequestId === requestId &&
        state.active &&
        state.active.workspaceId === workspaceId &&
        state.active.channelId === channelId;
    };
    var copyFailed = function () {
      if (!isCurrentChannel()) return;
      state.channelTryNotice = "Copy failed. Select the prompt and copy it manually.";
      state.channelTryError = true;
      render();
    };
    if (!navigator.clipboard || !navigator.clipboard.writeText) { copyFailed(); return; }
    try {
      Promise.resolve(navigator.clipboard.writeText(ONBOARDING_PROMPT)).then(function () {
        if (!isCurrentChannel()) return;
        state.channelTryNotice = "Prompt copied.";
        state.channelTryError = false;
        render();
      }).catch(copyFailed);
    } catch (_) { copyFailed(); }
  }

  function refreshData(renderAfterRefresh) {
    return Promise.all([
      api("/admin/api/agents"),
      api("/admin/api/models"),
      // Resilient on purpose: the connection card is auxiliary — if this
      // endpoint fails, the rest of the admin page must still render.
      api("/admin/api/slack-connection").catch(function () { return null; }),
      api("/admin/api/slack-behavior").then(function (body) {
        return { body: body, error: "" };
      }).catch(function (error) {
        return { body: null, error: error.serverMessage || error.message || "Could not load Slack behavior." };
      }),
      api("/admin/api/onboarding").then(function (body) {
        return { body: body, error: "" };
      }).catch(function (error) {
        return {
          body: null,
          error: error && error.message === "onboarding_not_found"
            ? "This install does not have an active setup journey."
            : ((error && (error.serverMessage || error.message)) || "Could not load setup.")
        };
      }),
      api("/admin/api/channels").then(function (body) {
        return { channels: body.channels || [], error: "" };
      }).catch(function (error) {
        return { channels: [], error: (error && (error.serverMessage || error.message)) || "Could not load Channels." };
      })
    ]).then(function (parts) {
      state.agents = parts[0].agents || [];
      state.grants = [];
      state.models = parts[1];
      state.slack = parts[2];
      state.slackBehavior = parts[3].body;
      state.slackBehaviorError = parts[3].error;
      state.slackBehaviorBusy = "";
      state.onboarding = parts[4].body;
      state.onboardingError = parts[4].error;
      state.channelIndex = parts[5].channels;
      state.channelIndex.forEach(function (channel) {
        (channel.grants || []).forEach(function (grant) {
          state.grants.push(Object.assign({}, grant, {
            workspaceId: channel.workspaceId,
            channelId: channel.channelId,
            channelLabel: channel.channelName || channel.channelId
          }));
        });
      });
      state.channelIndexError = parts[5].error;
      syncChannelFormWorkspacePrefill();
      if (renderAfterRefresh) renderAfterRefresh();
      else render();
    }).catch(function (error) {
      document.querySelector(".main-inner").innerHTML = '<div class="empty"><p class="field-label">Admin failed to load</p><p class="error">' + esc(error.message) + '</p></div>';
    });
  }

  function publishAgentToChannel(agentId, workspaceId, channelId) {
    return postJson("/admin/api/agents/" + encodeURIComponent(agentId) + "/channels", "POST", {
      workspaceId: workspaceId,
      channelId: channelId
    });
  }

  // ---- pea mascot: eye tracking, proximity expression, click boop ----------
  // The tick re-queries .pea every frame because render() rebuilds the topbar
  // wholesale; all transient state lives in this closure, not the DOM. The
  // CSS drives expression from the --prox custom property; JS only supplies
  // --prox and the lerped pupil translate.
  var peaMotionOk = typeof window === "undefined" || !window.matchMedia || !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var peaMouseX = -1;
  var peaMouseY = -1;
  var peaEyeX = 0;
  var peaEyeY = 0;
  var peaRaf = 0;
  function peaTick() {
    peaRaf = 0;
    var pea = document.querySelector(".avatar .pea");
    if (!pea || !pea.getBoundingClientRect || peaMouseX < 0) return;
    var rect = pea.getBoundingClientRect();
    if (!rect.width) return;
    var dx = peaMouseX - (rect.left + rect.width / 2);
    var dy = peaMouseY - (rect.top + rect.height / 2);
    var dist = Math.sqrt(dx * dx + dy * dy);
    // Expression ramps from neutral to grin as the cursor closes within 420px.
    var prox = Math.max(0, Math.min(1, 1 - dist / 420));
    // Pupils hit full travel (1.3 SVG units) once the cursor is 60px out.
    var reach = Math.min(1, dist / 60) * 1.3;
    var targetX = dist > 0 ? (dx / dist) * reach : 0;
    var targetY = dist > 0 ? (dy / dist) * reach : 0;
    peaEyeX += (targetX - peaEyeX) * 0.22;
    peaEyeY += (targetY - peaEyeY) * 0.22;
    var eyes = pea.querySelectorAll(".pea-eye");
    for (var i = 0; i < eyes.length; i++) {
      eyes[i].style.transform = "translate(" + peaEyeX.toFixed(2) + "px, " + peaEyeY.toFixed(2) + "px)";
    }
    pea.style.setProperty("--prox", prox.toFixed(3));
    if (Math.abs(targetX - peaEyeX) > 0.02 || Math.abs(targetY - peaEyeY) > 0.02) {
      peaRaf = requestAnimationFrame(peaTick);
    }
  }
  function peaBoop() {
    // Deferred a frame so it lands on the avatar the go-home re-render just
    // built (a class added before render() would be wiped with the old DOM).
    requestAnimationFrame(function () {
      var wrap = document.querySelector(".brand-home .avatar");
      if (!wrap || !wrap.classList) return;
      wrap.classList.remove("is-boop");
      void wrap.offsetWidth;
      wrap.classList.add("is-boop");
      setTimeout(function () {
        if (wrap.classList) wrap.classList.remove("is-boop");
      }, 520);
    });
  }
  if (peaMotionOk && typeof requestAnimationFrame === "function") {
    document.addEventListener("mousemove", function (event) {
      peaMouseX = event.clientX;
      peaMouseY = event.clientY;
      if (!peaRaf) peaRaf = requestAnimationFrame(peaTick);
    }, { passive: true });
    document.addEventListener("click", function (event) {
      if (event.target && event.target.closest && event.target.closest(".brand-home")) peaBoop();
    });
  }

  document.addEventListener("click", function (event) {
    // Connection menus and capability popovers are mutually exclusive. Native
    // details elements do not close their siblings or dismiss on outside click.
    if (event.target && event.target.closest && document.querySelectorAll) {
      var clickedConnectionDetails = event.target.closest(".connection-state-stack details");
      document.querySelectorAll(".connection-state-stack details[open]").forEach(function (details) {
        if (details !== clickedConnectionDetails) details.removeAttribute("open");
      });
    }
    // Outside-click closes the open Model combobox (F6). A click inside the
    // combo (the input, an option, or the Settings row) is left to the
    // data-action branch below; anything else dismisses the popover. Guarded by
    // closest so it is inert unless a real .model-combo ancestor exists.
    if (state.modelPickerOpen && event.target && event.target.closest) {
      var insideCombo = event.target.closest(".model-combo");
      if (!insideCombo) closeModelPicker();
    }
    if (state.teamActionMenuId && event.target && event.target.closest) {
      var insideTeamMenu = event.target.closest(".team-action-menu");
      var teamMenuToggle = event.target.closest('[data-action="team-actions-toggle"]');
      if (!insideTeamMenu && !teamMenuToggle) {
        state.teamActionMenuId = "";
        render();
      }
    }
    var target = event.target.closest("[data-action]");
    if (!target) return;
    var action = target.getAttribute("data-action");

    if (state.teamConfirm) {
      if (action === "team-confirm-cancel") {
        var cancelledTeamAction = state.teamConfirm;
        state.teamConfirm = null;
        render();
        if (cancelledTeamAction.field === "role") focusTeamRoleControl(cancelledTeamAction.membershipId);
        else focusTeamActionTrigger(cancelledTeamAction.membershipId);
      } else if (action === "team-confirm-apply") {
        var confirmedTeamAction = state.teamConfirm;
        state.teamConfirm = null;
        updateTeamMembership(
          confirmedTeamAction.membershipId,
          confirmedTeamAction.field,
          confirmedTeamAction.value
        );
      }
      return;
    }

    // While the Slack disconnect dialog is open, its two buttons are the only
    // actionable controls. The background is inert too, but this guard keeps
    // synthetic/programmatic clicks from bypassing the modal contract.
    if (state.slackDisconnectConfirm) {
      if (action === "slack-disconnect-cancel") {
        if (state.slackDisconnectBusy) return;
        state.slackDisconnectConfirm = false;
        state.slackDisconnectError = "";
        render();
        focusAction("slack-disconnect-open");
      } else if (action === "slack-disconnect-confirm") {
        disconnectSlack();
      }
      return;
    }

    if (state.githubDisconnectConfirm) {
      if (action === "github-disconnect-cancel") {
        if (state.githubBusy === "disconnect") return;
        state.githubDisconnectConfirm = false;
        state.githubDisconnectError = "";
        render();
        focusAction("github-disconnect-open");
      } else if (action === "github-disconnect-confirm") {
        disconnectGithub();
      }
      return;
    }

    if (state.sandboxConfirm) {
      if (action === "sandbox-confirm-cancel") {
        if (state.sandboxSaving) return;
        state.sandboxConfirm = "";
        state.sandboxReadyAttested = false;
        state.sandboxError = "";
        render();
      } else if (action === "sandbox-install-confirm") {
        requestSandboxInstall();
      } else if (action === "sandbox-enable-confirm" && state.sandboxReadyAttested) {
        putSandbox(true, true, "enable");
      }
      return;
    }

    if (state.scheduledDeleteConfirm) {
      if (action === "scheduled-delete-cancel") {
        if (state.scheduledBusy) return;
        state.scheduledDeleteConfirm = false;
        render();
      } else if (action === "scheduled-delete-confirm") {
        controlScheduledRoutine("delete");
      }
      return;
    }
    if (action === "mobile-agents-open") {
      state.mobileAgentRosterOpen = true;
      state.mobileAgentRosterFocus = "close";
      render();
      return;
    }
    if (action === "mobile-agents-close") {
      state.mobileAgentRosterOpen = false;
      state.mobileAgentRosterFocus = "trigger";
      render();
      return;
    }
    if (state.ownerMemory.dirty && (
      action === "open-channels" || action === "open-profiles" || action === "open-team" || action === "open-settings" ||
      action === "open-audit" || action === "open-usage" || action === "go-home" || action === "profiles-back" ||
      action === "edit-profile" || action === "new-profile" || action === "duplicate-profile" || action === "open-channel-from-profile" ||
      action === "open-channel-index" || action === "select-channel" || action === "channel-back"
    )) {
      state.ownerMemory.error = "Save or discard this memory draft before navigating away.";
      render();
      return;
    }

    // Disconnect is an atomic transition. Do not let navigation or another
    // action make the operation appear canceled while its request is live.
    if (state.githubBusy === "disconnect") return;

    if (state.slackConnectionBusy && (
      action === "slack-test" ||
      action === "slack-gateway-refresh" ||
      action === "slack-disconnect-open"
    )) return;

    // Unsaved-changes guard. The modal's own buttons resolve it; while it is
    // open, no other click acts; and an attempt to leave a dirty editor opens
    // it instead of navigating.
    if (action === "leave-cancel") { state.leavePrompt = null; render(); return; }
    if (action === "leave-discard") {
      if (state.leavePrompt && state.leavePrompt.kind === "channel") performChannelLeave(state.leavePrompt);
      else performProfileLeave(state.leavePrompt);
      return;
    }
    if (action === "leave-save") {
      var pendingLeave = state.leavePrompt;
      state.leavePrompt = null;
      if (pendingLeave && pendingLeave.kind !== "channel") {
        saveProfile(function () { performProfileLeave(pendingLeave); });
      } else if (pendingLeave) {
        performChannelLeave(pendingLeave);
      }
      return;
    }
    if (state.leavePrompt) { return; }
    if (action === "edit-profile" && state.profileScreen === "edit" && target.getAttribute("data-agent") === state.editingAgentId) return;
    if (state.profileScreen === "edit" && state.profileDirty && isEditLeaveAction(action)) {
      state.leavePrompt = {
        kind: "profile",
        action: action,
        agent: (target.getAttribute("data-agent") || ""),
        section: (target.getAttribute("data-section") || "")
      };
      render();
      return;
    }
    if (state.view === "channels" && state.channelScreen === "detail" && state.dirty && isChannelLeaveAction(action) && !channelLeaveTargetIsCurrent(action, target)) {
      state.leavePrompt = {
        kind: "channel",
        action: action,
        agent: target.getAttribute("data-agent") || "",
        section: target.getAttribute("data-section") || "",
        workspace: target.getAttribute("data-workspace") || "",
        channel: target.getAttribute("data-channel") || ""
      };
      render();
      return;
    }

    // Channels is the platform overview. Concrete rows remain detail screens
    // underneath it; the top-level Channels button always returns here.
    if (action === "open-channels") { openChannels(); }
    if (action === "channel-back") {
      var channelBackAgent = agentById(target.getAttribute("data-agent") || "");
      if (channelBackAgent) openProfileEditor(channelBackAgent);
      else openChannels();
    }
    if (action === "open-channel-index") {
      selectActive(target.getAttribute("data-workspace") || connectedTeamId(), target.getAttribute("data-channel") || "");
      render();
    }
    if (action === "channel-index-add") {
      state.addChannelOpen = true;
      state.addChannelSelected = target.getAttribute("data-channel") || "";
      state.channelFormDraft.workspaceId = target.getAttribute("data-workspace") || connectedTeamId();
      render();
    }
    // Profiles is now a main-panel destination — open lands on the overview,
    // or (with a data-agent) directly on that profile's edit detail (the
    // channel-page Profile row's Edit affordance).
    if (action === "open-profiles") {
      var requestedProfileId = target.getAttribute("data-agent") || "";
      if (!requestedProfileId && target.getAttribute("data-section-switcher") === "true") {
        requestedProfileId = state.editingAgentId || state.profileLastAgentId || (state.agents[0] && state.agents[0].id) || "";
      }
      enterProfiles(requestedProfileId);
    }
    if (action === "open-team") { openTeam(); }
    if (action === "team-retry") { loadTeam(); }
    if (action === "team-actions-toggle" && !state.teamBusy) {
      var toggleMembershipId = target.getAttribute("data-membership") || "";
      state.teamActionMenuId = state.teamActionMenuId === toggleMembershipId ? "" : toggleMembershipId;
      var teamMenuOpening = !!state.teamActionMenuId;
      render();
      if (teamMenuOpening) focusTeamActionMenu();
      else focusTeamActionTrigger(toggleMembershipId);
    }
    if (action === "team-status-action" && !state.teamBusy) {
      var statusMembershipId = target.getAttribute("data-membership") || "";
      var statusMember = teamMemberById(statusMembershipId);
      var nextStatus = target.getAttribute("data-status") || "";
      state.teamActionMenuId = "";
      if (statusMember && nextStatus === "active") updateTeamMembership(statusMember.id, "status", "active");
      else if (statusMember && (nextStatus === "suspended" || nextStatus === "removed")) confirmTeamStatus(statusMember, nextStatus);
    }
    if (action === "open-usage" && USAGE_ADMIN_UI) { openUsage(); }
    if (action === "open-audit") { openAuditLogs("", "", ""); }
    // Brand-as-home: the reliable exit to the canonical Agent.
    if (action === "go-home") { openHome(); }
    if (action === "onboarding-continue-to-channel" && state.view === "onboarding") {
      state.onboardingSlackConnected = false;
      state.slackOnboardingFocus = "onboarding-channel-heading";
      render();
    }
    if (action === "refresh-onboarding-channels") { loadSlackChannels(true); }
    if (action === "retry-onboarding") { state.onboardingError = ""; loadOnboarding(true); }
    if (action === "onboarding-proceed-dashboard") { proceedFromOnboardingTry(); }
    if (action === "copy-onboarding-prompt") { copyOnboardingPrompt(); }
    if (action === "copy-channel-prompt") { copyChannelPrompt(); }
    if (action === "select-channel") { state.view = "channels"; state.channelScreen = "detail"; selectActive(target.getAttribute("data-workspace"), target.getAttribute("data-channel")); render(); }
    if (action === "open-channel-scheduled") {
      openChannelScheduledWork(target.getAttribute("data-workspace") || "", target.getAttribute("data-channel") || "");
    }
    if (action === "toggle-add-channel") { openAddChannel(); }
    if (action === "cancel-add-channel") { state.addChannelOpen = false; state.addChannelManual = false; state.addChannelError = ""; state.addChannelAgentId = ""; render(); }
    if (action === "refresh-channels") { loadSlackChannels(true); }
    if (action === "slack-behavior-retry") { loadSlackBehavior(); }
    if (action === "slack-test") { testSlackConnection(); }
    if (action === "slack-gateway-refresh") { refreshSlackGatewayAuthorization(); }
    if (action === "slack-disconnect-open" && slackConnectionMutable()) {
      state.slackDisconnectConfirm = true;
      state.slackDisconnectError = "";
      render();
    }
    if (action === "toggle-manual-channel") { state.addChannelManual = !state.addChannelManual; state.addChannelError = ""; render(); }
    if (action === "toggle-swap") { state.swapOpen = !state.swapOpen; render(); }
    // Profiles master-detail navigation + form actions.
    if (action === "new-profile") { openNewProfile(); }
    if (action === "duplicate-profile") {
      var duplicateSource = agentById(target.getAttribute("data-agent") || "");
      if (duplicateSource) openDuplicateProfile(duplicateSource);
    }
    if (action === "edit-profile") { var selected = agentById(target.getAttribute("data-agent")); if (selected) openProfileEditor(selected); }
    if (action === "profiles-back") { state.profileScreen = "list"; state.profileDraft = null; state.editingAgentId = null; resetProfileTransientState(); render(); }
    // Capability tab switch. The keystroke mirrors keep the draft in sync, so
    // no collectProfileDraft here — its trim() would strip whitespace out of
    // text the user is mid-typing. showProfileTab's guard also makes
    // re-clicking the active pill a free no-op instead of a full re-render.
    if (action === "profile-tab" && state.profileDraft) {
      showProfileTab(target.getAttribute("data-tab") || "instructions");
    }
    if (action === "connection-account-retry" && state.profileDraft) { loadAgentConnections(state.profileDraft.id); }
    if (action === "composio-setup-close" && state.composioSetup && state.composioSetup.phase !== "validating" && state.composioSetup.phase !== "preparing") {
      var returnPresetId = state.composioSetup.returnFocusPresetId;
      state.composioSetup = null;
      render();
      var returnPreset = document.querySelector('[data-action="connection-account-preset"][data-preset="' + returnPresetId + '"]');
      if (returnPreset && returnPreset.focus) returnPreset.focus();
    }
    if (action === "composio-setup-settings") {
      state.composioSetup = null;
      openSettings("connectors");
    }
    if (action === "composio-setup-save") { submitComposioSetup(); }
    if (action === "managed-auth-open" && state.managedAuthorization) {
      state.managedAuthorization.popupBlocked = !openManagedAuthorizationTab(state.managedAuthorization.authorizationUrl);
      persistManagedAuthorization(state.managedAuthorization);
      render();
    }
    if (action === "managed-auth-retry" && state.managedAuthorization) {
      state.managedAuthorization.status = "waiting";
      state.managedAuthorization.error = "";
      state.managedAuthorization.startedAt = Date.now();
      state.managedAuthorization.pollAttempts = 0;
      persistManagedAuthorization(state.managedAuthorization);
      pollManagedAuthorization();
    }
    if (action === "managed-auth-cancel") { cancelManagedAuthorization(); }
    if (action === "connection-account-new") { newConnectionAccountForm(); }
    if (action === "connection-account-preset") {
      newConnectionAccountFormFromPreset(
        target.getAttribute("data-preset") || "",
        target.getAttribute("data-owner-kind") || ""
      );
    }
    if (action === "connection-account-cancel") { state.connectionAccountForm = null; render(); }
    if (action === "connection-account-managed-access" && state.connectionAccountForm &&
        state.connectionAccountForm.kind === "managed") {
      state.connectionAccountForm.managedAccess = target.getAttribute("data-access") === "write" ? "write" : "read";
      state.connectionAccountForm.error = "";
      render();
    }
    if (action === "connection-account-google-access" && state.connectionAccountForm) {
      var accountGoogleService = googleServicePresetById(state.connectionAccountForm.presetId);
      if (accountGoogleService && state.connectionAccountForm.apiEditor) {
        state.connectionAccountForm.apiEditor.googleAccess[accountGoogleService.service] = target.getAttribute("data-access") === "write" ? "write" : "read";
        syncGoogleApiPolicy(state.connectionAccountForm.apiEditor);
        state.connectionAccountForm.error = "";
        render();
      }
    }
    if (action === "connection-account-supabase-access" && state.connectionAccountForm && state.connectionAccountForm.mcpEditor && state.connectionAccountForm.mcpEditor.presetId === "supabase") {
      state.connectionAccountForm.mcpEditor.supabaseReadOnly = target.getAttribute("data-access") !== "read-write";
      syncSupabaseUrl(state.connectionAccountForm.mcpEditor);
      state.connectionAccountForm.url = state.connectionAccountForm.mcpEditor.url;
      state.connectionAccountForm.error = "";
      render();
    }
    if (action === "connection-account-create") { createConnectionAccount(); }
    if (action === "connection-account-oauth-start") { startConnectionAccountOAuth(target.getAttribute("data-connection-id") || "", false); }
    if (action === "connection-account-mcp-oauth-start") { startConnectionAccountOAuth(target.getAttribute("data-connection-id") || "", false, "mcp"); }
    if (action === "connection-account-managed-reconnect") { reconnectManagedConnection(target.getAttribute("data-connection-id") || ""); }
    if (action === "connection-inventory-reconnect") {
      reconnectSettingsConnectionAccount(
        target.getAttribute("data-connection-id") || "",
        target.getAttribute("data-agent-id") || ""
      );
    }
    if (action === "connection-inventory-provider-setup") {
      var connectorSettingsKey = document.getElementById("connector-settings-key");
      if (connectorSettingsKey && connectorSettingsKey.focus) connectorSettingsKey.focus();
    }
    if (action === "connection-account-resource-open") { startManagedResourceSelection(target.getAttribute("data-connection-id") || ""); }
    if (action === "connection-account-resource-toggle") {
      toggleManagedResourceSelection(
        target.getAttribute("data-resource-key") || "",
        target.getAttribute("data-resource-handle") || "",
        !!target.checked
      );
    }
    if (action === "connection-account-resource-cancel") { state.managedResourceEditor = null; render(); }
    if (action === "connection-account-resource-save") { saveManagedResourceSelection(); }
    if (action === "connection-account-attach") { attachConnectionAccount(target.getAttribute("data-connection-id") || ""); }
    if (action === "connection-account-detach") { detachConnectionAccount(target.getAttribute("data-connection-id") || ""); }
    if (action === "connection-account-revoke") { revokeConnectionAccount(target.getAttribute("data-connection-id") || ""); }
    if (action === "agent-schedules-retry" && state.profileDraft) { loadAgentSchedules(state.profileDraft.id); }
    if (action === "agent-schedule-reassign") {
      reassignAgentSchedule(
        target.getAttribute("data-schedule-id") || "",
        target.getAttribute("data-revision") || "0"
      );
    }
    if (action === "repo-add") { openRepositoryAdd(); }
    if (action === "repo-add-cancel") { closeRepositoryPicker(); }
    if (action === "repo-manage") {
      var repoInstallation = target.getAttribute("data-installation");
      var repoAccount = target.getAttribute("data-account") || "GitHub";
      var repoInstallationId = Number(repoInstallation);
      if (Number.isInteger(repoInstallationId) && repoInstallationId > 0) openRepositoryPicker(repoInstallationId, repoAccount);
    }
    if (action === "repo-remove") { removeRepositoryGrant(target.getAttribute("data-repository-id") || ""); }
    if (action === "repo-picker-cancel") { closeRepositoryPicker(); }
    if (action === "repo-picker-retry") { repoPickerSearch.load(); }
    if (action === "repo-picker-apply") { applyRepositoryPicker(); }
    // Inline title rename: open the input seeded with the current name, focused
    // and selected. Commit is Enter/blur; Escape reverts to prev.
    if (action === "profile-rename" && state.profileDraft) {
      state.profileRenaming = { prev: state.profileDraft.name };
      render();
      var renameInput = document.getElementById("p-name");
      if (renameInput) { renameInput.focus(); renameInput.select(); }
    }
    if (action === "profile-description-edit" && state.profileDraft) {
      state.profileDescriptionEditing = { prev: state.profileDraft.description || "" };
      render();
      var descriptionInput = document.getElementById("p-description");
      if (descriptionInput) { descriptionInput.focus(); descriptionInput.select(); }
    }
    // Footer "Add to channels" picker.
    if (action === "attach-open" && state.profileDraft) { openProfileAttachPicker(); }
    if (action === "attach-new-channel") { state.attachPicker = false; state.attachChannelSelected = ""; state.attachError = ""; openAddChannel(target.getAttribute("data-agent") || ""); }
    if (action === "attach-cancel") { state.attachPicker = false; state.attachChannelSelected = ""; state.attachError = ""; renderPreservingPagePosition(); }
    if (action === "attach-channel-confirm" && state.profileDraft) { attachProfileToChannel(); }
    if (action === "detach-channel" && state.profileDraft) {
      detachProfileFromChannel(
        target.getAttribute("data-workspace") || "",
        target.getAttribute("data-channel") || "",
        target.getAttribute("data-label") || "Channel"
      );
    }
    if (action === "cancel-create") { state.profileScreen = "list"; state.profileDraft = null; resetProfileTransientState(); render(); }
    // Settings (model-providers) is a separate destination that lands with its
    // own build; the affordance is present per the approved model-field design.
    if (action === "open-settings") { openSettings(target.getAttribute("data-section") || ""); }
    if (action === "settings-section") {
      var nextSettingsSection = normalizeSettingsSection(target.getAttribute("data-section") || "providers");
      if (nextSettingsSection === "slack" || nextSettingsSection === "connectors" || state.settingsSection === "slack" || state.settingsSection === "connectors") openSettings(nextSettingsSection);
      else {
        state.settingsSection = nextSettingsSection;
        render();
      }
    }
    if (action === "connection-inventory-retry") { loadConnectionInventory(state.settingsLoadGeneration); }
    if (action === "connector-settings-retry-load") { loadConnectorSettings(state.settingsLoadGeneration); }
    if (action === "connector-settings-edit-key") {
      state.connectorSettings.editing = true;
      state.connectorSettings.error = "";
      state.connectorSettings.notice = "";
      render();
      focusAction("connector-settings-key");
    }
    if (action === "connector-settings-edit-cancel") {
      state.connectorSettings.editing = false;
      state.connectorSettings.key = "";
      state.connectorSettings.error = "";
      render();
    }
    if (action === "connector-settings-save") { saveConnectorSettingsKey(false); }
    if (action === "connector-settings-retry") { retryConnectorSettingsSetup(); }
    if (action === "connector-settings-disable-open") {
      state.connectorSettings.confirm = "disable";
      render();
    }
    if (action === "connector-settings-confirm-cancel") {
      state.connectorSettings.confirm = "";
      render();
    }
    if (action === "connector-settings-confirm-apply") {
      if (state.connectorSettings.confirm === "replace") saveConnectorSettingsKey(true);
      else if (state.connectorSettings.confirm === "disable") disableConnectorSettings();
    }
    if (action === "usage-retry") { loadUsage(true); }
    if (action === "usage-load-more") { loadMoreUsageOperations(); }
    if (action === "usage-custom-apply") { applyCustomUsageRange(); }
    if (action === "usage-clear-filter") { state.usageOperationFilter = null; state.usageOperations = null; loadUsageOperations(true); }
    if (action === "usage-group-filter") {
      state.usageOperationFilter = { groupBy: state.usageGroupBy, value: target.getAttribute("data-value") || "", label: target.getAttribute("data-label") || "" };
      state.usageOperations = null;
      loadUsageOperations(true);
    }
    if (action === "usage-open-settings") { openSettings("providers"); }
    if (action === "audit-tab-scheduled" && state.auditDomain !== "scheduled-work") { openScheduledWork(""); }
    if (action === "scheduled-retry") { loadScheduledRoutines(); }
    if (action === "scheduled-back-list") {
      state.scheduledSelection = "";
      state.scheduledDetail = null;
      state.scheduledInspector = false;
      state.scheduledDetailTab = "overview";
      state.scheduledNotice = "";
      state.scheduledError = "";
      render();
    }
    if (action === "select-scheduled-routine") { selectScheduledRoutine(target.getAttribute("data-routine") || ""); }
    if (action === "scheduled-summary-close") { closeScheduledSummary(); }
    if (action === "scheduled-open-inspector" && state.scheduledDetail) { state.scheduledInspector = true; render(); }
    if (action === "scheduled-back-summary") { state.scheduledInspector = false; render(); }
    if (action === "scheduled-list-control") { controlScheduledRoutineFromList(target.getAttribute("data-routine") || "", target.getAttribute("data-control") || ""); }
    if (action === "scheduled-list-delete") { openScheduledDeleteFromList(target.getAttribute("data-routine") || ""); }
    if (action === "scheduled-detail-tab") {
      var scheduledTab = target.getAttribute("data-tab") || "overview";
      if (["overview", "runs", "activity"].includes(scheduledTab)) {
        state.scheduledDetailTab = scheduledTab;
        render();
      }
    }
    if (action === "scheduled-control") { controlScheduledRoutine(target.getAttribute("data-control") || ""); }
    if (action === "scheduled-delete-open" && state.scheduledDetail) { state.scheduledDeleteConfirm = true; render(); }
    if (action === "owner-memory-retry") {
      loadOwnerMemory(state.ownerMemory.ownerKind, state.ownerMemory.workspaceId, state.ownerMemory.ownerId, true);
    }
    if (action === "owner-memory-save") { saveOwnerMemoryEntry(); }
    if (action === "owner-memory-discard") { discardOwnerMemoryDraft(); }
    if (action === "owner-memory-use-latest") {
      state.ownerMemory.dirty = false;
      state.ownerMemory.conflict = null;
      loadOwnerMemory(
        state.ownerMemory.ownerKind,
        state.ownerMemory.workspaceId,
        state.ownerMemory.ownerId,
        true
      );
    }
    if (state.githubBusy && action.indexOf("github-") === 0) return;
    if (action === "github-manifest-open") {
      state.githubManifestOpen = true;
      state.githubError = "";
      render();
    }
    if (action === "github-manifest-cancel") {
      state.githubManifestOpen = false;
      state.githubError = "";
      render();
    }
    if (action === "github-refresh") { refreshGithubStatus(); }
    if (action === "github-disconnect-open" && state.githubStatus && state.githubStatus.mode === "app") {
      state.githubDisconnectConfirm = true;
      state.githubDisconnectError = "";
      render();
    }
    if (state.sandboxSaving && action.indexOf("sandbox-") === 0) return;
    if (action === "sandbox-refresh") { loadSandboxStatus().then(render); }
    if (action === "sandbox-save") { saveSandbox(); }
    if (action === "sandbox-install-open") {
      state.sandboxConfirm = "install";
      state.sandboxError = "";
      state.sandboxNotice = "";
      render();
    }
    if (action === "sandbox-enable-open") {
      state.sandboxConfirm = "enable";
      state.sandboxReadyAttested = false;
      state.sandboxError = "";
      state.sandboxNotice = "";
      render();
    }
    if (action === "sandbox-check-again") { checkSandboxInstall(); }
    if (action === "sandbox-cancel-install") { cancelSandboxInstall(); }
    if (action === "sandbox-disable") { putSandbox(false, false, "disable"); }
    if (action === "sandbox-copy-profile") {
      var sandboxBuildVariable = "CHICKPEA_DEPLOY_PROFILE=sandbox";
      var selectSandboxBuildVariable = function () {
        state.sandboxNotice = "Clipboard access was unavailable. The build variable is selected for manual copy.";
        render();
        var sandboxBuildVariableInput = document.getElementById("sandbox-build-variable");
        if (sandboxBuildVariableInput && sandboxBuildVariableInput.focus) sandboxBuildVariableInput.focus();
        if (sandboxBuildVariableInput && sandboxBuildVariableInput.select) sandboxBuildVariableInput.select();
      };
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        selectSandboxBuildVariable();
      } else {
        try {
          Promise.resolve(navigator.clipboard.writeText(sandboxBuildVariable)).then(function () {
            state.sandboxNotice = "Sandbox build variable copied.";
            render();
          }).catch(selectSandboxBuildVariable);
        } catch (_) {
          selectSandboxBuildVariable();
        }
      }
    }
    if (state.egressSaving && action.indexOf("egress-") === 0) return;
    if (action === "egress-mode") {
      egressDraft.mode = target.getAttribute("data-mode") || "allowlist";
      if (egressDraft.mode === "allowlist" && egressDraft.domains.length === 0) egressDraft.domains.push("");
      state.egressError = "";
      render();
    }
    if (action === "egress-domain-add") {
      if (egressDraft.domains.length < 100) egressDraft.domains.push("");
      render();
    }
    if (action === "egress-domain-remove") {
      var egressRemoveIndex = Number(target.getAttribute("data-index"));
      if (egressRemoveIndex >= 0 && egressRemoveIndex < egressDraft.domains.length) egressDraft.domains.splice(egressRemoveIndex, 1);
      render();
    }
    if (action === "egress-save") { saveEgress(); }
    if (action === "model-catalog-refresh") { refreshModelCatalogFromSettings(); }
    if (action === "prov-add-key") { openProviderPaste(target.getAttribute("data-provider"), "add"); }
    if (action === "prov-change-key") { openProviderPaste(target.getAttribute("data-provider"), "change"); }
    if (action === "prov-cancel-key") { closeProviderPaste(target.getAttribute("data-provider")); }
    if (action === "prov-validate") { validateProviderKey(target.getAttribute("data-provider")); }
    if (action === "prov-remove") { openProviderRemove(target.getAttribute("data-provider")); }
    if (action === "prov-remove-cancel") { closeProviderRemove(target.getAttribute("data-provider")); }
    if (action === "prov-remove-confirm") { removeProviderKey(target.getAttribute("data-provider")); }
    if (action === "fav-manager-toggle") {
      var favoriteProvider = target.getAttribute("data-provider");
      var favoriteUi = favUiFor(favoriteProvider);
      favoriteUi.open = !favoriteUi.open;
      render();
      if (favoriteUi.open) {
        var favoriteSearch = document.getElementById("fav-search-" + favoriteProvider);
        if (favoriteSearch && favoriteSearch.focus) favoriteSearch.focus();
      }
    }
    if (action === "fav-star") { toggleFavorite(target.getAttribute("data-provider"), target.getAttribute("data-model")); }
    if (action === "workers-ai-refresh") { refreshWorkersAiModels(); }
    // Open the Model combobox (F6) when the input is clicked/focused. The input
    // carries data-action="profile-model"; the same action feeds keystrokes to
    // the filter in the input listener below.
    if (action === "profile-model") { openModelPicker(); }
    if (action === "pick-model") { var modelInput = document.getElementById("p-model"); if (modelInput) modelInput.value = target.getAttribute("data-model") || ""; collectProfileDraft(); state.profileDirty = true; closeModelPicker(); }
    if (action === "agent-overflow-toggle" && state.profileDraft) {
      state.profileOverflowOpen = !state.profileOverflowOpen;
      var overflowOpening = state.profileOverflowOpen;
      render();
      focusAction(overflowOpening
        ? (state.profileDraft.lifecycle === "archived" ? "restore-profile" : "archive-profile")
        : "agent-overflow-toggle");
    }
    if (action === "archive-profile") { archiveProfile(); }
    if (action === "restore-profile") { restoreProfile(); }
    if (action === "agent-lifecycle-enable" && state.profileDraft) {
      state.profileDraft.enabled = true;
      state.profileOverflowOpen = false;
      markProfileDirty();
      render();
      focusAction("agent-overflow-toggle");
    }
    if (action === "agent-lifecycle-disable" && state.profileDraft) {
      state.profileOverflowOpen = false;
      if (allGrantsForAgent(state.profileDraft.id).length > 0) state.disableConfirm = true;
      else { state.profileDraft.enabled = false; markProfileDirty(); }
      render();
      focusAction("agent-overflow-toggle");
    }
    if (action === "save-profile") { saveProfile(); }
    if (action === "agent-presence-retry") { retryAgentPresence(); }
    if (action === "reload-profile") { reloadProfile(); }
    if (action === "discard-profile") { discardProfile(); }
    if (action === "delete-profile") { deleteProfile(); }
    if (action === "open-channel-from-profile") { state.view = "channels"; state.channelScreen = "detail"; state.profileScreen = "list"; selectActive(target.getAttribute("data-workspace"), target.getAttribute("data-channel")); render(); }
    if (action === "disable-keep") { state.disableConfirm = false; render(); focusAction("agent-overflow-toggle"); }
    if (action === "disable-confirm") { if (state.profileDraft) state.profileDraft.enabled = false; state.disableConfirm = false; state.profileDirty = true; render(); focusAction("agent-overflow-toggle"); }
    // Custom-skills editor: open blank / open seeded / remove / save / cancel.
    // Each editor open captures the current field text off state.skillEditor so
    // the inline error survives a re-render (input handlers mirror keystrokes).
    if (action === "suggested-skill-category") {
      var suggestedCategory = target.getAttribute("data-category") || "featured";
      if (suggestedCategory !== state.suggestedSkillCategory && SUGGESTED_SKILL_CATEGORIES.some(function (category) { return category.id === suggestedCategory; })) {
        state.suggestedSkillCategory = suggestedCategory;
        render();
      }
    }
    if (action === "skill-new") { collectProfileDraft(); state.skillEditor = { index: null, name: "", description: "", instructions: "", error: "" }; render(); }
    if (action === "skill-edit") {
      collectProfileDraft();
      var editIndex = Number(target.getAttribute("data-index"));
      var editSkill = (state.profileDraft.skills || [])[editIndex];
      if (editSkill) { state.skillEditor = { index: editIndex, name: editSkill.name, description: editSkill.description, instructions: editSkill.instructions, error: "" }; render(); }
    }
    if (action === "skill-remove") {
      collectProfileDraft();
      var removeIndex = Number(target.getAttribute("data-index"));
      var removeSkills = state.profileDraft.skills || [];
      if (removeIndex >= 0 && removeIndex < removeSkills.length) { removeSkills.splice(removeIndex, 1); state.profileDraft.skills = removeSkills; state.skillEditor = null; markProfileDirty(); render(); }
    }
    if (action === "skill-cancel") { state.skillEditor = null; render(); }
    if (action === "skill-save-row") {
      var editor = state.skillEditor;
      if (editor) {
        var skills = state.profileDraft.skills || [];
        var validationError = validateSkillEditor(editor, skills);
        if (validationError) { editor.error = validationError; render(); }
        else {
          var saved = { name: String(editor.name).trim(), description: String(editor.description).trim(), instructions: String(editor.instructions).trim(), enabled: true };
          if (editor.index === null || editor.index === undefined) { saved.enabled = true; skills.push(saved); }
          else {
            var replaced = skills[editor.index];
            saved.enabled = replaced ? replaced.enabled : true;
            if (replaced && replaced.suggestedSkillId !== undefined) saved.suggestedSkillId = replaced.suggestedSkillId;
            skills[editor.index] = saved;
          }
          state.profileDraft.skills = skills;
          state.skillEditor = null;
          markProfileDirty();
          render();
        }
      }
    }
    // Import skills from a URL: open the panel, run the resolve, drive the picker.
    // Opening captures the current draft first so a filled skill editor is not
    // lost, and closes any open inline skill editor so only one panel shows.
    if (action === "import-skills") { openSkillImport(); }
    if (action === "import-cancel") { closeSkillImport(); }
    if (action === "import-find") { findSkillsFromSource(); }
    if (action === "import-browse-open") { openSkillImportBrowse(); }
    if (action === "import-browse-cancel") { closeSkillImportBrowse(); }
    if (action === "import-browse-retry") { skillImportRepoSearch.load(); }
    if (action === "import-browse-account") {
      var importInstallationId = Number(target.getAttribute("data-installation"));
      var importAccount = target.getAttribute("data-account") || "GitHub";
      openSkillImportRepositoryBrowser(importInstallationId, importAccount);
    }
    if (action === "import-browse-select") { selectSkillImportRepository(target.getAttribute("data-repo") || ""); }
    if (action === "import-select-all" && state.skillImport && state.skillImport.resolution) {
      var imp = state.skillImport;
      var allOn = imp.selected.length > 0 && imp.selected.every(function (on) { return on; });
      imp.selected = (imp.resolution.skills || []).map(function () { return !allOn; });
      render();
    }
    if (action === "import-add") { addSelectedSkills(); }

    // Connections (remote MCP servers) editor: open blank / open seeded / remove
    // (confirm) / test / save / cancel. Each open captures the current draft off
    // the form first so unrelated typed text is not lost.
    if (action === "conn-custom") {
      collectProfileDraft();
      state.customConnectionLane = "mcp";
      state.connectorGallerySearch = "";
      state.connectionEditor = newConnectionEditor();
      state.apiConnectionEditor = null;
      render();
    }
    if (action === "custom-lane" && state.customConnectionLane) {
      var customLane = target.getAttribute("data-lane") === "api" ? "api" : "mcp";
      state.customConnectionLane = customLane;
      if (customLane === "mcp" && !state.connectionEditor) state.connectionEditor = newConnectionEditor();
      if (customLane === "api" && !state.apiConnectionEditor) state.apiConnectionEditor = newApiConnectionEditor();
      render();
    }
    if (action === "conn-preset") {
      var connPresetId = target.getAttribute("data-preset");
      var selectedPreset = presetById(connPresetId);
      var selectedGoogleService = googleServicePresetById(connPresetId);
      if (selectedGoogleService) {
        collectProfileDraft();
        state.customConnectionLane = null;
        state.connectorGallerySearch = "";
        state.connectionEditor = null;
        var googleConnections = state.profileDraft.apiConnections || [];
        var googleConnectionIndex = googleConnections.findIndex(function (conn) {
          return conn.id === selectedGoogleService.connectionPresetId || conn.presetId === selectedGoogleService.connectionPresetId;
        });
        if (googleConnectionIndex >= 0) {
          state.apiConnectionEditor = editorFromApiConnection(googleConnectionIndex, googleConnections[googleConnectionIndex]);
        } else {
          var googlePreset = presetById(selectedGoogleService.connectionPresetId);
          if (!googlePreset) return;
          state.apiConnectionEditor = apiEditorFromPreset(googlePreset);
          state.apiConnectionEditor.googleAccess = googleAccessFromScopes([]);
        }
        state.apiConnectionEditor.googleAccess[selectedGoogleService.service] = "read";
        syncGoogleApiPolicy(state.apiConnectionEditor);
        render();
      } else if (selectedPreset) {
        collectProfileDraft();
        state.customConnectionLane = null;
        state.connectorGallerySearch = "";
        var selectedPresetLanes = presetLanes(selectedPreset);
        if (selectedPresetLanes.api && !selectedPresetLanes.mcp) {
          state.connectionEditor = null;
          state.apiConnectionEditor = apiEditorFromPreset(selectedPreset);
          render();
        } else if (selectedPresetLanes.mcp) {
          state.apiConnectionEditor = null;
          state.connectionEditor = editorFromPreset(selectedPreset);
          render();
        }
      }
    }
    if (action === "conn-view" && state.connectionEditor) {
      state.connectionEditor.view = target.getAttribute("data-view") === "advanced" ? "advanced" : "recommended";
      render();
    }
    if (action === "conn-supabase-access" && state.connectionEditor && state.connectionEditor.presetId === "supabase") {
      state.connectionEditor.supabaseReadOnly = target.getAttribute("data-access") !== "read-write";
      syncSupabaseUrl(state.connectionEditor);
      state.connectionEditor.error = "";
      markProfileDirty();
      render();
    }
    if (action === "conn-edit") {
      collectProfileDraft();
      var connEditIndex = Number(target.getAttribute("data-index"));
      var connEditServer = (state.profileDraft.mcpServers || [])[connEditIndex];
      if (connEditServer) {
        state.customConnectionLane = null;
        state.connectorGallerySearch = "";
        state.apiConnectionEditor = null;
        state.connectionEditor = editorFromConnection(connEditIndex, connEditServer);
        render();
      }
    }
    if (action === "conn-cancel") {
      if (state.customConnectionLane) {
        clearCustomConnectionMode();
      } else {
        state.connectionEditor = null;
      }
      render();
    }
    if (action === "conn-remove") {
      collectProfileDraft();
      state.connectionRemove = Number(target.getAttribute("data-index"));
      render();
    }
    if (action === "conn-oauth-disconnect" && state.connectionEditor) {
      collectProfileDraft();
      var oauthDisconnectIndex = state.connectionEditor.index;
      if (oauthDisconnectIndex !== null && oauthDisconnectIndex !== undefined) {
        state.connectionRemove = oauthDisconnectIndex;
        render();
      }
    }
    if (action === "conn-remove-cancel") { state.connectionRemove = null; render(); }
    if (action === "conn-remove-confirm") {
      var removeConnIndex = state.connectionRemove;
      var removeServers = (state.profileDraft && state.profileDraft.mcpServers) || [];
      if (removeConnIndex !== null && removeConnIndex >= 0 && removeConnIndex < removeServers.length) {
        // Record the id so its secrets are DELETEd on the next save, even though
        // the row is gone from the array now.
        rememberRemovedConnection(removeServers[removeConnIndex]);
        if (state.oauthReturn && state.oauthReturn.connectionId === removeServers[removeConnIndex].id) {
          state.oauthReturn = null;
        }
        removeServers.splice(removeConnIndex, 1);
        state.profileDraft.mcpServers = removeServers;
        // If the open editor pointed at a shifted index, just close it — simplest
        // correct behavior.
        if (state.customConnectionLane) clearCustomConnectionMode();
        else state.connectionEditor = null;
        markProfileDirty();
      }
      state.connectionRemove = null;
      render();
    }
    if (action === "conn-transport" && state.connectionEditor) {
      state.connectionEditor.transport = target.getAttribute("data-transport") || "streamable-http";
      markProfileDirty();
      render();
    }
    if (action === "conn-header-add" && state.connectionEditor) {
      var addEditor = state.connectionEditor;
      addEditor.headerNames = (addEditor.headerNames || []).concat("");
      addEditor.headerValues = (addEditor.headerValues || []).concat("");
      markProfileDirty();
      render();
    }
    if (action === "conn-header-remove" && state.connectionEditor) {
      var hdrEditor = state.connectionEditor;
      var hdrIndex = Number(target.getAttribute("data-index"));
      (hdrEditor.headerNames || []).splice(hdrIndex, 1);
      (hdrEditor.headerValues || []).splice(hdrIndex, 1);
      markProfileDirty();
      render();
    }
    if (action === "conn-oauth-start") { startOAuthConnection(); }
    if (action === "conn-test") { testConnection(); }
    if (action === "conn-save-row") {
      if (isPersistedReadyOAuthEditor(state.connectionEditor)) saveOAuthToolAccess();
      else commitConnectionRow();
    }
    // Credentialed REST API connections keep their own action namespace even
    // though their saved rows and custom-create flow now share this panel.
    if (action === "apiconn-view" && state.apiConnectionEditor) {
      state.apiConnectionEditor.view = target.getAttribute("data-view") === "advanced" ? "advanced" : "recommended";
      render();
    }
    if (action === "apiconn-google-app-type" && isGoogleWorkspaceEditor(state.apiConnectionEditor)) {
      state.apiConnectionEditor.oauthAppType = target.getAttribute("data-app-type") === "external" ? "external" : "workspace-internal";
      state.apiConnectionEditor.error = "";
      markProfileDirty();
      render();
    }
    if (action === "apiconn-google-access" && isGoogleWorkspaceEditor(state.apiConnectionEditor)) {
      var googleService = target.getAttribute("data-service");
      var googleAccess = target.getAttribute("data-access");
      if (GOOGLE_WORKSPACE_SCOPES[googleService] && ["off", "read", "write"].indexOf(googleAccess) >= 0) {
        state.apiConnectionEditor.googleAccess[googleService] = googleAccess;
        syncGoogleApiPolicy(state.apiConnectionEditor);
        state.apiConnectionEditor.error = "";
        markProfileDirty();
        render();
      }
    }
    if (action === "apiconn-oauth-start") { startApiOAuthConnection(); }
    if (action === "apiconn-oauth-disconnect" && state.apiConnectionEditor) {
      collectProfileDraft();
      var apiOauthDisconnectIndex = state.apiConnectionEditor.index;
      if (apiOauthDisconnectIndex !== null && apiOauthDisconnectIndex !== undefined) {
        state.apiConnectionRemove = apiOauthDisconnectIndex;
        render();
      }
    }
    if (action === "apiconn-edit") {
      collectProfileDraft();
      var apiConnEditIndex = Number(target.getAttribute("data-index"));
      var apiConnEditValue = (state.profileDraft.apiConnections || [])[apiConnEditIndex];
      if (apiConnEditValue) {
        state.customConnectionLane = null;
        state.connectionEditor = null;
        state.apiConnectionEditor = editorFromApiConnection(apiConnEditIndex, apiConnEditValue);
        render();
      }
    }
    if (action === "apiconn-cancel") {
      if (state.customConnectionLane) {
        clearCustomConnectionMode();
      } else {
        state.apiConnectionEditor = null;
      }
      render();
    }
    if (action === "apiconn-remove") {
      collectProfileDraft();
      state.apiConnectionRemove = Number(target.getAttribute("data-index"));
      render();
    }
    if (action === "apiconn-remove-cancel") { state.apiConnectionRemove = null; render(); }
    if (action === "apiconn-remove-confirm") {
      var apiConnRemoveIndex = state.apiConnectionRemove;
      var apiConnRemoveValues = (state.profileDraft && state.profileDraft.apiConnections) || [];
      if (apiConnRemoveIndex !== null && apiConnRemoveIndex >= 0 && apiConnRemoveIndex < apiConnRemoveValues.length) {
        rememberRemovedApiConnection(apiConnRemoveValues[apiConnRemoveIndex]);
        if (state.oauthReturn && state.oauthReturn.lane === "api" && state.oauthReturn.connectionId === apiConnRemoveValues[apiConnRemoveIndex].id) {
          state.oauthReturn = null;
        }
        apiConnRemoveValues.splice(apiConnRemoveIndex, 1);
        state.profileDraft.apiConnections = apiConnRemoveValues;
        if (state.customConnectionLane) clearCustomConnectionMode();
        else state.apiConnectionEditor = null;
        markProfileDirty();
      }
      state.apiConnectionRemove = null;
      render();
    }
    if (action === "apiconn-host-add" && state.apiConnectionEditor) {
      state.apiConnectionEditor.allowedHosts = (state.apiConnectionEditor.allowedHosts || []).concat("");
      markProfileDirty();
      render();
    }
    if (action === "apiconn-host-remove" && state.apiConnectionEditor) {
      (state.apiConnectionEditor.allowedHosts || []).splice(Number(target.getAttribute("data-index")), 1);
      markProfileDirty();
      render();
    }
    if (action === "apiconn-path-add" && state.apiConnectionEditor) {
      state.apiConnectionEditor.pathPrefixes = (state.apiConnectionEditor.pathPrefixes || []).concat("");
      markProfileDirty();
      render();
    }
    if (action === "apiconn-path-remove" && state.apiConnectionEditor) {
      (state.apiConnectionEditor.pathPrefixes || []).splice(Number(target.getAttribute("data-index")), 1);
      markProfileDirty();
      render();
    }
    if (action === "apiconn-save-row") { commitApiConnectionRow(); }
  });

  document.addEventListener("input", function (event) {
    var target = event.target;
    var action = target.getAttribute && target.getAttribute("data-action");
    if (action === "channels-index-query") {
      var channelQueryCaret = target.selectionStart;
      state.channelIndexQuery = target.value;
      render();
      var search = document.getElementById("channels-index-query");
      if (search && search.focus) search.focus();
      if (search && channelQueryCaret != null && search.setSelectionRange) {
        try { search.setSelectionRange(channelQueryCaret, channelQueryCaret); } catch (error) { /* ignore */ }
      }
    }
    if (state.ownerMemory.draft) {
      if (action === "owner-memory-description") { state.ownerMemory.draft.description = target.value; markOwnerMemoryDirty(); }
      if (action === "owner-memory-body") { state.ownerMemory.draft.body = target.value; markOwnerMemoryDirty(); }
    }
    // Preserve a half-typed manual channel id across re-renders.
    if (action === "manual-channel-input") { state.channelFormDraft.channelId = target.value; }
    // Mirror the import source into state without a re-render so the input keeps
    // focus; "Find skills" reads it off state.skillImport.
    if (action === "import-source" && state.skillImport) { state.skillImport.source = target.value; state.skillImport.error = ""; }
    // Mirror the pasted provider key into state so a re-render (e.g. a validate
    // spinner) never wipes it; the favorites search re-renders only its own
    // results container to keep the input focused.
    if (action === "prov-key-input") { provUiFor(target.getAttribute("data-provider")).key = target.value; }
    if (action === "composio-setup-key" && state.composioSetup) {
      state.composioSetup.key = target.value;
      state.composioSetup.error = "";
      if (state.composioSetup.phase === "invalid_key" || state.composioSetup.phase === "transient_failure" || state.composioSetup.phase === "selected_unavailable") state.composioSetup.phase = "idle";
      var setupSubmit = document.querySelector('[data-action="composio-setup-save"]');
      if (setupSubmit) setupSubmit.disabled = !String(target.value || "").trim();
      var setupError = document.getElementById("composio-project-key-error");
      if (setupError) setupError.textContent = "";
    }
    if (action === "connector-settings-key") {
      state.connectorSettings.key = target.value;
      state.connectorSettings.error = "";
      var connectorSettingsSubmit = document.querySelector('[data-action="connector-settings-save"]');
      if (connectorSettingsSubmit) connectorSettingsSubmit.disabled = !String(target.value || "").trim();
      var connectorSettingsError = document.getElementById("connector-settings-error");
      if (connectorSettingsError) connectorSettingsError.textContent = "";
    }
    if (action === "github-org-input") { state.githubOrg = target.value; }
    if (action === "repo-search") { repoPickerSearch.search(target.value); }
    if (action === "import-browse-search") { skillImportRepoSearch.search(target.value); }
    if (action === "egress-domain-input") {
      var egressInputIndex = Number(target.getAttribute("data-index"));
      if (!state.egressSaving && egressInputIndex >= 0 && egressInputIndex < egressDraft.domains.length) egressDraft.domains[egressInputIndex] = target.value;
    }
    if (action === "fav-search") { updateFavSearch(target.getAttribute("data-provider"), target.value); }
    if (state.connectionAccountForm) {
      if (action === "connection-account-provider") { state.connectionAccountForm.providerId = target.value; state.connectionAccountForm.error = ""; }
      if (action === "connection-account-label") { state.connectionAccountForm.label = target.value; state.connectionAccountForm.error = ""; }
      if (action === "connection-account-purpose") { state.connectionAccountForm.purpose = target.value; }
      if (action === "connection-account-url") { state.connectionAccountForm.url = target.value; state.connectionAccountForm.error = ""; }
      if (action === "connection-account-subdomain") { state.connectionAccountForm.apiSubdomain = target.value; state.connectionAccountForm.error = ""; }
      if (action === "connection-account-supabase-ref" && state.connectionAccountForm.mcpEditor) {
        state.connectionAccountForm.mcpEditor.supabaseProjectRef = target.value;
        syncSupabaseUrl(state.connectionAccountForm.mcpEditor);
        state.connectionAccountForm.url = state.connectionAccountForm.mcpEditor.url;
        state.connectionAccountForm.error = "";
      }
      if ((action === "connection-account-sentry-organization" || action === "connection-account-sentry-project") && state.connectionAccountForm.mcpEditor) {
        if (action === "connection-account-sentry-organization") state.connectionAccountForm.mcpEditor.sentryOrganizationSlug = target.value;
        if (action === "connection-account-sentry-project") state.connectionAccountForm.mcpEditor.sentryProjectSlug = target.value;
        syncSentryUrl(state.connectionAccountForm.mcpEditor);
        state.connectionAccountForm.url = state.connectionAccountForm.mcpEditor.url;
        state.connectionAccountForm.error = "";
      }
      if (action === "connection-account-capabilities") { state.connectionAccountForm.capabilities = target.value; }
      if (action === "connection-account-credential") { state.connectionAccountForm.credential = target.value; }
      if (action === "connection-account-oauth-client-id") { state.connectionAccountForm.oauthClientId = target.value; state.connectionAccountForm.error = ""; }
      if (action === "connection-account-oauth-client-secret") { state.connectionAccountForm.oauthClientSecret = target.value; state.connectionAccountForm.error = ""; }
    }
    if (action === "conn-gallery-search") {
      var caret = null;
      try { caret = target.selectionStart; } catch (error) { caret = null; }
      state.connectorGallerySearch = target.value;
      render();
      var gallerySearchInput = document.getElementById("conn-gallery-search-input");
      if (gallerySearchInput && gallerySearchInput.focus) {
        gallerySearchInput.focus();
        if (caret != null && gallerySearchInput.setSelectionRange) {
          try { gallerySearchInput.setSelectionRange(caret, caret); } catch (error) { /* ignore */ }
        }
      }
    }
    // Profile form fields: mirror keystrokes into the draft (so a pick-model /
    // tool-toggle re-render keeps typed text) and mark the edit save bar dirty
    // without a full re-render, preserving focus.
    if (state.profileDraft) {
      if (action === "profile-name") { state.profileDraft.name = target.value; markProfileDirty(); }
      if (action === "profile-handle") { state.profileDraft.handle = target.value; markProfileDirty(); }
      if (action === "profile-description") { state.profileDraft.description = target.value; markProfileDirty(); }
      // Mirror the typed model too: tab switches re-render from the draft, and
      // without this a half-typed specifier would be lost with the picker open.
      if (action === "profile-model") { state.profileDraft.model = target.value; markProfileDirty(); filterModelPicker(target); }
      if (action === "profile-instructions") { state.profileDraft.instructions = target.value; markProfileDirty(); }
      // Skill editor fields mirror into state.skillEditor without a re-render so
      // the textarea keeps focus; validation/upsert happens on skill-save-row.
      if (state.skillEditor) {
        // Typing in a skill editor marks the profile dirty so "Save changes"
        // enables — a filled editor is committed on save (commitOpenSkillEditor),
        // so the user never has to notice the separate "Add skill" step.
        if (action === "skill-field-name") { state.skillEditor.name = target.value; markProfileDirty(); }
        if (action === "skill-field-description") { state.skillEditor.description = target.value; markProfileDirty(); }
        if (action === "skill-field-instructions") { state.skillEditor.instructions = target.value; markProfileDirty(); }
      }
      // Connection editor fields mirror into state.connectionEditor without a
      // re-render so the inputs keep focus. The bearer/header VALUES are the
      // transient secrets — they stay in editor state only and are PUT to the
      // settings store on save, never entering the profile PATCH body.
      if (state.connectionEditor) {
        var connEditor = state.connectionEditor;
        if (action === "conn-field-name") { connEditor.displayName = target.value; markProfileDirty(); }
        if (action === "conn-supabase-project-ref" && connEditor.presetId === "supabase") {
          connEditor.supabaseProjectRef = target.value;
          syncSupabaseUrl(connEditor);
          connEditor.error = "";
          markProfileDirty();
          var supabaseOauthButton = document.querySelector('[data-action="conn-oauth-start"]');
          if (supabaseOauthButton) supabaseOauthButton.disabled = !validSupabaseProjectRef(connEditor.supabaseProjectRef);
        }
        if ((action === "conn-sentry-organization" || action === "conn-sentry-project") && connEditor.presetId === "sentry") {
          if (action === "conn-sentry-organization") connEditor.sentryOrganizationSlug = target.value;
          if (action === "conn-sentry-project") connEditor.sentryProjectSlug = target.value;
          syncSentryUrl(connEditor);
          connEditor.error = "";
          markProfileDirty();
        }
        if (action === "conn-field-url") {
          connEditor.url = target.value;
          markProfileDirty();
          // Sync the Test button's disabled state directly (no re-render, so
          // the input keeps focus) — the URL is now its only gate, and nothing
          // else re-renders between typing the URL and clicking Test.
          var connTestButton = document.querySelector('[data-action="conn-test"]');
          if (connTestButton) connTestButton.disabled = !String(connEditor.url || "").trim();
        }
        if (action === "conn-field-oauth-scope") { connEditor.oauthScope = target.value; markProfileDirty(); }
        if (action === "conn-field-bearer") { connEditor.bearerToken = target.value; markProfileDirty(); }
        if (action === "conn-header-name") { connEditor.headerNames[Number(target.getAttribute("data-index"))] = target.value; markProfileDirty(); }
        if (action === "conn-header-value") { connEditor.headerValues[Number(target.getAttribute("data-index"))] = target.value; markProfileDirty(); }
      }
      // API policy fields mirror keystrokes without re-rendering; the credential
      // remains transient in editor state until the profile PATCH succeeds.
      if (state.apiConnectionEditor) {
        var apiConnEditor = state.apiConnectionEditor;
        if (action === "apiconn-field-name") { apiConnEditor.displayName = target.value; markProfileDirty(); }
        if (action === "apiconn-field-subdomain") {
          var apiConnSubdomain = String(target.value || "").trim();
          var apiConnTemplateParts = apiConnectionHostTemplateParts(apiConnEditor);
          var apiConnTemplateHost = String(apiConnEditor.hostTemplateHost || "");
          apiConnEditor.allowedHosts = [apiConnSubdomain && apiConnTemplateParts.valid
            ? apiConnTemplateParts.prefix + apiConnSubdomain + apiConnTemplateParts.suffix
            : apiConnTemplateHost];
          markProfileDirty();
          var apiConnHostChip = document.querySelector('[data-role="apiconn-host-chip"]');
          if (apiConnHostChip) apiConnHostChip.textContent = apiConnEditor.allowedHosts[0];
        }
        if (action === "apiconn-host-input") { apiConnEditor.allowedHosts[Number(target.getAttribute("data-index"))] = target.value; markProfileDirty(); }
        if (action === "apiconn-path-input") { apiConnEditor.pathPrefixes[Number(target.getAttribute("data-index"))] = target.value; markProfileDirty(); }
        if (action === "apiconn-field-header-name") { apiConnEditor.headerName = target.value; markProfileDirty(); }
        if (action === "apiconn-field-header-prefix") { apiConnEditor.headerValuePrefix = target.value; markProfileDirty(); }
        if (action === "apiconn-field-credential") { apiConnEditor.credential = target.value; markProfileDirty(); }
        if (action === "apiconn-google-client-id") { apiConnEditor.oauthClientId = target.value; apiConnEditor.error = ""; markProfileDirty(); }
        if (action === "apiconn-google-client-secret") { apiConnEditor.oauthClientSecret = target.value; apiConnEditor.error = ""; markProfileDirty(); }
      }
    }
  });

  document.addEventListener("change", function (event) {
    var target = event.target;
    var action = target.getAttribute && target.getAttribute("data-action");
    if (action === "team-role-select" && !state.teamBusy) {
      var roleMembershipId = target.getAttribute("data-membership") || "";
      var roleMember = teamMemberById(roleMembershipId);
      var nextRole = target.value || "";
      if (roleMember && ["member", "admin", "owner"].indexOf(nextRole) >= 0 && nextRole !== roleMember.role) {
        if (roleMember.role === "owner" || nextRole === "owner") confirmTeamRole(roleMember, nextRole);
        else updateTeamMembership(roleMember.id, "role", nextRole);
      }
    }
    if (state.connectionAccountForm && action === "connection-account-owner") {
      state.connectionAccountForm.ownerKind = target.value === "member" ? "member" : "team";
      render();
    }
    if (state.connectionAccountForm && action === "connection-account-kind") {
      state.connectionAccountForm.kind = target.value === "mcp" ? "mcp" : "api";
      if (state.connectionAccountForm.kind === "mcp") state.connectionAccountForm.authMode = "credential";
      render();
    }
    if (state.connectionAccountForm && action === "connection-account-auth") {
      state.connectionAccountForm.authMode = target.value === "google_oauth" ? "google_oauth" : "credential";
      if (state.connectionAccountForm.authMode === "google_oauth" && !state.connectionAccountForm.providerId) state.connectionAccountForm.providerId = "google";
      render();
    }
    if (action === "profile-avatar-upload" && target.files && target.files[0]) {
      uploadProfileAvatar(target.files[0]);
    }
    if (action === "onboarding-channel-select") {
      state.onboardingChannelSelected = target.value;
      render();
    }
    if (action === "workers-ai-enabled") setWorkersAiEnabled(!!target.checked);
    if (action === "team-member-status") {
      updateTeamMembership(target.getAttribute("data-membership") || "", "status", target.value);
    }
    if (action === "usage-range") {
      var usagePeriod = String(target.value || "last_30_days");
      var allowedUsagePeriods = ["last_7_days", "last_30_days", "last_90_days", "this_month", "last_month", "this_week", "last_week", "custom"];
      state.usagePeriod = allowedUsagePeriods.includes(usagePeriod) ? usagePeriod : "last_30_days";
      if (state.usagePeriod === "custom") {
        var appliedCustom = usageCustomRange(state.usageCustomFrom, state.usageCustomTo);
        if (appliedCustom.error) {
          var customDefaults = usageDefaultCustomDates();
          state.usageCustomFrom = customDefaults.from;
          state.usageCustomTo = customDefaults.to;
        }
        state.usageCustomDraftFrom = state.usageCustomFrom;
        state.usageCustomDraftTo = state.usageCustomTo;
      }
      state.usageCustomError = "";
      state.usageOperationFilter = null;
      syncUsageQueryUrl();
      loadUsage(true);
    }
    if (action === "usage-custom-from") {
      state.usageCustomDraftFrom = String(target.value || "");
      state.usageCustomError = "";
    }
    if (action === "usage-custom-to") {
      state.usageCustomDraftTo = String(target.value || "");
      state.usageCustomError = "";
    }
    if (action === "usage-group") {
      var usageGroup = String(target.value || "channel");
      state.usageGroupBy = ["channel", "agent", "provider", "model"].includes(usageGroup) ? usageGroup : "channel";
      state.usageOperationFilter = null;
      syncUsageQueryUrl();
      loadUsage(true);
    }
    if (action === "scheduled-filter-scope") {
      var scopeParts = String(target.value || "").split("|");
      state.scheduledFilters.workspaceId = scopeParts[0] === "workspace" || scopeParts[0] === "channel" ? scopeParts[1] || "" : "";
      state.scheduledFilters.channelId = scopeParts[0] === "channel" ? scopeParts[2] || "" : "";
      state.scheduledSelection = "";
      state.scheduledDetail = null;
      state.scheduledInspector = false;
      state.scheduledRoutines = null;
      loadScheduledRoutines();
    }
    if (action === "scheduled-filter-state") {
      var scheduledState = String(target.value || "current");
      state.scheduledFilters.state = ["current", "active", "paused", "completed", "disabled", "all"].includes(scheduledState) ? scheduledState : "current";
      state.scheduledSelection = "";
      state.scheduledDetail = null;
      state.scheduledInspector = false;
      state.scheduledRoutines = null;
      loadScheduledRoutines();
    }
    if (action === "sandbox-ready-attestation" && !state.sandboxSaving) {
      state.sandboxReadyAttested = !!target.checked;
      state.sandboxError = "";
      render();
    }
    if (action === "sandbox-monthly-cap" && !state.sandboxSaving) {
      var monthlySessionCap = Number(target.value);
      sandboxDraft.monthlySessionCap = Number.isSafeInteger(monthlySessionCap) && monthlySessionCap >= 0
        ? Math.min(monthlySessionCap, 100000)
        : 200;
      state.sandboxError = "";
    }
    if (action === "sandbox-host" && !state.sandboxSaving) {
      var sandboxHost = target.getAttribute("data-host") || "";
      var sandboxHostIndex = sandboxDraft.allowedHosts.indexOf(sandboxHost);
      if (target.checked && sandboxHostIndex < 0) sandboxDraft.allowedHosts.push(sandboxHost);
      if (!target.checked && sandboxHostIndex >= 0) sandboxDraft.allowedHosts.splice(sandboxHostIndex, 1);
      state.sandboxError = "";
      render();
    }
    if (action === "slack-behavior") {
      saveSlackBehavior(target.getAttribute("data-setting"), !!target.checked);
    }
    // Remember the picked channel so a Refresh / re-render keeps the selection.
    if (action === "select-channel-option") { state.addChannelSelected = target.value; }
    if (action === "attach-channel-option") { state.attachChannelSelected = target.value; }
    if (action === "profile-edit-policy" && state.profileDraft) {
      state.profileDraft.editPolicy = target.value === "all_workspace_members"
        ? "all_workspace_members"
        : "creator_and_admins";
      markProfileDirty();
    }
    if (action === "replacement-default-agent") {
      state.profileReplacementDefaultAgentId = target.value || "";
    }
    // Custom-skill enable toggle: flip enabled on the row at data-index. Re-render
    // so the checked attribute in the HTML stays in sync with the draft (the
    // toggle is a pure-CSS control, so a stale attribute would desync on save).
    if (action === "skill-toggle" && state.profileDraft) {
      collectProfileDraft();
      var toggleIndex = Number(target.getAttribute("data-index"));
      var toggleSkills = state.profileDraft.skills || [];
      if (toggleSkills[toggleIndex]) { toggleSkills[toggleIndex].enabled = target.checked; state.profileDraft.skills = toggleSkills; markProfileDirty(); render(); }
    }
    if (action === "suggested-skill-toggle" && state.profileDraft) {
      collectProfileDraft();
      var suggestedId = target.getAttribute("data-skill-id") || "";
      var suggestion = SUGGESTED_SKILLS.find(function (skill) { return skill.id === suggestedId; });
      if (suggestion) {
        var suggestedSkills = state.profileDraft.skills || [];
        var suggestedIndex = suggestedSkillIndex(suggestedSkills, suggestion);
        var suggestedChanged = false;
        if (suggestedIndex >= 0) {
          if (target.checked) {
            if (!suggestedSkills[suggestedIndex].enabled) {
              suggestedSkills[suggestedIndex].enabled = true;
              suggestedChanged = true;
            }
          } else {
            suggestedSkills.splice(suggestedIndex, 1);
            suggestedChanged = true;
          }
        } else if (target.checked) {
          var suggestedNameInUse = suggestedSkills.some(function (skill) { return skill.name === suggestion.name; });
          if (!suggestedNameInUse) {
            suggestedSkills.push({
              name: suggestion.name,
              description: suggestion.runtimeDescription,
              instructions: suggestion.instructions,
              enabled: true,
              suggestedSkillId: suggestion.id
            });
            suggestedChanged = true;
          }
        }
        if (suggestedChanged) {
          state.profileDraft.skills = suggestedSkills;
          markProfileDirty();
        }
        render();
      }
    }
    // Import picker per-row checkbox: flip the parallel selected[] flag and
    // re-render so the row highlight + Select all/Clear all label stay in sync.
    if (action === "import-row-toggle" && state.skillImport && state.skillImport.resolution) {
      var importIndex = Number(target.getAttribute("data-index"));
      var importSelected = state.skillImport.selected || [];
      importSelected[importIndex] = target.checked;
      state.skillImport.selected = importSelected;
      render();
    }
    // Connection card enable toggle: flip enabled on the row at data-index.
    if (action === "conn-toggle" && state.profileDraft) {
      collectProfileDraft();
      var connToggleIndex = Number(target.getAttribute("data-index"));
      var connToggleServers = state.profileDraft.mcpServers || [];
      if (connToggleServers[connToggleIndex]) { connToggleServers[connToggleIndex].enabled = target.checked; state.profileDraft.mcpServers = connToggleServers; markProfileDirty(); render(); }
    }
    // Connection auth mode select. Choosing another mode from an existing
    // OAuth connection explicitly stages OAuth credential cleanup on save.
    if (action === "conn-auth" && state.connectionEditor) {
      state.connectionEditor.authMode = target.value === "oauth"
        ? "oauth"
        : (target.value === "bearer" ? "bearer" : "none");
      markProfileDirty();
      render();
    }
    // Discovered-tool checkbox: flip the parallel checked[] flag. Re-render so the
    // check visual and the count line stay in sync.
    if (action === "conn-tool-toggle" && state.connectionEditor) {
      var connToolIndex = Number(target.getAttribute("data-index"));
      var connChecked = state.connectionEditor.checked || [];
      connChecked[connToolIndex] = target.checked;
      state.connectionEditor.checked = connChecked;
      state.connectionEditor.toolAccessError = "";
      if (!isPersistedReadyOAuthEditor(state.connectionEditor)) markProfileDirty();
      render();
    }
    if (action === "apiconn-toggle" && state.profileDraft) {
      collectProfileDraft();
      var apiConnToggleIndex = Number(target.getAttribute("data-index"));
      var apiConnToggleValues = state.profileDraft.apiConnections || [];
      if (apiConnToggleValues[apiConnToggleIndex]) { apiConnToggleValues[apiConnToggleIndex].enabled = target.checked; state.profileDraft.apiConnections = apiConnToggleValues; markProfileDirty(); render(); }
    }
    if (action === "apiconn-method-toggle" && state.apiConnectionEditor) {
      var apiConnMethodIndex = Number(target.getAttribute("data-index"));
      var apiConnMethodChecked = state.apiConnectionEditor.methodChecked || [];
      apiConnMethodChecked[apiConnMethodIndex] = target.checked;
      state.apiConnectionEditor.methodChecked = apiConnMethodChecked;
      markProfileDirty();
      render();
    }
    if (action === "repo-select" && state.repositoryPicker) {
      var repoFullName = target.getAttribute("data-repo") || "";
      var repoSelected = state.repositoryPicker.selectedFullNames || [];
      var repoSelectedIndex = repoSelected.indexOf(repoFullName);
      if (target.checked && repoSelectedIndex < 0) repoSelected.push(repoFullName);
      if (!target.checked && repoSelectedIndex >= 0) repoSelected.splice(repoSelectedIndex, 1);
      state.repositoryPicker.selectedFullNames = repoSelected;
      // A full render() would rebuild the page and throw away the picker
      // list's scroll position — the selection would jump out of view on
      // every click. Redraw only the picker, keeping the list where it was.
      rerenderRepositoryPicker();
    }
    if (action === "repo-all" && state.profileDraft) {
      toggleAllRepositories(
        Number(target.getAttribute("data-installation")),
        target.getAttribute("data-account") || "GitHub",
        !!target.checked
      );
    }
  });

  // Blur commits the inline title rename (same as Enter). focusout bubbles;
  // blur does not.
  document.addEventListener("focusout", function (event) {
    var target = event.target;
    var action = target && target.getAttribute && target.getAttribute("data-action");
    if (action === "profile-name" && state.profileRenaming) {
      closeProfileRename(false);
    }
    if (action === "profile-description" && state.profileDescriptionEditing) {
      closeProfileDescriptionEdit(false);
    }
  });

  document.addEventListener("submit", function (event) {
    var form = event.target;
    var action = form.getAttribute("data-action");
    if (!action) return;
    event.preventDefault();
    if (action === "add-channel-form") addChannel(new FormData(form));
    if (action === "onboarding-channel-form") startOnboardingTry(new FormData(form));
    if (action === "github-manifest-form") submitGithubManifest(new FormData(form));
  });

  // Escape dismisses the open Model combobox (F6) without picking a model.
  // Close the inline title rename. Empty names revert to the previous name
  // (the title must never go blank), so "Name is required." is unreachable on
  // the edit screen.
  function closeProfileRename(revert) {
    if (!state.profileRenaming || !state.profileDraft) return;
    var prev = state.profileRenaming.prev;
    if (revert || !String(state.profileDraft.name || "").trim()) {
      state.profileDraft.name = prev;
    }
    state.profileRenaming = null;
    render();
  }

  function closeProfileDescriptionEdit(revert) {
    if (!state.profileDescriptionEditing || !state.profileDraft) return;
    if (revert) state.profileDraft.description = state.profileDescriptionEditing.prev;
    state.profileDescriptionEditing = null;
    render();
  }

  function trapModalTab(event, selector) {
    if (event.key !== "Tab") return false;
    var dialog = document.querySelector(selector);
    if (!dialog) return false;
    var controls = Array.prototype.slice.call(dialog.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    if (!controls.length) {
      event.preventDefault();
      if (dialog.focus) dialog.focus();
      return true;
    }
    var first = controls[0];
    var last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return true;
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
      return true;
    }
    return false;
  }

  document.addEventListener("keydown", function (event) {
    if (state.composioSetup) {
      if (trapModalTab(event, '[data-role="composio-setup-dialog"]')) return;
      if ((event.key === "Escape" || event.key === "Esc") && state.composioSetup.phase !== "validating" && state.composioSetup.phase !== "preparing") {
        event.preventDefault();
        var composioReturnPresetId = state.composioSetup.returnFocusPresetId;
        state.composioSetup = null;
        render();
        var composioReturn = document.querySelector('[data-action="connection-account-preset"][data-preset="' + composioReturnPresetId + '"]');
        if (composioReturn && composioReturn.focus) composioReturn.focus();
        return;
      }
    }
    if (state.managedAuthorization) {
      if (trapModalTab(event, '[data-role="managed-auth-dialog"]')) return;
      if (event.key === "Escape" || event.key === "Esc") {
        event.preventDefault();
        return;
      }
    }
    if (state.connectorSettings.confirm) {
      if (trapModalTab(event, '[data-role="connector-settings-confirm-dialog"]')) return;
      if (event.key === "Escape" || event.key === "Esc") {
        event.preventDefault();
        state.connectorSettings.confirm = "";
        render();
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      if (state.ownerMemory.dirty) {
        event.preventDefault();
        saveOwnerMemoryEntry();
        return;
      }
      if (state.profileScreen === "edit" && state.profileDirty) { event.preventDefault(); saveProfile(); return; }
    }
    if (state.teamActionMenuId && (event.key === "Escape" || event.key === "Esc")) {
      event.preventDefault();
      var closingTeamMenuId = state.teamActionMenuId;
      state.teamActionMenuId = "";
      render();
      focusTeamActionTrigger(closingTeamMenuId);
      return;
    }
    if (state.sandboxConfirm && state.sandboxSaving && event.key === "Tab") {
      event.preventDefault();
      var pendingSandboxDialog = document.querySelector('[data-role="sandbox-confirm-dialog"]');
      if (pendingSandboxDialog && pendingSandboxDialog.focus) pendingSandboxDialog.focus();
      return;
    }
    if (state.sandboxConfirm && (event.key === "Escape" || event.key === "Esc")) {
      event.preventDefault();
      if (state.sandboxSaving) return;
      state.sandboxConfirm = "";
      state.sandboxReadyAttested = false;
      state.sandboxError = "";
      render();
      return;
    }
    if (state.scheduledDeleteConfirm && (event.key === "Escape" || event.key === "Esc")) {
      event.preventDefault();
      if (state.scheduledBusy) return;
      state.scheduledDeleteConfirm = false;
      render();
      return;
    }
    if (state.scheduledSelection && !state.scheduledInspector && (event.key === "Escape" || event.key === "Esc")) {
      event.preventDefault();
      closeScheduledSummary();
      return;
    }
    if (state.githubDisconnectConfirm && event.key === "Tab") {
      event.preventDefault();
      if (state.githubBusy === "disconnect") {
        focusGithubDisconnectDialog();
        return;
      }
      var cancelGithubDisconnect = document.querySelector('[data-action="github-disconnect-cancel"]');
      var confirmGithubDisconnect = document.querySelector('[data-action="github-disconnect-confirm"]');
      if (!cancelGithubDisconnect || !confirmGithubDisconnect) {
        focusGithubDisconnectDialog();
        return;
      }
      var activeGithubDisconnect = document.activeElement;
      var nextGithubDisconnect = event.shiftKey
        ? (activeGithubDisconnect === cancelGithubDisconnect ? confirmGithubDisconnect : cancelGithubDisconnect)
        : (activeGithubDisconnect === confirmGithubDisconnect ? cancelGithubDisconnect : confirmGithubDisconnect);
      if (nextGithubDisconnect.focus) nextGithubDisconnect.focus();
      return;
    }
    if (state.githubDisconnectConfirm && (event.key === "Escape" || event.key === "Esc")) {
      event.preventDefault();
      if (state.githubBusy === "disconnect") {
        focusGithubDisconnectDialog();
        return;
      }
      state.githubDisconnectConfirm = false;
      state.githubDisconnectError = "";
      render();
      focusAction("github-disconnect-open");
      return;
    }
    if (state.slackDisconnectConfirm && event.key === "Tab") {
      event.preventDefault();
      if (state.slackDisconnectBusy) {
        focusSlackDisconnectDialog();
        return;
      }
      var cancelDisconnect = document.querySelector('[data-action="slack-disconnect-cancel"]');
      var confirmDisconnect = document.querySelector('[data-action="slack-disconnect-confirm"]');
      if (!cancelDisconnect || !confirmDisconnect) {
        focusSlackDisconnectDialog();
        return;
      }
      var activeDisconnect = document.activeElement;
      var nextDisconnect = event.shiftKey
        ? (activeDisconnect === cancelDisconnect ? confirmDisconnect : cancelDisconnect)
        : (activeDisconnect === confirmDisconnect ? cancelDisconnect : confirmDisconnect);
      if (nextDisconnect.focus) nextDisconnect.focus();
      return;
    }
    if (state.slackDisconnectConfirm && (event.key === "Escape" || event.key === "Esc")) {
      event.preventDefault();
      if (state.slackDisconnectBusy) {
        focusSlackDisconnectDialog();
        return;
      }
      state.slackDisconnectConfirm = false;
      state.slackDisconnectError = "";
      render();
      focusAction("slack-disconnect-open");
      return;
    }
    var agentOverflowTrigger = event.target && event.target.closest && event.target.closest(".agent-overflow-trigger");
    if (agentOverflowTrigger && (event.key === "Enter" || event.key === " " || event.key === "ArrowDown")) {
      event.preventDefault();
      if (!state.profileOverflowOpen) {
        state.profileOverflowOpen = true;
        render();
        focusAction(state.profileDraft && state.profileDraft.lifecycle === "archived"
          ? "restore-profile"
          : "archive-profile");
      }
      return;
    }
    if (state.profileOverflowOpen && (event.key === "Escape" || event.key === "Esc")) {
      event.preventDefault();
      state.profileOverflowOpen = false;
      render();
      focusAction("agent-overflow-toggle");
      return;
    }
    if (state.profileRenaming) {
      if (event.key === "Enter") { event.preventDefault(); closeProfileRename(false); return; }
      if (event.key === "Escape" || event.key === "Esc") { closeProfileRename(true); return; }
    }
    if (state.profileDescriptionEditing) {
      if (event.key === "Enter") { event.preventDefault(); closeProfileDescriptionEdit(false); return; }
      if (event.key === "Escape" || event.key === "Esc") { closeProfileDescriptionEdit(true); return; }
    }
    if (event.key === "Escape" || event.key === "Esc") {
      if (state.leavePrompt) { state.leavePrompt = null; render(); return; }
      if (state.profileTab === "skills" && state.skillImport && state.skillImport.browse) { closeSkillImportBrowse(); return; }
      if (state.repositoryPicker || state.repositoryAddOpen) { closeRepositoryPicker(); return; }
      if (state.modelPickerOpen) { closeModelPicker(); }
    }
    // ARIA tabs keyboard contract for the capability tab bar: Left/Right (and
    // Home/End) move focus AND activate; the roving tabindex in profileTabsHtml
    // keeps exactly one pill in the document Tab order.
    var tabButton = event.target && event.target.closest && event.target.closest(".ptab");
    if (tabButton && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      var order = ["instructions", "skills", "connections", "repositories", "memory", "schedules"];
      var current = order.indexOf(state.profileTab || "instructions");
      var next =
        event.key === "ArrowLeft" ? (current + order.length - 1) % order.length :
        event.key === "ArrowRight" ? (current + 1) % order.length :
        event.key === "Home" ? 0 : order.length - 1;
      showProfileTab(order[next]);
      var focusTarget = document.getElementById("ptab-" + order[next]);
      if (focusTarget) focusTarget.focus();
    }
  });

  // Browser-level guard: warn before a tab close, reload, or external
  // navigation leaves a profile editor with unsaved changes. window is absent
  // in the unit-test VM context, so registration is skipped there.
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("beforeunload", function (event) {
      if (
        (state.profileScreen === "edit" && state.profileDirty) ||
        (state.view === "channels" && state.channelScreen === "detail" && state.dirty) ||
        state.ownerMemory.dirty ||
        state.slackConnectionBusy === "disconnect" ||
        state.githubBusy === "disconnect"
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    // Back/forward apply the popped URL to state. A dirty editor is guarded
    // here too: restore the editor's URL and park the destination behind the
    // same leave modal the in-app navigation uses.
    window.addEventListener("popstate", function () {
      if (!canNavigate || !routeReady) return;
      var targetPath = location.pathname;
      if (state.slackConnectionBusy === "disconnect") {
        history.pushState(null, "", canonicalPath());
        if (state.slackConnectionBusy === "disconnect") focusSlackDisconnectDialog();
        return;
      }
      if (state.githubBusy === "disconnect") {
        history.pushState(null, "", canonicalPath());
        if (state.githubBusy === "disconnect") focusGithubDisconnectDialog();
        return;
      }
      // A non-busy disconnect confirmation is not a route. Close it before
      // applying Back/Forward so the old dialog cannot survive over a new page
      // or try to restore focus to a control that no longer exists.
      if (state.slackDisconnectConfirm) {
        state.slackDisconnectConfirm = false;
        state.slackDisconnectError = "";
      }
      if (state.githubDisconnectConfirm) {
        state.githubDisconnectConfirm = false;
        state.githubDisconnectError = "";
      }
      if (state.ownerMemory.dirty && targetPath !== canonicalPath()) {
        history.pushState(null, "", canonicalPath());
        state.ownerMemory.error = "Save or discard this memory draft before navigating away.";
        render();
        return;
      }
      if (state.profileScreen === "edit" && state.profileDirty && targetPath !== canonicalPath()) {
        history.pushState(null, "", canonicalPath());
        state.leavePrompt = { kind: "profile", action: "route", path: targetPath };
        render();
        return;
      }
      if (state.view === "channels" && state.channelScreen === "detail" && state.dirty && targetPath !== canonicalPath()) {
        history.pushState(null, "", canonicalPath());
        state.leavePrompt = { kind: "channel", action: "route", path: targetPath };
        render();
        return;
      }
      applyRoute(targetPath);
    });
  }

  // Land on the Profiles overview (topbar / channel-page "Manage profiles"), or
  // directly on a profile's edit detail when a target id is supplied (the
  // channel-page Profile row's Edit affordance).
  function enterProfiles(targetAgentId) {
    if (state.ownerMemory.dirty && (!targetAgentId || targetAgentId !== state.ownerMemory.ownerId)) {
      state.ownerMemory.error = "Save or discard this memory draft before opening another Agent.";
      render();
      return;
    }
    state.view = "profiles";
    resetProfileTransientState();
    var target = targetAgentId ? agentById(targetAgentId) : null;
    if (target) {
      state.profileScreen = "edit";
      state.editingAgentId = target.id;
      state.profileLastAgentId = target.id;
      state.profileDraft = cloneAgent(target);
      loadAgentConnections(target.id);
      loadAgentSchedules(target.id);
      loadOwnerMemory("agent", connectedTeamId(), target.id);
    } else {
      state.profileScreen = "list";
      state.profileDraft = null;
      state.editingAgentId = null;
    }
    render();
  }

  function openHome() {
    var homeAgent = defaultAgent();
    if (homeAgent) openProfileEditor(homeAgent);
    else enterProfiles(null);
  }

  function openChannels() {
    state.view = "channels";
    state.channelScreen = "overview";
    state.profileScreen = "list";
    state.disableConfirm = false;
    state.addChannelOpen = false;
    state.slackDisconnectConfirm = false;
    if (isSlackConnected()) {
      if (!state.slackBehavior) loadSlackBehavior();
      if (!state.slackChannels && !state.slackChannelsLoading) loadSlackChannels(false);
    }
    render();
  }

  function openAddChannel(agentId) {
    state.view = "channels";
    state.channelScreen = "overview";
    state.addChannelOpen = true;
    state.addChannelError = "";
    state.addChannelInvite = "";
    state.addChannelAgentId = agentId || "";
    if (!ensureSlackChannelsLoaded()) render();
  }

  function loadSlackBehavior() {
    if (state.slackBehaviorBusy) return Promise.resolve(null);
    state.slackBehaviorBusy = "load";
    state.slackBehaviorError = "";
    render();
    return api("/admin/api/slack-behavior").then(function (body) {
      state.slackBehavior = body;
      state.slackBehaviorBusy = "";
      render();
      return body;
    }).catch(function (error) {
      state.slackBehaviorError = error.serverMessage || error.message || "Could not load Slack behavior.";
      state.slackBehaviorBusy = "";
      render();
      return null;
    });
  }

  function saveSlackBehavior(key, value) {
    if (!key || state.slackBehaviorBusy || !state.slackBehavior || !state.slackBehavior[key]) return;
    var prior = state.slackBehavior[key].value;
    state.slackBehavior[key].value = value;
    state.slackBehaviorBusy = key;
    state.slackBehaviorError = "";
    render();
    var body = {};
    body[key] = value;
    postJson("/admin/api/slack-behavior", "PUT", body).then(function (result) {
      state.slackBehavior = result;
      state.slackBehaviorBusy = "";
      render();
    }).catch(function (error) {
      state.slackBehavior[key].value = prior;
      state.slackBehaviorBusy = "";
      state.slackBehaviorError = error.serverMessage || error.message || "Could not save Slack behavior.";
      render();
    });
  }

  function testSlackConnection() {
    if (state.slackConnectionBusy) return;
    state.slackConnectionBusy = "test";
    state.slackTestBusy = true;
    state.slackTestStatus = null;
    render();
    postJson("/admin/api/slack-connection/test", "POST", {}).then(function (result) {
      state.slackTestBusy = false;
      state.slackConnectionBusy = "";
      var team = (result && (result.teamName || result.teamId)) || connectedTeamName();
      state.slackTestStatus = { ok: true, message: "Connection healthy" + (team ? " · " + team : "") };
      render();
    }).catch(function (error) {
      state.slackTestBusy = false;
      state.slackConnectionBusy = "";
      var detail = error.detail || (error.payload && error.payload.detail);
      if (state.slack && error.message === "slack_gateway_unreachable" && slackReconnectRequired(detail)) {
        state.slack.health = "needs_attention";
        state.slack.healthDetail = detail;
      }
      state.slackTestStatus = { ok: false, message: slackErrorText(error.message, error.detail, error.serverMessage, error.payload) };
      render();
    });
  }

  function refreshSlackGatewayAuthorization() {
    if (state.slackConnectionBusy) return;
    state.slackConnectionBusy = "refresh";
    state.slackReconnectError = "";
    render();
    api("/admin/slack-gateway/refresh", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json"
      },
      body: "{}"
    }).then(function (body) {
      var authorizationUrl;
      try { authorizationUrl = new URL(String(body && body.authorizationUrl || "")); } catch (error) { throw new Error("Slack authorization returned an invalid URL."); }
      if (authorizationUrl.protocol !== "https:") throw new Error("Slack authorization must use https.");
      location.assign(authorizationUrl.href);
    }).catch(function (error) {
      state.slackConnectionBusy = "";
      state.slackReconnectError = (error && (error.serverMessage || error.message)) || "Could not open Slack authorization.";
      render();
    });
  }

  function disconnectSlack() {
    if (state.slackConnectionBusy) return;
    state.slackConnectionBusy = "disconnect";
    state.slackDisconnectBusy = true;
    state.slackDisconnectError = "";
    render();
    api("/admin/api/slack-connection", { method: "DELETE" }).then(function () {
      state.slackDisconnectBusy = false;
      state.slackConnectionBusy = "";
      state.slackDisconnectConfirm = false;
      state.slackDisconnectError = "";
      state.slackTestStatus = null;
      state.slackBehavior = null;
      state.slackChannelsRequestId += 1;
      state.slackChannels = null;
      state.active = null;
      state.channelScreen = "overview";
      return refreshData();
    }).catch(function (error) {
      state.slackDisconnectBusy = false;
      state.slackConnectionBusy = "";
      state.slackDisconnectError = error.serverMessage || error.message || "Could not disconnect Slack.";
      render();
    });
  }

  function openProfileAttachPicker() {
    state.attachPicker = true;
    state.attachChannelSelected = "";
    state.attachError = "";
    state.attachNotice = "";
    if (!ensureSlackChannelsLoaded()) renderPreservingPagePosition();
  }

  // Returns true when loadSlackChannels owns the next render. Both channel
  // pickers use this guard so an open does not duplicate requests or renders.
  function ensureSlackChannelsLoaded() {
    if (isSlackConnected() && !state.slackChannels && !state.slackChannelsLoading) {
      loadSlackChannels(false);
      return true;
    }
    return false;
  }

  function loadSlackChannels(refresh) {
    if (!isSlackConnected()) return Promise.resolve();
    var preserveAgentId = state.view === "profiles" && state.profileScreen === "edit" && state.attachPicker && state.profileDraft
      ? state.profileDraft.id
      : "";
    var requestId = ++state.slackChannelsRequestId;
    state.slackChannelsLoading = true;
    state.slackChannelsError = null;
    renderSlackChannelCatalogState(preserveAgentId);
    return api("/admin/api/slack-channels" + (refresh ? "?refresh=1" : "")).then(function (body) {
      if (requestId !== state.slackChannelsRequestId) return null;
      state.slackChannels = body;
      state.slackChannelsLoading = false;
      // Adopt the workspace identity the proxy backfilled so the locked
      // Workspace field and the connection card both name it, even on installs
      // that predate team persistence.
      if (state.slack) {
        if (body.teamId) state.slack.teamId = body.teamId;
        if (body.teamName) state.slack.teamName = body.teamName;
      }
      if (
        state.view === "onboarding" &&
        state.onboarding &&
        state.onboarding.stage === "choose_channel" &&
        !state.onboardingChannelSelected &&
        body.channels &&
        body.channels.length
      ) {
        state.onboardingChannelSelected = body.channels[0].id;
      }
      renderSlackChannelCatalogState(preserveAgentId);
    }).catch(function (error) {
      if (requestId !== state.slackChannelsRequestId) return null;
      state.slackChannelsLoading = false;
      state.slackChannelsError = {
        text: slackChannelsErrorText(error),
        code: error && error.message === "slack_list_failed" ? (error.detail || "") : ((error && error.message) || "")
      };
      renderSlackChannelCatalogState(preserveAgentId);
    });
  }

  function slackChannelsErrorText(error) {
    if (error && error.message === "slack_not_configured") return "Connect @Chickpea first to list channels.";
    if (error && error.message === "slack_list_failed" && error.detail === "missing_scope") {
      return "Slack permissions are out of date. Use scoped recovery to refresh the installation.";
    }
    if (error && error.message === "slack_list_failed" && error.detail) {
      return "Slack could not list channels (" + error.detail + ").";
    }
    return (error && (error.serverMessage || error.message)) || "Could not load channels.";
  }

  function slackOAuthSettingsUrl() {
    return "https://api.slack.com/apps";
  }

  function slackScopeReinstallLinkHtml() {
    return '<a class="btn btn-soft btn-sm" href="' + esc(slackOAuthSettingsUrl()) + '" target="_blank" rel="noopener noreferrer">Reinstall in Slack &nearr;</a>';
  }

  function slackScopeCredentialRepairHtml() {
    return '<p class="hint">After reinstalling, use the scoped recovery flow so Chickpea can verify and atomically replace the encrypted installation.</p>';
  }

  function addChannelErrorText(error) {
    if (error && error.serverMessage) return error.serverMessage;
    var message = error && error.message;
    if (message === "channel_not_found") return "Slack could not find that channel in the connected workspace. Check the ID, and invite the connected Slack app if it is private.";
    if (message === "workspace_mismatch") return "That channel belongs to a different workspace than the one Chickpea is connected to.";
    if (message === "unknown_agent") return "The Agent no longer exists. Reload and try again.";
    if (message === "channel_grant_changed") return "This Agent's Channel grant changed elsewhere. Reload the Agent and try again.";
    return message || "Could not add the channel.";
  }

  function channelInviteWarning(channelName) {
    return "#" + channelName + " was added, but the connected Slack app isn't a member of it yet, so it won't hear mentions there. Invite it to #" + channelName + " in Slack — no need to come back here.";
  }

  function addChannel(formData) {
    var agent = agentById(state.addChannelAgentId) || defaultAgent();
    var fail = function (message) { state.addChannelError = message; render(); };
    if (!agent) { fail("Create an Agent before adding a Channel."); return; }
    if (!isSlackConnected()) { fail("Connect @Chickpea first."); return; }
    var workspaceId = connectedTeamId();
    if (!workspaceId) { fail("Could not determine the connected workspace. Click Refresh and try again."); return; }
    var channelId;
    var label = "";
    if (state.addChannelManual) {
      channelId = String(formData.get("manualChannelId") || "").trim();
      if (!channelId) { fail("Channel ID is required."); return; }
      state.channelFormDraft.channelId = channelId;
    } else {
      channelId = String(formData.get("channelSelect") || state.addChannelSelected || "").trim();
      if (!channelId) { fail("Pick a channel, or enter its ID manually."); return; }
      var picked = findSlackChannel(channelId);
      if (picked) label = picked.name;
    }
    var existingChannel = (state.channelIndex || []).find(function (candidate) {
      return candidate.workspaceId === workspaceId && candidate.channelId === channelId;
    });
    if (existingChannel && (existingChannel.grants || []).some(function (grant) { return grant.agentId === agent.id; })) {
      fail(agent.name + " is already available in this Channel.");
      return;
    }
    publishAgentToChannel(agent.id, workspaceId, channelId).then(function (result) {
      state.addChannelOpen = false;
      state.addChannelManual = false;
      state.addChannelError = "";
      state.addChannelAgentId = "";
      state.channelFormDraft.channelId = "";
      state.active = { workspaceId: workspaceId, channelId: channelId };
      state.channelScreen = "detail";
      state.addChannelInvite = result && result.grant && result.grant.status !== "active"
        ? channelInviteWarning(normalizeChannelLabel(result.grant.channelLabel || label || channelId))
        : "";
      return refreshData();
    }).catch(function (error) { fail(addChannelErrorText(error)); });
  }

  // Commit an open skill editor into the draft before a profile save. Returns
  // true when it is safe to proceed (no editor, an empty editor discarded, or a
  // valid editor committed) and false when the editor is invalid — the error is
  // surfaced and the save aborts so the user never loses their typed skill.
  function commitOpenSkillEditor() {
    var editor = state.skillEditor;
    if (!editor) return true;
    var name = String(editor.name || "").trim();
    var description = String(editor.description || "").trim();
    var instructions = String(editor.instructions || "").trim();
    if (!name && !description && !instructions) { state.skillEditor = null; return true; }
    var skills = (state.profileDraft && state.profileDraft.skills) || [];
    var validationError = validateSkillEditor(editor, skills);
    if (validationError) { editor.error = validationError; render(); return false; }
    var saved = { name: name, description: description, instructions: instructions, enabled: true };
    if (editor.index === null || editor.index === undefined) { skills.push(saved); }
    else {
      var replaced = skills[editor.index];
      saved.enabled = replaced ? replaced.enabled : true;
      if (replaced && replaced.suggestedSkillId !== undefined) saved.suggestedSkillId = replaced.suggestedSkillId;
      skills[editor.index] = saved;
    }
    state.profileDraft.skills = skills;
    state.skillEditor = null;
    return true;
  }

  /* ---- Connections editor logic ------------------------------------------ */

  // A blank Connections editor for the "Add connection" flow.
  function newConnectionEditor() {
    return {
      index: null,
      preset: null,
      id: "",
      displayName: "",
      url: "",
      transport: "streamable-http",
      authMode: "none",
      oauthScope: "",
      headerNames: [],
      headerValues: [],
      bearerToken: "",
      enabled: true,
      testing: false,
      testError: "",
      discoveredTools: [],
      checked: [],
      lifecycleStatus: "pending",
      statusText: "",
      lastCheckedAt: null,
      identity: null,
      // Secret presence is inferred from the persisted policy (secrets-by-
      // reference): a saved bearer connection means a token was stored, a saved
      // headerName means that header value was stored. A freshly typed value
      // overrides the placeholder. Blank for a new connection.
      sources: { bearer: "missing", headers: {} },
      oauthStarting: false,
      oauthError: "",
      savedAllowedTools: [],
      toolAccessSaving: false,
      toolAccessError: "",
      error: ""
    };
  }

  function editorFromPreset(preset) {
    var authMode = preset.auth.kind === "bearer"
      ? "bearer"
      : (preset.auth.kind === "oauth" ? "oauth" : "none");
    var headerNames = preset.auth.kind === "header" ? [preset.auth.headerName] : [];
    var headerValues = preset.auth.kind === "header" ? [""] : [];
    var editor = Object.assign(newConnectionEditor(), {
      index: null,
      preset: preset,
      presetId: preset.id,
      view: "recommended",
      displayName: preset.name,
      url: preset.url,
      transport: preset.transport,
      id: preset.id,
      authMode: authMode,
      oauthScope: preset.auth.kind === "oauth" ? String(preset.auth.scope || "").trim() : "",
      headerNames: headerNames,
      headerValues: headerValues
    });
    if (preset.id === "supabase") {
      editor.supabaseProjectRef = "";
      editor.supabaseReadOnly = true;
      syncSupabaseUrl(editor);
    }
    if (preset.oauthPathScope === "sentry-org-project") {
      editor.sentryOrganizationSlug = "";
      editor.sentryProjectSlug = "";
      syncSentryUrl(editor);
    }
    return editor;
  }

  function connectionAuthKind(conn) {
    if (conn.authMode === "oauth") return "oauth";
    if (conn.authMode === "bearer") return "bearer";
    return (conn.headerNames || []).length > 0 ? "header" : "none";
  }

  // Seed an editor from an existing connection (POLICY only — secrets never live
  // in the profile row). checked[] is derived from allowedTools ∩ discoveredTools;
  // sources carry the "stored" placeholders for the bearer + known header names.
  function editorFromConnection(index, conn) {
    var editor = newConnectionEditor();
    editor.index = index;
    editor.id = conn.id;
    editor.displayName = conn.displayName;
    editor.url = conn.url;
    editor.transport = conn.transport || "streamable-http";
    editor.authMode = conn.authMode || "none";
    editor.oauthScope = conn.oauthScope || "";
    editor.headerNames = (conn.headerNames || []).slice();
    editor.headerValues = editor.headerNames.map(function () { return ""; });
    editor.enabled = !!conn.enabled;
    editor.lifecycleStatus = conn.lifecycleStatus || "pending";
    editor.statusText = conn.statusText || "";
    editor.lastCheckedAt = conn.lastCheckedAt !== undefined ? conn.lastCheckedAt : null;
    editor.identity = conn.identity ? {
      workspaceName: conn.identity.workspaceName,
      accountName: conn.identity.accountName
    } : null;
    editor.discoveredTools = (conn.discoveredTools || []).map(function (tool) {
      var t = { name: tool.name };
      if (tool.title !== undefined) t.title = tool.title;
      if (tool.description !== undefined) t.description = tool.description;
      return t;
    });
    var approved = conn.allowedTools || [];
    editor.checked = editor.discoveredTools.map(function (tool) { return approved.indexOf(tool.name) >= 0; });
    editor.savedAllowedTools = approved.slice();
    var pending = state.profileDraft && state.profileDraft.pendingSecrets && state.profileDraft.pendingSecrets[conn.id];
    var pendingHeaders = (pending && pending.headers) || {};
    var headerSources = {};
    editor.headerNames.forEach(function (name) {
      headerSources[name] = Object.prototype.hasOwnProperty.call(pendingHeaders, name) ? "missing" : "stored";
    });
    var bearerSource = conn.authMode === "bearer" && !(pending && pending.bearerToken !== undefined) ? "stored" : "missing";
    editor.sources = { bearer: bearerSource, headers: headerSources };
    editor.presetId = conn.presetId;
    if (conn.presetId) {
      var matchedPreset = presetById(conn.presetId) || null;
      // Reattach catalog copy and behavior only while the saved policy still
      // matches it. A changed auth kind or URL leaves the row in Advanced so a
      // catalog upgrade cannot broaden the saved connection's access.
      var supabaseSetup = matchedPreset && matchedPreset.id === "supabase"
        ? supabaseSetupFromUrl(conn.url)
        : null;
      var sentrySetup = matchedPreset && matchedPreset.oauthPathScope === "sentry-org-project"
        ? sentryScopeFromUrl(conn.url)
        : null;
      var presetMatchesPolicy = !!matchedPreset &&
        matchedPreset.auth.kind === connectionAuthKind(conn) &&
        (matchedPreset.url === conn.url ||
          (matchedPreset.id === "supabase" && !!supabaseSetup && validSupabaseProjectRef(supabaseSetup.projectRef)) ||
          (matchedPreset.oauthPathScope === "sentry-org-project" && !!sentrySetup));
      editor.preset = presetMatchesPolicy ? matchedPreset : null;
      if (editor.preset) {
        editor.view = "recommended";
        if (editor.preset.id === "supabase" && supabaseSetup) {
          editor.supabaseProjectRef = supabaseSetup.projectRef;
          editor.supabaseReadOnly = supabaseSetup.readOnly;
        }
        if (editor.preset.oauthPathScope === "sentry-org-project" && sentrySetup) {
          editor.sentryOrganizationSlug = sentrySetup.organizationSlug;
          editor.sentryProjectSlug = sentrySetup.projectSlug;
        }
        if (!editor.oauthScope && editor.preset.auth.kind === "oauth") {
          editor.oauthScope = String(editor.preset.auth.scope || "").trim();
        }
      }
    }
    return editor;
  }

  // Track a removed connection so its secrets are DELETEd on the next save. Keyed
  // by id; headerNames are needed because the settings store has no prefix scan.
  function rememberRemovedConnection(conn) {
    if (!state.profileDraft) return;
    var removed = state.profileDraft.removedConnections || [];
    removed.push({ id: conn.id, headerNames: (conn.headerNames || []).slice() });
    state.profileDraft.removedConnections = removed;
  }

  // Build the { id, url, transport, authMode, bearerToken?, headers? } body for
  // the test endpoint from the open editor. Only NON-EMPTY typed secrets are
  // included — an empty box means "use the stored/env value" server-side.
  function presetHeaderPrefix(editor, headerName) {
    var preset = editor && editor.preset;
    if (preset && preset.auth && preset.auth.kind === "header" && preset.auth.valuePrefix && preset.auth.headerName === headerName) return preset.auth.valuePrefix;
    return "";
  }

  function applyHeaderPrefix(prefix, value) {
    if (!prefix || !value) return value;
    return value.indexOf(prefix) === 0 ? value : prefix + value;
  }

  function connectionTestBody(editor) {
    var id = editor.id || connectionSlug(editor.displayName);
    var body = {
      id: id,
      url: String(editor.url || "").trim(),
      transport: editor.transport,
      authMode: editor.authMode
    };
    if (editor.authMode === "bearer" && String(editor.bearerToken || "").trim()) {
      body.bearerToken = editor.bearerToken;
    }
    var headers = {};
    var names = editor.headerNames || [];
    var values = editor.headerValues || [];
    var hasHeader = false;
    var headerNames = [];
    names.forEach(function (name, i) {
      var trimmedName = String(name || "").trim();
      var value = values[i];
      if (trimmedName) headerNames.push(trimmedName);
      if (trimmedName && value) { headers[trimmedName] = applyHeaderPrefix(presetHeaderPrefix(editor, trimmedName), value); hasHeader = true; }
    });
    if (hasHeader) body.headers = headers;
    // Always send the header NAMES so the server can back an un-retyped header
    // with its stored value on a re-test (typed values above still win).
    if (headerNames.length) body.headerNames = headerNames;
    return body;
  }

  // POST the UNSAVED form to the test endpoint. On success, replace discoveredTools
  // with the fresh results — RE-TEST RESETS APPROVALS: every new tool defaults
  // checked, but a tool that was previously approved AND still exists keeps its
  // check. On failure, mark the editor failed + record the safe statusText.
  function testConnection() {
    var editor = state.connectionEditor;
    if (!editor || editor.testing) return;
    if (!String(editor.url || "").trim()) return;
    editor.testing = true;
    editor.testError = "";
    editor.error = "";
    render();
    postJson("/admin/api/agents/" + encodeURIComponent(connectionAgentId()) + "/mcp/test", "POST", connectionTestBody(editor)).then(function (body) {
      var current = state.connectionEditor;
      if (!current) return;
      current.testing = false;
      if (body && body.ok) {
        var tools = (body.tools || []).map(function (tool) {
          var t = { name: tool.name };
          if (tool.title !== undefined) t.title = tool.title;
          if (tool.description !== undefined) t.description = tool.description;
          return t;
        });
        // A (re-)test refreshes discoveredTools but PRESERVES the operator's
        // approvals: a tool the operator unchecked must stay unchecked across a
        // re-test (silently re-approving a write-capable tool is a real footgun).
        // Carry each still-present tool's prior checked state by name; only
        // genuinely new tools default to checked.
        var priorApproval = {};
        (current.discoveredTools || []).forEach(function (tool, index) {
          priorApproval[tool.name] = (current.checked || [])[index];
        });
        current.discoveredTools = tools;
        current.checked = tools.map(function (tool) {
          var prior = priorApproval[tool.name];
          // Keep a still-present tool's prior approval; a genuinely new tool
          // (never seen in a prior test) defaults to checked.
          return prior === undefined ? true : prior;
        });
        current.lifecycleStatus = "ready";
        current.statusText = "";
        current.lastCheckedAt = Date.now();
        current.testError = "";
      } else {
        current.lifecycleStatus = "failed";
        current.statusText = (body && body.message) || "Could not connect to this MCP server.";
        current.testError = current.statusText;
        current.discoveredTools = [];
        current.checked = [];
      }
      markProfileDirty();
      render();
    }).catch(function (error) {
      var current = state.connectionEditor;
      if (!current) return;
      current.testing = false;
      current.lifecycleStatus = "failed";
      current.statusText = (error && (error.serverMessage || error.message)) || "Could not connect to this MCP server.";
      current.testError = current.statusText;
      markProfileDirty();
      render();
    });
  }

  function oauthStartErrorText(error, connectionName) {
    if (error && error.message === "oauth_unavailable") {
      return connectionName + " OAuth could not be prepared. Check that this install has a reachable callback URL, then try again.";
    }
    return (error && (error.serverMessage || error.message)) || connectionName + " OAuth could not be started.";
  }

  function showOAuthStartError(connectionId, error) {
    var draft = state.profileDraft;
    var servers = (draft && draft.mcpServers) || [];
    var index = servers.findIndex(function (connection) { return connection.id === connectionId; });
    var connectionName = index >= 0
      ? servers[index].displayName
      : ((state.connectionEditor && state.connectionEditor.displayName) || "Connection");
    var message = oauthStartErrorText(error, connectionName);
    if (index >= 0) {
      state.connectionEditor = editorFromConnection(index, servers[index]);
      state.connectionEditor.oauthError = message;
    } else if (state.connectionEditor) {
      state.connectionEditor.oauthStarting = false;
      state.connectionEditor.oauthError = message;
    } else {
      state.profileError = message;
    }
    state.profileTab = "connections";
    render();
  }

  // OAuth start is deliberately operator-driven. Persist the profile policy
  // first so the server can bind discovery/state/client registration to an
  // existing connection, then navigate only to the HTTPS authorization URL it
  // returns. The browser never receives credentials or the PKCE verifier.
  function startOAuthConnection() {
    var editor = state.connectionEditor;
    if (!editor || editor.authMode !== "oauth" || editor.oauthStarting) return;
    var servers = (state.profileDraft && state.profileDraft.mcpServers) || [];
    var validationError = validateConnectionEditor(editor, servers);
    if (validationError) { editor.error = validationError; render(); return; }
    var connectionId = editor.id || connectionSlug(editor.displayName);
    var oauthScope = String(editor.oauthScope || "").trim();
    var oauthStartBody = oauthScope ? { scope: oauthScope } : {};
    var oauthWindow = null;
    if (typeof window !== "undefined" && typeof window.open === "function") {
      oauthWindow = window.open("", "chickpea-mcp-oauth-" + Date.now());
      if (oauthWindow) oauthWindow.opener = null;
    }
    editor.oauthStarting = true;
    editor.oauthError = "";
    editor.error = "";
    render();
    saveProfile(function () {
      var agentId = state.editingAgentId || connectionAgentId();
      postJson(
        "/admin/api/agents/" + encodeURIComponent(agentId) + "/mcp/oauth/" + encodeURIComponent(connectionId) + "/start",
        "POST",
        oauthStartBody
      ).then(function (body) {
        var authorizationUrl;
        try {
          authorizationUrl = new URL(String(body && body.authorizationUrl || ""));
        } catch (_) {
          throw new Error("The OAuth provider returned an invalid authorization URL.");
        }
        if (authorizationUrl.protocol !== "https:") {
          throw new Error("The OAuth provider returned an unsafe authorization URL.");
        }
        if (oauthWindow && !oauthWindow.closed) {
          oauthWindow.location.assign(authorizationUrl.href);
        } else {
          location.assign(authorizationUrl.href);
        }
      }).catch(function (error) {
        if (oauthWindow && !oauthWindow.closed && typeof oauthWindow.close === "function") {
          oauthWindow.close();
        }
        showOAuthStartError(connectionId, error);
      });
    }, function () {
      if (oauthWindow && !oauthWindow.closed && typeof oauthWindow.close === "function") {
        oauthWindow.close();
      }
      var current = state.connectionEditor;
      if (current && (current.id || connectionSlug(current.displayName)) === connectionId) {
        current.oauthStarting = false;
      }
      render();
    });
  }

  function apiOAuthStartErrorText(error, connectionName) {
    if (error && (error.message === "client_missing" || error.message === "oauth_client_missing")) {
      return "Enter and save the Google OAuth client ID and client secret, then try again.";
    }
    if (error && error.message === "oauth_unavailable") {
      return connectionName + " OAuth could not be prepared. Check the Google client and redirect URI, then try again.";
    }
    return (error && (error.serverMessage || error.message)) || connectionName + " OAuth could not be started.";
  }

  function showApiOAuthStartError(connectionId, error) {
    var draft = state.profileDraft;
    var connections = (draft && draft.apiConnections) || [];
    var index = connections.findIndex(function (connection) { return connection.id === connectionId; });
    var connectionName = index >= 0
      ? connections[index].displayName
      : ((state.apiConnectionEditor && state.apiConnectionEditor.displayName) || "Connection");
    var message = apiOAuthStartErrorText(error, connectionName);
    if (index >= 0) {
      state.apiConnectionEditor = editorFromApiConnection(index, connections[index]);
      state.apiConnectionEditor.oauthError = message;
    } else if (state.apiConnectionEditor) {
      state.apiConnectionEditor.oauthStarting = false;
      state.apiConnectionEditor.oauthError = message;
    } else {
      state.profileError = message;
    }
    state.profileTab = "connections";
    render();
  }

  // BYO API OAuth follows the same save-before-navigation rule as MCP OAuth:
  // persist policy and the write-only client first, then ask the server for a
  // provider authorization URL. Tokens and PKCE state never enter this page.
  function startApiOAuthConnection() {
    var editor = state.apiConnectionEditor;
    if (!isGoogleWorkspaceEditor(editor) || editor.oauthStarting) return;
    syncGoogleApiPolicy(editor);
    var connections = (state.profileDraft && state.profileDraft.apiConnections) || [];
    var validationError = validateApiConnectionEditor(editor, connections);
    if (validationError) { editor.error = validationError; render(); return; }
    var connectionId = editor.id || connectionSlug(editor.displayName);
    editor.oauthStarting = true;
    editor.oauthError = "";
    editor.error = "";
    render();
    saveProfile(function () {
      var agentId = state.editingAgentId || connectionAgentId();
      postJson(
        "/admin/api/agents/" + encodeURIComponent(agentId) + "/api-connections/oauth/" + encodeURIComponent(connectionId) + "/start",
        "POST",
        {}
      ).then(function (body) {
        var authorizationUrl;
        try {
          authorizationUrl = new URL(String(body && body.authorizationUrl || ""));
        } catch (_) {
          throw new Error("Google returned an invalid authorization URL.");
        }
        if (authorizationUrl.protocol !== "https:") {
          throw new Error("Google returned an unsafe authorization URL.");
        }
        location.assign(authorizationUrl.href);
      }).catch(function (error) {
        showApiOAuthStartError(connectionId, error);
      });
    }, function () {
      var current = state.apiConnectionEditor;
      if (current && (current.id || connectionSlug(current.displayName)) === connectionId) {
        current.oauthStarting = false;
      }
      render();
    });
  }

  // Turn an open editor into a saved connection POLICY entry (never a secret).
  // allowedTools is the currently-checked subset of discoveredTools.
  function connectionFromEditor(editor) {
    var id = editor.id || connectionSlug(editor.displayName);
    var headerNames = (editor.headerNames || []).map(function (name) { return String(name || "").trim(); }).filter(function (name) { return !!name; });
    var discovered = (editor.discoveredTools || []).map(function (tool) {
      var t = { name: tool.name };
      if (tool.title !== undefined) t.title = tool.title;
      if (tool.description !== undefined) t.description = tool.description;
      return t;
    });
    var allowed = selectedConnectionToolNames(editor);
    var conn = {
      id: id,
      displayName: String(editor.displayName || "").trim(),
      url: String(editor.url || "").trim(),
      transport: editor.transport,
      authMode: editor.authMode,
      headerNames: headerNames,
      enabled: !!editor.enabled,
      lifecycleStatus: editor.lifecycleStatus || "pending",
      statusText: editor.statusText || "",
      discoveredTools: discovered,
      allowedTools: allowed
    };
    if (editor.authMode === "oauth" && String(editor.oauthScope || "").trim()) {
      conn.oauthScope = String(editor.oauthScope).trim();
    }
    if (editor.lastCheckedAt) conn.lastCheckedAt = editor.lastCheckedAt;
    if (editor.identity) conn.identity = editor.identity;
    if (editor.presetId) conn.presetId = editor.presetId;
    return conn;
  }

  // A successful OAuth callback has already persisted every discovered tool.
  // Later checkbox edits are therefore their own small policy operation: PATCH
  // only mcpServers, keep the editor open, and leave the profile-level dirty bit
  // untouched so unrelated draft changes still control the sticky save bar.
  function saveOAuthToolAccess() {
    var editor = state.connectionEditor;
    var draft = collectProfileDraft();
    if (!isPersistedReadyOAuthEditor(editor) || !draft || !draft.id ||
        editor.toolAccessSaving || !oauthToolAccessChanged(editor)) return;
    var savedAgent = agentById(draft.id);
    var persistedServers = ((savedAgent && savedAgent.mcpServers) || draft.mcpServers || []).map(cloneConnection);
    var persistedIndex = persistedServers.findIndex(function (connection) { return connection.id === editor.id; });
    if (persistedIndex < 0) {
      editor.toolAccessError = "This connector is no longer available. Reload the Agent and try again.";
      render();
      return;
    }

    var fromEditor = connectionFromEditor(editor);
    var updatedConnection = cloneConnection(persistedServers[persistedIndex]);
    updatedConnection.discoveredTools = fromEditor.discoveredTools;
    updatedConnection.allowedTools = fromEditor.allowedTools;
    updatedConnection.lifecycleStatus = fromEditor.lifecycleStatus;
    updatedConnection.statusText = fromEditor.statusText;
    updatedConnection.lastCheckedAt = editor.lastCheckedAt;
    persistedServers[persistedIndex] = updatedConnection;

    var savedAllowedTools = updatedConnection.allowedTools.slice();
    var connectionId = editor.id;
    editor.toolAccessSaving = true;
    editor.toolAccessError = "";
    render();
    postJson(
      "/admin/api/agents/" + encodeURIComponent(draft.id),
      "PATCH",
      { mcpServers: persistedServers }
    ).then(function () {
      var agent = agentById(draft.id);
      if (agent) agent.mcpServers = persistedServers.map(cloneConnection);
      var draftIndex = (draft.mcpServers || []).findIndex(function (connection) { return connection.id === connectionId; });
      if (draftIndex >= 0) {
        var draftConnection = draft.mcpServers[draftIndex];
        draftConnection.discoveredTools = updatedConnection.discoveredTools.map(function (tool) {
          return Object.assign({}, tool);
        });
        draftConnection.allowedTools = savedAllowedTools.slice();
        draftConnection.lifecycleStatus = updatedConnection.lifecycleStatus;
        draftConnection.statusText = updatedConnection.statusText;
        draftConnection.lastCheckedAt = updatedConnection.lastCheckedAt;
      }
      var current = state.connectionEditor;
      if (current && current.id === connectionId) {
        current.savedAllowedTools = savedAllowedTools.slice();
        current.toolAccessSaving = false;
        current.toolAccessError = "";
      }
      render();
    }).catch(function (error) {
      var current = state.connectionEditor;
      if (!current || current.id !== connectionId) return;
      current.toolAccessSaving = false;
      current.toolAccessError = (error && (error.serverMessage || error.message)) || "Tool access could not be saved.";
      render();
    });
  }

  // Stage the transient secrets typed into an editor for the settings PUT that
  // saveProfile issues after the profile PATCH. Only non-empty values are staged;
  // an empty box leaves the stored/env value untouched. NEVER goes in the PATCH.
  function stagePendingSecrets(id, editor, prior) {
    if (!state.profileDraft) return;
    var pending = state.profileDraft.pendingSecrets || {};
    var entry = pending[id] || { headerNames: [] };
    entry.headerNames = (editor.headerNames || []).map(function (name) { return String(name || "").trim(); }).filter(function (name) { return !!name; });
    // Orphan cleanup: a header renamed/removed in this edit, or an auth switch
    // away from bearer, deletes its stored secret on save — otherwise dead
    // values linger in settings under keys nothing references anymore.
    if (prior && prior.id === id) {
      var keptNames = {};
      entry.headerNames.forEach(function (name) { keptNames[name] = true; });
      var removedNames = (prior.headerNames || []).filter(function (name) { return !keptNames[name]; });
      if (removedNames.length) {
        var staged = entry.removeHeaderNames || [];
        removedNames.forEach(function (name) { if (staged.indexOf(name) < 0) staged.push(name); });
        entry.removeHeaderNames = staged;
      }
      if (prior.authMode === "bearer" && editor.authMode !== "bearer") {
        entry.clearBearer = true;
      }
      if (prior.authMode === "oauth" && editor.authMode !== "oauth") {
        entry.clearOAuth = true;
      }
    }
    if (editor.authMode === "bearer" && String(editor.bearerToken || "").trim()) {
      entry.bearerToken = editor.bearerToken;
      // A re-entered bearer supersedes any staged clear from an earlier edit.
      delete entry.clearBearer;
    }
    var headers = entry.headers || {};
    var names = editor.headerNames || [];
    var values = editor.headerValues || [];
    names.forEach(function (name, i) {
      var trimmedName = String(name || "").trim();
      var value = values[i];
      if (trimmedName && value) headers[trimmedName] = applyHeaderPrefix(presetHeaderPrefix(editor, trimmedName), value);
    });
    if (Object.keys(headers).length) entry.headers = headers;
    pending[id] = entry;
    state.profileDraft.pendingSecrets = pending;
  }

  // "Add connection" / "Save connection" button: validate, upsert into the draft,
  // stage typed secrets, close the editor.
  function commitConnectionRow() {
    var editor = state.connectionEditor;
    if (!editor) return;
    var customMode = state.customConnectionLane === "mcp";
    var servers = (state.profileDraft && state.profileDraft.mcpServers) || [];
    var validationError = validateConnectionEditor(editor, servers);
    if (validationError) { editor.error = validationError; render(); return; }
    var conn = connectionFromEditor(editor);
    var prior = (editor.index === null || editor.index === undefined) ? null : servers[editor.index];
    if (editor.index === null || editor.index === undefined) { servers.push(conn); }
    else { servers[editor.index] = conn; }
    state.profileDraft.mcpServers = servers;
    stagePendingSecrets(conn.id, editor, prior);
    if (customMode) clearCustomConnectionMode();
    else state.connectionEditor = null;
    markProfileDirty();
    render();
  }

  // Commit a filled-but-not-"Added" connection editor into the draft on save, so
  // a typed connection is never silently dropped. Mirrors commitOpenSkillEditor:
  // returns false (and keeps the editor open with an inline error) if invalid.
  function commitOpenConnectionEditor() {
    if (state.customConnectionLane === "api") return true;
    var editor = state.connectionEditor;
    if (!editor) return true;
    var customMode = state.customConnectionLane === "mcp";
    // A completely empty editor is discarded silently.
    if (!String(editor.displayName || "").trim() && !String(editor.url || "").trim()) {
      if (customMode) clearCustomConnectionMode();
      else state.connectionEditor = null;
      return true;
    }
    var servers = (state.profileDraft && state.profileDraft.mcpServers) || [];
    var validationError = validateConnectionEditor(editor, servers);
    if (validationError) { editor.error = validationError; render(); return false; }
    var conn = connectionFromEditor(editor);
    var prior = (editor.index === null || editor.index === undefined) ? null : servers[editor.index];
    if (editor.index === null || editor.index === undefined) { servers.push(conn); }
    else { servers[editor.index] = conn; }
    state.profileDraft.mcpServers = servers;
    stagePendingSecrets(conn.id, editor, prior);
    if (customMode) clearCustomConnectionMode();
    else state.connectionEditor = null;
    return true;
  }

  async function settleSecretOperations(operations, pending, removed, succeededPending, skippedRemoved) {
    var succeededRemoved = {};
    var settled = await Promise.allSettled(operations.map(function (operation) { return operation.request; }));
    var failed = [];
    settled.forEach(function (result, index) {
      var operation = operations[index];
      if (result.status === "fulfilled") {
        if (operation.kind === "pending") succeededPending[operation.id] = true;
        else succeededRemoved[operation.index] = true;
      } else {
        failed.push({ id: operation.id, op: operation.op });
      }
    });
    Object.keys(succeededPending).forEach(function (id) { delete pending[id]; });
    var retainedRemoved = removed.filter(function (entry, index) {
      if (succeededRemoved[index]) return false;
      // A same-id DELETE was intentionally skipped in favor of the PUT. Once
      // that PUT succeeds, the stale removal is complete too; if it failed,
      // retain both entries so the same safe ordering is retried.
      if (skippedRemoved[index] && succeededPending[entry.id]) return false;
      return true;
    });
    return { failed: failed, removed: retainedRemoved };
  }

  // After the profile PATCH succeeds, concurrently PUT staged secrets and
  // DELETE removed connections. Successful operations leave the transient
  // queue; failures stay staged so the next profile save can retry them.
  async function flushConnectionSecrets(draft, agentId) {
    var pending = (draft && draft.pendingSecrets) || {};
    var removed = (draft && draft.removedConnections) || [];
    var operations = [];
    var succeededPending = {};
    var skippedRemoved = {};
    // A same-slug remove + re-add in one save stages BOTH a DELETE and a PUT for
    // that id. Skip the DELETE when a value-bearing PUT is pending for the same
    // id, so an out-of-order DELETE can't clobber the just-stored secret. (Any
    // header the re-add dropped is left orphaned but inert — turn time only
    // sends headers named on the current connection.)
    function pendingHasValue(id) {
      var e = pending[id];
      return !!e && (e.bearerToken !== undefined || e.headers !== undefined);
    }
    removed.forEach(function (entry, index) {
      if (pendingHasValue(entry.id)) { skippedRemoved[index] = true; return; }
      operations.push({
        id: entry.id,
        op: "delete",
        kind: "removed",
        index: index,
        request: postJson("/admin/api/agents/" + encodeURIComponent(agentId) + "/mcp/secrets/" + encodeURIComponent(entry.id), "DELETE", { headerNames: entry.headerNames || [] })
      });
    });
    Object.keys(pending).forEach(function (id) {
      var entry = pending[id];
      var body = { headerNames: entry.headerNames || [] };
      if (entry.bearerToken !== undefined) body.bearerToken = entry.bearerToken;
      if (entry.headers !== undefined) body.headers = entry.headers;
      if (entry.removeHeaderNames && entry.removeHeaderNames.length) body.removeHeaderNames = entry.removeHeaderNames;
      if (entry.clearBearer) body.clearBearer = true;
      if (entry.clearOAuth) body.clearOAuth = true;
      // Round-trip when there is a value to store OR an orphan to clean up.
      if (body.bearerToken !== undefined || body.headers !== undefined || body.removeHeaderNames !== undefined || body.clearBearer !== undefined || body.clearOAuth !== undefined) {
        operations.push({
          id: id,
          op: "put",
          kind: "pending",
          request: postJson("/admin/api/agents/" + encodeURIComponent(agentId) + "/mcp/secrets/" + encodeURIComponent(id), "PUT", body)
        });
      } else {
        // A policy-only edit can create an empty pending entry. It has no
        // credential operation to retry, so treat it as already complete.
        succeededPending[id] = true;
      }
    });
    var result = await settleSecretOperations(operations, pending, removed, succeededPending, skippedRemoved);
    if (draft) { draft.pendingSecrets = pending; draft.removedConnections = result.removed; }
    return { failed: result.failed };
  }

  /* ---- Credentialed REST API connection editor --------------------------- */

  function newApiConnectionEditor() {
    var defaults = { GET: true, POST: true };
    return {
      index: null,
      id: "",
      displayName: "",
      allowedHosts: [""],
      pathPrefixes: [""],
      headerName: "",
      headerValuePrefix: "",
      methodChecked: API_CONNECTION_METHODS.map(function (method) { return defaults[method] === true; }),
      credential: "",
      credentialPlaceholder: "",
      tokenDocsUrl: "",
      tokenDocsHint: "",
      hostTemplate: false,
      hostTemplateHost: "",
      enabled: true,
      authMode: "credential",
      oauthProvider: "",
      oauthScopes: [],
      savedOAuthScopes: [],
      oauthAppType: "workspace-internal",
      lifecycleStatus: "pending",
      statusText: "Not connected",
      identity: null,
      savedLifecycleStatus: "pending",
      savedStatusText: "Not connected",
      savedIdentity: null,
      oauthClientId: "",
      oauthClientSecret: "",
      oauthStarting: false,
      oauthError: "",
      googleAccess: { gmail: "read", calendar: "read", drive: "read" },
      sources: { credential: "missing", oauthClient: "missing", oauthTokens: "missing" },
      error: ""
    };
  }

  function apiEditorPresetMetadata(preset) {
    var api = preset.api;
    return {
      presetId: preset.id,
      view: "recommended",
      credentialPlaceholder: api.placeholder,
      tokenDocsUrl: preset.tokenDocsUrl || "",
      tokenDocsHint: preset.tokenDocsHint || "",
      hostTemplate: api.hostTemplate === true,
      hostTemplateHost: api.hostTemplate && api.hosts && api.hosts.length ? api.hosts[0] : "",
      authMode: api.oauth ? "oauth" : "credential",
      oauthProvider: api.oauth ? api.oauth.provider : ""
    };
  }

  function apiEditorFromPreset(preset) {
    var api = preset.api;
    var editor = Object.assign(newApiConnectionEditor(), apiEditorPresetMetadata(preset), {
      displayName: preset.name,
      id: preset.id,
      allowedHosts: (api.hosts || []).slice(),
      pathPrefixes: (api.pathPrefixes || []).slice(),
      headerName: api.headerName,
      headerValuePrefix: api.valuePrefix || "",
      methodChecked: API_CONNECTION_METHODS.map(function (method) { return (api.methods || []).indexOf(method) >= 0; })
    });
    if (isGoogleWorkspaceEditor(editor)) syncGoogleApiPolicy(editor);
    return editor;
  }

  function editorFromApiConnection(index, conn) {
    var editor = newApiConnectionEditor();
    var allowedMethods = conn.allowedMethods || [];
    editor.index = index;
    editor.id = conn.id;
    editor.displayName = conn.displayName;
    editor.allowedHosts = (conn.allowedHosts || []).length ? conn.allowedHosts.slice() : [""];
    editor.pathPrefixes = (conn.pathPrefixes || []).length ? conn.pathPrefixes.slice() : [""];
    editor.headerName = conn.headerName || "";
    editor.headerValuePrefix = conn.headerValuePrefix || "";
    editor.methodChecked = API_CONNECTION_METHODS.map(function (method) { return allowedMethods.indexOf(method) >= 0; });
    editor.enabled = !!conn.enabled;
    editor.presetId = conn.presetId;
    editor.authMode = conn.authMode || "credential";
    editor.oauthProvider = conn.oauthProvider || "";
    editor.oauthScopes = (conn.oauthScopes || []).slice();
    editor.savedOAuthScopes = editor.oauthScopes.slice();
    editor.oauthAppType = conn.oauthAppType || "workspace-internal";
    editor.lifecycleStatus = conn.lifecycleStatus || "pending";
    editor.statusText = conn.statusText || "";
    editor.identity = conn.identity || null;
    editor.savedLifecycleStatus = editor.lifecycleStatus;
    editor.savedStatusText = editor.statusText;
    editor.savedIdentity = editor.identity;
    editor.googleAccess = googleAccessFromScopes(editor.oauthScopes);
    // Credentials are write-only, so trust the server's resolved source
    // (stored/env/missing) rather than assuming a persisted policy has a value.
    // A draft that still carries an unsaved write for this connection overrides
    // it to "missing" until that write persists.
    var pending = state.profileDraft && state.profileDraft.pendingApiSecrets && state.profileDraft.pendingApiSecrets[conn.id];
    editor.sources = {
      credential: pending && pending.credential !== undefined ? "missing" : (conn.credentialSource || "missing"),
      oauthClient: pending && pending.oauthClient !== undefined ? "missing" : (conn.oauthClientSource || "missing"),
      oauthTokens: conn.oauthTokenSource || "missing"
    };
    var preset = conn.presetId ? presetById(conn.presetId) : null;
    if (preset && preset.api) Object.assign(editor, apiEditorPresetMetadata(preset));
    if (isGoogleWorkspaceEditor(editor)) syncGoogleApiPolicy(editor);
    return editor;
  }

  function apiConnectionFromEditor(editor) {
    var checked = editor.methodChecked || [];
    var conn = {
      id: editor.id || connectionSlug(editor.displayName),
      displayName: String(editor.displayName || "").trim(),
      allowedHosts: (editor.allowedHosts || []).map(function (host) { return String(host || "").trim(); }).filter(function (host) { return !!host; }),
      pathPrefixes: (editor.pathPrefixes || []).map(function (prefix) { return String(prefix || "").trim(); }).filter(function (prefix) { return !!prefix; }),
      headerName: String(editor.headerName || "").trim(),
      allowedMethods: API_CONNECTION_METHODS.filter(function (_method, index) { return checked[index] === true; }),
      enabled: !!editor.enabled
    };
    if (String(editor.headerValuePrefix || "") !== "") conn.headerValuePrefix = String(editor.headerValuePrefix);
    if (editor.presetId) conn.presetId = editor.presetId;
    if (isGoogleWorkspaceEditor(editor)) {
      conn.authMode = "oauth";
      conn.oauthProvider = "google";
      conn.oauthScopes = (editor.oauthScopes || []).slice();
      conn.oauthAppType = editor.oauthAppType === "external" ? "external" : "workspace-internal";
      conn.lifecycleStatus = editor.lifecycleStatus || "pending";
      conn.statusText = editor.statusText || "Not connected";
      if (editor.identity) conn.identity = editor.identity;
    }
    return conn;
  }

  function stagePendingApiSecret(id, editor) {
    if (!state.profileDraft) return;
    var pending = state.profileDraft.pendingApiSecrets || {};
    if (isGoogleWorkspaceEditor(editor)) {
      var clientId = String(editor.oauthClientId || "").trim();
      var clientSecret = String(editor.oauthClientSecret || "").trim();
      if (!clientId || !clientSecret) return;
      pending[id] = { oauthClient: { provider: "google", clientId: clientId, clientSecret: clientSecret } };
    } else {
      if (!String(editor.credential || "").trim()) return;
      pending[id] = { credential: editor.credential };
    }
    state.profileDraft.pendingApiSecrets = pending;
  }

  function rememberRemovedApiConnection(conn) {
    if (!state.profileDraft) return;
    var removed = state.profileDraft.removedApiConnections || [];
    removed.push({ id: conn.id });
    state.profileDraft.removedApiConnections = removed;
    // If this row was added/edited earlier in the same draft, its staged value
    // must not be written after removal. A later same-slug re-add can stage it anew.
    var pending = state.profileDraft.pendingApiSecrets || {};
    delete pending[conn.id];
    state.profileDraft.pendingApiSecrets = pending;
  }

  function commitApiConnectionRow() {
    var editor = state.apiConnectionEditor;
    if (!editor) return;
    var customMode = state.customConnectionLane === "api";
    var connections = (state.profileDraft && state.profileDraft.apiConnections) || [];
    var validationError = validateApiConnectionEditor(editor, connections);
    if (validationError) { editor.error = validationError; render(); return; }
    var conn = apiConnectionFromEditor(editor);
    if (editor.index === null || editor.index === undefined) connections.push(conn);
    else connections[editor.index] = conn;
    state.profileDraft.apiConnections = connections;
    stagePendingApiSecret(conn.id, editor);
    if (customMode) clearCustomConnectionMode();
    else state.apiConnectionEditor = null;
    markProfileDirty();
    render();
  }

  function commitOpenApiConnectionEditor() {
    if (state.customConnectionLane === "mcp") return true;
    var editor = state.apiConnectionEditor;
    if (!editor) return true;
    var customMode = state.customConnectionLane === "api";
    var hasTypedValue = String(editor.displayName || "").trim() ||
      (editor.allowedHosts || []).some(function (host) { return !!String(host || "").trim(); }) ||
      String(editor.headerName || "").trim() || String(editor.credential || "").trim();
    if (!hasTypedValue) {
      if (customMode) clearCustomConnectionMode();
      else state.apiConnectionEditor = null;
      return true;
    }
    var connections = (state.profileDraft && state.profileDraft.apiConnections) || [];
    var validationError = validateApiConnectionEditor(editor, connections);
    if (validationError) { editor.error = validationError; render(); return false; }
    var conn = apiConnectionFromEditor(editor);
    if (editor.index === null || editor.index === undefined) connections.push(conn);
    else connections[editor.index] = conn;
    state.profileDraft.apiConnections = connections;
    stagePendingApiSecret(conn.id, editor);
    if (customMode) clearCustomConnectionMode();
    else state.apiConnectionEditor = null;
    return true;
  }

  async function flushApiConnectionSecrets(draft, agentId) {
    var pending = (draft && draft.pendingApiSecrets) || {};
    var removed = (draft && draft.removedApiConnections) || [];
    var operations = [];
    var succeededPending = {};
    var skippedRemoved = {};
    function pendingHasValue(id) {
      return !!pending[id] && (pending[id].credential !== undefined || pending[id].oauthClient !== undefined);
    }
    removed.forEach(function (entry, index) {
      if (pendingHasValue(entry.id)) { skippedRemoved[index] = true; return; }
      operations.push({
        id: entry.id,
        op: "delete",
        kind: "removed",
        index: index,
        request: postJson("/admin/api/agents/" + encodeURIComponent(agentId) + "/api-connections/secrets/" + encodeURIComponent(entry.id), "DELETE", {})
      });
    });
    Object.keys(pending).forEach(function (id) {
      var entry = pending[id];
      if (entry.oauthClient !== undefined) {
        operations.push({
          id: id,
          op: "put",
          kind: "pending",
          request: postJson("/admin/api/agents/" + encodeURIComponent(agentId) + "/api-connections/oauth/" + encodeURIComponent(id) + "/client", "PUT", entry.oauthClient)
        });
      } else if (entry.credential !== undefined) {
        operations.push({
          id: id,
          op: "put",
          kind: "pending",
          request: postJson("/admin/api/agents/" + encodeURIComponent(agentId) + "/api-connections/secrets/" + encodeURIComponent(id), "PUT", { credential: entry.credential })
        });
      } else {
        succeededPending[id] = true;
      }
    });
    var result = await settleSecretOperations(operations, pending, removed, succeededPending, skippedRemoved);
    if (draft) { draft.pendingApiSecrets = pending; draft.removedApiConnections = result.removed; }
    return { failed: result.failed };
  }

  function openSkillImport() {
    collectProfileDraft();
    state.skillEditor = null;
    var imp = {
      source: "",
      loading: false,
      error: "",
      resolution: null,
      selected: [],
      browse: null
    };
    state.skillImport = imp;
    render();
    // GitHub status is optional and lazy. Its failure only changes the helper
    // copy; the public paste field and resolver stay fully usable.
    if (!state.githubStatusLoaded) {
      loadGithubStatus().then(function () {
        if (state.skillImport === imp) render();
      });
    }
  }

  function closeSkillImport() {
    resetSkillImportBrowseTransientState();
    state.skillImport = null;
    render();
  }

  function focusSkillImportSource() {
    if (state.profileTab !== "skills") return;
    focusInputAtEnd("import-source");
  }

  function focusSkillImportBrowseSearch() {
    if (state.profileTab !== "skills") return;
    focusInputAtEnd("skill-import-browse-search");
  }

  function openSkillImportRepositoryBrowser(installationId, accountLogin) {
    var imp = state.skillImport;
    if (!imp || !Number.isInteger(installationId) || installationId < 1) return;
    resetSkillImportBrowseTransientState();
    imp.browse = {
      chooseAccount: false,
      installationId: installationId,
      accountLogin: accountLogin,
      query: "",
      repos: [],
      totalCount: 0,
      truncated: false,
      loading: true,
      error: "",
      requestId: 0
    };
    skillImportRepoSearch.load();
  }

  function openSkillImportBrowse() {
    var imp = state.skillImport;
    var status = state.githubStatus;
    if (!imp || !state.githubStatusLoaded || !status || status.mode !== "app") return;
    var installations = status.installations || [];
    if (installations.length === 1) {
      openSkillImportRepositoryBrowser(Number(installations[0].id), installations[0].accountLogin);
      return;
    }
    resetSkillImportBrowseTransientState();
    imp.browse = { chooseAccount: true, requestId: 0 };
    render();
  }

  function closeSkillImportBrowse() {
    var imp = state.skillImport;
    if (!imp || !imp.browse) return;
    resetSkillImportBrowseTransientState();
    render();
    focusSkillImportSource();
  }

  function selectSkillImportRepository(fullName) {
    var imp = state.skillImport;
    if (!imp || !imp.browse || !fullName) return;
    resetSkillImportBrowseTransientState();
    imp.source = fullName;
    imp.error = "";
    imp.resolution = null;
    imp.selected = [];
    render();
    focusSkillImportSource();
  }

  // POST the raw pasted source to the resolve endpoint and, on success, open the
  // picker with every skill pre-selected. On error, surface the server message
  // (error.serverMessage) or a friendly fallback keyed by the code (error.message,
  // which the api() helper set from body.error). The panel stays open either way.
  function findSkillsFromSource() {
    var imp = state.skillImport;
    if (!imp || imp.loading) return;
    var source = String(imp.source || "").trim();
    if (!source) { imp.error = "Paste a repo, a GitHub URL, or a skills.sh link."; render(); return; }
    resetSkillImportBrowseTransientState();
    imp.loading = true;
    imp.error = "";
    render();
    postJson("/admin/api/skills/resolve", "POST", { source: source }).then(function (body) {
      // The panel may have been closed and reopened for another source while
      // this request was in flight. Never let the old session repaint the new.
      if (state.skillImport !== imp) return;
      var resolution = body && body.resolution ? body.resolution : { owner: "", repo: "", skills: [], capped: false, skipped: 0 };
      imp.loading = false;
      imp.error = "";
      imp.resolution = resolution;
      imp.selected = (resolution.skills || []).map(function () { return true; });
      render();
    }).catch(function (error) {
      if (state.skillImport !== imp) return;
      imp.loading = false;
      imp.error = (error && error.serverMessage) || skillImportFallback(error && error.message);
      render();
    });
  }

  // Merge the checked skills into the draft as { name, description, instructions,
  // enabled: true }. DEDUPE by name: an imported skill replaces a same-named
  // existing one in place (duplicate names are a hard turn-killer). Then close
  // the panel, mark dirty, and re-render so they show as normal rows.
  function addSelectedSkills() {
    var imp = state.skillImport;
    if (!imp || !imp.resolution || !state.profileDraft) return;
    var picked = imp.resolution.skills || [];
    var selected = imp.selected || [];
    var skills = state.profileDraft.skills || [];
    picked.forEach(function (skill, index) {
      if (!selected[index]) return;
      var entry = { name: skill.name, description: skill.description, instructions: skill.instructions, enabled: true };
      var existingIndex = -1;
      for (var i = 0; i < skills.length; i += 1) {
        if (skills[i].name === entry.name) { existingIndex = i; break; }
      }
      if (existingIndex >= 0) { skills[existingIndex] = entry; }
      else { skills.push(entry); }
    });
    state.profileDraft.skills = skills;
    state.skillImport = null;
    markProfileDirty();
    render();
  }

  // The four ways to leave the profile editor: the top-nav Profiles/Settings,
  // the brand-home logo, and the "<- Profiles" back link.
  function isEditLeaveAction(action) {
    return action === "open-channels" || action === "open-profiles" || action === "open-team" || action === "open-settings" ||
      action === "open-audit" || action === "open-usage" || action === "go-home" || action === "profiles-back" ||
      action === "edit-profile" || action === "new-profile" || action === "duplicate-profile" || action === "open-channel-from-profile";
  }

  function isChannelLeaveAction(action) {
    return action === "open-channels" || action === "open-profiles" || action === "open-team" || action === "open-settings" ||
      action === "open-audit" || action === "open-usage" || action === "go-home" || action === "channel-back" ||
      action === "edit-profile" || action === "new-profile" || action === "open-channel-index" || action === "select-channel";
  }

  function channelLeaveTargetIsCurrent(action, target) {
    if ((action !== "select-channel" && action !== "open-channel-index") || !state.active) return false;
    return target.getAttribute("data-workspace") === state.active.workspaceId &&
      target.getAttribute("data-channel") === state.active.channelId;
  }

  // Perform a confirmed leave — the edit draft is dropped and the pending
  // navigation is carried out. Used by both "Discard & leave" and the
  // after-save continuation.
  function performProfileLeave(pending) {
    state.leavePrompt = null;
    state.profileDirty = false;
    state.skillEditor = null;
    resetSkillImportBrowseTransientState();
    state.skillImport = null;
    clearCustomConnectionMode();
    state.connectorGallerySearch = "";
    state.connectionRemove = null;
    state.apiConnectionRemove = null;
    resetRepositoryTransientState();
    state.profileError = "";
    state.profileDraft = null;
    state.editingAgentId = null;
    state.disableConfirm = false;
    var action = pending ? pending.action : "profiles-back";
    if (action === "route") {
      // Browser back/forward while the editor was dirty: the pending path was
      // parked while the guard asked; carry it out now.
      applyRoute(pending.path);
    } else if (action === "open-settings") {
      openSettings((pending && pending.section) || "");
    } else if (action === "open-audit") {
      openAuditLogs("", "", "");
    } else if (action === "open-usage") {
      openUsage();
    } else if (action === "open-team") {
      openTeam();
    } else if (action === "go-home") {
      openHome();
    } else if (action === "open-channels") {
      openChannels();
    } else if (action === "edit-profile") {
      var selected = agentById((pending && pending.agent) || "");
      if (selected) openProfileEditor(selected);
      else enterProfiles(state.profileLastAgentId || ((state.agents[0] && state.agents[0].id) || ""));
    } else if (action === "new-profile") {
      openNewProfile();
    } else if (action === "duplicate-profile") {
      var duplicateSource = agentById((pending && pending.agent) || "");
      if (duplicateSource) openDuplicateProfile(duplicateSource);
    } else if (action === "open-profiles") {
      enterProfiles((pending && pending.agent) || null);
    } else {
      state.view = "profiles";
      state.profileScreen = "list";
      render();
    }
  }

  function performChannelLeave(pending) {
    state.leavePrompt = null;
    state.dirty = false;
    state.saveError = "";
    var action = pending ? pending.action : "open-channels";
    if (action === "route") {
      applyRoute(pending.path);
    } else if (action === "edit-profile") {
      var selected = agentById((pending && pending.agent) || "");
      if (selected) openProfileEditor(selected);
      else openHome();
    } else if (action === "new-profile") {
      openNewProfile();
    } else if (action === "open-profiles") {
      enterProfiles((pending && pending.agent) || state.profileLastAgentId || ((defaultAgent() && defaultAgent().id) || ""));
    } else if (action === "open-settings") {
      openSettings((pending && pending.section) || "");
    } else if (action === "open-audit") {
      openAuditLogs("", "", "");
    } else if (action === "open-usage") {
      openUsage();
    } else if (action === "open-team") {
      openTeam();
    } else if (action === "go-home") {
      openHome();
    } else if (action === "channel-back") {
      var backAgent = agentById((pending && pending.agent) || "");
      if (backAgent) openProfileEditor(backAgent);
      else openChannels();
    } else if (action === "select-channel" || action === "open-channel-index") {
      state.view = "channels";
      state.channelScreen = "detail";
      selectActive((pending && pending.workspace) || connectedTeamId(), (pending && pending.channel) || "");
      render();
    } else {
      openChannels();
    }
  }

  function saveProfile(onSaved, onFailed) {
    var draft = collectProfileDraft();
    // Clear any stale field error BEFORE the commit gates below render — a
    // fixed-but-uncleared error would otherwise resurface on a hidden panel.
    state.profileError = "";
    state.profileConflict = false;
    // Commit an open inline skill editor into the draft first — a filled-but-
    // not-"Added" skill must be saved, not silently dropped. Abort on invalid,
    // jumping to the tab that carries the inline error so it is visible.
    if (!commitOpenSkillEditor()) { showProfileTab("skills"); if (onFailed) onFailed(); return; }
    // Same for an open Connections editor — commit it into mcpServers (and stage
    // its typed secrets) before the PATCH, or bail on an inline validation error.
    if (!commitOpenConnectionEditor()) { showProfileTab("connections"); if (onFailed) onFailed(); return; }
    if (!commitOpenApiConnectionEditor()) { showProfileTab("connections"); if (onFailed) onFailed(); return; }
    if (!draft.name) { state.profileError = "Name is required."; render(); if (onFailed) onFailed(); return; }
    if (!draft.instructions) { state.profileError = "Agent instructions are required."; state.profileTab = "instructions"; render(); if (onFailed) onFailed(); return; }
    // An open repository picker holds checkbox changes the user has made but
    // not yet Applied; saving must not silently serialize the stale grant
    // list. Committing equals clicking Apply — which is what the checked
    // boxes said the user wants.
    if (state.repositoryPicker) applyRepositoryPicker();
    var body = {
      name: draft.name,
      description: draft.description || "",
      handle: draft.handle || handleFromAgentName(draft.name),
      editPolicy: draft.editPolicy || "creator_and_admins",
      instructions: draft.instructions,
      enabled: draft.enabled,
      skills: draft.skills || [],
      // POLICY ONLY. connectionFromEditor / cloneConnection strip secrets by
      // construction — no token or header VALUE is ever in this array.
      mcpServers: draft.mcpServers || [],
      apiConnections: draft.apiConnections || [],
      repositories: draft.repositories || []
    };
    var isEdit = !!draft.id;
    // Capture the draft carrying the transient secrets + removals BEFORE the
    // post-save re-clone wipes them, so the secret PUT/DELETE still run.
    var secretsDraft = draft;
    if (isEdit) {
      body.model = draft.model || null;
      body.expectedRevision = Number.isInteger(draft.revision) ? draft.revision : 1;
    }
    else {
      if (draft.model) body.model = draft.model;
      body.id = slugId(draft.name);
    }
    var secretAgentId = isEdit ? draft.id : body.id;
    (isEdit
      ? postJson("/admin/api/agents/" + encodeURIComponent(draft.id), "PATCH", body)
      : postJson("/admin/api/agents", "POST", body)
    ).then(async function () {
      state.profileError = "";
      state.profileDirty = false;
      state.disableConfirm = false;
      if (!isEdit) {
        draft.id = secretAgentId;
        state.profileScreen = "edit";
        state.editingAgentId = secretAgentId;
      }
      // The profile policy is already saved. Persist both kinds of credentials
      // concurrently, retaining only failed operations for an explicit retry.
      var secretResults = await Promise.all([
        flushConnectionSecrets(secretsDraft, secretAgentId),
        flushApiConnectionSecrets(secretsDraft, secretAgentId)
      ]);
      var secretFailures = secretResults[0].failed.concat(secretResults[1].failed);
      var secretsFailed = secretFailures.length > 0;
      if (isEdit || secretsFailed) {
        // A failed create becomes an edit of the policy that did persist. Keep
        // that screen open so its pending write-only value remains retryable.
        if (!isEdit) {
          state.profileScreen = "edit";
          state.editingAgentId = secretAgentId;
        }
        // Stay on the editor; re-clone the draft from the refreshed agent so the
        // form reflects exactly what persisted (and the save bar re-disables).
        // If a leave was requested (Save changes in the guard modal), carry it
        // out now that the save succeeded, instead of staying on the editor.
        return refreshData().then(function () {
          var saved = agentById(state.editingAgentId);
          if (saved) state.profileDraft = cloneAgent(saved);
          if (secretsFailed && state.profileDraft) {
            // refreshData re-clones policy from the server; restore only the
            // operations the flushes deliberately retained for retry.
            state.profileDraft.pendingSecrets = secretsDraft.pendingSecrets || {};
            state.profileDraft.removedConnections = secretsDraft.removedConnections || [];
            state.profileDraft.pendingApiSecrets = secretsDraft.pendingApiSecrets || {};
            state.profileDraft.removedApiConnections = secretsDraft.removedApiConnections || [];
            var putFailed = secretFailures.some(function (failure) { return failure.op === "put"; });
            state.profileError = putFailed
              ? "Agent saved, but a credential could not be stored — open the connector and Save again."
              : "Agent saved, but a credential could not be removed — Save again to retry.";
            state.profileDirty = true;
            render();
            if (onFailed) onFailed();
            return;
          }
          if (onSaved) { onSaved(); } else { render(); }
        });
      }
      // Create → return to the overview so the new profile shows in the list.
      if (onSaved) {
        state.profileScreen = "edit";
        state.editingAgentId = secretAgentId;
        return refreshData().then(function () {
          var created = agentById(secretAgentId);
          if (created) state.profileDraft = cloneAgent(created);
          onSaved();
        });
      }
      state.profileScreen = "list";
      state.profileDraft = null;
      state.editingAgentId = null;
      return refreshData();
    }).catch(function (error) {
      if (error && error.payload && error.payload.error === "agent_revision_conflict") {
        state.profileConflict = true;
        state.profileError = "This Agent changed in another session. Your draft is preserved; reload the latest Agent before saving again.";
        render();
        if (onFailed) onFailed();
        return;
      }
      state.profileError = (error && (error.serverMessage || error.message)) || "Could not save this Agent.";
      render();
      if (onFailed) onFailed();
    });
  }

  function discardProfile() {
    var saved = agentById(state.editingAgentId);
    state.profileDraft = saved ? cloneAgent(saved) : newProfileDraft();
    state.profileError = "";
    state.profileConflict = false;
    state.profileDirty = false;
    state.disableConfirm = false;
    state.profileRenaming = null;
    state.profileDescriptionEditing = null;
    state.skillEditor = null;
    state.skillImport = null;
    clearCustomConnectionMode();
    state.connectorGallerySearch = "";
    state.connectionRemove = null;
    state.apiConnectionRemove = null;
    resetRepositoryTransientState();
    render();
  }

  function reloadProfile() {
    var draft = state.profileDraft;
    if (!draft || !draft.id) return;
    state.profileError = "";
    return api("/admin/api/agents/" + encodeURIComponent(draft.id)).then(function (body) {
      var latest = body && body.agent;
      if (!latest) throw new Error("Agent response was missing.");
      var index = state.agents.findIndex(function (agent) { return agent.id === latest.id; });
      if (index >= 0) state.agents[index] = latest;
      else state.agents.push(latest);
      openProfileEditor(latest);
    }).catch(function (error) {
      state.profileError = error.serverMessage || error.message || "Could not reload this Agent.";
      state.profileConflict = true;
      render();
    });
  }

  function base64FromArrayBuffer(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = "";
    for (var offset = 0; offset < bytes.length; offset += 32768) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 32768));
    }
    return btoa(binary);
  }

  // Presence mutations have their own revision-fenced endpoints. If one
  // settles while this Agent has unsaved form edits, merge only the server-
  // owned fields and revision instead of replacing the draft and losing work.
  function applyAgentMutation(updated, serverOwnedFields) {
    if (!updated || !updated.id) return;
    var saved = cloneAgent(updated);
    var index = state.agents.findIndex(function (agent) { return agent.id === saved.id; });
    if (index >= 0) state.agents[index] = saved;
    if (!state.profileDraft || state.profileDraft.id !== saved.id) return;
    if (!state.profileDirty) {
      state.profileDraft = cloneAgent(saved);
      return;
    }
    state.profileDraft.revision = saved.revision;
    (serverOwnedFields || []).forEach(function (field) {
      if (saved[field] === undefined) delete state.profileDraft[field];
      else state.profileDraft[field] = saved[field];
    });
  }

  function beginProfilePresenceMutation(kind, agentId) {
    if (state.profilePresenceMutation) return null;
    var token = { kind: kind, agentId: agentId };
    state.profilePresenceMutation = token;
    render();
    return token;
  }

  function profilePresenceMutationIsCurrent(token) {
    return state.profilePresenceMutation === token &&
      !!state.profileDraft && state.profileDraft.id === token.agentId;
  }

  function finishProfilePresenceMutation(token) {
    if (state.profilePresenceMutation !== token) return;
    state.profilePresenceMutation = null;
    render();
  }

  function uploadProfileAvatar(file) {
    var draft = state.profileDraft;
    if (!draft || !draft.id || !file || state.profilePresenceMutation) return;
    state.profileError = "";
    if (file.size > 512 * 1024) {
      state.profileError = "Avatar images must be 512 KB or smaller.";
      render();
      return;
    }
    var mutation = beginProfilePresenceMutation("avatar", draft.id);
    if (!mutation) return;
    Promise.resolve(file.arrayBuffer()).then(function (buffer) {
      return postJson("/admin/api/agents/" + encodeURIComponent(draft.id) + "/avatar", "PUT", {
        contentType: file.type,
        base64: base64FromArrayBuffer(buffer)
      });
    }).then(function (body) {
      if (!profilePresenceMutationIsCurrent(mutation)) return;
      var updated = body && body.agent;
      if (!updated) throw new Error("Agent response was missing.");
      applyAgentMutation(updated, ["slackPresence", "slackPresenceRecovery"]);
      render();
    }).catch(function (error) {
      if (!profilePresenceMutationIsCurrent(mutation)) return;
      state.profileError = (error && (error.serverMessage || error.message)) || "Could not upload the avatar.";
    }).finally(function () { finishProfilePresenceMutation(mutation); });
  }

  function retryAgentPresence() {
    var draft = state.profileDraft;
    if (!draft || !draft.id || state.profilePresenceMutation) return;
    state.profileError = "";
    var mutation = beginProfilePresenceMutation("retry", draft.id);
    if (!mutation) return;
    postJson("/admin/api/agents/" + encodeURIComponent(draft.id) + "/slack/retry", "POST", {
      workspaceId: connectedTeamId() || undefined
    }).then(function (body) {
      if (!profilePresenceMutationIsCurrent(mutation)) return;
      var updated = body && body.agent;
      if (!updated) throw new Error("Agent response was missing.");
      applyAgentMutation(updated, ["slackPresence", "slackPresenceRecovery"]);
      render();
    }).catch(function (error) {
      if (!profilePresenceMutationIsCurrent(mutation)) return;
      var payload = error && error.payload;
      if (payload && payload.agent) {
        applyAgentMutation(payload.agent, ["slackPresence", "slackPresenceRecovery"]);
      }
      state.profileError = (error && (error.serverMessage || error.message)) || "Slack could not finish this Agent handle.";
    }).finally(function () { finishProfilePresenceMutation(mutation); });
  }

  function deleteProfileErrorText(error) {
    if (error && error.payload && error.payload.error === "agent_still_referenced") {
      return "This Agent still has a Channel grant or is the workspace Default Agent. Remove every reference before deleting it.";
    }
    if (error && error.payload && error.payload.error === "agent_live_snapshot_roots") {
      return "This Agent still has live Slack threads. Wait for those conversations to expire before deleting it.";
    }
    return (error && error.message) || "Could not delete the Agent.";
  }

  function deleteProfile() {
    var draft = state.profileDraft;
    if (!draft || !draft.id) return;
    api("/admin/api/agents/" + encodeURIComponent(draft.id), { method: "DELETE" }).then(function () {
      state.profileScreen = "list";
      state.profileDraft = null;
      state.editingAgentId = null;
      state.profileError = "";
      return refreshData();
    }).catch(function (error) { state.profileError = deleteProfileErrorText(error); render(); });
  }

  function postProfileLifecycleMutation(draft, action, body, mutation, attempt) {
    var path = "/admin/api/agents/" + encodeURIComponent(draft.id) + "/" + action;
    return postJson(path, "POST", body).catch(function (error) {
      var conflict = error && error.payload && error.payload.error === "agent_revision_conflict";
      if (!conflict || attempt > 0 || !profilePresenceMutationIsCurrent(mutation)) throw error;
      // Presence reconciliation can advance the Agent revision while this page
      // is open. Refresh only the authoritative projection and retry once so a
      // lifecycle action never fails merely because Chickpea updated its own
      // Slack health in the background. Unsaved form fields remain untouched.
      return api("/admin/api/agents/" + encodeURIComponent(draft.id), { cache: "no-store" }).then(function (latestBody) {
        if (!profilePresenceMutationIsCurrent(mutation)) throw error;
        var latest = latestBody && latestBody.agent;
        if (!latest) throw new Error("Agent response was missing.");
        applyAgentMutation(latest, [
          "lifecycle", "enabled", "slackPresence", "slackPresenceRecovery",
          "isWorkspaceDefault", "defaultForWorkspaces", "whereItWorks"
        ]);
        return postProfileLifecycleMutation(
          draft,
          action,
          Object.assign({}, body, { expectedRevision: latest.revision }),
          mutation,
          attempt + 1
        );
      });
    });
  }

  function archiveProfile() {
    var draft = state.profileDraft;
    if (!draft || !draft.id || state.profilePresenceMutation) return;
    state.profileOverflowOpen = false;
    state.profileError = "";
    var mutation = beginProfilePresenceMutation("archive", draft.id);
    if (!mutation) return;
    postProfileLifecycleMutation(draft, "archive", {
      expectedRevision: draft.revision,
      replacementDefaultAgentId: draft.isWorkspaceDefault
        ? (state.profileReplacementDefaultAgentId || undefined)
        : undefined
    }, mutation, 0).then(function (body) {
      if (!profilePresenceMutationIsCurrent(mutation)) return;
      var updated = body && body.agent;
      if (!updated) throw new Error("Agent response was missing.");
      applyAgentMutation(updated, [
        "lifecycle", "enabled", "slackPresence", "slackPresenceRecovery",
        "isWorkspaceDefault", "defaultForWorkspaces", "whereItWorks"
      ]);
      if (draft.isWorkspaceDefault && state.profileReplacementDefaultAgentId) {
        state.agents.forEach(function (agent) {
          agent.isWorkspaceDefault = agent.id === state.profileReplacementDefaultAgentId;
        });
      }
      state.profileReplacementDefaultAgentId = "";
    }).catch(function (error) {
      if (!profilePresenceMutationIsCurrent(mutation)) return;
      var payload = error && error.payload;
      if (payload && payload.agent) {
        applyAgentMutation(payload.agent, [
          "lifecycle", "enabled", "slackPresence", "slackPresenceRecovery",
          "isWorkspaceDefault", "defaultForWorkspaces", "whereItWorks"
        ]);
      }
      state.profileError = error && error.message === "replacement_default_agent_required"
        ? "Choose another default Agent before archiving this one."
        : ((error && (error.serverMessage || error.message)) || "Could not archive the Agent.");
    }).finally(function () { finishProfilePresenceMutation(mutation); });
  }

  function restoreProfile() {
    var draft = state.profileDraft;
    if (!draft || !draft.id || state.profilePresenceMutation) return;
    state.profileOverflowOpen = false;
    state.profileError = "";
    var mutation = beginProfilePresenceMutation("restore", draft.id);
    if (!mutation) return;
    postProfileLifecycleMutation(draft, "restore", {
      expectedRevision: draft.revision,
      workspaceId: connectedTeamId() || undefined
    }, mutation, 0).then(function (body) {
      if (!profilePresenceMutationIsCurrent(mutation)) return;
      var updated = body && body.agent;
      if (!updated) throw new Error("Agent response was missing.");
      applyAgentMutation(updated, [
        "lifecycle", "enabled", "slackPresence", "slackPresenceRecovery",
        "isWorkspaceDefault", "defaultForWorkspaces", "whereItWorks"
      ]);
    }).catch(function (error) {
      if (!profilePresenceMutationIsCurrent(mutation)) return;
      var payload = error && error.payload;
      if (payload && payload.agent) {
        applyAgentMutation(payload.agent, [
          "lifecycle", "enabled", "slackPresence", "slackPresenceRecovery",
          "isWorkspaceDefault", "defaultForWorkspaces", "whereItWorks"
        ]);
      }
      state.profileError = (error && (error.serverMessage || error.message)) || "Could not restore the Agent.";
    }).finally(function () { finishProfilePresenceMutation(mutation); });
  }

  // Publish this Agent into a Channel. The server verifies that the acting
  // member belongs to the Channel, joins public Channels for Chickpea, and
  // reconciles the Agent's Slack user-group handle before activating the grant.
  function attachProfileToChannel() {
    var draft = state.profileDraft;
    if (!draft || !draft.id) return;
    var select = document.querySelector('[data-role="attach-channel"]');
    if (!select) return;
    var candidates = attachCandidates(draft.id);
    var chosenId = state.attachChannelSelected;
    if (!candidates.some(function (candidate) { return candidate.channelId === chosenId; })) chosenId = select.value;
    var chosen = candidates.find(function (candidate) { return candidate.channelId === chosenId; });
    var channel = chosen && findSlackChannel(chosen.channelId);
    var workspaceId = connectedTeamId();
    if (!channel || !workspaceId) return;
    postJson("/admin/api/agents/" + encodeURIComponent(draft.id) + "/channels", "POST", {
      workspaceId: workspaceId,
      channelId: channel.id
    }).then(function () {
      state.attachPicker = false;
      state.attachChannelSelected = "";
      state.attachError = "";
      state.attachNotice = "Agent added to #" + normalizeChannelLabel(channel.name || channel.id) + ".";
      return refreshData(renderPreservingPagePosition);
    }).catch(function (error) {
      var payload = error && error.payload;
      if (payload && payload.agent) {
        var index = state.agents.findIndex(function (agent) { return agent.id === payload.agent.id; });
        if (index >= 0) state.agents[index] = payload.agent;
        state.profileDraft = cloneAgent(payload.agent);
      }
      state.attachError = (error && (error.serverMessage || error.message)) || "Could not add this Agent to the Channel.";
      renderPreservingPagePosition();
    });
  }

  function detachProfileFromChannel(workspaceId, channelId, label) {
    var draft = state.profileDraft;
    if (!draft || !draft.id || !workspaceId || !channelId) return;
    state.profileError = "";
    api("/admin/api/agents/" + encodeURIComponent(draft.id) + "/channels/" +
      encodeURIComponent(workspaceId) + "/" + encodeURIComponent(channelId), {
      method: "DELETE"
    }).then(function () {
      state.attachNotice = "Agent removed from #" + normalizeChannelLabel(label) + ".";
      return refreshData(renderPreservingPagePosition);
    }).catch(function (error) {
      state.profileError = (error && (error.serverMessage || error.message)) || "Could not remove this Agent from the Channel.";
      render();
    });
  }

  // Boot: capture the deep link BEFORE the first data render (which would
  // otherwise sync the URL to the default state), apply it once data is
  // loaded, then turn URL sync on with a replace so landing on /admin becomes
  // the canonical Default Agent without adding a history entry.
  function oauthReturnFromSearch(search) {
    if (!search) return null;
    var params = new URLSearchParams(search);
    var status = params.get("oauth");
    var connectionId = params.get("connection");
    var lane = params.get("lane") === "api" ? "api" : "mcp";
    if (["connected", "cancelled", "failed", "verification_failed"].indexOf(status) < 0) return null;
    if (!connectionId || !/^[a-z0-9][a-z0-9_-]{0,191}$/.test(connectionId)) return null;
    return { status: status, connectionId: connectionId, lane: lane };
  }

  function connectorSetupFromPath(pathname) {
    var parts = String(pathname || "").split("/").filter(Boolean).map(function (part) {
      try { return decodeURIComponent(part); } catch (_) { return ""; }
    });
    if (parts.length !== 7 || parts[0] !== "admin" || parts[1] !== "agents" ||
        parts[3] !== "connections" || parts[4] !== "new") return null;
    var connector = parts[5] || "";
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(connector)) return null;
    if (parts[6] !== "team" && parts[6] !== "member") return null;
    return {
      connector: connector,
      ownerKind: parts[6]
    };
  }

  var initialRoute = canNavigate ? location.pathname : "/admin";
  if (initialRoute === "/admin/onboarding") {
    state.view = "onboarding";
    // Paint the dedicated setup shell before any API request settles. The
    // server HTML contains the normal Admin skeleton, so waiting for
    // refreshData() would briefly expose post-setup navigation after the owner
    // form redirects here.
    render();
  }
  if (USAGE_ADMIN_UI && initialRoute === "/admin/usage") applyUsageQuery(location.search || "");
  state.oauthReturn = canNavigate ? oauthReturnFromSearch(location.search || "") : null;
  var connectorSetup = canNavigate ? connectorSetupFromPath(location.pathname) : null;
  var connectorSetupConsumed = false;
  refreshData().then(async function () {
    // Managed-only presets and the native-vs-managed Google decision both
    // depend on the Agent connections response. Do not consume the one-shot
    // connector handoff until that catalog and availability flag are known.
    await applyRoute(initialRoute);
    if (connectorSetup && state.profileDraft && state.profileScreen === "edit") {
      state.profileTab = "connections";
      newConnectionAccountFormFromPreset(connectorSetup.connector);
      if (state.connectionAccountForm) {
        state.connectionAccountForm.ownerKind = connectorSetup.ownerKind;
        connectorSetupConsumed = true;
        render();
        history.replaceState(null, "", canonicalPath());
      }
    }
    if (state.oauthReturn && state.profileDraft && state.profileScreen === "edit") {
      state.oauthReturn.agentId = state.profileDraft.id;
      state.profileTab = "connections";
      if (state.oauthReturn.lane === "api") {
        var returnedApiIndex = (state.profileDraft.apiConnections || []).findIndex(function (connection) {
          return connection.id === state.oauthReturn.connectionId;
        });
        if (returnedApiIndex >= 0) {
          state.apiConnectionEditor = editorFromApiConnection(
            returnedApiIndex,
            state.profileDraft.apiConnections[returnedApiIndex]
          );
        }
      } else {
        var returnedIndex = (state.profileDraft.mcpServers || []).findIndex(function (connection) {
          return connection.id === state.oauthReturn.connectionId;
        });
        if (returnedIndex >= 0) {
          state.connectionEditor = editorFromConnection(
            returnedIndex,
            state.profileDraft.mcpServers[returnedIndex]
          );
        }
      }
      render();
      // The callback URL carries status and connection identity only, but it is
      // one-shot UI state. Remove it so a refresh cannot replay a stale banner.
      history.replaceState(null, "", location.pathname);
    }
    routeReady = true;
    // A transient initial load failure must not erase a one-shot Slack
    // connector handoff. Keep the original path so reloading can retry it.
    if (!connectorSetup || connectorSetupConsumed) syncUrl(true);
  });
})();
</script>
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
  intro: string;
  status: string;
  statusId?: string;
  body: string;
  alert?: string | undefined;
  rootAttributes?: string;
}): string {
  const alert = input.alert
    ? `<div class="auth-alert" id="auth-error" role="alert" tabindex="-1">${escapeHtmlAttribute(input.alert)}</div>`
    : '';
  return `<!doctype html><html lang="en" data-slack-auth-surface="${escapeHtmlAttribute(input.surface)}"${input.rootAttributes ? ` ${input.rootAttributes}` : ''}><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>Chickpea · ${escapeHtmlAttribute(input.title)}</title>${ADMIN_FAVICON}
<style>
:root{--canvas:#f4ebd8;--card:#fffdf6;--well:#f8f1df;--ink:#3b3220;--muted:#6b5c42;--gold:#dda033;--gold-press:#b27e1f;--line:rgba(59,50,32,.16);--danger:#a83f34;--focus:#b05415}*{box-sizing:border-box}html{color-scheme:light}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--canvas);color:var(--ink);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:clamp(12px,4vw,32px);overflow-wrap:anywhere}.auth-card{width:min(600px,100%);background:var(--card);border:1px solid var(--line);border-radius:22px;padding:clamp(22px,6vw,46px);box-shadow:0 14px 38px rgba(59,50,32,.1)}.auth-brand{display:flex;align-items:center;gap:10px;margin-bottom:30px}.auth-brand-mark{width:42px;height:42px;display:block}.auth-brand-name{font-weight:850;font-size:1.15rem}.auth-eyebrow{margin:0;color:var(--muted);font-size:.76rem;font-weight:850;letter-spacing:.09em;text-transform:uppercase}.auth-title{margin:8px 0 10px;font-size:clamp(1.75rem,7vw,2.7rem);line-height:1.05;letter-spacing:-.035em}.auth-intro,.auth-status,.auth-help{color:var(--muted);line-height:1.55}.auth-status{min-height:1.5em;margin:14px 0}.auth-alert{margin:18px 0;border-left:4px solid var(--danger);border-radius:8px;background:#fff3ee;color:var(--danger);padding:12px 14px;font-weight:750;line-height:1.45}.auth-section{margin-top:24px;padding:20px;border:1px solid var(--line);border-radius:15px;background:var(--well)}.auth-section h2{margin:0 0 8px;font-size:1.08rem}.auth-progress{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin:24px 0 6px;padding:0;list-style:none}.auth-progress li{border-top:4px solid var(--line);padding-top:7px;color:var(--muted);font-size:.73rem;font-weight:750}.auth-progress li[data-current="true"]{border-color:var(--gold-press);color:var(--ink)}label{display:block;margin:17px 0 6px;font-weight:750}label span{display:block;margin-top:2px;color:var(--muted);font-size:.78rem;font-weight:500}input,textarea{width:100%;min-height:46px;border:1px solid var(--line);border-radius:11px;background:#fff;color:var(--ink);padding:11px 12px;font:inherit}textarea{min-height:220px;resize:vertical}details{margin-top:20px;border-top:1px solid var(--line);padding-top:17px}summary{cursor:pointer;font-weight:800}.auth-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}.auth-button,.auth-link{display:inline-flex;align-items:center;justify-content:center;min-height:48px;border:0;border-radius:12px;padding:11px 17px;background:var(--gold);box-shadow:0 3px 0 var(--gold-press);color:var(--ink);font:inherit;font-weight:850;text-decoration:none;cursor:pointer}.auth-button{width:100%}.auth-button.secondary,.auth-link.secondary{background:transparent;border:1px solid var(--line);box-shadow:none}.auth-button:active,.auth-link:active{transform:translateY(2px);box-shadow:none}.auth-button:focus-visible,.auth-link:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible,.auth-alert:focus-visible{outline:3px solid color-mix(in srgb,var(--focus) 48%,transparent);outline-offset:3px}.auth-warning{margin-top:22px;border:1px solid rgba(168,63,52,.25);border-radius:13px;background:#fff3ee;padding:15px}.auth-warning strong{display:block;margin-bottom:5px}.auth-meta{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.83rem}.auth-manifest{max-height:280px;overflow:auto;white-space:pre-wrap;font-size:.75rem}.slack-logo-image{background:url("${SLACK_LOGO_DATA_URL}") center/contain no-repeat;display:inline-block}.setup-token-callout{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;margin:22px 0;padding:15px 17px;border-left:3px solid var(--gold-press);border-radius:12px;background:var(--well)}.setup-token-callout strong{display:block;margin-bottom:3px}.setup-token-callout p{margin:0;color:var(--muted);font-size:.86rem;line-height:1.45}.setup-slack-link{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:9px 13px;border:1px solid var(--line);border-radius:11px;background:var(--card);color:var(--ink);font-weight:800;text-decoration:none;white-space:nowrap}.setup-slack-logo{width:22px;height:22px}.setup-token-note{display:flex;gap:8px;align-items:flex-start;margin:13px 0 0;color:var(--muted);font-size:.8rem;line-height:1.45}.setup-manual-choice p{margin-bottom:14px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:440px){body{padding:8px}.auth-card{border-radius:14px;padding:21px 16px}.auth-progress{gap:4px}.auth-progress li{font-size:.66rem}.auth-actions{display:grid}.auth-link,.auth-button{width:100%}.auth-section{padding:16px 13px}.setup-token-callout{grid-template-columns:1fr}.setup-slack-link{width:100%;justify-content:center}}
</style></head><body><main class="auth-card" aria-labelledby="auth-title">${AUTH_BRAND_HTML}<p class="auth-eyebrow">${escapeHtmlAttribute(input.eyebrow)}</p><h1 class="auth-title" id="auth-title">${escapeHtmlAttribute(input.title)}</h1><p class="auth-intro">${escapeHtmlAttribute(input.intro)}</p>${alert}<p class="auth-status"${input.statusId ? ` id="${escapeHtmlAttribute(input.statusId)}"` : ''} role="status" aria-live="polite">${escapeHtmlAttribute(input.status)}</p>${input.body}</main></body></html>`;
}

/** Complete a same-origin POST before navigating across the strict form-action CSP boundary. */
export function renderSlackAuthorizationHandoffPage(authorizationUrl: string): string {
  const target = new URL(authorizationUrl);
  const allowedPath = target.pathname === '/oauth/v2/authorize' ||
    target.pathname === '/openid/connect/authorize';
  if (target.origin !== 'https://slack.com' || !allowedPath ||
      target.username || target.password || target.hash) {
    throw new TypeError('Slack authorization URL is invalid.');
  }
  const safeTarget = escapeHtmlAttribute(target.toString());
  return renderSlackJourneyPage({
    surface: 'authorization-handoff',
    eyebrow: 'Secure Slack handoff',
    title: 'Opening Slack…',
    intro: 'Chickpea prepared a fresh, short-lived Slack authorization request.',
    status: 'If Slack does not open automatically, use the button below.',
    body: `<div class="auth-actions"><a class="auth-link" data-slack-authorization-link href="${safeTarget}" rel="noreferrer" autofocus>Continue to Slack</a></div><script src="/auth/slack/continue.js" defer></script>`,
  });
}

export function renderSlackSignInPage(destination: string): string {
  const safeDestination = safeSlackPageDestination(destination);
  return renderSlackJourneyPage({
    surface: 'sign-in',
    eyebrow: 'Chickpea control plane',
    title: 'Sign in with Slack',
    intro: 'Use the same Slack identity you use with Chickpea in this workspace.',
    status: 'Full Slack members get access after their first Agent interaction. Guests and Slack Connect participants remain Slack-only.',
    body: `<form method="post" action="/auth/slack/oidc/start"><input type="hidden" name="purpose" value="login"><input type="hidden" name="destination" value="${escapeHtmlAttribute(safeDestination)}"><button class="auth-button" type="submit" autofocus>Continue with Slack</button></form>`,
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
    body: `<form method="post" action="/auth/slack/oidc/start"><input type="hidden" name="purpose" value="${input.purpose}">${capability}<input type="hidden" name="destination" value="${escapeHtmlAttribute(safeDestination)}"><button class="auth-button" type="submit" autofocus>Try another Slack account</button></form>${setupScript}`,
  });
}

export function renderSlackOwnerCompletePage(destination: string): string {
  const safeDestination = safeSlackPageDestination(destination);
  return renderSlackJourneyPage({
    surface: 'owner-complete',
    eyebrow: 'Setup complete',
    title: 'You’re the first Owner',
    intro: 'Slack installation and your exact identity are verified. Chickpea is ready to configure.',
    status: 'Your requested control-plane view is ready.',
    body: `<div class="auth-actions"><a class="auth-link" href="${escapeHtmlAttribute(safeDestination)}" autofocus>Open Chickpea</a></div>`,
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
    rootAttributes: `data-invitation-state="complete" data-destination="${escapeHtmlAttribute(safeDestination)}"`,
    body: `<noscript><a class="auth-link" href="${escapeHtmlAttribute(safeDestination)}">Open Chickpea</a></noscript><script src="/auth/slack/invite/client.js" defer></script>`,
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

/** Restored pre-U10 guided Slack setup, isolated from the automated token path. */
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
  const hidden = `<input data-slack-setup-capability type="hidden" name="capability"><input type="hidden" name="destination" value="${escapeHtmlAttribute(destination)}">`;
  const manifestJson = escapeHtmlAttribute(JSON.stringify(input.manifest, null, 2));
  const initialStep = input.error ? 'credentials' : 'create';
  const alert = input.error
    ? `<div class="onboarding-error" role="alert" tabindex="-1"><p class="field-error">${escapeHtmlAttribute(slackSetupPageMessage(input.error))}</p><p class="hint">For your safety, every secret field has been cleared.</p></div>`
    : '';
  const capabilityPanel = `<section class="onboarding-panel" data-manual-step-panel="create"><p class="onboarding-eyebrow">Connect Slack</p><h1 class="onboarding-title" tabindex="-1">Resume manual setup</h1><p class="onboarding-lede" id="slack-setup-status">Reading the private setup capability from this browser tab.</p><form id="slack-setup-open-form" method="post" action="/admin/setup/manual"><input type="hidden" name="action" value="open">${hidden}<button class="btn btn-primary" type="submit">Continue manual setup</button></form></section>`;
  const createPanelHidden = initialStep === 'create' ? '' : ' hidden';
  const createPanel = `<section class="onboarding-panel" data-manual-step-panel="create"${createPanelHidden}><p class="onboarding-eyebrow">Connect Slack</p><h1 class="onboarding-title" tabindex="-1">Create Chickpea</h1><p class="onboarding-lede">Slack opens in a new tab. Come back here after Chickpea is created.</p><div class="onboarding-instructions">${manualSlackInstruction(1, 'Choose your workspace, then click Next.', '', 'create-workspace', 'onboarding-shot-viewport', 'Slack Create from manifest screen with the workspace picker and Next button')}${manualSlackInstruction(2, 'Review Chickpea, then click Create and Install.', '', 'create-review', 'onboarding-shot-viewport', 'Slack app review screen showing Chickpea permissions and Create and Install')}</div><div class="onboarding-guide-actions"><span></span><a class="btn btn-primary" href="${escapeHtmlAttribute(input.manifestPrefillUrl)}" target="_blank" rel="noreferrer" data-manual-step-target="finish"><span class="onboarding-slack-logo slack-logo-image" aria-hidden="true"></span>Create Chickpea in Slack <span aria-hidden="true">↗</span></a></div></section>`;
  const finishPanel = `<section class="onboarding-panel" data-manual-step-panel="finish" hidden><p class="onboarding-eyebrow">Connect Slack</p><h1 class="onboarding-title" tabindex="-1">Finish creating Chickpea</h1><p class="onboarding-lede">Two quick actions in the Slack tab you just opened.</p><div class="onboarding-instructions">${manualSlackInstruction(1, 'Review the permissions, then click Allow.', '', 'allow', 'onboarding-shot-focused', 'Slack permission approval screen with the Allow button')}${manualSlackInstruction(2, 'When Slack says Chickpea is ready, click Go to App Settings.', '', 'ready', 'onboarding-shot-ready', 'Slack Chickpea is ready dialog with the Go to App Settings button')}</div><div class="onboarding-guide-actions"><button class="btn btn-ghost" type="button" data-manual-step-target="create">Back</button><button class="btn btn-primary" type="button" data-manual-step-target="events">Next: Verify Event URL</button></div></section>`;
  const eventsPanel = `<section class="onboarding-panel" data-manual-step-panel="events" hidden><p class="onboarding-eyebrow">Connect Slack</p><h1 class="onboarding-title" tabindex="-1">Verify the Event URL</h1><p class="onboarding-lede">Slack needs one manual check before it can send messages to Chickpea.</p><a class="btn btn-ghost onboarding-inline-recovery" href="https://api.slack.com/apps" target="_blank" rel="noreferrer">Lost the Slack tab? Open your apps <span aria-hidden="true">↗</span></a><div class="onboarding-instructions"><section class="onboarding-instruction"><h2 class="onboarding-instruction-title"><span class="onboarding-instruction-number">1</span><span>In the left sidebar, open Event Subscriptions.</span></h2></section>${manualSlackInstruction(2, 'Beside Request URL, click Retry.', '', 'events-retry', 'onboarding-shot-wide', 'Slack Event Subscriptions showing the Retry button')}${manualSlackInstruction(3, 'When Request URL says Verified, click Save Changes.', 'If it still says your URL did not respond, wait a few seconds and click Retry again.', 'events', 'onboarding-shot-focused onboarding-shot-events', 'Slack Event Subscriptions showing Request URL Verified')}</div><div class="onboarding-guide-actions"><button class="btn btn-ghost" type="button" data-manual-step-target="finish">Back</button><button class="btn btn-primary" type="button" data-manual-step-target="credentials">I saved changes</button></div></section>`;
  const credentialsPanel = `<section class="onboarding-panel" data-manual-step-panel="credentials"${initialStep === 'credentials' ? '' : ' hidden'}><p class="onboarding-eyebrow">Connect Slack</p><h1 class="onboarding-title" tabindex="-1">Add app credentials</h1><p class="onboarding-lede">Paste these values once. Chickpea validates the app, encrypts its credentials, and then uses Slack OAuth for the bot token and installer identity.</p><a class="btn btn-ghost onboarding-inline-recovery" href="https://api.slack.com/apps" target="_blank" rel="noreferrer">Lost the Slack tab? Open your apps <span aria-hidden="true">↗</span></a><form class="onboarding-credential-form" method="post" action="/admin/setup/manual"><input type="hidden" name="action" value="adopt">${hidden}<section class="onboarding-credential"><h2 class="onboarding-instruction-title"><span class="onboarding-instruction-number">1</span><span>In Basic Information, copy the app credentials.</span></h2><div class="onboarding-credential-grid"><div class="onboarding-shot onboarding-shot-secret"><img src="/admin/assets/onboarding/signing-secret.webp" alt="Slack Basic Information showing the Signing Secret" loading="lazy" decoding="async"></div><div class="onboarding-credential-help"><label class="field" for="manual-app-id"><span class="field-label">App ID</span><input class="input mono" id="manual-app-id" name="appId" type="text" autocomplete="off" maxlength="64" required></label><label class="field" for="manual-client-id"><span class="field-label">Client ID</span><input class="input mono" id="manual-client-id" name="clientId" type="text" autocomplete="off" maxlength="256" required></label><label class="field" for="manual-client-secret"><span class="field-label">Client Secret</span><input class="input mono" id="manual-client-secret" name="clientSecret" type="password" autocomplete="off" maxlength="4096" required></label><label class="field" for="manual-signing-secret"><span class="field-label">Signing Secret</span><span class="onboarding-credential-subtext">Use Signing Secret — not Client Secret.</span><input class="input mono" id="manual-signing-secret" name="signingSecret" type="password" autocomplete="off" maxlength="4096" required></label></div></div></section><section class="onboarding-credential"><h2 class="onboarding-instruction-title"><span class="onboarding-instruction-number">2</span><span>Export the app manifest as JSON and paste it here.</span></h2><label class="field" for="manual-manifest"><span class="field-label">Exported app manifest (JSON)</span><textarea class="input mono" id="manual-manifest" name="observedManifest" maxlength="7500" required>${manifestJson}</textarea></label></section>${alert}<div class="onboarding-guide-actions"><button class="btn btn-ghost" type="button" data-manual-step-target="events">Back</button><button class="btn btn-primary" type="submit">Validate and continue</button></div></form></section>`;
  const panels = state === 'capability_required'
    ? capabilityPanel
    : state === 'awaiting_app_creation'
      ? `${createPanel}${finishPanel}${eventsPanel}${credentialsPanel}`
      : `<section class="onboarding-panel" data-manual-step-panel="create"><p class="onboarding-eyebrow">Manual setup</p><h1 class="onboarding-title" tabindex="-1">Continue shared setup</h1><p class="onboarding-lede">The app is ready. Continue with the encrypted Slack installation and Owner verification.</p><div class="onboarding-actions"><a class="btn btn-primary" href="/admin/setup">Continue setup</a></div></section>`;
  return `<!doctype html><html lang="en" data-slack-manual-setup-state="${escapeHtmlAttribute(state)}" data-slack-setup-state="${escapeHtmlAttribute(state)}" data-slack-setup-auto-resume="${String(input.autoResume === true)}" data-manual-initial-step="${initialStep}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Chickpea · Manual Slack setup</title>${ADMIN_FAVICON}<style>${SLACK_MANUAL_SETUP_CSS}</style></head><body><main class="onboarding-shell"><div class="onboarding-shell-inner"><div class="onboarding-brand-row">${AUTH_BRAND_HTML}<span class="onboarding-environment">private setup</span></div><ol class="onboarding-orientation" role="list" aria-label="Onboarding progress"><li class="active" aria-current="step"><span class="onboarding-step-dot">1</span><span class="onboarding-step-label">Connect Slack</span></li><li><span class="onboarding-step-dot">2</span><span class="onboarding-step-label">Choose a channel</span></li><li><span class="onboarding-step-dot">3</span><span class="onboarding-step-label">Try Chickpea</span></li></ol><div class="onboarding-stage" aria-live="polite">${panels}</div></div></main><script src="/admin/setup/manual/client.js" defer></script></body></html>`;
}

function manualSlackInstruction(
  number: number,
  title: string,
  note: string,
  imageName: string,
  imageClass: string,
  alt: string,
): string {
  return `<section class="onboarding-instruction"><h2 class="onboarding-instruction-title"><span class="onboarding-instruction-number">${number}</span><span>${escapeHtmlAttribute(title)}</span></h2>${note ? `<p class="onboarding-instruction-note">${escapeHtmlAttribute(note)}</p>` : ''}<div class="onboarding-shot ${escapeHtmlAttribute(imageClass)}"><img src="/admin/assets/onboarding/${escapeHtmlAttribute(imageName)}.webp" alt="${escapeHtmlAttribute(alt)}" loading="lazy" decoding="async"></div></section>`;
}

const SLACK_MANUAL_SETUP_CSS = `
@import url("https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&family=Quicksand:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap");
:root{--bg:#fffdf6;--canvas:#f4ebd8;--well:#f8f1df;--line:rgba(59,50,32,.1);--line-strong:rgba(59,50,32,.16);--text:#3b3220;--text-2:#6b5c42;--text-3:#9f8f72;--ember:#dda033;--ember-deep:#8a6410;--ember-tint:rgba(221,160,51,.18);--ember-press:#b27e1f;--danger:#b5473a;--font:Quicksand,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--display:"Baloo 2",var(--font);--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace}*{box-sizing:border-box}html{color-scheme:light;background:var(--canvas)}body{margin:0;background:var(--canvas);color:var(--text);font-family:var(--font)}button,input,textarea{font:inherit}.onboarding-shell{isolation:isolate;min-height:100dvh;width:100%}.onboarding-shell-inner{margin:0 auto;max-width:1500px;padding:24px 28px 64px;width:100%}.onboarding-brand-row{align-items:center;display:flex;gap:20px;justify-content:space-between}.auth-brand{align-items:center;display:flex;gap:11px}.auth-brand-mark{height:36px;width:36px}.auth-brand-name{font-family:var(--display);font-size:1.625rem;font-weight:700}.onboarding-environment{color:var(--text-3);font-family:var(--mono);font-size:.8125rem}.onboarding-orientation{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));list-style:none;margin:26px auto 0;max-width:560px;padding:0;width:100%}.onboarding-orientation li{min-width:0;position:relative;text-align:center}.onboarding-orientation li:not(:first-child)::before{background:var(--line-strong);content:"";height:2px;position:absolute;right:50%;top:18px;width:100%;z-index:-1}.onboarding-step-dot{background:var(--canvas);border:2px solid var(--line-strong);border-radius:50%;color:var(--text-3);display:grid;font-family:var(--mono);font-size:.875rem;height:38px;margin:0 auto 9px;place-items:center;width:38px}.active .onboarding-step-dot{background:var(--bg);border-color:var(--ember);box-shadow:0 0 0 5px var(--ember-tint);color:var(--ember-deep)}.onboarding-step-label{color:var(--text-3);display:block;font-size:.875rem;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.active .onboarding-step-label{color:var(--text)}.onboarding-stage{display:grid;min-height:590px;padding-top:32px;place-items:start center}.onboarding-panel{background:var(--bg);border-radius:28px;box-shadow:0 4px 0 rgba(59,50,32,.11);padding:42px 44px;width:min(82%,1280px)}.onboarding-eyebrow{color:var(--ember-deep);font-family:var(--mono);font-size:.75rem;font-weight:700;letter-spacing:.09em;margin:0 0 12px;text-transform:uppercase}.onboarding-title{color:var(--text);font-family:var(--display);font-size:clamp(2.25rem,3.4vw,2.875rem);font-weight:700;letter-spacing:-.025em;line-height:1;margin:0;max-width:24ch;text-wrap:balance}.onboarding-lede{color:var(--text-2);font-size:1.125rem;line-height:1.5;margin:14px 0 0;max-width:58ch}.onboarding-instructions{display:grid;gap:32px;margin-top:32px}.onboarding-instruction{display:grid;gap:13px}.onboarding-instruction-title{align-items:center;color:var(--text);display:grid;font-size:1.125rem;font-weight:700;gap:12px;grid-template-columns:36px minmax(0,1fr);line-height:1.35;margin:0}.onboarding-instruction-number{background:#faedca;border-radius:50%;color:var(--ember-deep);display:grid;font-family:var(--mono);font-size:.875rem;font-weight:700;height:36px;place-items:center;width:36px}.onboarding-instruction-note{color:var(--text-2);font-size:.9375rem;line-height:1.45;margin:-3px 0 0 48px}.onboarding-shot{background:white;border:1px solid var(--line-strong);border-radius:16px;box-shadow:0 2px 0 rgba(59,50,32,.07);overflow:hidden}.onboarding-shot img{display:block;height:auto;width:100%}.onboarding-shot-viewport{height:380px}.onboarding-shot-viewport img{height:100%;object-fit:cover;object-position:center bottom}.onboarding-shot-focused{margin-left:53px;width:min(700px,calc(100% - 53px))}.onboarding-shot-ready{margin-left:53px;width:min(760px,calc(100% - 53px))}.onboarding-shot-wide{margin-left:53px;width:min(920px,calc(100% - 53px))}.onboarding-shot-events{aspect-ratio:1.25;position:relative}.onboarding-shot-events img{height:auto;left:0;position:absolute;top:-7%;width:100%}.onboarding-guide-actions{align-items:center;border-top:1px solid var(--line);display:flex;gap:16px;justify-content:space-between;margin-top:36px;padding-top:22px}.btn{align-items:center;border:0;border-radius:12px;color:var(--text);cursor:pointer;display:inline-flex;font-weight:700;justify-content:center;min-height:46px;padding:10px 17px;text-decoration:none}.btn-primary{background:var(--ember);box-shadow:0 3px 0 var(--ember-press)}.btn-ghost{background:transparent;border:1px solid var(--line-strong)}.slack-logo-image{background:url("${SLACK_LOGO_DATA_URL}") center/contain no-repeat;display:inline-block}.onboarding-slack-logo{height:23px;margin-right:7px;width:23px}.onboarding-inline-recovery{margin-top:10px}.onboarding-credential-form{display:grid;gap:32px;margin-top:32px}.onboarding-credential{display:grid;gap:13px}.onboarding-credential-grid{align-items:start;display:grid;gap:26px;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.onboarding-credential-help{display:grid;gap:9px}.field{display:grid;gap:7px}.field-label{font-weight:700}.input{background:var(--well);border:1px solid var(--line-strong);border-radius:11px;color:var(--text);min-height:48px;padding:11px 12px;width:100%}textarea.input{min-height:230px;resize:vertical}.mono{font-family:var(--mono)}.onboarding-credential-subtext,.hint{color:var(--text-3);font-size:.8125rem}.onboarding-shot-secret{width:min(420px,100%)}.onboarding-error{background:#fff3ee;border-left:4px solid var(--danger);border-radius:8px;padding:12px 14px}.field-error{color:var(--danger);font-weight:700;margin:0 0 4px}.onboarding-actions{display:flex;gap:10px;margin-top:30px}[hidden]{display:none!important}:focus-visible{outline:3px solid rgba(176,84,21,.48);outline-offset:3px}
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
  const hidden = `<input data-slack-setup-capability type="hidden" name="capability"><input type="hidden" name="destination" value="${escapeHtmlAttribute(destination)}">`;
  const manifestJson = escapeHtmlAttribute(JSON.stringify(input.manifest, null, 2));
  let title = 'Resume private setup';
  let intro = 'Chickpea keeps this seven-day setup checkpoint without turning the setup link into a user session.';
  let body = '';
  if (state === 'capability_required') {
    body = `<form id="slack-setup-open-form" method="post" action="/admin/setup"><input type="hidden" name="action" value="open">${hidden}${input.notice ? `<input type="hidden" name="notice" value="${escapeHtmlAttribute(input.notice)}">` : ''}<button class="auth-button" data-primary-action="resume-private" type="submit" autofocus>Continue private setup</button></form>`;
  } else if (state === 'awaiting_app_creation') {
    title = input.gatewayState === 'connected' ? 'Slack is connected' : 'Add Chickpea to Slack';
    intro = input.gatewayState === 'connected'
      ? 'The shared Chickpea app is bound to this deployment. Verify your Slack identity to become the first Owner.'
      : 'The recommended install uses Chickpea’s shared Slack app. Your deployment keeps its own data and never receives a Slack bot token.';
    const primary = input.gatewayState === 'connected'
      ? `<form method="post" action="/auth/slack/oidc/start">${hidden}<input type="hidden" name="purpose" value="first_owner"><button class="auth-button" data-primary-action="gateway-owner" type="submit" autofocus>Continue with Slack</button></form>`
      : input.gatewayState === 'pending'
        ? `<form method="post" action="/admin/setup"><input type="hidden" name="action" value="gateway_refresh">${hidden}<button class="auth-button" data-primary-action="gateway-refresh" type="submit" autofocus>Check Slack installation</button></form>`
        : `<form method="post" action="/admin/setup"><input type="hidden" name="action" value="gateway_begin">${hidden}<button class="auth-button" data-primary-action="gateway-install" type="submit" autofocus><span class="setup-slack-logo slack-logo-image" aria-hidden="true"></span>Add to Slack</button></form>`;
    body = `${primary}<p class="setup-token-note"><span aria-hidden="true">▢</span><span>No app configuration token or Slack credentials to copy.</span></p><details class="setup-manual-choice" data-secondary-action="customer-owned-app"><summary>Use your own Slack app instead</summary><p class="auth-help">For isolated or regulated deployments, create a customer-owned app with a short-lived Slack configuration token.</p><aside class="setup-token-callout"><div><strong>Generate an App Configuration token in Slack</strong><p>Under Your App Configuration Tokens, choose Generate Token and select your workspace.</p></div><a class="setup-slack-link" href="https://api.slack.com/apps#:~:text=Your%20App%20Configuration%20Tokens" target="_blank" rel="noreferrer"><span class="setup-slack-logo slack-logo-image" aria-hidden="true"></span>Open Slack <span class="sr-only">(opens in a new tab)</span></a></aside><form method="post" action="/admin/setup"><input type="hidden" name="action" value="create">${hidden}<label for="configuration-token">Slack configuration access token<span>Paste the xoxe.xoxp- token here.</span></label><input id="configuration-token" type="password" name="configurationToken" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" maxlength="512" placeholder="xoxe.xoxp-…" required><p class="auth-help">Slack also shows a refresh token beginning xoxe-. Chickpea does not need it.</p><button class="auth-button secondary" data-primary-action="create-app" type="submit">Create my Slack app</button><p class="setup-token-note"><span aria-hidden="true">▢</span><span>Sent once to Slack and never stored by Chickpea.</span></p></form><p class="auth-help"><a class="auth-link secondary" href="/admin/setup/manual">Can’t create an app configuration token? Use guided manual setup.</a></p></details>`;
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
    body = `<div class="auth-warning" role="note"><strong>If Slack has not delivered the challenge</strong>Open Event Subscriptions, click Retry beside Request URL, then click Save Changes.</div><div class="auth-actions"><a class="auth-link secondary" href="${escapeHtmlAttribute(eventsUrl)}" target="_blank" rel="noreferrer">Open Event Subscriptions</a></div><form method="post" action="/auth/slack/install/finalize">${hidden}<button class="auth-button" data-primary-action="verify-events" type="submit" autofocus>Check signed Events verification</button></form>`;
  } else if (state === 'bot_installed') {
    title = 'Become the first Owner';
    intro = 'Sign in as the same Slack member who installed the app. Installation alone does not grant Chickpea access.';
    body = `<form method="post" action="/auth/slack/oidc/start"><input type="hidden" name="purpose" value="first_owner">${hidden}<button class="auth-button" data-primary-action="claim-owner" type="submit" autofocus>Sign in with Slack</button></form>`;
  } else if (state === 'install_failed') {
    title = 'Installation could not be verified';
    intro = 'The inactive bot credential was discarded. The private setup state is preserved for inspection.';
    body = '<p class="auth-help">Create a fresh deployment setup link before attempting another installation.</p>';
  } else {
    title = 'Slack setup is complete';
    intro = 'The setup capability no longer grants any action.';
    body = `<div class="auth-actions"><a class="auth-link" href="${escapeHtmlAttribute(destination)}" autofocus>Open Chickpea</a></div>`;
  }
  const progress = slackSetupProgress(state);
  const progressHtml = `<ol class="auth-progress" aria-label="Setup progress"><li data-current="${String(progress === 1)}">Create app</li><li data-current="${String(progress === 2)}">Install</li><li data-current="${String(progress === 3)}">Verify Owner</li></ol>`;
  return renderSlackJourneyPage({
    surface: 'setup', eyebrow: 'Private Slack setup', title, intro,
    status: slackSetupPageMessage(state), alert: error ?? notice,
    rootAttributes: `data-slack-setup-state="${escapeHtmlAttribute(state)}" data-slack-setup-auto-resume="${String(input.autoResume === true)}"`,
    body: `${progressHtml}${body}<script src="/admin/setup/client.js" defer></script>`,
  });
}

function slackSetupProgress(state: string): 1 | 2 | 3 {
  if (['app_created', 'approval_pending', 'bot_install_pending', 'install_failed'].includes(state)) return 2;
  if (['bot_installed', 'consumed'].includes(state)) return 3;
  return 1;
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
        <label for="app-id">Slack app ID</label><input id="app-id" name="appId" required maxlength="64" autocomplete="off" value="${escapeHtmlAttribute(options.expectedAppId ?? '')}">
        <label for="team-id">Slack team ID</label><input id="team-id" name="teamId" required maxlength="64" autocomplete="off" value="${escapeHtmlAttribute(options.expectedTeamId ?? '')}">
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

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
