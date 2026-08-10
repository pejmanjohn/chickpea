import { isCloudflareTarget } from '../config/runtime-target.ts';
import { CONNECTOR_LOGOS } from '../config/connector-logos.ts';
import { CONNECTOR_PRESETS, GOOGLE_WORKSPACE_SERVICE_PRESETS } from '../config/presets.ts';
import { GOOGLE_WORKSPACE_SCOPE_OPTIONS } from '../config/api-oauth-policy.ts';
import {
  PASSWORD_MIN_CODE_POINTS,
  type PasswordPolicyErrorCode,
} from '../auth/password-policy.ts';

const ADMIN_FAVICON = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='8 9 32 32'%3E%3Ccircle cx='24' cy='25' r='15.5' fill='%23E3AC45'/%3E%3Ccircle cx='17' cy='17.5' r='4.2' fill='%23F4D084'/%3E%3Ccircle cx='18.5' cy='24' r='1.9' fill='%233B3220'/%3E%3Ccircle cx='29.5' cy='24' r='1.9' fill='%233B3220'/%3E%3Cpath d='M19 29 Q24 32.5 29 29' fill='none' stroke='%233B3220' stroke-width='1.8' stroke-linecap='round'/%3E%3Ccircle cx='15.5' cy='28.5' r='2' fill='%23DC8A4F' opacity='0.4'/%3E%3Ccircle cx='32.5' cy='28.5' r='2' fill='%23DC8A4F' opacity='0.4'/%3E%3C/svg%3E">`;
const SLACK_LOGO_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAA/CAMAAABnwz74AAAAn1BMVEX///+j3++a2+rw5M3n2tOk0K7L3L54xrXI0sftyHSPxZqLwZSp07HI6/RkzOpz0uyJ09tmtHlirnNwtH59z+ZZyOpdrXFbqm1dsnOPxppNxej23qjupqThYIDldY3yr7rodJPx0Ibz0YreSW3dO2XjMV7kVnv43qzzyXbvuE/ttUXyyHfjNmPjKVrbJVXwsTvusj3aG1DbLFLhH1PvscJL5pvlAAAAAXRSTlMAQObYZgAABDtJREFUSMe9lw1vokAQhvkQVsFCEUFbRVBEQUWl9v//tpuZ3QU8bW97l9ybaAI4z843UdOeSTdAendtDizLGtiaonSdIYAN5Y2R7TjMdZyxIuDF8FD+q7zhsmACCl01wnDqRREhXqX9JI4n8Ww2USNMo0gAvNch2ccxegCEwDUVMmBEkhD5L5o2tlg8D8AHAMwchUTqfhQJROQZNgACHsCPAcgAwNAhQDxDF5QAxj1gDACKABkqAE2nInQhOAFo8gOAZvh3HlhBIBCqgDfm9T0QACCoAjAP0+nUgC/jrQOgD6qAvsZWOBGEvwZ0Hrj/Aph8DdC/0O+ALonmeDx+M+Vg6FNMehR1Q8THear3AZMewHVcFrqOZQr76F0q6nVh5BEBhknYI4BMYD/MQYFr0Xi39tG9wAlca48Al83JHggI0L0HU+lC5Bsm9sGE1gEAZrgPbAdMA/jM5yEzNZ1Fz+17rRz3AablzmVrBY6lDYwo+haA44ze0z5wTRkSKgwB8PI9wETALIbDSU8ANL0U8KPePUoihBtz+8DhgDDkpeUAn6+vR/P3d6yCbmHS+UoMGVUlZGHI0A/Xxq3LvD4ASwIfqqvPsMy2C/kWDoxFWUMeAeOdyHzqvN7JBHn3xHObcQLkHAALCiFgjLmunAV6k5GmrXx/yuRzeLO5ILKHMuKFA+oNFkQyBOEXXQ6H+os+7J6PRvB+tEfixyO41OjrOw21/ytzuVyaZjvg2jJJlnfPzQXIvFPv8WiVZlmWghJ+YwWX2aoNMllvnmidyMdplm9BeV5k/N4qL0DbneDty+pwqB51PCbCfou/L06nekd3VkVd10VRn3MOPFYX0BV1aMUR+DzJ8uJEJ54KAqxOaA6AuqHrdXW4cKMegOwP1RoykeyKFoAnJjtuD4QmX0HnYQAPElGUezAQDqDwxCSXgKLZpuYXACIcDuVGS7PWvKj7gHNRfOQc8JQADAIMskIeWNxagMgCepCUPN5WkJCrJAAgWW0loOY5yG91TWUoaulBHyAKcqHEUg52wgWwx+5K8kYS6lNqYxWqPgId4IDLpTpiFdIcCfWt2KXUF9sOkCNAEEQl5fmo6rgQnXQ6QRtlqSYAzRn18SEA2roUgF4rgQdVuRCjkHymaZaI1n4C0OzNppTqhmG/6E9bO1w9wFkCNPOpnk82AhoOaFrAT9TzoAPgOvg7AHeT9oEqoQWcOWCxL49i/uW++QMg/w2wkW1QlUqEFiBCSEo5vNC5KmEAAM1rBJw6wAEBlRrgXNcIgO4WgIvYAIdqo/CPRQLqFnDhk0cAhb5IdgRAUQiLEidYbEUlD7LzTQLyzwSrcJGEaj36M0DLtjdOaM601vcQw5UvIaUq4HuhaW44EGLA9yXN8fVaKXbjKNuhB9tM9k3KF7OqPRA+6d2YtH23WMIiWC+UOplkDkB3P98PBs+P/wV/Ze9+4cPjFgAAAABJRU5ErkJggg==';

export function renderAdminPage(
  options: { usageAdminUi?: boolean } = {},
): string {
  // Target-aware chrome: the header chip and the provider-hint copy differ
  // between the Node and Cloudflare runtimes. Resolved server-side (the inline
  // script has no runtime-target check of its own) and interpolated as plain
  // text into both the first-paint skeleton and the inlined script.
  const isCloudflare = isCloudflareTarget();
  const targetChip = isCloudflare ? 'cloudflare · workers' : 'local · node';
  const providerHint = isCloudflare
    ? 'Read-only &mdash; the Workers AI binding is always available; configure others via wrangler secrets (built-ins) or src/app.ts (custom).'
    : 'Read-only &mdash; configured via .env (built-ins) or src/app.ts (custom).';
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
.onboarding-frame { max-width: none; }
.onboarding-shell { isolation: isolate; min-height: 100dvh; width: 100%; }
.onboarding-shell-inner { margin: 0 auto; max-width: 1180px; padding: 30px 26px 52px; width: 100%; }
.onboarding-brand-row { align-items: center; display: flex; gap: 20px; justify-content: space-between; }
.onboarding-brand { align-items: center; color: var(--text); display: inline-flex; gap: 11px; min-width: 0; text-decoration: none; }
.onboarding-brand .avatar, .onboarding-brand .avatar .pea { height: 34px; width: 34px; }
.onboarding-brand .brand-name { font-size: 1.5rem; line-height: 1; }
.onboarding-environment { color: var(--text-3); font-family: var(--mono); font-size: .6875rem; }
.onboarding-orientation { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); list-style: none; margin: 34px auto 0; max-width: 710px; padding: 0; width: 100%; }
.onboarding-orientation li { min-width: 0; position: relative; text-align: center; }
.onboarding-orientation li:not(:first-child)::before { background: var(--line-strong); content: ""; height: 2px; position: absolute; right: 50%; top: 15px; width: 100%; z-index: -1; }
.onboarding-orientation li.complete:not(:first-child)::before,
.onboarding-orientation li.active:not(:first-child)::before { background: var(--ember); }
.onboarding-step-dot { background: var(--canvas); border: 2px solid var(--line-strong); border-radius: 50%; color: var(--text-3); display: grid; font-family: var(--mono); font-size: .6875rem; font-variant-numeric: tabular-nums; height: 31px; margin: 0 auto 8px; place-items: center; width: 31px; }
.complete .onboarding-step-dot { background: var(--ember); border-color: var(--ember); color: var(--text); }
.active .onboarding-step-dot { background: var(--bg); border-color: var(--ember); box-shadow: 0 0 0 5px var(--ember-tint); color: var(--ember-deep); }
.onboarding-step-label { color: var(--text-3); display: block; font-size: .8125rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.active .onboarding-step-label, .complete .onboarding-step-label { color: var(--text); }
.onboarding-stage { display: grid; min-height: 590px; padding-top: 42px; place-items: start center; }
.onboarding-panel { background: var(--bg); border-radius: 24px; box-shadow: var(--card-shadow); padding: 42px; width: min(100%, 760px); }
.onboarding-panel-wide { width: min(100%, 900px); }
.onboarding-eyebrow { color: var(--ember-deep); font-family: var(--mono); font-size: .6875rem; letter-spacing: .08em; margin: 0 0 10px; text-transform: uppercase; }
.onboarding-title { color: var(--text); font-family: var(--display); font-size: clamp(2rem, 5vw, 2.75rem); font-weight: 700; letter-spacing: -.025em; line-height: 1.03; margin: 0; max-width: 24ch; text-wrap: balance; }
.onboarding-lede { color: var(--text-2); font-size: 1rem; line-height: 1.65; margin: 12px 0 0; max-width: 56ch; text-wrap: pretty; }
.onboarding-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; margin-top: 30px; }
.onboarding-actions .btn { min-height: 38px; padding: 9px 14px; }
.onboarding-slack-logo { display: inline-block; flex: 0 0 auto; height: 18px; margin-right: 3px; width: 18px; }
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
.onboarding-prompt-box { background: var(--well); border-radius: 15px; box-shadow: inset 0 0 0 1px var(--line); margin-top: 30px; padding: 19px; }
.onboarding-prompt-label { color: var(--text-3); font-family: var(--mono); font-size: .6875rem; letter-spacing: .06em; margin: 0 0 9px; text-transform: uppercase; }
.onboarding-prompt { color: var(--text); font-size: 1rem; font-weight: 600; line-height: 1.65; margin: 0; }
.onboarding-status { color: var(--ok); font-size: .8125rem; font-weight: 700; margin: 10px 0 0; min-height: 20px; }
@media (max-width: 720px) {
  .onboarding-shell-inner { padding: 20px 14px 38px; }
  .onboarding-environment { display: none; }
  .onboarding-orientation { margin-top: 25px; }
  .onboarding-step-label { font-size: .75rem; }
  .onboarding-stage { min-height: 520px; padding-top: 28px; }
  .onboarding-panel { border-radius: 19px; padding: 28px 21px; }
  .onboarding-actions, .onboarding-form-actions { align-items: stretch; flex-direction: column-reverse; }
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
.slack-identity-card {
  align-items: center;
  background: var(--well);
  border-radius: 16px;
  display: flex;
  gap: 14px;
  padding: 14px 16px;
}
.slack-identity-avatar {
  align-items: center;
  background: var(--bg);
  border-radius: 14px;
  box-shadow: inset 0 0 0 1.5px var(--line-strong);
  color: var(--ember-press);
  display: inline-flex;
  flex-shrink: 0;
  font-family: var(--display);
  font-size: 1.25rem;
  font-weight: 700;
  height: 56px;
  justify-content: center;
  overflow: hidden;
  width: 56px;
}
.slack-identity-avatar img { height: 100%; object-fit: cover; width: 100%; }
.slack-identity-copy { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.slack-identity-name { color: var(--text); font-family: var(--mono); font-size: 0.9375rem; font-weight: 700; overflow-wrap: anywhere; }
.slack-identity-actions { align-items: center; display: flex; flex-shrink: 0; gap: 8px; }
.identity-list { container-type: inline-size; display: flex; flex-direction: column; gap: 10px; }
.identity-row {
  align-items: center;
  background: var(--well);
  border-radius: 16px;
  box-shadow: inset 0 0 0 1.5px var(--line);
  display: grid;
  gap: 12px;
  grid-template-columns: auto minmax(160px, 1.2fr) minmax(140px, .8fr) minmax(150px, .9fr) auto;
  padding: 14px 16px;
}
.identity-row .slack-identity-avatar { height: 48px; width: 48px; }
.identity-meta { align-items: flex-start; color: var(--text-3); display: flex; flex-direction: column; font-size: .75rem; gap: 3px; min-width: 0; }
.identity-meta strong { color: var(--text-2); font-size: .8125rem; }
.identity-wizard { display: flex; flex-direction: column; gap: 14px; }
.identity-step { background: var(--well); border-radius: 16px; box-shadow: inset 0 0 0 1.5px var(--line); padding: 16px; }
.identity-step.active { box-shadow: inset 0 0 0 2px var(--ember); }
.identity-step-head { align-items: center; display: flex; gap: 10px; margin-bottom: 8px; }
.identity-step-number { align-items: center; background: var(--bg); border-radius: 999px; color: var(--text-2); display: inline-flex; flex: 0 0 28px; font-family: var(--mono); font-size: .75rem; height: 28px; justify-content: center; }
.identity-detail-grid { display: grid; gap: 14px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.identity-detail-grid .section { margin: 0; }
.identity-profile-list { display: flex; flex-direction: column; gap: 6px; }
.identity-profile-row { align-items: center; background: var(--bg); border-radius: 12px; display: flex; gap: 10px; justify-content: space-between; padding: 9px 11px; }
@container (max-width: 640px) {
  .identity-row { align-items: start; grid-template-columns: 48px minmax(0, 1fr) auto; }
  .identity-row .slack-identity-avatar { grid-column: 1; grid-row: 1 / 3; }
  .identity-row .slack-identity-copy { grid-column: 2; grid-row: 1; }
  .identity-row > .btn { grid-column: 3; grid-row: 1; }
  .identity-row .identity-meta { grid-row: 2; }
}
@container (max-width: 620px) {
  .identity-detail-grid { grid-template-columns: 1fr; }
}
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
@media (max-width: 720px) {
  .skill-row { align-items: stretch; flex-direction: column; }
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
.openai-auth-option.active { box-shadow: inset 0 0 0 1.5px var(--ok-solid); }
.openai-auth-head { align-items: center; display: flex; flex-wrap: wrap; gap: 10px 12px; }
.openai-auth-copy { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 190px; }
.openai-auth-title { color: var(--text); font-size: 0.875rem; font-weight: 700; }
.openai-auth-meta { color: var(--text-3); font-size: 0.75rem; }
.openai-auth-option .input { background: var(--well); }
.openai-auth-footer { align-items: center; display: flex; flex-wrap: wrap; gap: 8px 12px; justify-content: space-between; }
.openai-auth-footer .hint { flex: 1; min-width: 220px; }
.openai-auth-choice { background: var(--well); border-radius: 14px; display: flex; flex-direction: column; gap: 7px; padding: 14px 16px; }
.openai-auth-choice-row { align-items: stretch; display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr) auto; }
.openai-auth-choice-row .btn { min-width: 72px; }
@media (max-width: 620px) {
  .openai-auth-choice-row { grid-template-columns: 1fr; }
  .openai-auth-choice-row .btn { justify-self: start; }
}
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
  .action-well, .danger-panel, .slack-identity-card, .slack-overview-foot { align-items: stretch; flex-direction: column; }
  .slack-identity-actions { align-items: stretch; flex-direction: column; }
  .identity-row { align-items: stretch; grid-template-columns: 1fr; }
  .identity-row .slack-identity-avatar { height: 56px; width: 56px; }
  .identity-detail-grid { grid-template-columns: 1fr; }
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
@media (max-width: 720px) {
  .skill-row.conn-row { align-items: stretch; flex-direction: column; }
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

/* ---- team and invitation admission ------------------------------------- */
.team-main { display: grid; gap: 22px; }
.team-hero { align-items: flex-start; display: flex; gap: 16px; justify-content: space-between; }
.team-count { background: var(--ember-tint); border-radius: 999px; color: var(--ember-deep); font-size: .75rem; font-weight: 800; padding: 6px 10px; white-space: nowrap; }
.team-card { background: var(--bg); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--card-shadow); padding: 18px; }
.team-card h2 { color: var(--text); font-size: 1rem; margin: 0 0 5px; }
.team-form { display: grid; gap: 12px; margin-top: 16px; }
.team-form-row { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr) auto; }
.team-list { display: grid; gap: 10px; }
.team-row { align-items: center; background: rgba(255,255,255,.48); border: 1px solid var(--line); border-radius: 12px; display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) auto; padding: 14px; }
.team-row-main { min-width: 0; }
.team-row-title { color: var(--text); font-size: .875rem; font-weight: 800; overflow-wrap: anywhere; }
.team-row-sub { color: var(--text-2); font-size: .75rem; line-height: 1.5; margin-top: 3px; overflow-wrap: anywhere; }
.team-row-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; justify-content: flex-end; }
.team-status-control { min-width: 132px; width: auto; }
.team-status-control select.input { border-radius: 11px; font-size: .75rem; min-height: 32px; padding-block: 6px; }
.team-status-control select.input:disabled { cursor: not-allowed; opacity: .55; }
.team-statuses { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.team-status { background: var(--well); border: 1px solid var(--line); border-radius: 999px; color: var(--text-2); font-size: .6875rem; font-weight: 800; padding: 4px 8px; }
.team-status.active { background: var(--ok-tint); color: var(--ok); }
.team-status.owner { background: var(--ember-tint); border-color: rgba(221,160,51,.34); color: var(--ember-deep); }
.team-status.suspended { background: var(--ember-tint); color: var(--ember-deep); }
.team-created-flash { align-items: center; background: var(--ember-tint); border: 1px solid rgba(176,84,21,.22); border-radius: 12px; display: flex; gap: 14px; justify-content: space-between; margin-top: 14px; padding: 12px 14px; }
.team-created-flash strong { color: var(--text); display: block; font-size: .8125rem; }
.team-created-flash span { color: var(--text-2); display: block; font-size: .75rem; margin-top: 2px; overflow-wrap: anywhere; }
.team-show-once { background: var(--ember-tint); border: 1px solid rgba(176,84,21,.22); border-radius: 12px; margin-top: 14px; padding: 14px; }
.team-show-once label { color: var(--text); display: block; font-size: .75rem; font-weight: 800; margin-bottom: 7px; }
.team-link-row { align-items: center; display: flex; gap: 8px; }
.team-link-row .input { flex: 1; min-width: 0; }
.team-empty { color: var(--text-2); font-size: .8125rem; padding: 8px 0; }
@media (max-width: 620px) {
  .team-hero, .team-row { align-items: stretch; grid-template-columns: 1fr; }
  .team-hero { flex-direction: column; }
  .team-count { width: max-content; }
  .team-form-row { grid-template-columns: 1fr; }
  .team-row-actions { justify-content: flex-start; }
  .team-status-control { flex: 1; min-width: 0; }
  .team-created-flash { align-items: stretch; flex-direction: column; }
  .team-link-row { align-items: stretch; flex-direction: column; }
}

</style>
</head>
<body>
<div id="app" class="frame">
  <header class="topbar">
    <div class="brand">
      <span class="avatar">T<svg class="pea" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><circle cx="24" cy="25" r="15.5" fill="#E3AC45"></circle><circle cx="17" cy="17.5" r="4.2" fill="#F4D084"></circle><g class="pea-eyes"><circle class="pea-eye" cx="18.5" cy="24" r="1.9" fill="#3B3220"></circle><circle class="pea-eye" cx="29.5" cy="24" r="1.9" fill="#3B3220"></circle></g><g class="pea-lids"><path d="M16.4 24.2 Q18.5 22 20.6 24.2" fill="none" stroke="#3B3220" stroke-width="1.8" stroke-linecap="round"></path><path d="M27.4 24.2 Q29.5 22 31.6 24.2" fill="none" stroke="#3B3220" stroke-width="1.8" stroke-linecap="round"></path></g><path class="pea-smile" d="M19 29 Q24 32.5 29 29" fill="none" stroke="#3B3220" stroke-width="1.8" stroke-linecap="round"></path><path class="pea-grin" d="M18.5 28.5 Q24 35.5 29.5 28.5 Z" fill="#3B3220"></path><circle class="pea-blush" cx="15.5" cy="28.5" r="2" fill="#DC8A4F"></circle><circle class="pea-blush" cx="32.5" cy="28.5" r="2" fill="#DC8A4F"></circle></svg></span>
      <span class="brand-name">Chickpea</span>
      <span class="chip">${targetChip}</span>
    </div>
    <div class="actions">
      <button type="button" class="btn btn-soft" disabled>Channels</button>
      <button type="button" class="btn btn-soft" disabled>Profiles</button>
      <button type="button" class="btn btn-soft" disabled>Settings</button>
    </div>
  </header>
  <div class="body">
    <nav class="rail" aria-label="Channels">
      <div class="rail-head"><span class="section-eyebrow">Channels</span></div>
      <div class="ws-row"><svg class="ic" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"/></svg>Workspace</div>
    </nav>
    <main class="main"><div class="main-inner"><div class="empty"><h1 class="page-title">Loading admin...</h1><p class="hint">Reading local configuration.</p></div></div></main>
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
  var CONNECTOR_LOGOS = ${JSON.stringify(CONNECTOR_LOGOS).replace(/</g, '\\u003c')};
  var API_CONNECTION_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
  var GOOGLE_WORKSPACE_SCOPES = ${JSON.stringify(GOOGLE_WORKSPACE_SCOPE_OPTIONS)};
  var WORKSPACE_DEFAULT_SLACK_IDENTITY_ID = "slack_identity_default";
  var NEW_SLACK_IDENTITY_VALUE = "__new__";
  var ONBOARDING_PROMPT = "@Chickpea summarize the recent discussion in this channel and list any open questions.";
  var state = {
    agents: [],
    assignments: [],
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
    swapOpen: false,
    channelDraft: { enabled: true, channelPromptAddendum: "", participationMode: "ambient" },
    dirty: false,
    saveError: "",
    // Channels is the default destination. channelScreen distinguishes the
    // platform overview from a concrete Slack-channel detail without muddling
    // the reusable Profiles destination into the platform hierarchy.
    view: "channels",
    // Team is Chickpea's authorization surface. Authentication providers prove
    // identity, while Chickpea owns invitations and membership status.
    team: null,
    teamLoading: false,
    teamError: "",
    teamBusy: "",
    teamNotice: "",
    teamInviteLink: "",
    teamInviteEmail: "",
    teamInviteCopied: false,
    teamInviteManualCopy: false,
    teamInviteCopyVersion: 0,
    teamResetLink: "",
    // Removal is a separate destructive action, never a select option. The
    // confirmation keeps an accidental status-picker change from permanently
    // deleting the Better Auth membership and its Chickpea authority.
    teamRemoveConfirm: null,
    teamInviteDraft: { email: "" },
    channelScreen: "overview",
    profileScreen: "list",
    profileLastAgentId: null,
    profileDirty: false,
    disableConfirm: false,
    editingAgentId: null,
    profileDraft: null,
    profileError: "",
    // Safe identity summaries for Profile selection. The workspace default is
    // always rendered even if this auxiliary collection endpoint is unavailable.
    slackIdentities: { identities: [], globalDmAllowed: true },
    slackIdentityScreen: "list",
    slackIdentitySelectedId: "",
    slackIdentityDetail: null,
    slackIdentityDetailLoading: false,
    slackIdentityDetailError: "",
    slackIdentityBusy: "",
    slackIdentityActionError: "",
    slackIdentityNotice: "",
    slackIdentityConfirm: null,
    slackIdentitySetupStage: 2,
    slackIdentityReconnectOpen: false,
    slackIdentityCreateDraft: { appName: "", displayName: "", initialDmAgentId: "" },
    slackIdentityCredentialDraft: { botToken: "", signingSecret: "" },
    slackIdentitySetupDraft: { appName: "", displayName: "" },
    slackIdentityDmDraft: { dmState: "off", dmAgentId: "" },
    slackIdentityGeneration: 0,
    // Active capability tab on the profile edit screen. Panels stay mounted
    // ([hidden]) across switches, so no draft state lives here — just which
    // panel is visible.
    profileTab: "instructions",
    // Inline title rename on the profile edit screen. null when closed; when
    // open it carries { prev } so Escape (or an emptied field) can revert.
    profileRenaming: null,
    // "Add to channels" picker in the profile footer. Candidates come from the
    // Slack workspace catalog; assignments only label or exclude them.
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
    // Non-null only while the gallery's single Custom connection flow is open.
    // Both lane editors may coexist so tab switches preserve typed values.
    customConnectionLane: null,
    connectorGallerySearch: "",
    // Index of the connection pending removal (its confirm modal is open), or
    // null. The DELETE of its secrets is issued on the next profile save.
    connectionRemove: null,
    apiConnectionRemove: null,
    // When the user tries to leave a dirty profile editor, this holds the
    // pending navigation { action, agent } and the confirm modal is shown.
    leavePrompt: null,
    slack: null,
    onboarding: null,
    onboardingError: "",
    onboardingBusy: false,
    onboardingNotice: "",
    onboardingChannelSelected: "",
    slackDraft: { botToken: "", signingSecret: "" },
    slackError: "",
    slackRepair: null,
    slackBusy: false,
    // First-run permission completion is a forward onboarding state, not the
    // shared Slack recovery surface. The credential pair remains only in this
    // live page state and is discarded on refresh or when onboarding is left.
    slackOnboardingContinuation: null,
    slackOnboardingRequestId: 0,
    slackOnboardingFocus: "",
    // First-run Slack handoff: 1 opens the manifest, 2 is the explicit return
    // checkpoint, and 3 reveals install credentials. Client-side only — Slack
    // owns app creation, so there is no server signal for the transition.
    slackStep: 1,
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
    // Slack owns this install-wide presentation. Keep the live profile
    // separate from the stored connection card so a Slack API outage cannot
    // make the underlying connection appear missing.
    slackIdentity: null,
    slackIdentityError: "",
    slackIdentityLoading: false,
    slackIdentityRequestId: 0,
    // One lock covers every Slack connection operation. The legacy per-action
    // booleans below still drive their specific labels, while this value keeps
    // test, credential replacement, disconnect, and navigation from racing.
    slackConnectionBusy: "",
    slackTestBusy: false,
    slackTestStatus: null,
    slackUpdateOpen: false,
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
    settingsError: "",
    modelCatalog: null,
    modelCatalogLoaded: false,
    modelCatalogError: "",
    modelCatalogBusy: false,
    modelCatalogRequestId: 0,
    // The device user code and attempt capability exist only in this page's
    // memory. Reloading or opening Settings elsewhere can observe the safe
    // authorizing status, but cannot display, poll, cancel, or confirm this attempt.
    openAiSubscriptionAttempt: null,
    openAiSubscriptionBusy: "",
    openAiSubscriptionError: "",
    openAiSubscriptionDisconnectConfirm: false,
    openAiSubscriptionCopyStatus: "",
    openAiAuthMethodDraft: "",
    openAiAuthMethodDirty: false,
    openAiAuthMethodBusy: false,
    openAiAuthMethodError: "",
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
    auditDomain: "memory",
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
    scheduledFilters: { workspaceId: "", channelId: "", state: "current", status: "" },
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
    // The Memory draft mirrors editable entry fields so a conflict or retry
    // never erases operator work.
    memoryScopes: null,
    memoryScopesLoading: false,
    memoryScopesError: "",
    memorySelection: { storeId: "", channelId: "", entryId: "" },
    memoryFiles: null,
    memoryFilesLoading: false,
    memoryFilesError: "",
    memoryFilesRequestId: 0,
    memorySelectedFile: "",
    memoryDetail: null,
    memoryHistory: [],
    memoryEntryRequestId: 0,
    memoryDraft: null,
    memoryDirty: false,
    memoryBusy: "",
    memoryError: "",
    memoryNotice: "",
    memoryIdempotencyKey: "",
    memoryConflict: null,
    memoryDeleteConfirm: false
  };
  var egressDraft = { mode: "allowlist", domains: [""] };
  var sandboxDraft = {
    allowedHosts: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"],
    monthlySessionCap: 200
  };
  var repositorySearchTimer = null;
  var skillImportSearchTimer = null;

  // Inline Heroicons (micro, 16px) — solid unless noted. Colour inherits from
  // the parent via currentColor; never override fill in CSS.
  function icon(name, extra) {
    var paths = {
      "chevron-down": "M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z",
      "chevron-right": "M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z",
      check: "M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 1 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z",
      "x-mark": "M2.22 2.22a.75.75 0 0 1 1.06 0L8 6.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L9.06 8l4.72 4.72a.75.75 0 1 1-1.06 1.06L8 9.06l-4.72 4.72a.75.75 0 0 1-1.06-1.06L6.94 8 2.22 3.28a.75.75 0 0 1 0-1.06Z",
      plus: "M8.75 3.75a.75.75 0 0 0-1.5 0v3.5h-3.5a.75.75 0 0 0 0 1.5h3.5v3.5a.75.75 0 0 0 1.5 0v-3.5h3.5a.75.75 0 0 0 0-1.5h-3.5v-3.5Z",
      pencil: "M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.596.892l-.848 2.047a.75.75 0 0 0 .98.98l2.047-.848a2.75 2.75 0 0 0 .892-.596l4.263-4.262a1.75 1.75 0 0 0 0-2.474Z",
      "lock-closed": "M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z",
      repository: "M3 1.5A1.5 1.5 0 0 0 1.5 3v9.25A2.25 2.25 0 0 0 3.75 14.5H14a.75.75 0 0 0 .75-.75V3A1.5 1.5 0 0 0 13.25 1.5H3Zm0 1.5h10.25v8.5H3.75c-.263 0-.516.045-.75.128V3Zm.75 2.25A.75.75 0 0 1 6.5 4.5h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1-.75-.75Z",
      "arrow-path": "M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08.932.75.75 0 0 1-1.3-.75 6 6 0 0 1 9.44-1.242l.842.84V3.227a.75.75 0 0 1 .75-.75Zm-.911 7.5A.75.75 0 0 1 13.2 11a6 6 0 0 1-9.44 1.241l-.84-.84v1.372a.75.75 0 0 1-1.5 0V9.591a.75.75 0 0 1 .75-.75H5.35a.75.75 0 0 1 0 1.5H3.98l.841.84a4.5 4.5 0 0 0 7.08-.932.75.75 0 0 1 1.025-.272Z",
      "exclamation-triangle": "M6.701 2.25c.577-1 2.02-1 2.598 0l5.196 9a1.5 1.5 0 0 1-1.299 2.25H2.804a1.5 1.5 0 0 1-1.299-2.25l5.196-9ZM8 5a.75.75 0 0 1 .75.75v2.5a.75.75 0 0 1-1.5 0v-2.5A.75.75 0 0 1 8 5Zm0 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
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
          // The assignment validators return a ready-to-show message (naming
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

  function postJson(path, method, body) {
    return api(path, {
      method: method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  function concreteAssignments() {
    return state.assignments.filter(function (assignment) {
      return assignment.workspaceId !== "*" && assignment.channelId !== "*";
    });
  }

  function activeAssignment() {
    if (!state.active) return null;
    return state.assignments.find(function (assignment) {
      return assignment.workspaceId === state.active.workspaceId && assignment.channelId === state.active.channelId;
    }) || null;
  }

  function firstWorkspaceAssignment() {
    return state.assignments.find(function (assignment) {
      return assignment.workspaceId !== "*";
    }) || null;
  }

  function defaultChannelFormWorkspaceId() {
    if (state.active && state.active.workspaceId) return state.active.workspaceId;
    var assignment = firstWorkspaceAssignment();
    return assignment ? assignment.workspaceId : "";
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

  // Every assignment for the agent, wildcards included — matches the server's
  // delete guard so the modal's "Used in N" count is honest and each blocking
  // row (including the seeded '*'/'*' catch-all) has a Remove affordance.
  function allAssignmentsForAgent(agentId) {
    return state.assignments.filter(function (assignment) { return assignment.agentId === agentId; });
  }

  function assignmentByKey(workspaceId, channelId) {
    return state.assignments.find(function (assignment) {
      return assignment.workspaceId === workspaceId && assignment.channelId === channelId;
    }) || null;
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
    if (repositorySearchTimer && typeof clearTimeout === "function") clearTimeout(repositorySearchTimer);
    repositorySearchTimer = null;
    state.repositoryPicker = null;
    state.repositoryAddOpen = false;
  }

  function resetSkillImportBrowseTransientState() {
    if (skillImportSearchTimer && typeof clearTimeout === "function") clearTimeout(skillImportSearchTimer);
    skillImportSearchTimer = null;
    if (state.skillImport && state.skillImport.browse) {
      state.skillImport.browse.requestId = (state.skillImport.browse.requestId || 0) + 1;
      state.skillImport.browse = null;
    }
  }

  function resetProfileTransientState() {
    state.profileError = "";
    state.profileDirty = false;
    state.disableConfirm = false;
    state.profileTab = "instructions";
    state.profileRenaming = null;
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
    resetRepositoryTransientState();
    state.modelPickerOpen = false;
    state.modelPickerFilter = "";
  }

  // Open a profile's edit screen (from a click or a route), resetting every
  // transient editor state.
  function openProfileEditor(selected) {
    state.view = "profiles";
    state.profileScreen = "edit";
    state.editingAgentId = selected.id;
    state.profileLastAgentId = selected.id;
    state.profileDraft = cloneAgent(selected);
    resetProfileTransientState();
    render();
  }

  function openNewProfile() {
    state.view = "profiles";
    state.profileScreen = "create";
    state.profileDraft = newProfileDraft();
    state.editingAgentId = null;
    resetProfileTransientState();
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
        var identityBase = "/admin/settings/slack/identities";
        if (state.slackIdentitySelectedId && state.slackIdentityScreen === "setup") {
          return identityBase + "/" + encodeURIComponent(state.slackIdentitySelectedId) + "/setup";
        }
        if (state.slackIdentitySelectedId && state.slackIdentityScreen === "detail") {
          return identityBase + "/" + encodeURIComponent(state.slackIdentitySelectedId);
        }
        return identityBase;
      }
      return "/admin/settings/" + encodeURIComponent(state.settingsSection);
    }
    if (state.view === "audit") {
      if (state.auditDomain === "scheduled-work") {
        return "/admin/audit-logs/scheduled-work" + (state.scheduledSelection ? "/" + encodeURIComponent(state.scheduledSelection) : "");
      }
      var memoryPath = "/admin/audit-logs/memory";
      if (state.memorySelection.storeId && state.memorySelection.channelId) {
        memoryPath += "/" + encodeURIComponent(state.memorySelection.storeId) + "/" + encodeURIComponent(state.memorySelection.channelId);
        if (state.memorySelection.entryId) memoryPath += "/" + encodeURIComponent(state.memorySelection.entryId);
      }
      return memoryPath;
    }
    if (state.view === "profiles") {
      if (state.profileScreen === "create") return "/admin/profiles/new";
      if (state.profileScreen === "edit" && state.editingAgentId) return "/admin/profiles/" + encodeURIComponent(state.editingAgentId);
      return "/admin/profiles";
    }
    if (state.channelScreen === "detail" && state.active) return "/admin/channels/" + encodeURIComponent(state.active.workspaceId) + "/" + encodeURIComponent(state.active.channelId);
    return "/admin/channels";
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
    if (state.view === "onboarding") resetOnboardingSlackContinuation(true);
    if (parts[1] === "usage" && USAGE_ADMIN_UI) { applyUsageQuery(location.search || ""); openUsage(); return; }
    if (parts[1] === "team") { openTeam(); return; }
    if (parts[1] === "settings") {
      if (parts[2] === "slack" && parts[3] === "identities") {
        openSlackIdentitiesRoute(parts[4] || "", parts[5] || "");
        return;
      }
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
    if (parts[1] === "profiles") {
      if (parts[2] === "new") {
        openNewProfile();
        return;
      }
      if (parts[2]) {
        var routedAgent = agentById(parts[2]);
        if (routedAgent) { openProfileEditor(routedAgent); return; }
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
    state.view = "channels";
    state.channelScreen = "overview";
    state.profileScreen = "list";
    state.disableConfirm = false;
    render();
  }

  function render() {
    var app = document.getElementById("app");
    var overlays = teamRemoveModalHtml() + leavePromptModalHtml() + connectionRemoveModalHtml() + apiConnectionRemoveModalHtml() + slackDisconnectModalHtml() + githubDisconnectModalHtml() + sandboxConfirmModalHtml() + memoryDeleteModalHtml() + scheduledRoutineSummaryModalHtml() + scheduledDeleteModalHtml() + slackIdentityConfirmModalHtml();
    if (state.view === "onboarding") {
      app.className = "frame onboarding-frame";
      app.innerHTML = onboardingShellHtml() + overlays;
    } else {
      app.className = "frame";
      app.innerHTML = topbarHtml() + '<div class="body">' + railHtml() + mainHtml() + "</div>" + overlays;
    }
    if (isOnboardingSlackConnection()) {
      var signingSecretInput = document.getElementById("onboarding-signing-secret");
      var botTokenInput = document.getElementById("onboarding-bot-token");
      // Set credential values only as live DOM properties. They must never be
      // serialized into innerHTML, history, storage, diagnostics, or URLs.
      if (signingSecretInput) signingSecretInput.value = state.slackDraft.signingSecret;
      if (botTokenInput) botTokenInput.value = state.slackDraft.botToken;
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
    if (state.teamRemoveConfirm) {
      [document.querySelector(".topbar"), document.querySelector(".body")].forEach(function (region) {
        if (!region) return;
        region.inert = true;
        if (region.setAttribute) region.setAttribute("aria-hidden", "true");
      });
      var teamRemoveCancel = document.querySelector('[data-action="team-remove-cancel"]');
      if (teamRemoveCancel && teamRemoveCancel.focus) teamRemoveCancel.focus();
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
      else focusSlackDisconnectAction("slack-disconnect-cancel");
    }
    if (state.githubDisconnectConfirm) {
      [document.querySelector(".topbar"), document.querySelector(".body")].forEach(function (region) {
        if (!region) return;
        region.inert = true;
        if (region.setAttribute) region.setAttribute("aria-hidden", "true");
      });
      if (state.githubBusy === "disconnect") focusGithubDisconnectDialog();
      else if (state.githubDisconnectError) focusSlackLiveRegion("github-disconnect-error");
      else focusSlackDisconnectAction("github-disconnect-cancel");
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
    if (state.memoryDeleteConfirm) {
      [document.querySelector(".topbar"), document.querySelector(".body")].forEach(function (region) {
        if (!region) return;
        region.inert = true;
        if (region.setAttribute) region.setAttribute("aria-hidden", "true");
      });
      var memoryDeleteCancel = document.querySelector('[data-action="memory-delete-cancel"]');
      if (memoryDeleteCancel && memoryDeleteCancel.focus) memoryDeleteCancel.focus();
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
    if (state.slackIdentityConfirm) {
      [document.querySelector(".topbar"), document.querySelector(".body")].forEach(function (region) {
        if (!region) return;
        region.inert = true;
        if (region.setAttribute) region.setAttribute("aria-hidden", "true");
      });
      var identityConfirmFocus = state.slackIdentityBusy
        ? document.querySelector('[data-role="slack-identity-confirm-dialog"]')
        : document.querySelector('[data-action="slack-identity-confirm-apply"]');
      if (identityConfirmFocus && identityConfirmFocus.focus) identityConfirmFocus.focus();
    }
    syncUrl();
    syncOnboardingActivity();
  }

  function slackIdentityConfirmModalHtml() {
    var confirmation = state.slackIdentityConfirm;
    if (!confirmation) return "";
    var copyByType = {
      cancel: {
        title: "Cancel this identity setup?",
        body: "Chickpea erases stored credentials and the pending Slack callback before removing this draft. The Slack app itself is not uninstalled.",
        label: "Cancel setup"
      },
      retire: {
        title: "Retire this Slack identity locally?",
        body: "Chickpea deletes this identity&rsquo;s local credentials and keeps a non-secret tombstone. This does not uninstall or revoke the Slack app, and old threads may become unavailable.",
        label: "Retire locally"
      },
      dm: {
        title: "Change DM behavior?",
        body: "Future DMs to this Slack app will use the selected setting and Profile. The existing Slack conversation and audience memory continue.",
        label: "Save DM behavior"
      }
    };
    var copy = copyByType[confirmation.type] || copyByType.dm;
    return '<div class="modal-backdrop"><div class="modal-card" role="dialog" aria-modal="true" aria-label="' + esc(copy.title) + '" tabindex="-1" data-role="slack-identity-confirm-dialog"><h2 class="modal-title">' + esc(copy.title) + '</h2><p class="modal-body">' + copy.body + '</p>' +
      (state.slackIdentityActionError ? '<p class="field-error" role="alert">' + esc(state.slackIdentityActionError) + '</p>' : '') +
      '<div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="slack-identity-confirm-cancel"' + (state.slackIdentityBusy ? " disabled" : "") + '>Go back</button><span class="spacer"></span><button type="button" class="btn ' + (confirmation.type === "dm" ? "btn-primary" : "btn-danger") + '" data-action="slack-identity-confirm-apply"' + (state.slackIdentityBusy ? " disabled" : "") + '>' + (state.slackIdentityBusy ? "Working&hellip;" : copy.label) + '</button></div></div></div>';
  }

  // The unsaved-changes guard modal. Rendered only while state.leavePrompt is
  // set (the user tried to leave a dirty profile editor). The backdrop carries
  // NO data-action, so a click outside the card is inert (Keep editing is the
  // explicit cancel); the dispatcher's closest("[data-action]") would otherwise
  // treat a backdrop click as an action.
  function leavePromptModalHtml() {
    if (!state.leavePrompt) return "";
    return '<div class="modal-backdrop">' +
      '<div class="modal-card" role="dialog" aria-modal="true" aria-label="Unsaved changes">' +
      '<h2 class="modal-title">Unsaved changes</h2>' +
      '<p class="modal-body">This profile has changes you haven&rsquo;t saved. Save them before leaving, or discard them.</p>' +
      '<div class="modal-foot">' +
      '<button type="button" class="btn btn-ghost" data-action="leave-cancel">Keep editing</button>' +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn btn-danger" data-action="leave-discard">Discard &amp; leave</button>' +
      '<button type="button" class="btn btn-primary" data-action="leave-save">Save changes</button>' +
      '</div></div></div>';
  }

  function topbarHtml() {
    // Desktop section navigation lives persistently at the bottom of the rail.
    // This duplicate action row is mobile-only and is revealed by the hamburger.
    var connectedBadge = isSlackConnected()
      ? '<span class="badge badge-on"><span class="dot"></span>Connected</span>'
      : "";
    // The brand doubles as a home affordance back to the Channels overview.
    return '<header class="topbar">' +
      '<div class="brand"><button type="button" class="brand-home" data-action="go-home" aria-label="Home">' + peaMarkHtml() + '<span class="brand-name">Chickpea</span></button><span class="chip">${targetChip}</span></div>' +
      '<details class="topbar-menu"><summary aria-label="Menu">' + icon("bars-3") + '</summary></details>' +
      '<div class="actions actions-list">' + connectedBadge +
      '<button type="button" class="btn btn-soft' + (primarySection() === "channels" ? " nav-active" : "") + '" data-action="open-channels" data-section-switcher="true">Channels</button>' +
      '<button type="button" class="btn btn-soft' + (primarySection() === "profiles" ? " nav-active" : "") + '" data-action="open-profiles" data-section-switcher="true">Profiles</button>' +
      '<button type="button" class="btn btn-soft' + (primarySection() === "team" ? " nav-active" : "") + '" data-action="open-team" data-section-switcher="true">Team</button>' +
      (USAGE_ADMIN_UI ? '<button type="button" class="btn btn-soft' + (primarySection() === "usage" ? " nav-active" : "") + '" data-action="open-usage" data-section-switcher="true">Usage</button>' : '') +
      '<button type="button" class="btn btn-soft' + (primarySection() === "settings" ? " nav-active" : "") + '" data-action="open-settings" data-section-switcher="true">Settings</button>' +
      '<a class="btn btn-soft" href="/admin/account">Account</a></div>' +
      "</header>";
  }

  function peaMarkHtml() {
    return '<span class="avatar"><svg class="pea" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><circle cx="24" cy="25" r="15.5" fill="#E3AC45"></circle><circle cx="17" cy="17.5" r="4.2" fill="#F4D084"></circle><g class="pea-eyes"><circle class="pea-eye" cx="18.5" cy="24" r="1.9" fill="#3B3220"></circle><circle class="pea-eye" cx="29.5" cy="24" r="1.9" fill="#3B3220"></circle></g><g class="pea-lids"><path d="M16.4 24.2 Q18.5 22 20.6 24.2" fill="none" stroke="#3B3220" stroke-width="1.8" stroke-linecap="round"></path><path d="M27.4 24.2 Q29.5 22 31.6 24.2" fill="none" stroke="#3B3220" stroke-width="1.8" stroke-linecap="round"></path></g><path class="pea-smile" d="M19 29 Q24 32.5 29 29" fill="none" stroke="#3B3220" stroke-width="1.8" stroke-linecap="round"></path><path class="pea-grin" d="M18.5 28.5 Q24 35.5 29.5 28.5 Z" fill="#3B3220"></path><circle class="pea-blush" cx="15.5" cy="28.5" r="2" fill="#DC8A4F"></circle><circle class="pea-blush" cx="32.5" cy="28.5" r="2" fill="#DC8A4F"></circle></svg></span>';
  }

  function primarySection() {
    return state.view === "audit" ? "channels" : state.view;
  }

  function sectionSwitcherHtml() {
    var active = primarySection();
    var sections = [
      { id: "channels", label: "Channels", action: "open-channels" },
      { id: "profiles", label: "Profiles", action: "open-profiles" },
      { id: "team", label: "Team", action: "open-team" }
    ];
    if (USAGE_ADMIN_UI) sections.push({ id: "usage", label: "Usage", action: "open-usage" });
    sections.push({ id: "settings", label: "Settings", action: "open-settings" });
    return '<nav class="section-switcher" aria-label="Admin navigation">' +
      sections.map(function (section) {
        var selected = active === section.id;
        return '<button type="button" class="section-nav-item' + (selected ? " active" : "") + '" data-action="' + section.action + '" data-section-switcher="true"' +
          (selected ? ' aria-current="page"' : '') + '>' + section.label + '</button>';
      }).join("") + '<a class="section-nav-item" href="/admin/account">Account</a></nav>';
  }

  // The connected workspace's display name for a rail group header: the friendly
  // team name for the workspace Chickpea is installed in, else the raw workspace id
  // (multiple workspaces can be grouped; only the connected one has a name).
  function railGroupLabel(workspaceId) {
    if (isSlackConnected() && workspaceId === connectedTeamId() && state.slack.teamName) return state.slack.teamName;
    return workspaceId || "Workspace";
  }

  function railHtml() {
    if (state.view === "onboarding") return onboardingRailHtml();
    if (state.view === "usage") return usageRailHtml();
    if (state.view === "team") return teamRailHtml();
    if (state.view === "profiles") return profilesRailHtml();
    if (state.view === "settings") return settingsRailHtml();
    if (state.view === "audit") return state.auditDomain === "scheduled-work" ? scheduledWorkRailHtml() : auditRailHtml();
    return channelsRailHtml();
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
    var channels = concreteAssignments();
    var groups = [];
    channels.forEach(function (assignment) {
      var group = groups.find(function (candidate) { return candidate.workspaceId === assignment.workspaceId; });
      if (!group) {
        group = { workspaceId: assignment.workspaceId, assignments: [] };
        groups.push(group);
      }
      group.assignments.push(assignment);
    });
    var html = '<nav class="rail" aria-label="Channels"><div class="rail-context">' +
      '<div class="rail-head"><span class="section-eyebrow">Channels</span></div>' +
      '<button type="button" class="platform-row' + (state.view === "channels" && state.channelScreen === "overview" ? " active" : "") + '" data-action="open-channels">' +
      '<span class="platform-logo slack-logo-image" aria-hidden="true"></span>Slack' +
      (isSlackConnected() ? '<span class="platform-status">Connected</span>' : '') + '</button>';
    if (channels.length === 0) {
      html += '<div class="ws-row">' + icon("chevron-down") + esc(railGroupLabel(connectedTeamId())) + '</div>' +
        '<div class="empty" style="margin:8px 0 8px 12px; padding:12px;"><p class="hint" style="margin:0;">No channels yet</p></div>';
    } else {
      groups.forEach(function (group) {
        html += '<div class="ws-row">' + icon("chevron-down") + esc(railGroupLabel(group.workspaceId)) + '</div>';
        group.assignments.forEach(function (assignment) {
          var active = state.channelScreen === "detail" && state.active && state.active.workspaceId === assignment.workspaceId && state.active.channelId === assignment.channelId;
          var railAgent = agentById(assignment.agentId);
          html += '<button type="button" class="chan-item' + (active ? " active" : "") + '" data-action="select-channel" data-workspace="' + esc(assignment.workspaceId) + '" data-channel="' + esc(assignment.channelId) + '">' +
            '<span class="chan-name">' + esc(channelLabel(assignment)) + '</span>' +
            '<span class="chan-meta">' + esc(railAgent ? railAgent.name : assignment.agentId) + '</span></button>';
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
    return '<nav class="rail" aria-label="Usage"><div class="rail-context">' +
      '<div class="rail-head"><span class="section-eyebrow">Usage</span></div>' +
      '<button type="button" class="chan-item active" data-action="open-usage"><span class="chan-name">Overview</span><span class="chan-meta">Spend and usage</span></button>' +
      '</div>' + sectionSwitcherHtml() + '</nav>';
  }

  function teamRailHtml() {
    var members = state.team && state.team.members ? state.team.members : [];
    var invitations = state.team && state.team.invitations ? state.team.invitations : [];
    var pending = invitations.filter(function (invitation) {
      return invitation.status === "pending" && Number(invitation.expiresAt) > Date.now();
    });
    return '<nav class="rail" aria-label="Team"><div class="rail-context">' +
      '<div class="rail-head"><span class="section-eyebrow">Team</span></div>' +
      '<button type="button" class="chan-item active" data-action="open-team" aria-current="page"><span class="chan-name">Members</span><span class="chan-meta">' + members.length + ' member' + (members.length === 1 ? '' : 's') + '</span></button>' +
      '<div class="ws-row">Join links</div>' +
      '<div class="empty" style="margin:8px; padding:12px;"><p class="hint" style="margin:0;">' + (pending.length ? pending.length + ' pending' : 'No pending links') + '</p></div>' +
      '</div>' + sectionSwitcherHtml() + '</nav>';
  }

  function teamMainHtml() {
    var team = state.team;
    if (state.teamLoading && !team) {
      return '<div class="empty"><h1 class="page-title">Loading your team&hellip;</h1><p class="hint">Reading Chickpea memberships and invitations.</p></div>';
    }
    if (!team) {
      return '<div class="empty"><h1 class="page-title">Team is unavailable</h1><p class="error">' + esc(state.teamError || "Could not load team access.") + '</p><button type="button" class="btn btn-soft" data-action="team-retry">Retry</button></div>';
    }
    var members = team.members || [];
    var invitations = team.invitations || [];
    var pending = invitations.filter(function (invitation) {
      return invitation.status === "pending" && Number(invitation.expiresAt) > Date.now();
    });
    var notice = state.teamError
      ? '<p class="error" role="alert">' + esc(state.teamError) + '</p>'
      : (state.teamNotice ? '<p class="hint" role="status">' + esc(state.teamNotice) + '</p>' : '');
    var createdFlash = state.teamInviteLink && state.teamInviteEmail
      ? (state.teamInviteManualCopy
        ? '<div class="team-show-once" role="status"><label for="team-invite-link">Copy this teammate join link manually</label><p class="hint">Clipboard access was denied. Select the full link below, then copy and share it privately.</p><div class="team-link-row"><input class="input mono" id="team-invite-link" readonly value="' + esc(state.teamInviteLink) + '"><button type="button" class="btn btn-primary btn-sm" data-action="team-copy-link">Copy link</button></div></div>'
        : '<div class="team-created-flash" role="status"><div><strong>Join link ready for</strong><span>' + esc(state.teamInviteEmail) + '</span></div><button type="button" class="btn btn-primary btn-sm" data-action="team-copy-link">' + (state.teamInviteCopied ? 'Copied' : 'Copy link') + '</button></div>')
      : '';
    var resetOnce = state.teamResetLink
      ? '<div class="team-show-once" role="status"><label for="team-reset-link">Copy this password reset link now</label><p class="hint">Send it privately to the named teammate. It expires quickly and cannot be shown again after you leave or refresh.</p><div class="team-link-row"><input class="input mono" id="team-reset-link" readonly value="' + esc(state.teamResetLink) + '"><button type="button" class="btn btn-primary btn-sm" data-action="team-copy-reset">Copy link</button><button type="button" class="btn btn-ghost btn-sm" data-action="team-dismiss-reset">Done</button></div></div>'
      : '';
    return '<div class="team-hero"><div><p class="section-eyebrow">People &amp; access</p><h1 class="page-title">Your team</h1><p class="hint">Everyone you invite can administer this Chickpea workspace. The person who created it remains the owner.</p></div><span class="team-count">' + members.length + ' member' + (members.length === 1 ? '' : 's') + '</span></div>' +
      notice +
      '<section class="team-card" aria-labelledby="invite-heading"><h2 id="invite-heading">Create a teammate join link</h2><p class="hint">Chickpea does not send email. Enter the exact email address, then copy and share the private link yourself.</p><form class="team-form" data-action="team-invite-form"><label class="field-label" for="team-invite-email">Email</label><div class="team-form-row"><input class="input" id="team-invite-email" name="email" data-action="team-invite-email" type="email" autocomplete="email" required placeholder="teammate@example.com" value="' + esc(state.teamInviteDraft.email) + '"><button type="submit" class="btn btn-primary"' + (state.teamBusy ? ' disabled' : '') + '>Create link</button></div></form>' + createdFlash + '</section>' +
      resetOnce + '<section class="team-card" aria-labelledby="members-heading"><h2 id="members-heading">Members</h2><p class="hint">Suspension takes effect on the next Chickpea request, even if the signed-in browser stays open.</p><div class="team-list">' + (members.length ? members.map(teamMemberRowHtml).join("") : '<p class="team-empty">No memberships yet.</p>') + '</div></section>' +
      '<section class="team-card" aria-labelledby="invitations-heading"><h2 id="invitations-heading">Pending join links</h2><p class="hint">Each teammate has one private link. Copy it whenever needed, or revoke it to stop access.</p><div class="team-list">' + (pending.length ? pending.map(teamInvitationRowHtml).join("") : '<p class="team-empty">No pending join links.</p>') + '</div></section>';
  }

  function teamMemberRowHtml(member) {
    var viewer = state.team && state.team.viewer ? state.team.viewer : { role: "admin", membershipId: "" };
    var canManageOwner = viewer.role === "owner";
    var busy = state.teamBusy === "member:" + member.id;
    var statusSelect = member.role === "owner" ? '' : '<span class="select-wrap team-status-control"><select class="input" name="membership-status-' + esc(member.id) + '" aria-label="Status for ' + esc(member.email || "member") + '" data-action="team-member-status" data-membership="' + esc(member.id) + '"' + (busy ? ' disabled' : '') + '>' + ["active", "suspended"].map(function (status) {
      return '<option value="' + status + '"' + (member.status === status ? ' selected' : '') + '>' + status.charAt(0).toUpperCase() + status.slice(1) + '</option>';
    }).join("") + '</select>' + icon("chevron-down", "select-caret") + '</span>';
    var resetButton = '<button type="button" class="btn btn-soft btn-sm" data-action="team-reset-password" data-membership="' + esc(member.id) + '"' + (busy || (member.role === "owner" && !canManageOwner) ? ' disabled' : '') + '>Reset password</button>';
    var removeButton = member.role === "owner" ? '' : '<button type="button" class="btn btn-danger btn-sm" data-action="team-remove-open" data-membership="' + esc(member.id) + '"' + (busy ? ' disabled' : '') + '>Remove</button>';
    var ownerMarker = member.role === "owner" ? '<span class="team-status owner">Owner</span>' : '';
    return '<article class="team-row"><div class="team-row-main"><div class="team-row-title">' + esc(member.displayName || member.email || "Teammate") + (viewer.membershipId === member.id ? ' <span class="hint">(you)</span>' : '') + '</div><div class="team-row-sub">' + esc(member.email || "No email") + '</div><div class="team-statuses">' + ownerMarker + '<span class="team-status ' + (member.status === "active" ? "active" : member.status === "suspended" ? "suspended" : "") + '">' + esc(member.status) + '</span></div></div><div class="team-row-actions">' + statusSelect + resetButton + removeButton + '</div></article>';
  }

  function teamRemoveModalHtml() {
    var confirmation = state.teamRemoveConfirm;
    if (!confirmation) return "";
    var label = confirmation.displayName || confirmation.email || "this teammate";
    return '<div class="modal-backdrop"><div class="modal-card" role="dialog" aria-modal="true" aria-label="Remove teammate">' +
      '<h2 class="modal-title">Remove ' + esc(label) + '?</h2>' +
      '<p class="modal-body">They will immediately lose access to this Chickpea workspace. Their membership is deleted and cannot be restored from this screen; invite them again to give access back.</p>' +
      '<div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="team-remove-cancel">Keep teammate</button><span class="spacer"></span><button type="button" class="btn btn-danger" data-action="team-remove-confirm">Remove teammate</button></div></div></div>';
  }

  function teamInvitationRowHtml(invitation) {
    var busy = state.teamBusy === "invite:" + invitation.id;
    var copyAction = invitation.inviteLink
      ? '<button type="button" class="btn btn-soft btn-sm" data-action="team-copy-invitation" data-link="' + esc(invitation.inviteLink) + '"' + (busy ? ' disabled' : '') + '>Copy link</button>'
      : '';
    var actions = copyAction + '<button type="button" class="btn btn-danger btn-sm" data-action="team-revoke" data-invitation="' + esc(invitation.id) + '"' + (busy ? ' disabled' : '') + '>Revoke</button>';
    var guidance = invitation.inviteLink
      ? ''
      : '<div class="team-row-sub">This link was created with older deployment credentials and cannot be displayed. Revoke it before creating a replacement.</div>';
    return '<article class="team-row"><div class="team-row-main"><div class="team-row-title">' + esc(invitation.email) + '</div><div class="team-row-sub">Expires ' + esc(new Date(invitation.expiresAt).toLocaleString()) + '</div><div class="team-statuses"><span class="team-status">Waiting to join</span></div>' + guidance + '</div><div class="team-row-actions">' + actions + '</div></article>';
  }

  function profilesRailHtml() {
    var html = '<nav class="rail" aria-label="Profiles"><div class="rail-context">' +
      '<div class="rail-head"><span class="section-eyebrow">Profiles</span></div>' +
      '<button type="button" class="rail-add' + (state.profileScreen === "create" ? " active" : "") + '" data-action="new-profile">' + icon("plus") + 'New profile</button>' +
      '<div class="ws-row">Your profiles</div>';
    if (!state.agents.length) {
      html += '<div class="empty" style="margin:8px; padding:12px;"><p class="hint">No profiles yet</p></div>';
    } else {
      state.agents.forEach(function (agent) {
        var active = state.profileScreen === "edit" && state.editingAgentId === agent.id;
        var meta = (agent.model || "No model pinned") + " · " + (agent.enabled ? "Enabled" : "Disabled");
        html += '<button type="button" class="chan-item' + (active ? " active" : "") + '" data-action="edit-profile" data-agent="' + esc(agent.id) + '">' +
          '<span class="chan-name">' + esc(agent.name) + '</span><span class="chan-meta">' + esc(meta) + '</span></button>';
      });
    }
    return html + '</div>' + sectionSwitcherHtml() + '</nav>';
  }

  function settingsRailHtml() {
    var sections = [
      { id: "slack", name: "Slack", meta: "Identities" },
      { id: "providers", name: "Model providers", meta: "Keys and models" },
      { id: "github", name: "GitHub", meta: "Accounts and access" },
      { id: "sandbox", name: "Coding sandbox", meta: "Workspace runtime" },
      { id: "outbound", name: "Outbound access", meta: "Network policy" }
    ];
    var html = '<nav class="rail" aria-label="Settings"><div class="rail-context">' +
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
    if (["channel", "profile", "provider", "model"].includes(group)) state.usageGroupBy = group;
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
    var entering = state.view !== "team";
    state.view = "team";
    state.profileScreen = "list";
    state.disableConfirm = false;
    state.teamError = "";
    state.teamNotice = "";
    if (entering) {
      state.teamInviteLink = "";
      state.teamInviteEmail = "";
      state.teamInviteCopied = false;
      state.teamInviteManualCopy = false;
      state.teamInviteCopyVersion += 1;
      state.teamResetLink = "";
    }
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

  function finishTeamMutation(message, result) {
    if (result && result.inviteLink) state.teamInviteLink = result.inviteLink;
    if (result && result.resetLink) state.teamResetLink = result.resetLink;
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

  function createTeamInvitation() {
    if (state.teamBusy) return;
    var email = String(state.teamInviteDraft.email || "").trim();
    if (!email || email.indexOf("@") < 1) {
      state.teamError = "Enter a valid teammate email.";
      render();
      return;
    }
    state.teamBusy = "invite:create";
    state.teamError = "";
    state.teamNotice = "";
    state.teamInviteLink = "";
    state.teamInviteEmail = "";
    state.teamInviteCopied = false;
    state.teamInviteManualCopy = false;
    state.teamInviteCopyVersion += 1;
    render();
    postJson("/admin/api/team/invitations", "POST", { email: email }).then(function (result) {
      state.teamInviteDraft.email = "";
      state.teamInviteEmail = result && result.invitation && result.invitation.email ? result.invitation.email : email;
      return finishTeamMutation("", result);
    }).catch(failTeamMutation);
  }

  function revokeTeamInvitation(invitationId) {
    if (state.teamBusy || !invitationId) return;
    state.teamBusy = "invite:" + invitationId;
    state.teamError = "";
    state.teamNotice = "";
    state.teamInviteLink = "";
    state.teamInviteEmail = "";
    state.teamInviteCopied = false;
    state.teamInviteManualCopy = false;
    state.teamInviteCopyVersion += 1;
    render();
    var path = "/admin/api/team/invitations/" + encodeURIComponent(invitationId);
    api(path, { method: "DELETE" })
      .then(function (result) { return finishTeamMutation("Join link revoked.", result); })
      .catch(failTeamMutation);
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
      .then(function () { return finishTeamMutation("Membership updated.", null); })
      .catch(failTeamMutation);
  }

  function createTeamPasswordReset(membershipId) {
    if (state.teamBusy || !membershipId) return;
    state.teamBusy = "member:" + membershipId;
    state.teamError = "";
    state.teamNotice = "";
    state.teamResetLink = "";
    render();
    postJson("/admin/api/team/memberships/" + encodeURIComponent(membershipId) + "/reset", "POST", {})
      .then(function (result) { return finishTeamMutation("Password reset created. Copy the private link and send it to the teammate.", result); })
      .catch(failTeamMutation);
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

  function usageTokenTotalHtml(input, output, total) {
    var totalLabel = usageInt(total);
    if (input == null && output == null) return totalLabel;
    var split = usageInt(input) + " input · " + usageInt(output) + " output";
    return '<span class="usage-token-total" tabindex="0" data-tooltip="' + esc(split) + '" aria-label="' + esc(totalLabel + " total tokens; " + split) + '">' + totalLabel + '</span>';
  }

  function usageGroupsHtml(summary) {
    var groups = summary.groups || [];
    if (!groups.length) return '<div class="empty"><p class="hint">No breakdown data for this period.</p></div>';
    var rows = groups.map(function (group) {
      var label = group.label || (state.usageGroupBy === "channel" && group.key === "direct_message" ? "Direct message" : group.key) || "Unknown";
      label = state.usageGroupBy === "channel" && label !== "Direct message" && !String(label).startsWith("#") ? "#" + label : label;
      return '<tr><td><button type="button" class="usage-row-action" data-action="usage-group-filter" data-value="' + esc(group.key) + '" data-label="' + esc(label) + '">' + esc(label) + '</button></td>' +
        '<td class="number">' + usageInt(group.operationCount) + '</td><td class="number">' + usageInt(group.inputTokens) + '</td>' +
        '<td class="number">' + usageInt(group.outputTokens) + '</td><td class="number">' + usageInt(group.totalTokens) + '</td>' +
        '<td class="number">' + usageMoney(group.estimateAmountMicros, summary.currency) + '</td></tr>';
    }).join("");
    return '<div class="usage-table-wrap"><table class="usage-table"><thead><tr><th>' + esc(state.usageGroupBy.replace(/_/g, " ")) + '</th><th class="number">' + usageActivityLabelHtml("Activity") + '</th><th class="number">Input tokens</th><th class="number">Output tokens</th><th class="number">Total tokens</th><th class="number">Spend</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function usageOperationsHtml() {
    if (!state.usageOperations) return '<div class="empty"><p class="hint">Loading activity&hellip;</p></div>';
    if (!state.usageOperations.length) return '<div class="empty"><p class="hint">No activity matches this period' + (state.usageOperationFilter ? ' and filter' : '') + '.</p></div>';
    var rows = state.usageOperations.map(function (detail) {
      var operation = detail.operation;
      var input = usageOperationTokens(detail, "inputTokens");
      var output = usageOperationTokens(detail, "outputTokens");
      var total = usageOperationTokens(detail, "totalTokens");
      return '<tr><td><strong class="usage-work-label">' + esc(usageWorkLabel(operation)) + '</strong><div class="hint">' + esc(new Date(operation.startedAt).toLocaleString()) + '</div></td>' +
        '<td>' + esc(operation.profileLabel || operation.profileId || "Unknown") + '</td><td>' + esc(usageOperationProvider(detail)) + '</td><td>' + esc(usageOperationModel(detail)) + '</td>' +
        '<td>' + usageStatusBadge(operation.status) + '</td><td class="number">' + usageTokenTotalHtml(input, output, total) + '</td><td class="number">' + usageMoney(usageOperationAmount(detail), "USD") + '</td></tr>';
    }).join("");
    return '<div class="usage-table-wrap"><table class="usage-table"><thead><tr><th>Channel or routine</th><th>Profile</th><th>Provider</th><th>Model</th><th>Status</th><th class="number">Tokens</th><th class="number">Spend</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (state.usageNextCursor ? '<button type="button" class="btn btn-ghost" data-action="usage-load-more"' + (state.usageLoadingMore ? ' disabled' : '') + '>' + (state.usageLoadingMore ? 'Loading&hellip;' : 'Load more') + '</button>' : '');
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
      [["channel", "Channel"], ["profile", "Profile"], ["provider", "Provider"], ["model", "Model"]].map(function (option) { return '<option value="' + option[0] + '"' + (state.usageGroupBy === option[0] ? ' selected' : '') + '>' + option[1] + '</option>'; }).join("") +
      '</select><span class="select-caret">' + icon("chevron-down") + '</span></span></label>' + customControls + '</div></div>';
    var head = '<div class="usage-head"><div class="usage-head-copy"><span class="section-eyebrow">Reporting</span><h1 class="page-title">Usage</h1><p class="hint">See token usage and spend across channels, profiles, providers, and recent activity.</p></div></div>' + controls +
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
      '<div class="usage-card"><span class="usage-card-label">Tokens</span><span class="usage-card-value">' + usageInt(totals.totalTokens) + '</span><span class="hint">' + usageInt(totals.inputTokens) + ' input · ' + usageInt(totals.outputTokens) + ' output</span></div>' +
      '<div class="usage-card"><span class="usage-card-label">Average spend</span><span class="usage-card-value">' + esc(perPriced) + '</span><span class="hint">Across ' + usageInt(denominator) + ' priced ' + usageActivityNoun(denominator) + '</span></div></div>';
    var coverage = usageCoverageHtml(totals);
    var staleCatalogs = (state.usageMetadata.catalogs || []).filter(function (catalog) { return Date.now() >= catalog.staleAfter; });
    var freshness = staleCatalogs.length ? '<p class="field-error">Spend estimates need a pricing update for ' + staleCatalogs.length + ' provider' + (staleCatalogs.length === 1 ? '' : 's') + '.</p>' : '';
    var filter = state.usageOperationFilter ? '<span class="usage-filter-chip">Recent activity: ' + esc(state.usageOperationFilter.label) + ' <button type="button" class="x-btn" data-action="usage-clear-filter" aria-label="Clear activity filter">&times;</button></span>' : '';
    var groupLabel = state.usageGroupBy === "channel" ? "channel" : state.usageGroupBy;
    return head + summary + coverage + freshness +
      '<section class="usage-section"><div class="usage-section-head"><div><h2 class="section-title">Spend by ' + esc(groupLabel) + '</h2><p class="hint">Compare where token usage and spend are concentrated.</p></div></div>' + usageGroupsHtml(current) + '</section>' +
      '<section class="usage-section"><div class="usage-section-head"><div><h2 class="section-title">Recent ' + usageActivityLabelHtml("activity") + '</h2><p class="hint">Hover over total tokens to see the input and output split.</p></div>' + filter + '</div>' + usageOperationsHtml() + '</section>';
  }

  function isOnboardingSlackConnection() {
    return state.view === "onboarding" && state.onboarding && state.onboarding.stage === "connect_slack";
  }

  function onboardingSlackPermissionUrl(value) {
    try {
      var url = new URL(String(value || ""));
      var pathParts = url.pathname.split("/").filter(Boolean);
      var appSpecific = pathParts.length === 3 && pathParts[0] === "apps" && /^[A-Z0-9]+$/.test(pathParts[1]) && pathParts[2] === "oauth";
      var appList = pathParts.length === 1 && pathParts[0] === "apps";
      if (url.protocol !== "https:" || url.hostname !== "api.slack.com" || url.username || url.password || (!appSpecific && !appList)) return "";
      var safePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
      return "https://api.slack.com" + safePath;
    } catch (_) {
      return "";
    }
  }

  function onboardingSlackCredentialInputs(readonly) {
    var locked = readonly ? ' readonly aria-readonly="true"' : "";
    var secureAttrs = ' type="password" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false"';
    return '<div class="field"><label class="field-label" for="onboarding-signing-secret">Signing secret</label>' +
      '<input class="input mono" id="onboarding-signing-secret" name="signingSecret"' + secureAttrs + ' data-action="slack-signing-secret"' + locked + '></div>' +
      '<div class="field"><label class="field-label" for="onboarding-bot-token">Bot User OAuth Token</label>' +
      '<input class="input mono" id="onboarding-bot-token" name="botToken"' + secureAttrs + ' data-action="slack-bot-token" placeholder="xoxb-&hellip;"' + locked + '>' +
      '<p class="hint">These values stay in this tab until Slack is connected. The Signing Secret is accepted only after Slack&rsquo;s signed check matches this app.</p></div>';
  }

  function onboardingSlackContinuationHtml() {
    var continuation = state.slackOnboardingContinuation;
    var phase = continuation.phase || "finish";
    var permissionUrl = onboardingSlackPermissionUrl(continuation.consoleUrl) || "https://api.slack.com/apps";
    var appListFallback = permissionUrl === "https://api.slack.com/apps";
    var fallback = appListFallback
      ? '<div class="advanced-note"><p class="hint">In Slack, open the Chickpea app, choose OAuth &amp; Permissions, then choose Install to Workspace or Reinstall to Workspace. Return to this tab when Slack is done.</p></div>'
      : '<p class="hint">Slack will open Chickpea&rsquo;s permissions page in a new tab.</p>';
    var status = continuation.note
      ? '<p class="onboarding-status" role="status" aria-live="polite">' + esc(continuation.note) + '</p>'
      : '<p class="onboarding-status" role="status" aria-live="polite">Your details are ready for the next check.</p>';
    var action = phase === "finish"
      ? '<a class="btn btn-primary" href="' + esc(permissionUrl) + '" target="_blank" rel="noopener noreferrer" data-action="slack-permissions-open">Continue in Slack <span class="sr-only">(opens in a new tab)</span></a>'
      : '<button type="button" class="btn btn-primary" data-action="slack-permissions-check"' + (phase === "checking" ? " disabled" : "") + '>' +
        (phase === "checking" ? '<span class="spinner"></span>Checking&hellip;' : 'Check again') + '</button>';
    var title = phase === "finish" ? "Finish applying Slack permissions" : "Return here after Slack is done";
    var lede = phase === "finish"
      ? "Slack has one more access step for Chickpea. Continue there, then return to this tab."
      : "When Slack finishes, check the same details again. You do not need to paste them a second time.";
    return '<section class="onboarding-panel"><p class="onboarding-eyebrow">Step 1 of 3</p>' +
      '<h1 class="onboarding-title" id="slack-permission-heading" tabindex="-1">' + title + '</h1>' +
      '<p class="onboarding-lede">' + lede + '</p>' + status +
      '<div class="onboarding-form">' + onboardingSlackCredentialInputs(true) + '</div>' + fallback +
      '<div class="onboarding-actions">' + action +
      '<button type="button" class="btn btn-ghost" data-action="slack-permissions-start-over"' + (phase === "checking" ? " disabled" : "") + '>Start over</button></div></section>';
  }

  function onboardingConnectHtml() {
    var conn = state.slack;
    if (!conn) return '<section class="onboarding-panel"><p class="onboarding-eyebrow">Step 1 of 3</p><h1 class="onboarding-title">Loading Slack setup&hellip;</h1></section>';
    if (state.slackStep < 2) {
      return '<section class="onboarding-panel"><p class="onboarding-eyebrow">Step 1 of 3</p>' +
        '<h1 class="onboarding-title">Connect @Chickpea</h1>' +
        '<p class="onboarding-lede">Create Chickpea in the Slack workspace where your team works.</p>' +
        '<div class="onboarding-actions"><a class="btn btn-primary" href="' + esc(conn.manifestUrl) + '" target="_blank" rel="noopener noreferrer" data-action="advance-slack-step">' +
        '<span class="onboarding-slack-logo slack-logo-image" aria-hidden="true"></span>Create @Chickpea in Slack</a></div></section>';
    }
    if (state.slackStep === 2) {
      return '<section class="onboarding-panel"><p class="onboarding-eyebrow">Step 1 of 3</p>' +
        '<h1 class="onboarding-title">Return here after Slack shows Chickpea</h1>' +
        '<p class="onboarding-lede">Slack should open a manifest for an app named Chickpea. If signing in drops you on AI Agent, Blank app, or the app list, close that dialog and open Chickpea setup again from here.</p>' +
        '<div class="onboarding-actions"><button type="button" class="btn btn-primary" data-action="slack-app-created">I created the Chickpea app</button>' +
        '<a class="btn btn-soft" href="' + esc(conn.manifestUrl) + '" target="_blank" rel="noopener noreferrer"><span class="onboarding-slack-logo slack-logo-image" aria-hidden="true"></span>Open Chickpea setup in Slack</a></div>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="back-to-slack-create">Back</button></section>';
    }
    if (state.slackOnboardingContinuation) return onboardingSlackContinuationHtml();
    var submit = state.slackBusy
      ? '<button type="submit" class="btn btn-primary" disabled><span class="spinner"></span>Connecting&hellip;</button>'
      : '<button type="submit" class="btn btn-primary">Validate and connect</button>';
    var errorHtml = state.slackError
      ? '<div class="onboarding-error" role="alert" aria-live="assertive" tabindex="-1" data-role="slack-connection-error"><p class="field-error">' + esc(state.slackError) + '</p></div>'
      : '';
    return '<section class="onboarding-panel">' +
      '<div class="onboarding-return-note"><span class="onboarding-return-icon" aria-hidden="true">&rarr;</span><span><strong>Install Chickpea in Slack, then return here.</strong><br>If Slack asked you to sign in, reopen the setup link. In OAuth &amp; Permissions, click Install to Workspace or Reinstall to Workspace before copying the token.</span></div>' +
      '<p class="onboarding-eyebrow">Step 1 of 3</p><h1 class="onboarding-title">Finish connecting Slack</h1>' +
      '<p class="onboarding-lede">Install the app in Slack, then paste the two values Slack gives you. Chickpea checks the workspace, permissions, and channel access before continuing.</p>' +
      '<div class="onboarding-actions"><a class="btn btn-soft" href="' + esc(conn.manifestUrl) + '" target="_blank" rel="noopener noreferrer"><span class="onboarding-slack-logo slack-logo-image" aria-hidden="true"></span>Open Slack setup again</a></div>' +
      '<form class="onboarding-form" data-action="slack-connect-form">' +
      onboardingSlackCredentialInputs(false) +
      errorHtml + '<div class="onboarding-form-actions"><button type="button" class="btn btn-ghost" data-action="back-to-slack-create">Back</button>' + submit + '</div></form>' +
      '<details class="advanced"><summary>Where do I find these?</summary><div class="adv-rows"><p class="hint">The signing secret is under Basic Information &rarr; App Credentials. Install the app from OAuth &amp; Permissions, then copy its xoxb- Bot User OAuth Token.</p></div></details>' +
      '</section>';
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
    return '<section class="onboarding-panel onboarding-panel-wide"><div class="onboarding-success"><span class="onboarding-success-icon" aria-hidden="true">&#10003;</span><div>' +
      '<p class="onboarding-eyebrow">Step 3 of 3</p><h1 class="onboarding-title">' + (complete ? 'Chickpea is ready in #' + esc(channel.name) : 'Try Chickpea in #' + esc(channel.name)) + '</h1>' +
      '<p class="onboarding-lede">' + (complete ? 'Chickpea replied successfully. Your setup is working.' : 'Open the channel and try one useful request. Your first reply confirms that everything is working.') + '</p></div></div>' +
      '<div class="onboarding-prompt-box"><p class="onboarding-prompt-label">Suggested first message</p><p class="onboarding-prompt">' + esc(ONBOARDING_PROMPT) + '</p>' +
      '<input id="onboarding-prompt" type="text" hidden readonly value="' + esc(ONBOARDING_PROMPT) + '">' +
      '<p class="onboarding-status" role="status">' + esc(state.onboardingNotice || (!complete ? 'Waiting for Chickpea to reply&hellip;' : 'Reply confirmed.')) + '</p></div>' +
      (state.onboardingError ? '<div class="onboarding-actions"><span class="field-error" role="alert">' + esc(state.onboardingError) + '</span><button type="button" class="btn btn-soft" data-action="retry-onboarding">Check again</button></div>' : '') +
      '<div class="onboarding-actions"><a class="btn btn-primary" href="' + esc(deepLink) + '" target="_blank" rel="noopener noreferrer">Open #' + esc(channel.name) + ' in Slack</a>' +
      '<button type="button" class="btn btn-soft" data-action="copy-onboarding-prompt">Copy message</button>' +
      (complete ? '<button type="button" class="btn btn-ghost" data-action="open-channels">Go to Channels</button>' : '') + '</div></section>';
  }

  function onboardingMainHtml() {
    if (state.onboardingError && !state.onboarding) {
      return '<section class="onboarding-panel"><p class="onboarding-eyebrow">Setup</p><h1 class="onboarding-title">Setup could not load</h1><p class="field-error">' + esc(state.onboardingError) + '</p><div class="onboarding-actions"><button type="button" class="btn btn-soft" data-action="retry-onboarding">Try again</button></div></section>';
    }
    if (!state.onboarding) return '<section class="onboarding-panel"><p class="onboarding-eyebrow">Setup</p><h1 class="onboarding-title">Loading setup&hellip;</h1></section>';
    if (state.onboarding.stage === "connect_slack") return onboardingConnectHtml();
    if (state.onboarding.stage === "choose_channel") return onboardingChooseChannelHtml();
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
    var labels = ["Connect Slack", "Choose a channel", "Try Chickpea"];
    return '<ol class="onboarding-orientation" role="list" aria-label="Onboarding progress">' + labels.map(function (label, index) {
      var step = index + 1;
      var className = step < current ? "complete" : step === current ? "active" : "";
      return '<li class="' + className + '"' + (step === current ? ' aria-current="step"' : '') + '><span class="onboarding-step-dot">' + (step < current ? '&#10003;' : step) + '</span><span class="onboarding-step-label">' + esc(label) + '</span></li>';
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
      return '<main class="main"><div class="main-inner audit-main">' + (state.auditDomain === "scheduled-work" ? scheduledWorkMainHtml() : auditMemoryMainHtml()) + '</div></main>';
    }
    if (state.channelScreen === "overview") {
      return '<main class="main"><div class="main-inner slack-overview">' + slackOverviewHtml() + '</div></main>';
    }
    // Not connected → the main panel is ONLY the Connect stepper. Nothing can
    // answer until there are live wire credentials, so no channel chrome shows.
    if (state.slack && !state.slack.connected) {
      return '<main class="main"><div class="main-inner">' + slackStepperHtml() + '</div></main>';
    }
    var assignment = activeAssignment();
    var connected = isSlackConnected();
    // Connected: credential provenance is demoted to a collapsed disclosure at
    // the very bottom so it never competes with the funnel or the channel page.
    var slackBottom = connected ? connectionDetailsHtml() : "";
    var addPanel = addChannelPanelHtml();
    var invite = inviteReminderHtml();
    if (!assignment) {
      if (connected) {
        // Connected + zero channels: the funnel is the single focus of the
        // screen — replaced by the picker when the operator opens it.
        var body = state.addChannelOpen ? addPanel : (successToastHtml() + funnelHtml());
        return '<main class="main"><div class="main-inner">' + invite + body + slackBottom + '</div></main>';
      }
      // Transient null connection (a failed connection fetch): keep a minimal,
      // non-blocking empty so the rest of the admin still renders.
      var emptyBlock = state.addChannelOpen ? "" : '<div class="empty">' +
        '<h1 class="page-title">No channels yet &mdash; add one</h1>' +
        '<p class="hint">Pick a Slack channel and attach a profile. Mentions guarantee a response; Chickpea may also join useful unmentioned conversation.</p>' +
        addChannelButtonHtml("btn btn-soft") +
        '</div>';
      return '<main class="main"><div class="main-inner">' + invite + addPanel + emptyBlock + '</div></main>';
    }
    var agent = agentById(assignment.agentId);
    var enabled = state.channelDraft.enabled;
    return '<main class="main"><div class="main-inner">' + invite + addPanel +
      '<div class="main-head"><div style="display:flex; flex-direction:column; gap:2px;">' +
      '<h1 class="page-title mono-title">' + esc(channelLabel(assignment)) + '</h1>' +
      '<p class="hint">What Chickpea can do in this channel. Mentions guarantee a response; ambient participation follows the setting below. New threads reply as ' + esc(slackIdentityMentionForId(state.effective && state.effective.slackIdentityId)) + '.</p>' +
      '</div><label style="display:flex; align-items:center; gap:10px;"><span class="hint">' + (enabled ? "Enabled" : "Disabled") + '</span>' +
      '<span class="toggle"><span class="thumb"></span><input type="checkbox" data-action="channel-enabled" ' + (enabled ? "checked" : "") + ' aria-label="Channel enabled"></span></label></div>' +
      profileSectionHtml(agent, assignment) +
      channelInstructionsHtml() +
      channelAuditSectionHtml(assignment) +
      accessSummaryHtml() +
      advancedHtml(assignment) +
      saveBarHtml() +
      slackBottom +
      '</div></main>';
  }

  // ---- Channels > Slack overview ------------------------------------------

  function slackConnectionMutable() {
    var credentials = state.slack && state.slack.credentials;
    return !!credentials && credentials.botToken === "stored" && credentials.signingSecret === "stored";
  }

  function connectedAssignmentCount() {
    var teamId = connectedTeamId();
    var channels = concreteAssignments();
    return teamId
      ? channels.filter(function (assignment) { return assignment.workspaceId === teamId; }).length
      : channels.length;
  }

  function slackCredentialSummary() {
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
      slackBehaviorRowHtml("allowDms", "Allow direct messages", "Chickpea answers Slack DMs with the install\'s Default profile and provider budget.") +
      slackBehaviorRowHtml("unassignedHint", "Help people configure unassigned channels", "When someone mentions " + slackMentionText() + " in an unassigned channel, Chickpea privately shares setup steps.") +
      slackBehaviorRowHtml("welcomeOnJoin", "Post a welcome when " + slackMentionText() + " joins an assigned channel", "Chickpea starts the conversation with a short welcome message.") +
      slackBehaviorRowHtml("ambientParticipation", "Allow ambient participation", "Chickpea may selectively respond to useful unmentioned messages in assigned channels. Turn this off for an installation-wide mention-only rollback.") +
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

  function slackUpdateCredentialsHtml() {
    if (!state.slackUpdateOpen) return "";
    var saveButton = state.slackBusy
      ? '<button type="submit" class="btn btn-primary" disabled><span class="spinner"></span>Validating&hellip;</button>'
      : '<button type="submit" class="btn btn-primary">Validate &amp; update</button>';
    return '<div class="empty" style="gap:14px;">' +
      '<div class="section-head"><div><p class="field-label">Update Slack credentials</p>' +
      '<p class="hint">Rotate this workspace&rsquo;s credentials, or switch to another workspace. Existing profiles and channel mappings stay saved.</p></div>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="slack-update-close"' + (state.slackConnectionBusy ? " disabled" : "") + '>Cancel</button></div>' +
      '<form data-action="slack-connect-form" style="display:flex; flex-direction:column; gap:12px;">' +
      '<div class="form-grid"><div class="field"><label class="field-label" for="slack-update-bot-token">Bot User OAuth Token</label>' +
      '<input id="slack-update-bot-token" class="input mono" name="botToken" type="password" autocomplete="off" placeholder="xoxb-&hellip;" value="' + esc(state.slackDraft.botToken) + '" data-action="slack-bot-token"' + (state.slackConnectionBusy ? " disabled" : "") + '></div>' +
      '<div class="field"><label class="field-label" for="slack-update-signing-secret">Signing Secret</label>' +
      '<input id="slack-update-signing-secret" class="input mono" name="signingSecret" type="password" autocomplete="off" placeholder="Signing secret" value="' + esc(state.slackDraft.signingSecret) + '" data-action="slack-signing-secret"' + (state.slackConnectionBusy ? " disabled" : "") + '></div></div>' +
      '<div class="save-bar" style="justify-content:flex-start;">' + saveButton +
      (state.slackError ? '<span class="field-error" role="alert" aria-live="assertive" tabindex="-1" data-role="slack-connection-error">' + esc(state.slackError) + '</span>' : "") + '</div></form></div>';
  }

  function slackIdentityHtml() {
    var identities = state.slackIdentities.identities || [];
    var base = identities.find(function (identity) { return identity.kind === "workspace_default"; });
    var dedicatedCount = identities.filter(function (identity) { return identity.kind === "dedicated" && identity.lifecycle !== "retired"; }).length;
    return '<section class="section"><div class="section-head"><div><h2 class="section-title">Slack identities</h2>' +
      '<p class="hint">The workspace starts with ' + esc(base ? "@" + (base.displayName || "Chickpea") : "@Chickpea") + ' and needs no additional setup. Add dedicated native identities only when distinct mentions, avatars, or DM conversations are useful.</p></div>' +
      '<button type="button" class="btn btn-soft btn-sm" data-action="open-settings" data-section="slack">Manage identities</button></div>' +
      (dedicatedCount ? '<p class="hint">' + esc(dedicatedCount + " active dedicated identit" + (dedicatedCount === 1 ? "y" : "ies")) + '</p>' : '') + '</section>';
  }

  function slackOverviewHtml() {
    var head = '<div class="slack-head"><span class="slack-logo-large slack-logo-image" role="img" aria-label="Slack"></span>' +
      '<div><h1 class="page-title" style="font-size:1.75rem;">Slack</h1><p class="hint">Manage where Chickpea answers in Slack.</p></div></div>';
    if (!state.slack) {
      return head + '<div class="empty"><p class="field-label">Slack settings are unavailable</p><p class="hint">Reload the page to try the connection again.</p></div>';
    }
    if (!isSlackConnected()) {
      return head + slackStepperHtml();
    }
    if (state.addChannelOpen) {
      return head + addChannelPanelHtml();
    }
    var count = connectedAssignmentCount();
    var mutable = slackConnectionMutable();
    var workspace = '<section class="section"><div class="section-head"><h2 class="section-title">Connected workspace</h2></div>' +
      '<div class="workspace-card"><div class="workspace-ident"><span class="workspace-icon"><span class="platform-logo slack-logo-image" aria-hidden="true"></span></span>' +
      '<div style="min-width:0;"><div class="workspace-name">' + esc(connectedTeamName()) + '</div><div class="workspace-meta mono">Team ID ' + esc(connectedTeamId() || "Unknown") + '</div></div></div>' +
      '<span class="badge badge-on"><span class="dot"></span>Connected</span>' +
      '<span class="hint">' + esc(count + " assigned " + (count === 1 ? "channel" : "channels")) + '</span>' +
      '<span class="hint">' + esc(slackCredentialSummary()) + '</span></div></section>';
    var behavior = '<section class="section"><div class="section-head"><div><h2 class="section-title">Slack behavior</h2>' +
      '<p class="hint">Control how Chickpea behaves across this Slack workspace.</p></div></div>' + slackBehaviorHtml() + '</section>';
    var connectionBusy = !!state.slackConnectionBusy;
    var testButton = state.slackTestBusy
      ? '<button type="button" class="btn btn-soft i-lead" disabled><span class="spinner"></span>Testing&hellip;</button>'
      : '<button type="button" class="btn btn-soft i-lead" data-action="slack-test"' + (connectionBusy ? " disabled" : "") + '>' + icon("arrow-path") + 'Test connection</button>';
    var updateButton = '<button type="button" class="btn btn-soft i-lead" data-action="slack-update-open"' +
      (mutable && !connectionBusy ? "" : ' disabled' + (!mutable ? ' title="Credentials managed by the environment"' : "")) + '>' + icon("pencil") + 'Update credentials</button>';
    var connection = '<section class="section"><div class="section-head"><div><h2 class="section-title">Connection</h2>' +
      '<p class="hint">Manage this Slack workspace connection.</p></div></div>' +
      '<div class="action-well">' + testButton + updateButton +
      slackConnectionStatusHtml() + '</div>' + slackUpdateCredentialsHtml() +
      '<div class="danger-panel"><div class="danger-copy"><span class="danger-title">Disconnect this workspace</span>' +
      '<span class="hint">Stops Chickpea from answering. Profiles and channel configuration stay saved so you can reconnect later. This does not uninstall the Slack app.</span>' +
      (!mutable ? '<span class="hint">This connection is managed by the environment and is read-only here.</span>' : "") +
      (state.slackDisconnectError ? '<span class="inline-status error">' + esc(state.slackDisconnectError) + '</span>' : "") + '</div>' +
      '<button type="button" class="btn btn-danger" data-action="slack-disconnect-open"' + (mutable && !connectionBusy ? "" : " disabled") + '>Disconnect</button></div></section>';
    var foot = '<div class="slack-overview-foot"><button type="button" class="btn btn-primary i-lead" data-action="toggle-add-channel">' + icon("plus") + 'Add Slack channel</button>' +
      '<span class="hint">Choose a channel where Chickpea should answer.</span></div>';
    return head + successToastHtml() + workspace + slackIdentityHtml() + behavior + connection + foot;
  }

  function slackDisconnectModalHtml() {
    if (!state.slackDisconnectConfirm) return "";
    var button = state.slackDisconnectBusy
      ? '<button type="button" class="btn btn-danger" disabled><span class="spinner"></span>Disconnecting&hellip;</button>'
      : '<button type="button" class="btn btn-danger" data-action="slack-disconnect-confirm">Disconnect workspace</button>';
    return '<div class="modal-backdrop"><div class="modal-card" role="dialog" aria-modal="true" aria-label="Disconnect Slack workspace" tabindex="-1" data-role="slack-disconnect-dialog">' +
      '<h2 class="modal-title">Disconnect ' + esc(connectedTeamName()) + '?</h2>' +
      '<p class="modal-body">Chickpea will stop answering in Slack. Profiles and channel mappings stay saved. The Slack app itself remains installed until you remove it in Slack.</p>' +
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
      ? '<b style="font-weight:500; color:var(--text);">' + profiles.length + ' profile' + (profiles.length === 1 ? "" : "s") + '</b> ' + (profiles.length === 1 ? "references" : "reference") + ' GitHub repositories &mdash; ' + names + '. Those repository selections stay saved, but cannot be used until GitHub is reconnected.'
      : 'No profiles currently reference GitHub repositories.';
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

  function focusSlackDisconnectAction(action) {
    var control = document.querySelector('[data-action="' + action + '"]');
    if (control && control.focus) control.focus();
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

  function successToastHtml() {
    if (!state.slackToast || state.slackToastDismissed) return "";
    var team = state.slackToast.team;
    var botName = state.slackToast.botName || slackDisplayName();
    var who = team
      ? 'Connected to <b style="font-weight:500; color:var(--text);">' + esc(team) + '</b> as <span class="mono" style="color:var(--text);">@' + esc(botName) + '</span>'
      : 'Connected as <span class="mono" style="color:var(--text);">@' + esc(botName) + '</span>';
    return '<div class="success-toast" role="status">' +
      '<span style="color:var(--ok); display:inline-flex;">' + icon("check") + '</span>' +
      '<span style="color:var(--text-2);">' + who + '</span>' +
      '<span style="flex:1;"></span>' +
      '<button type="button" class="x-btn" data-action="dismiss-slack-toast" aria-label="Dismiss">' + icon("x-mark") + '</button></div>';
  }

  function funnelHtml() {
    return '<div class="empty" style="align-items:center; text-align:center; gap:14px; padding:46px 32px;">' +
      '<h1 class="page-title" style="font-size:1.1875rem;">Choose where Chickpea answers</h1>' +
      '<p class="hint" style="max-width:452px; font-size:0.875rem; line-height:1.55;">Chickpea only answers where you allow it. Pick a Slack channel to start &mdash; it comes with sensible defaults, and you can customize instructions, model, and tools per channel anytime.</p>' +
      '<button type="button" class="btn btn-primary" style="margin-top:4px; padding:9px 18px;" data-action="toggle-add-channel">Choose a channel</button>' +
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

  function slackDisplayName() {
    var liveName = state.slackIdentity && typeof state.slackIdentity.displayName === "string"
      ? state.slackIdentity.displayName.trim()
      : "";
    return liveName || "Chickpea";
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

  function connectedTeamName() {
    if (state.slackChannels && state.slackChannels.teamName) return state.slackChannels.teamName;
    if (state.slack && state.slack.teamName) return state.slack.teamName;
    return connectedTeamId() || "your workspace";
  }

  function defaultAgentName() {
    var agent = defaultAgent();
    return agent ? agent.name : "a profile";
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
    var head = '<div class="section-head"><div><h2 class="section-title">Add a channel</h2>' +
      '<p class="hint">Attach to a Slack channel. Mentions guarantee a response and ambient messages may be evaluated with the ' + esc(addChannelAgentName()) + ' profile.</p></div>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="cancel-add-channel">Cancel</button></div>';
    if (!isSlackConnected()) {
      return '<section class="section">' + head +
        '<div class="empty"><p class="field-label">Connect @Chickpea first</p>' +
        '<p class="hint">Add the bot token and signing secret above, then come back to pick a channel.</p></div></section>';
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
            slackScopeCredentialRepairHtml('<button type="button" class="btn btn-primary btn-sm" data-action="slack-update-open">Update credentials</button>') + '</div>'
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
      '<button type="submit" class="btn btn-primary btn-sm">Add channel</button>' +
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

  // First-run Connect stepper (cards 01-03). Two real steps: create the app,
  // then install + paste. The active step is emphasized, the finished step
  // shows a green check, and the future step is dimmed (and clickable to jump
  // ahead). The paste form is the whole submit surface — validated live.
  function slackStepBoldHint(text) {
    return '<b style="font-weight:700; color:var(--text);">' + text + '</b>';
  }

  function slackStep1Html(conn) {
    if (state.slackStep >= 2) {
      return '<div class="step-block">' +
        '<span class="step-num done">' + icon("check") + '</span>' +
        '<div class="step-body"><div class="step-done-line"><span class="step-title">Create @Chickpea in Slack</span>' +
        '<span class="hint" style="color:var(--ok);">' + (state.slackStep >= 3 ? 'App created' : 'Setup opened') + '</span></div></div></div>';
    }
    return '<div class="step-block">' +
      '<span class="step-num active">1</span>' +
      '<div class="step-body">' +
      '<div class="step-title">Create @Chickpea in Slack</div>' +
      '<p class="hint">Opens Slack with a manifest that pre-fills everything, including this install&rsquo;s events URL.</p>' +
      '<div class="field" style="gap:4px;"><span class="tiny-label">Events URL (already in the manifest)</span>' +
      '<span class="chip">' + esc(conn.requestUrl) + '</span></div>' +
      '<div><a class="btn btn-primary" href="' + esc(conn.manifestUrl) + '" target="_blank" rel="noreferrer" data-action="advance-slack-step">Create @Chickpea in Slack &nearr;</a></div>' +
      // The one unrecoverable choice: Slack forces a workspace pick during
      // creation and the manifest cannot pre-select it. Choosing a different
      // workspace here creates an install the configured bot cannot serve.
      '<p class="hint warn-accent">Slack will ask you to ' + slackStepBoldHint("pick a workspace") + ' &mdash; choose the one you want Chickpea in. It can&rsquo;t be changed later without reinstalling.</p>' +
      '</div></div>';
  }

  function slackStep2Html() {
    if (state.slackStep < 2) {
      // Dimmed and clickable — a returning operator can jump straight to it.
      // Spans (not divs) keep the <button> valid: button holds phrasing content.
      return '<div class="step-block dimmed">' +
        '<button type="button" class="advance-step" data-action="advance-slack-step" aria-label="Install, copy and paste">' +
        '<span class="step-num idle">2</span>' +
        '<span class="step-body"><span class="step-title">Install, copy &amp; paste</span></span></button></div>';
    }
    if (state.slackStep === 2) {
      return '<div class="step-block"><span class="step-num active">2</span><div class="step-body">' +
        '<div class="step-title">Confirm Slack created Chickpea</div>' +
        '<p class="hint">Slack should show an app named Chickpea created from the manifest. If signing in dropped you on AI Agent, Blank app, or the app list, reopen the setup link.</p>' +
        '<div style="display:flex; gap:10px; flex-wrap:wrap;"><button type="button" class="btn btn-primary" data-action="slack-app-created">I created the Chickpea app</button>' +
        '<a class="btn btn-soft" href="' + esc(state.slack.manifestUrl) + '" target="_blank" rel="noopener noreferrer">Open Chickpea setup in Slack</a></div>' +
        '</div></div>';
    }
    var validateBtn = state.slackBusy
      ? '<button type="submit" class="btn btn-primary" disabled><span class="spinner"></span>Validating&hellip;</button>'
      : '<button type="submit" class="btn btn-primary">Validate &amp; save</button>';
    var validateTail = state.slackRepair
      ? '<div role="alert" aria-live="assertive" tabindex="-1" data-role="slack-connection-error"><p class="field-error">Apply Chickpea&rsquo;s Slack permissions before continuing.</p><a class="btn btn-primary btn-sm" href="' + esc(state.slackRepair.consoleUrl || "https://api.slack.com/apps") + '" target="_blank" rel="noopener noreferrer">Reinstall @Chickpea in Slack</a></div>'
      : state.slackError
      ? '<span class="field-error" role="alert" aria-live="assertive" tabindex="-1" data-role="slack-connection-error">' + esc(state.slackError) + '</span>'
      : (state.slackBusy ? "" : '<span class="hint">The token is checked live against Slack before anything is saved. The signing secret is verified on the first real Slack event.</span>');
    return '<div class="step-block">' +
      '<span class="step-num active">2</span>' +
      '<div class="step-body">' +
      '<div class="step-title">Install, copy &amp; paste</div>' +
      '<p class="hint">The app exists now, but it has no token until you install it. Copy one value in Slack, come back and paste it here, then go get the next.</p>' +
      '<form data-action="slack-connect-form" style="display:flex; flex-direction:column; gap:14px;">' +
      '<div class="paste-pair"><div class="pair-head"><span class="n">a</span><span>' +
      slackStepBoldHint("Signing Secret") + ' &mdash; Slack lands on ' + slackStepBoldHint("Basic Information") + ' after creating the app. Under <span class="chip">App Credentials</span> &rarr; ' + slackStepBoldHint("Signing Secret") + ' &rarr; Show &rarr; copy.</span></div>' +
      '<input class="input mono" name="signingSecret" type="password" autocomplete="off" aria-label="Signing secret" placeholder="Paste the Signing Secret here" value="' + esc(state.slackDraft.signingSecret) + '" data-action="slack-signing-secret"></div>' +
      '<div class="paste-pair"><div class="pair-head"><span class="n">b</span><span>' +
      slackStepBoldHint("Bot User OAuth Token") + ' &mdash; in the left sidebar, click the <span class="chip">OAuth &amp; Permissions</span> tab. Under the <span class="chip">OAuth Tokens</span> heading, click the green ' + slackStepBoldHint("Install to (your workspace)") + ' button &rarr; Allow. If Slack says the permission scopes changed, click ' + slackStepBoldHint("Reinstall to Workspace") + ' and Allow before copying the token. The token (<span class="chip">xoxb-&hellip;</span>) appears there after installing.</span></div>' +
      '<input class="input mono" name="botToken" type="password" autocomplete="off" aria-label="Bot token" placeholder="Paste the xoxb-&hellip; token here" value="' + esc(state.slackDraft.botToken) + '" data-action="slack-bot-token"></div>' +
      '<div class="full" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">' + validateBtn + validateTail + '</div>' +
      '</form></div></div>';
  }

  function slackStepperHtml() {
    var conn = state.slack;
    if (!conn) return "";
    return '<section class="section"><div class="section-head"><div><h2 class="section-title">Connect @Chickpea</h2>' +
      '<p class="hint">This is the workspace-default identity. Create its Slack app, then install it and paste two values back as you copy them.</p></div>' +
      '<span class="badge badge-off"><span class="dot"></span>Not connected</span></div>' +
      '<div class="stepper">' + slackStep1Html(conn) + slackStep2Html() + '</div></section>' +
      '<details class="advanced"><summary>Request URL shows as unverified?</summary>' +
      '<div class="adv-rows" style="padding-bottom:14px;"><p class="hint">Open ' + slackStepBoldHint("Event Subscriptions") + ' in Slack and click ' + slackStepBoldHint("Retry") + ' &mdash; the worker echoes the verification challenge even before these credentials are saved.</p></div></details>' +
      '<details class="advanced"><summary>Where credentials come from</summary>' +
      '<div class="adv-rows" style="padding-bottom:14px;">' + slackCredentialsWellHtml(conn) + '</div></details>';
  }

  function slackErrorText(message, detail, serverMessage, payload) {
    if (message === "challenge_invalid_signature") return "Slack could not verify this app. Retry the Event Subscriptions request URL check in Slack, then try connecting again.";
    if (message === "challenge_expired") return "Slack's verification check expired. Retry the Event Subscriptions request URL check in Slack, then try connecting again.";
    if (message === "challenge_missing") return "Chickpea is still waiting for Slack to verify the Events URL. Open Event Subscriptions in Slack, click Retry, then try connecting again.";
    if (message === "signing_secret_change_requires_reconnect") return "To change the Signing Secret, disconnect this Slack app and connect it again.";
    if (message === "workspace_mismatch") return "This token belongs to a different Slack workspace. Use the app you created for this Chickpea install and workspace.";
    if (message === "app_mismatch") return "The token and signing secret came from different Slack apps. Copy both values from the same app and try again.";
    if (message === "slack_scope_unverified") return "Slack has not confirmed the required permissions. Reinstall the app to the workspace, allow the requested permissions, then try again.";
    if (message === "slack_channel_list_failed") return "Chickpea could not confirm channel access. Reinstall the app to refresh its Slack permissions, then try again.";
    if (message === "slack_auth_failed") return "Slack rejected the bot token (auth.test failed" + (detail ? ": " + detail : "") + "). Re-copy the xoxb- token and try again.";
    if (message === "slack_unreachable") return "Could not reach the Slack API to validate the token. Check connectivity and try again.";
    if (message === "slack_missing_scopes") {
      return "Slack has not applied all required permissions to this token yet. Reinstall the app, then copy the refreshed Bot User OAuth Token.";
    }
    if (message === "internal_error") return "Chickpea could not store the credentials (an internal error). Check the worker logs and try again.";
    return serverMessage || (detail ? message + ": " + detail : message);
  }

  function resetOnboardingSlackContinuation(clearDraft) {
    state.slackOnboardingRequestId += 1;
    state.slackOnboardingContinuation = null;
    state.slackOnboardingFocus = "";
    if (clearDraft) state.slackDraft = { botToken: "", signingSecret: "" };
    state.slackError = "";
    state.slackRepair = null;
    if (state.slackConnectionBusy === "update") state.slackConnectionBusy = "";
    state.slackBusy = false;
  }

  function isSlackCredentialMismatch(message) {
    return message === "workspace_mismatch" || message === "app_mismatch" ||
      message === "challenge_invalid_signature" || message === "signing_secret_change_requires_reconnect";
  }

  function isRetryableSlackContinuationFailure(message) {
    return message === "slack_unreachable" ||
      message === "identity_profile_unavailable" ||
      message === "slack_channel_list_failed";
  }

  function submitSlackConnection(formData) {
    submitSlackCredentialPair(
      String(formData.get("botToken") || "").trim(),
      String(formData.get("signingSecret") || "").trim()
    );
  }

  function submitSlackCredentialPair(botToken, signingSecret) {
    if (state.slackConnectionBusy) return;
    // Submitting the paste form means the credential surface is active — pin it so a
    // validation error renders against the fields (not a collapsed step).
    state.slackStep = 3;
    state.slackDraft = { botToken: botToken, signingSecret: signingSecret };
    var onboardingAttempt = isOnboardingSlackConnection();
    if (!botToken) { state.slackError = "Bot token is required."; if (onboardingAttempt) state.slackOnboardingFocus = "onboarding-bot-token"; render(); return; }
    if (!signingSecret) { state.slackError = "Signing secret is required."; if (onboardingAttempt) state.slackOnboardingFocus = "onboarding-signing-secret"; render(); return; }
    var continuationAttempt = onboardingAttempt && !!state.slackOnboardingContinuation;
    var requestId = onboardingAttempt ? ++state.slackOnboardingRequestId : 0;
    state.slackError = "";
    state.slackRepair = null;
    state.slackBusy = true;
    state.slackConnectionBusy = "update";
    if (continuationAttempt) {
      state.slackOnboardingContinuation = {
        phase: "checking",
        consoleUrl: state.slackOnboardingContinuation.consoleUrl || "",
        note: "Checking Slack."
      };
    }
    render();
    postJson("/admin/api/slack-connection", "POST", { botToken: botToken, signingSecret: signingSecret }).then(function (result) {
      if (onboardingAttempt && requestId !== state.slackOnboardingRequestId) return null;
      state.slackBusy = false;
      state.slackConnectionBusy = "";
      state.slackDraft = { botToken: "", signingSecret: "" };
      // The connected funnel's success toast is driven off the POST result
      // (team + botName): the follow-up GET reports connected but not botName,
      // so capture them here. Reset the stepper for any later reconnect.
      state.slackToast = { team: (result && result.team) || "", botName: (result && result.botName) || "" };
      state.slackToastDismissed = false;
      state.slackStep = 1;
      state.slackRepair = null;
      state.slackUpdateOpen = false;
      state.slackIdentity = null;
      state.slackIdentityError = "";
      state.slackIdentityLoading = false;
      state.slackIdentityRequestId += 1;
      if (onboardingAttempt) {
        state.slackOnboardingContinuation = null;
        state.slackOnboardingFocus = "onboarding-channel-heading";
      }
      return refreshData();
    }).catch(function (error) {
      if (onboardingAttempt && requestId !== state.slackOnboardingRequestId) return;
      state.slackBusy = false;
      state.slackConnectionBusy = "";
      if (onboardingAttempt && error && error.message === "slack_missing_scopes") {
        state.slackRepair = null;
        state.slackError = "";
        state.slackOnboardingContinuation = {
          phase: "finish",
          consoleUrl: onboardingSlackPermissionUrl(error.payload && error.payload.consoleUrl),
          note: continuationAttempt ? "Slack needs one more confirmation before Chickpea can continue." : ""
        };
        state.slackOnboardingFocus = continuationAttempt ? "slack-permissions-open" : "slack-permission-heading";
        render();
        return;
      }
      if (onboardingAttempt && continuationAttempt && error && isRetryableSlackContinuationFailure(error.message)) {
        state.slackRepair = null;
        state.slackError = "";
        state.slackOnboardingContinuation = {
          phase: "awaiting",
          consoleUrl: (state.slackOnboardingContinuation && state.slackOnboardingContinuation.consoleUrl) || "",
          note: "Slack could not be checked just now. Your details are still here; check again when you are ready."
        };
        state.slackOnboardingFocus = "slack-permissions-check";
        render();
        return;
      }
      if (onboardingAttempt && error && error.message === "slack_auth_failed") {
        state.slackRepair = null;
        state.slackOnboardingContinuation = null;
        state.slackDraft = continuationAttempt
          ? { botToken: "", signingSecret: signingSecret }
          : { botToken: "", signingSecret: "" };
        state.slackError = continuationAttempt
          ? "Paste the current Bot User OAuth Token from Slack, then check again."
          : "Slack rejected these credentials. Copy both values from the same Chickpea app and try again.";
        state.slackOnboardingFocus = continuationAttempt ? "onboarding-bot-token" : "onboarding-signing-secret";
        render();
        return;
      }
      if (onboardingAttempt && error && isSlackCredentialMismatch(error.message)) {
        state.slackRepair = null;
        state.slackOnboardingContinuation = null;
        state.slackDraft = { botToken: "", signingSecret: "" };
      }
      if (onboardingAttempt && continuationAttempt) {
        // Every continuation response must leave the checking screen. Known
        // retryable failures return above; all other errors re-open the normal
        // credential form so its actionable error is visible.
        state.slackOnboardingContinuation = null;
      }
      state.slackRepair = error && error.message === "slack_missing_scopes"
        ? {
            missingScopes: (error.payload && error.payload.missingScopes) || [],
            consoleUrl: (error.payload && error.payload.consoleUrl) || ""
          }
        : null;
      if (state.slackRepair) {
        state.slackDraft = { botToken: "", signingSecret: signingSecret };
      }
      state.slackError = slackErrorText(error.message, error.detail, error.serverMessage, error.payload);
      render();
      focusSlackLiveRegion("slack-connection-error");
    });
  }

  function profileSectionHtml(agent, assignment) {
    // Count concrete channels + a separate "+ DMs" suffix — never fold the DM
    // wildcard into the channel count (that read "used in 2 channels" for a
    // profile on 1 channel + the DM default), matching the profile list/footer.
    var meta = "Unknown profile";
    if (agent) {
      var usedChannels = concreteAssignmentsForAgent(agent.id).length;
      var usedDm = agentHasDmDefault(agent.id);
      meta = modelLabel(agent) + " · used in " + channelCountLabel(usedChannels) + (usedDm ? " + DMs" : "");
    }
    var row = agent
      ? '<div class="bundle-row"><span class="b-name">' + esc(agent.name) + '</span><span class="b-meta">' + esc(meta) + '</span><span class="spacer"></span>' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="open-profiles" data-agent="' + esc(agent.id) + '">Edit</button>' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="toggle-swap">Change</button>' +
        '<button type="button" class="x-btn" data-action="detach-profile" aria-label="Detach profile">' + icon("x-mark") + '</button></div>'
      : '<div class="empty"><p class="field-label">No profile attached</p><p class="hint">Attach a profile before the channel can answer.</p></div>';
    if (state.swapOpen) {
      row += '<div class="bundle-row"><span class="select-wrap"><select class="input" data-role="swap-profile">' + state.agents.map(function (profile) {
        return '<option value="' + esc(profile.id) + '"' + (profile.id === assignment.agentId ? " selected" : "") + '>' + esc(profile.name) + '</option>';
      }).join("") + '</select>' + icon("chevron-down", "select-caret") + '</span><button type="button" class="btn btn-primary btn-sm" data-action="attach-selected-profile">Attach</button></div>';
    }
    return '<section class="section"><div class="section-head"><div><h2 class="section-title">Profile</h2><p class="hint">The reusable behavior attached to this channel &mdash; instructions, model, skills, and connections.</p></div><button type="button" class="btn btn-ghost btn-sm" data-action="open-profiles">Manage profiles</button></div>' + row + '</section>';
  }

  function channelInstructionsHtml() {
    return '<section class="section"><div class="section-head"><div><h2 class="section-title">Channel instructions</h2><p class="hint">Appended to the profile\\'s instructions in this channel only.</p></div></div>' +
      '<div class="field"><label class="field-label" for="participation-mode">Participation</label>' +
      '<span class="select-wrap"><select class="input" id="participation-mode" data-action="channel-participation">' +
      '<option value="ambient"' + (state.channelDraft.participationMode === "ambient" ? " selected" : "") + '>Ambient (mentions guaranteed)</option>' +
      '<option value="mention_only"' + (state.channelDraft.participationMode === "mention_only" ? " selected" : "") + '>Mention only</option></select>' + icon("chevron-down", "select-caret") + '</span>' +
      '<p class="hint">Ambient lets Chickpea decide when an unmentioned contribution is useful. Mention-only narrows this channel without changing tools or teammate permissions.</p></div>' +
      '<div class="field"><label class="field-label" for="addendum" style="position:absolute; clip: rect(0 0 0 0);">Channel instructions</label>' +
      '<textarea class="textarea" id="addendum" data-action="channel-addendum">' + esc(state.channelDraft.channelPromptAddendum || "") + '</textarea></div></section>';
  }

  function accessSummaryHtml() {
    var body = "";
    if (state.effectiveError) {
      body = '<div class="empty"><p class="field-label">Configuration issue</p><p class="hint">' + esc(state.effectiveError) + '</p></div>';
    } else if (!state.effective) {
      body = '<div class="well"><dl><div class="kv"><dt>Status</dt><dd>Resolving...</dd></div></dl></div>';
    } else {
      var profile = state.effective.profile;
      // Trimmed to the four human-meaningful rows ("what will it do"); Model,
      // Provider, and Snapshot are diagnostic and move under Advanced (card 07).
      body = '<div class="well"><dl>' +
        '<div class="kv"><dt>Profile</dt><dd>' + esc(profile.name) + ' ' + enabledBadge(profile.enabled) + '</dd></div>' +
        '<div class="kv"><dt>Replies as</dt><dd>' + esc(slackIdentityMentionForId(state.effective.slackIdentityId)) + ' &mdash; new threads only</dd></div>' +
        '<div class="kv"><dt>Instructions</dt><dd><div class="instructions-preview">' + instructionLayersHtml(state.effective.instructionLayers) + '</div></dd></div>' +
        '</dl></div>';
    }
    return '<section class="section"><div class="section-head"><div><h2 class="section-title">Access summary</h2><p class="hint">Resolved from the attached profile and this channel\\'s instructions. New threads pick this up; existing threads keep the snapshot they started with.</p></div></div>' + body + '</section>';
  }

  function advancedHtml(assignment) {
    // The diagnostic rows trimmed out of the Access summary (card 07): the raw
    // model/provider specifiers and the thread-snapshot hash, resolved from the
    // effective config when it is available.
    var diagnostics = "";
    if (state.effective) {
      // The RESOLVED model/provider the runtime actually runs. Unpinned profiles
      // resolve only through SLACK_TAG_MODEL; otherwise the effective-config
      // request renders the configuration issue above.
      diagnostics =
        '<div class="kv"><dt>Model</dt><dd class="mono">' + esc(state.effective.model || "unknown") + '</dd></div>' +
        '<div class="kv"><dt>Provider</dt><dd class="mono">' + esc(state.effective.provider || "unknown") + '</dd></div>' +
        '<div class="kv"><dt>Snapshot</dt><dd class="mono">sha256:' + esc(shortHash(state.effective.snapshotHash)) + ' · new threads only</dd></div>';
    }
    return '<details class="advanced"><summary>Advanced</summary><div class="adv-rows"><dl style="display:contents;">' +
      diagnostics +
      '<div class="kv"><dt>Channel ID</dt><dd class="mono">' + esc(assignment.channelId) + '</dd></div>' +
      '<div class="kv"><dt>Workspace ID</dt><dd class="mono">' + esc(assignment.workspaceId) + '</dd></div>' +
      '<div class="kv"><dt>Providers</dt><dd style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">' + providerBadges() + '<span class="hint" style="font-size:0.75rem;">${providerHint}</span></dd></div>' +
      '<div class="kv"><dt>Coming later</dt><dd>Inherited defaults, guest policy, and channel-member edits arrive with scope inheritance &mdash; see the roadmap.</dd></div>' +
      '</dl></div></details>';
  }

  function saveBarHtml() {
    return '<div class="save-bar">' +
      '<p class="save-note">Changes apply to new threads without a restart.</p>' +
      (state.saveError ? '<p class="field-error">' + esc(state.saveError) + '</p>' : "") +
      '<button type="button" class="btn btn-ghost" data-action="discard-channel" ' + (!state.dirty ? "disabled" : "") + '>Discard</button>' +
      '<button type="button" class="btn btn-primary" data-action="save-channel" ' + (!state.dirty ? "disabled" : "") + '>Save changes</button>' +
      '</div>';
  }

  // ---- Profiles master-detail view (cards 09-12) ---------------------------

  function profilesMainHtml() {
    if (state.profileScreen === "create") return profileCreateHtml();
    if (state.profileScreen === "edit" && state.profileDraft) return profileEditHtml();
    return profileOverviewHtml();
  }

  function agentHasDmDefault(agentId) {
    return state.assignments.some(function (assignment) {
      return assignment.agentId === agentId && assignment.workspaceId === "*" && assignment.channelId === "*";
    });
  }

  function concreteAssignmentsForAgent(agentId) {
    return state.assignments.filter(function (assignment) {
      return assignment.agentId === agentId && assignment.workspaceId !== "*" && assignment.channelId !== "*";
    });
  }

  // ---- Overview (card 09) --------------------------------------------------

  function profileOverviewHtml() {
    var cards = state.agents.map(profileCardHtml).join("");
    return '<div class="main-head"><div style="display:flex; flex-direction:column; gap:6px;">' +
      '<h1 class="page-title">Profiles</h1>' +
      '<p class="hint" style="max-width:58ch;">A profile is reusable behavior you attach to channels &mdash; its instructions, model, skills, connections, and Slack identity. By default, every Profile always replies as <b style="font-weight:500; color:var(--text);">' + slackMentionHtml() + '</b>; dedicated identities are optional.</p>' +
      '</div><button type="button" class="btn btn-primary" style="flex-shrink:0;" data-action="new-profile">New profile</button></div>' +
      '<section class="section"><div class="section-head"><div><h2 class="section-title">Your profiles</h2><p class="hint">Everything Chickpea can be in this workspace.</p></div></div>' +
      (cards || '<div class="empty"><p class="field-label">No profiles yet</p><p class="hint">Create one to give Chickpea a behavior you can attach to channels.</p></div>') +
      '</section>';
  }

  function profileCardHtml(agent) {
    var dm = agentHasDmDefault(agent.id);
    var concrete = concreteAssignmentsForAgent(agent.id);
    var roleBadge = dm ? '<span class="badge badge-role"><span class="dot"></span>DM default</span>' : "";
    var stateBadge = agent.enabled
      ? '<span class="badge badge-on"><span class="dot"></span>Enabled</span>'
      : '<span class="badge badge-off"><span class="dot"></span>Disabled</span>';
    var modelPart = agent.model ? '<span class="mono">' + esc(agent.model) + '</span>' : "No model pinned";
    var usage = "used in " + channelCountLabel(concrete.length) + (dm ? " + DMs" : "");
    var meta = modelPart + " &middot; " + usage + " &middot; replies as " + esc(slackIdentityMentionForId(effectiveSlackIdentityId(agent.slackIdentityId || "")));
    return '<div class="pcard"><div class="pcard-head"><span class="pcard-name">' + esc(agent.name) + '</span>' + roleBadge + stateBadge + '</div>' +
      '<div class="pcard-foot"><span class="hint">' + meta + '</span><span class="spacer"></span>' +
      '<button type="button" class="btn btn-soft btn-sm" data-action="edit-profile" data-agent="' + esc(agent.id) + '">Edit</button></div></div>';
  }

  // ---- Shared form pieces (create + edit) ----------------------------------

  function modelFieldHtml(draft) {
    var model = draft.model || "";
    var warning = modelWarning(model);
    var caveat = modelCompactionCaveat(model);
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
      (caveat ? '<p class="hint warn-accent">' + caveat + '</p>' : "") +
      '</div>';
  }

  function modelCompactionCaveat(model) {
    // Every binding-backed cloudflare/* model resolves with contextWindow 0, so
    // Flue never threshold-compacts it (measured: DM transcripts grow unbounded).
    // The REST cloudflare-workers-ai/* provider is exempt (it declares a floor),
    // and "cloudflare/" only prefix-matches the binding provider.
    if (model && model.indexOf("cloudflare/") === 0) {
      return "This model resolves through the Workers AI binding, which declares no context window &mdash; so auto-compaction is off and long threads grow unbounded. Pin a catalog model (Claude, GPT) for bounded, auto-compacting context.";
    }
    return "";
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

  function skillImportBrowseAccountsHtml(browse) {
    var installations = (state.githubStatus && state.githubStatus.installations) || [];
    var choices = installations.map(function (installation) {
      var count = installation.repoCount == null ? "Repository count unavailable" : installation.repoCount + " repositories";
      return '<button type="button" class="btn btn-ghost repo-account-choice" data-action="import-browse-account" data-installation="' + esc(installation.id) + '" data-account="' + esc(installation.accountLogin) + '">' +
        '<span class="repo-avatar">' + esc(String(installation.accountLogin || "?").slice(0, 1)) + '</span>' +
        '<span style="display:flex; flex-direction:column; align-items:flex-start;"><span class="field-label">' + esc(installation.accountLogin) + '</span><span class="hint">' + esc(count) + '</span></span></button>';
    }).join("");
    if (!choices) choices = '<p class="hint">No GitHub App installations are available.</p>';
    return '<div class="repo-account-choices"><span class="tiny-label">Choose an account or organization</span>' + choices +
      '<div><button type="button" class="btn btn-ghost btn-sm" data-action="import-browse-cancel">Cancel browsing</button></div></div>';
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
    var list;
    if (browse.loading) {
      list = '<div class="empty"><p class="hint"><span class="spinner"></span> Loading repositories&hellip;</p></div>';
    } else if (browse.error) {
      list = '<div class="empty"><p class="field-error" role="alert">' + esc(browse.error) + '</p><button type="button" class="btn btn-soft btn-sm" data-action="import-browse-retry">Retry</button></div>';
    } else if (!rows) {
      list = '<div class="empty"><p class="hint">No repositories match this search. You can still paste exact owner/repo above.</p></div>';
    } else {
      list = '<div class="repo-picker-list">' + rows + '</div>';
    }
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
      ? skillImportBrowseAccountsHtml(browse)
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
      ? skillImportBrowseAccountsHtml(browse)
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
        '<span>' + access + 'Selected instructions are copied into this profile as a snapshot and may be sent to its configured model when the skill is used. Scripts and assets are excluded.</span>' +
        '<span>Importing does not grant the profile access to the repository. Configure ongoing runtime access separately in the Repositories tab.</span></div>';
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

  // ---- Capability tabs (Instructions / Skills / Connections / Repositories) -

  // One panel is visible at a time; the other three stay MOUNTED but [hidden] so
  // their form fields survive re-renders and collectProfileDraft() keeps
  // reading p-instr regardless of the active tab. The same tray serves create
  // and edit so every profile capability is reachable before the first save.
  function profileTabsHtml(draft) {
    var active = state.profileTab || "instructions";
    // An open inline editor (or import panel, or an async test result landing
    // in it) on a NON-active tab gets an attention dot — the panel is
    // [hidden], so without the dot the user would never see what's in flight.
    var attention = {
      instructions: false,
      skills: !!(state.skillEditor || state.skillImport),
      connections: !!(state.connectionEditor || state.apiConnectionEditor),
      repositories: !!(state.repositoryPicker || state.repositoryAddOpen)
    };
    var repositoryCount = enabledRepositoryGrants(draft).length;
    var tabs = [
      { id: "instructions", label: "Instructions", count: 0 },
      { id: "skills", label: "Skills", count: (draft.skills || []).length },
      { id: "connections", label: "Connections", count: (draft.mcpServers || []).length + (draft.apiConnections || []).length },
      { id: "repositories", label: "Repositories", count: repositoryCount }
    ];
    var bar = tabs.map(function (tab) {
      var on = tab.id === active;
      return '<button type="button" id="ptab-' + tab.id + '" class="ptab' + (on ? " on" : "") + '" role="tab" aria-selected="' + (on ? "true" : "false") + '" tabindex="' + (on ? "0" : "-1") + '" aria-controls="ptab-panel-' + tab.id + '" data-action="profile-tab" data-tab="' + tab.id + '">' + tab.label +
        (tab.count ? '<span class="ptab-count">' + tab.count + '</span>' : "") +
        (!on && attention[tab.id] ? '<span class="ptab-dot" aria-hidden="true"></span>' : "") + '</button>';
    }).join("");
    function panel(id, html) {
      return '<div class="ptab-panel" id="ptab-panel-' + id + '" role="tabpanel" aria-labelledby="ptab-' + id + '"' + (id === active ? "" : " hidden") + '>' + html + '</div>';
    }
    return '<section class="section">' +
      '<div class="ptab-tray">' +
      '<div class="ptabs" role="tablist" aria-label="Profile behavior">' + bar + '</div>' +
      panel("instructions", instructionsPanelHtml(draft, state.profileScreen === "create")) +
      panel("skills", skillsPanelHtml(draft)) +
      panel("connections", connectionsPanelHtml(draft)) +
      panel("repositories", repositoriesPanelHtml(draft)) +
      '</div>' +
      '</section>';
  }

  function instructionsPanelHtml(draft, showPlaceholder) {
    return '<p class="hint ptab-hint">These travel with the profile to every channel it&rsquo;s attached to. Channels can append their own instructions on each channel&rsquo;s page.</p>' +
      '<div class="field">' + profileInstructionsFieldHtml(draft, showPlaceholder) + '</div>';
  }

  function skillsPanelHtml(draft) {
    var skills = draft.skills || [];
    var editor = state.skillEditor;
    var imp = state.skillImport;
    var rows = skills.map(function (skill, index) {
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
    var list = rows ? '<div class="skill-list">' + rows + '</div>' : "";
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
    var body = list + newForm + importPanel + addButtons;
    if (!list && !newForm && !importPanel) {
      body = '<div class="empty"><p class="field-label">No custom skills yet</p><p class="hint">Add one to extend what this profile can do.</p></div>' + addButtons;
    }
    return body;
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
    var logo = (CONNECTOR_LOGOS || {})[preset.id];
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

  function connectorGalleryHtml() {
    // A preset already in use drops out of "Available" — its id seeds the
    // connection id, and connection ids are unique, so a second Connect would
    // fail on save anyway. Remove the existing connection to add it again.
    var draft = state.profileDraft || {};
    var connectedPresetIds = {};
    (draft.mcpServers || []).forEach(function (conn) { if (conn.presetId) connectedPresetIds[conn.presetId] = true; });
    (draft.apiConnections || []).forEach(function (conn) { if (conn.presetId) connectedPresetIds[conn.presetId] = true; });
    var googleConnection = googleWorkspaceConnection(draft);
    var googleAccess = googleAccessFromScopes(googleConnection ? googleConnection.oauthScopes : []);
    var q = String(state.connectorGallerySearch || "").trim().toLowerCase();
    var catalog = (CONNECTOR_PRESETS || []).filter(function (preset) {
      return preset.id !== "google-workspace";
    }).concat(GOOGLE_WORKSPACE_SERVICE_PRESETS || []);
    var shown = catalog.filter(function (preset) {
      var googleService = googleServicePresetById(preset.id);
      if (googleService) {
        if (googleAccess[googleService.service] !== "off") return false;
      } else if (connectedPresetIds[preset.id]) {
        return false;
      }
      var searchText = (preset.name + " " + (preset.description || "")).toLowerCase();
      return !q || searchText.indexOf(q) >= 0;
    }).slice().sort(function (a, b) {
      var an = a.name.toLowerCase();
      var bn = b.name.toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    var rows = shown.map(function (preset) {
      var googleService = googleServicePresetById(preset.id);
      var lanes = googleService ? { mcp: false, api: true } : presetLanes(preset);
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
    var list = shown.length
      ? '<div class="gallery-list">' + rows + '</div>'
      : (q
          ? '<div class="gallery-empty">No connectors match &ldquo;' + esc(state.connectorGallerySearch) + '&rdquo;.</div>'
          : '<div class="gallery-empty">Every prepackaged connector is already added.</div>');
    var custom = '<div class="gallery-row">' +
      '<span class="conn-logo conn-logo-mono" style="background:var(--ember)">+</span>' +
      '<span class="gallery-row-name">Custom connection</span>' +
      '<span class="gallery-row-spacer"></span>' +
      '<button type="button" class="btn btn-soft btn-sm" data-action="conn-custom">Connect</button></div>';
    return '<input class="input" id="conn-gallery-search-input" type="text" autocomplete="off" placeholder="Search connectors" value="' + esc(state.connectorGallerySearch || "") + '" data-action="conn-gallery-search" aria-label="Search connectors">' +
      '<div class="gallery-head"><span>Available</span><span class="gallery-head-count">' + shown.length + '</span></div>' +
      list + custom;
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
    var setupHtml = preset.id === "supabase" ? supabaseSetupHtml(editor) : "";
    var docsHtml = preset.auth.kind !== "oauth" && preset.tokenDocsHint ? '<p class="hint">' + esc(preset.tokenDocsHint) + '</p>' : "";
    if (preset.auth.kind !== "oauth" && preset.tokenDocsUrl) {
      docsHtml += '<a class="hint-link" href="' + esc(preset.tokenDocsUrl) + '" target="_blank" rel="noopener noreferrer">Where do I find this?</a>';
    }
    var notesHtml = preset.notes ? '<p class="hint">' + esc(preset.notes) + '</p>' : "";
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
      (editor.authMode === "oauth" ? '<option value="oauth" selected disabled>OAuth (configured separately)</option>' : "") +
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
    var advancedOAuthHtml = editor.authMode === "oauth"
      ? oauthConnectionHtml(editor, editor.preset || presetById(editor.presetId) || null)
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
    return "";
  }

  function legacyGithubConnectionNoticeHtml(conn) {
    if (!conn || conn.presetId !== "github") return "";
    return '<span class="conn-meta">GitHub now lives in the <button type="button" class="link-btn" data-action="profile-tab" data-tab="repositories">Repositories tab</button></span>';
  }

  function connectionsPanelHtml(draft) {
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
    var hint = 'MCP servers and REST APIs this profile can call.';
    var security = '<p class="conn-security">Your profile stores connection policy and tool approvals only &mdash; tokens live in the settings store and are never returned by the API.</p>';
    return oauthReturnNoticeHtml(draft) + '<p class="hint ptab-hint">' + hint + '</p>' + list + createForm + gallery + security;
  }

  function oauthReturnNoticeHtml(draft) {
    var result = state.oauthReturn;
    if (!result || result.agentId !== draft.id) return "";
    var lane = result.lane === "api" ? "api" : "mcp";
    var connection = (lane === "api" ? (draft.apiConnections || []) : (draft.mcpServers || [])).find(function (entry) {
      return entry.id === result.connectionId;
    });
    var presetId = connection && connection.presetId
      ? connection.presetId
      : result.connectionId;
    var preset = presetById(presetId);
    var name = connection ? connection.displayName : (preset ? preset.name : "The connection");
    var message;
    var statusClass = "ok";
    var role = "status";
    if (result.status === "connected") {
      // A callback success is one-shot evidence about the connection row that
      // returned. Never reinterpret it as success after that row is removed.
      if (!connection) return "";
      var identity = connection && connection.identity;
      var targetName = identity && (identity.workspaceName || identity.accountName)
        ? (identity.workspaceName || identity.accountName)
        : name;
      if (lane === "api") {
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
      var existingConnectionActive = connection &&
        connection.lifecycleStatus === "ready" &&
        (lane === "api" || (connection.allowedTools || []).length > 0);
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
    var installations = status.installations || [];
    var choices = installations.map(function (installation) {
      var count = installation.repoCount == null ? "Repository count unavailable" : installation.repoCount + " repositories";
      return '<button type="button" class="btn btn-ghost repo-account-choice" data-action="repo-manage" data-installation="' + esc(installation.id) + '" data-account="' + esc(installation.accountLogin) + '">' +
        '<span class="repo-avatar">' + esc(String(installation.accountLogin || "?").slice(0, 1)) + '</span>' +
        '<span style="display:flex; flex-direction:column; align-items:flex-start;"><span class="field-label">' + esc(installation.accountLogin) + '</span><span class="hint">' + esc(count) + '</span></span></button>';
    }).join("");
    if (!choices) {
      choices = '<p class="hint">No GitHub App installations are available yet. Install the app on an account or organization, then refresh.</p>';
    }
    return '<div class="repo-account-choices"><span class="tiny-label">Choose an account or organization</span>' + choices +
      '<div><button type="button" class="btn btn-ghost btn-sm" data-action="repo-add-cancel">Cancel</button></div></div>';
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
    var list;
    if (picker.loading) {
      list = '<div class="empty"><p class="hint"><span class="spinner"></span> Loading repositories&hellip;</p></div>';
    } else if (picker.error) {
      list = '<div class="empty"><p class="field-error" role="alert">' + esc(picker.error) + '</p><button type="button" class="btn btn-soft btn-sm" data-action="repo-picker-retry">Retry</button></div>';
    } else if (!rows) {
      list = '<div class="empty"><p class="hint">No repositories match this search.</p></div>';
    } else {
      list = '<div class="repo-picker-list">' + rows + '</div>';
    }
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
      (exceedsLimit ? '<p class="field-error">A profile can select at most 200 repository grants.</p>' : "") + '</div>';
  }

  function repositoryGroupHtml(group) {
    var allRepositories = group.grants.some(function (grant) { return grant.allRepos === true; });
    var explicit = group.grants.filter(function (grant) { return grant.allRepos !== true; });
    var selectionLabel = allRepositories
      ? "All repositories"
      : explicit.length + " repositor" + (explicit.length === 1 ? "y" : "ies");
    var rows = allRepositories
      ? '<p class="hint">Every repository in this installation is available to this profile.</p>'
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
    var capabilityHint = '<p class="hint ptab-hint">Coding runs in a sandbox when this profile has enabled repository grants and the install-wide tier is on.</p>';
    if (!state.githubStatusLoaded) {
      return capabilityHint + '<div class="empty"><p class="hint">Loading GitHub connection&hellip;</p></div>';
    }
    var status = state.githubStatus;
    if (!status) {
      return capabilityHint + '<div class="empty"><p class="field-error" role="alert">' + esc(state.githubError || "Could not load GitHub settings.") + '</p>' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="github-refresh">Retry</button></div>';
    }
    if (status.mode !== "app") {
      return capabilityHint + '<div class="empty"><p class="field-label">Connect GitHub to give this profile access to repositories.</p>' +
        '<button type="button" class="btn btn-primary" data-action="open-settings" data-section="github-settings">Connect GitHub</button></div>';
    }
    var groups = repositoryGroups(draft);
    var selectedCount = enabledRepositoryGrants(draft).length;
    var content;
    if (!selectedCount) {
      content = '<div class="empty"><p class="field-label">No repositories selected</p><p class="hint">Choose the repositories this profile can read and change.</p>' +
        '<button type="button" class="btn btn-primary" data-action="repo-add">Add repositories</button></div>';
    } else {
      content = '<div class="repo-panel-head"><p class="hint ptab-hint">Repositories this profile can work with.</p>' +
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
      '<span class="oauth-account-detail">Selected Google services are available to this profile.</span></div>' +
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
      '<span class="oauth-account-detail">Only grant the Gmail, Calendar, and Drive access this profile needs.</span></div></div>' +
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
      ? "This disconnects the account and removes its tool approvals from this profile. Chickpea's stored OAuth tokens and client registration are deleted when you save."
      : "This drops the connection and its tool approvals from this profile. Its stored token and header values are deleted when you save.";
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
        : "This drops the API policy from this profile. Its stored credential is deleted when you save.") + '</p>' +
      '<div class="modal-foot"><span class="spacer"></span>' +
      '<button type="button" class="btn btn-ghost" data-action="apiconn-remove-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-danger" data-action="apiconn-remove-confirm">' + (isOAuth ? "Disconnect and remove" : "Remove connection") + '</button>' +
      '</div></div></div>';
  }

  function workspaceDefaultSlackIdentity() {
    var identities = (state.slackIdentities && state.slackIdentities.identities) || [];
    return identities.find(function (identity) { return identity.kind === "workspace_default"; }) || null;
  }

  function slackIdentityById(identityId) {
    var identities = (state.slackIdentities && state.slackIdentities.identities) || [];
    return identities.find(function (identity) { return identity.id === identityId; }) || null;
  }

  function slackIdentityMention(identity) {
    return "@" + ((identity && identity.displayName) || "Chickpea");
  }

  function slackIdentityMentionForId(identityId) {
    var identity = identityId ? slackIdentityById(identityId) : workspaceDefaultSlackIdentity();
    if (identity) return slackIdentityMention(identity);
    if (identityId && identityId !== WORKSPACE_DEFAULT_SLACK_IDENTITY_ID) return identityId;
    return "@" + ((state.slackIdentity && state.slackIdentity.displayName) || "Chickpea");
  }

  function effectiveSlackIdentityId(value) {
    if (value && value !== NEW_SLACK_IDENTITY_VALUE) return value;
    var workspaceDefault = workspaceDefaultSlackIdentity();
    return workspaceDefault ? workspaceDefault.id : WORKSPACE_DEFAULT_SLACK_IDENTITY_ID;
  }

  function selectedProfileSlackIdentity(draft) {
    if (!draft || draft.slackIdentityId === NEW_SLACK_IDENTITY_VALUE) return null;
    return slackIdentityById(effectiveSlackIdentityId(draft.slackIdentityId));
  }

  function profilePersistedSlackIdentityId(draft) {
    if (!draft || !draft.id) return "";
    var saved = agentById(draft.id);
    return (saved && saved.slackIdentityId) || "";
  }

  function profileSlackIdentityChanged(draft) {
    return !!draft && (draft.slackIdentityId || "") !== profilePersistedSlackIdentityId(draft);
  }

  function profileHasUnenumeratedChannels(draft) {
    if (!draft || !draft.id) return false;
    return allAssignmentsForAgent(draft.id).some(function (assignment) {
      return String(assignment.workspaceId || "").indexOf("*") >= 0 ||
        String(assignment.channelId || "").indexOf("*") >= 0;
    });
  }

  function slackIdentityNeedsSetup(identity) {
    return !!identity &&
      (identity.lifecycle === "setup_incomplete" || identity.lifecycle === "credentials_pending");
  }

  function slackIdentityOpenAction(identity) {
    if (identity && identity.kind === "workspace_default" && slackIdentityNeedsSetup(identity)) return "open-channels";
    if (identity && identity.kind === "dedicated" && slackIdentityNeedsSetup(identity)) return "slack-identity-open-setup";
    return "slack-identity-open-detail";
  }

  function slackIdentityOpenLabel(identity) {
    var mention = slackIdentityMention(identity);
    if (identity && identity.kind === "workspace_default" && slackIdentityNeedsSetup(identity)) return "Connect " + mention;
    if (identity && identity.kind === "dedicated" && slackIdentityNeedsSetup(identity)) return "Resume " + mention + " setup";
    return "Manage " + mention;
  }

  function profileIdentityHtml(draft) {
    var workspaceDefault = workspaceDefaultSlackIdentity();
    var dedicated = ((state.slackIdentities && state.slackIdentities.identities) || []).filter(function (identity) {
      return identity.kind === "dedicated" &&
        (identity.lifecycle === "connected" || identity.lifecycle === "degraded");
    });
    var selectedValue = draft.slackIdentityId || "";
    var options = '<option value=""' + (!selectedValue ? " selected" : "") + '>' +
      esc(slackIdentityMention(workspaceDefault)) + ' — Workspace default</option>';
    dedicated.forEach(function (identity) {
      options += '<option value="' + esc(identity.id) + '"' + (selectedValue === identity.id ? " selected" : "") + '>' +
        esc(slackIdentityMention(identity)) + (identity.health === "degraded" ? " — needs attention" : "") + '</option>';
    });
    options += '<option value="' + NEW_SLACK_IDENTITY_VALUE + '"' + (selectedValue === NEW_SLACK_IDENTITY_VALUE ? " selected" : "") + '>New Slack identity…</option>';

    var details = "";
    if (selectedValue === NEW_SLACK_IDENTITY_VALUE) {
      details = '<div class="well" style="display:flex; gap:12px; align-items:flex-start;">' +
        '<span aria-hidden="true" style="width:40px; height:40px; border-radius:10px; display:grid; place-items:center; background:var(--well); font-size:20px;">+</span>' +
        '<div><div class="field-label">Create a dedicated Slack identity</div>' +
        '<p class="hint">Chickpea saves this Profile first, then guides you through a separate Slack app install. Canceling setup leaves the Profile on ' + esc(slackIdentityMention(workspaceDefault)) + '.</p></div></div>';
    } else {
      var selected = selectedProfileSlackIdentity(draft) || workspaceDefault;
      if (selected) {
        var identityStatus = managedIdentityStatus(selected);
        var identityAction = slackIdentityOpenAction(selected);
        var identityActionAttributes = identityAction === "open-channels"
          ? ' data-action="open-channels"'
          : ' data-action="' + identityAction + '" data-identity="' + esc(selected.id) + '"';
        var identityNote = identityStatus === "Connected"
          ? esc(slackIdentityMention(selected)) + " will reply in new conversations."
          : esc(identityStatus) + ". Finish setup before using this identity for new conversations.";
        details = '<div class="action-well" style="justify-content:space-between;">' +
          '<span class="hint">' + identityNote + '</span>' +
          '<button type="button" class="btn btn-soft btn-sm"' + identityActionAttributes + '>' + esc(slackIdentityOpenLabel(selected)) + '</button></div>';
      }
    }

    var wildcard = profileSlackIdentityChanged(draft) && profileHasUnenumeratedChannels(draft)
      ? '<div class="well" style="border-color:var(--ember);"><p class="field-label">Some channel rules cannot be enumerated</p>' +
        '<p class="hint">Chickpea cannot enumerate every destination matched by a wildcard or pattern. Invite the new Slack app wherever those rules match; channels without it will fail closed.</p>' +
        '<label style="display:flex; gap:8px; align-items:flex-start; margin-top:10px;"><input type="checkbox" data-action="profile-identity-wildcard-ack"' + (draft.acknowledgeUnenumeratedChannels ? " checked" : "") + '> <span>I understand that unverified channels will fail closed.</span></label></div>'
      : "";

    return '<section class="section"><div class="section-head"><div><h2 class="section-title">Replies as</h2>' +
      '<p class="hint">Choose which Slack identity this Profile uses for new conversations.</p></div></div>' +
      '<div class="field"><label class="field-label" for="p-slack-identity">Identity</label>' +
      '<span class="select-wrap"><select class="input" id="p-slack-identity" data-action="profile-slack-identity">' + options + '</select>' + icon("chevron-down", "select-caret") + '</span></div>' +
      details + wildcard + '</section>';
  }

  function profileNameFieldHtml(draft) {
    var err = state.profileError === "Name is required.";
    return '<div class="field"><label class="field-label" for="p-name">Name</label>' +
      '<input class="input" id="p-name" name="name" type="text" value="' + esc(draft.name) + '"' + (err ? ' style="outline:2px solid var(--danger); outline-offset:-1px;"' : "") + ' data-action="profile-name">' +
      '<p class="hint">Shown here in /admin only. Choose the Slack identity separately under Replies as.</p>' +
      (err ? '<p class="field-error">Name is required.</p>' : "") + '</div>';
  }

  function profileInstructionsFieldHtml(draft, showPlaceholder) {
    var err = state.profileError === "Profile instructions are required.";
    var placeholder = showPlaceholder
      ? ' placeholder="e.g. Answer teammates&rsquo; product questions in a warm, concise voice. When you&rsquo;re unsure, say so and point to #support instead of guessing."'
      : "";
    return '<textarea class="textarea" id="p-instr" name="instructions" aria-label="Profile instructions"' + (err ? ' style="outline:2px solid var(--danger); outline-offset:-1px;"' : "") + placeholder + ' data-action="profile-instructions">' + esc(draft.instructions) + '</textarea>' +
      (err ? '<p class="field-error">Profile instructions are required.</p>' : "");
  }

  function profileGenericErrorHtml() {
    if (!state.profileError) return "";
    if (state.profileError === "Name is required." || state.profileError === "Profile instructions are required.") return "";
    return '<p class="field-error" role="alert" aria-live="polite">' + esc(state.profileError) + '</p>';
  }

  // ---- Create (card 10) ----------------------------------------------------

  function profileCreateHtml() {
    var draft = state.profileDraft || newProfileDraft();
    return '<div style="display:flex; flex-direction:column; gap:6px;">' +
      '<button type="button" class="link-btn" style="align-self:flex-start;" data-action="profiles-back">&larr; Profiles</button>' +
      '<h1 class="page-title">New profile</h1>' +
      '<p class="hint">Create reusable behavior, then choose whether it inherits ' + slackMentionHtml() + ' or gets a dedicated Slack identity.</p></div>' +
      '<section class="section"><div class="section-head"><div><h2 class="section-title">Details</h2></div></div>' +
      '<div class="form-grid">' +
      profileNameFieldHtml(draft) +
      modelFieldHtml(draft) +
      '</div></section>' +
      profileIdentityHtml(draft) +
      profileTabsHtml(draft) +
      '<div class="save-bar">' + profileGenericErrorHtml() +
      '<button type="button" class="btn btn-ghost" data-action="cancel-create">Cancel</button>' +
      '<button type="button" class="btn btn-primary" data-action="save-profile">Create profile</button></div>';
  }

  // ---- Edit (card 11) + edge states (card 12) ------------------------------

  function profileEditHtml() {
    var draft = state.profileDraft;
    // The name lives in the title with an inline rename affordance (pencil →
    // input; Enter/blur commit, Escape reverts) — there is no Name field below.
    var titleRow = state.profileRenaming
      ? '<input class="input page-title-input" id="p-name" name="name" type="text" value="' + esc(draft.name) + '" aria-label="Profile name" data-action="profile-name">'
      : '<span class="title-row"><h1 class="page-title">' + esc(draft.name || "Profile") + '</h1>' +
        '<button type="button" class="rename-btn" data-action="profile-rename" aria-label="Rename profile">' + icon("pencil") + '</button></span>';
    return '<div class="main-head"><div style="display:flex; flex-direction:column; gap:6px;">' +
      '<button type="button" class="link-btn" style="align-self:flex-start;" data-action="profiles-back">&larr; Profiles</button>' +
      titleRow +
      '<p class="hint">Edit this reusable behavior and the Slack identity it uses for new conversations.</p></div>' +
      '<label style="display:flex; align-items:center; gap:10px;"><span class="hint">' + (draft.enabled ? "Enabled" : "Disabled") + '</span>' +
      '<span class="toggle"><span class="thumb"></span><input type="checkbox" name="profile-enabled" data-action="profile-enable-toggle" ' + (draft.enabled ? "checked" : "") + ' aria-label="Profile enabled"></span></label></div>' +
      disableConfirmHtml(draft) +
      '<section class="section"><div class="section-head"><div><h2 class="section-title">Details</h2></div></div>' +
      '<div class="form-grid">' +
      modelFieldHtml(draft) +
      '</div></section>' +
      profileIdentityHtml(draft) +
      profileTabsHtml(draft) +
      usedInHtml(draft) +
      profileFooterHtml(draft) +
      '<div class="save-bar-sticky' + (state.profileDirty ? "" : " is-clean") + (saveBarCueActive() ? " cue" : "") + '">' +
      '<div class="save-bar-inner">' +
      '<p class="save-note">&#9679; Unsaved changes &mdash; applies to new threads</p>' + profileGenericErrorHtml() +
      '<button type="button" class="btn btn-ghost" data-action="discard-profile">Discard</button>' +
      '<button type="button" class="btn btn-primary" data-action="save-profile">Save changes</button>' +
      '</div></div>' +
      '<div aria-hidden="true" style="height:56px"></div>';
  }

  function usedInHtml(draft) {
    var dm = agentHasDmDefault(draft.id);
    var concrete = concreteAssignmentsForAgent(draft.id);
    var rows = "";
    if (dm) {
      rows += '<div class="bundle-row"><span class="b-name">Direct messages</span><span class="b-meta">all workspaces &middot; the DM default</span><span class="spacer"></span><span class="chip">locked</span></div>';
    }
    concrete.forEach(function (assignment) {
      rows += '<div class="bundle-row"><span class="b-name mono" style="font-weight:500;">' + esc(channelLabel(assignment)) + '</span>' +
        '<span class="b-meta">' + esc(assignment.channelId) + '</span><span class="spacer"></span>' +
        '<button type="button" class="link-btn" data-action="open-channel-from-profile" data-workspace="' + esc(assignment.workspaceId) + '" data-channel="' + esc(assignment.channelId) + '">Open channel &nearr;</button>' +
        '<button type="button" class="btn btn-danger btn-sm" data-action="detach-channel" data-workspace="' + esc(assignment.workspaceId) + '" data-channel="' + esc(assignment.channelId) + '">Detach</button></div>';
    });
    if (!rows) {
      rows = '<div class="empty"><p class="field-label">Not attached to any channels yet</p><p class="hint">Use Add to channels below, or attach it from a channel page.</p></div>';
    }
    var hint = 'Editing here changes how ' + esc(draft.name || "this profile") + ' answers in all of these. <b style="font-weight:500; color:var(--text);">Changes apply to new threads</b> &mdash; threads already underway keep the config they started with.';
    return '<section class="section"><div class="section-head"><div><h2 class="section-title">Used in</h2><p class="hint">' + hint + '</p></div></div>' + rows + '</section>';
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

  // Compact footer row (mirrors the reference pattern): destructive action,
  // the attach affordance, and the usage count that doubles as the reason the
  // Delete button is disabled while attachments exist.
  function profileFooterHtml(draft) {
    var dm = agentHasDmDefault(draft.id);
    var concrete = concreteAssignmentsForAgent(draft.id);
    var blocked = dm || concrete.length > 0;
    var name = esc(draft.name || "This profile");
    var usage = name + " used in " + channelCountLabel(concrete.length) + (dm ? " + DMs" : "");
    var deleteTitle = blocked
      ? (dm ? "The DM default can\\u2019t be deleted. Detach it everywhere first." : "Detach it from every channel first.")
      : "This can\\u2019t be undone.";
    return '<div class="profile-foot">' +
      '<button type="button" class="btn btn-danger" data-action="delete-profile"' + (blocked ? " disabled" : "") + ' title="' + deleteTitle + '">Delete profile</button>' +
      '<button type="button" class="btn btn-soft" data-action="attach-open">Add to channels</button>' +
      '<span class="hint">' + usage + '</span>' +
      '</div>' + attachPickerHtml(draft) + attachNoticeHtml();
  }

  function attachNoticeHtml() {
    if (!state.attachNotice) return "";
    return '<div class="callout">' + icon("exclamation-triangle", "ic-l g") +
      '<span>' + esc(state.attachNotice) + '</span></div>';
  }

  // Every Slack channel in the connected workspace catalog except channels
  // already using this profile. A candidate may carry an existing assignment
  // (reassign it) or no assignment at all (create one).
  function attachCandidates(agentId) {
    var workspaceId = connectedTeamId();
    var channels = (state.slackChannels && state.slackChannels.channels) || [];
    if (!workspaceId) return [];
    var assignmentsByChannel = new Map();
    state.assignments.forEach(function (assignment) {
      if (assignment.workspaceId === workspaceId) assignmentsByChannel.set(assignment.channelId, assignment);
    });
    return channels.map(function (channel) {
      var assignment = assignmentsByChannel.get(channel.id) || null;
      return {
        channelId: channel.id,
        channelLabel: channel.name,
        assignment: assignment
      };
    }).filter(function (candidate) {
      return !candidate.assignment || candidate.assignment.agentId !== agentId;
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
            slackScopeCredentialRepairHtml('<button type="button" class="btn btn-primary btn-sm" data-action="open-channels">Open Slack connection</button>')
          : '<button type="button" class="btn btn-soft btn-sm" data-action="refresh-channels">Retry</button>') +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="attach-cancel">Close</button></div>';
    }
    if (state.slackChannelsLoading || !state.slackChannels) {
      return '<div class="bundle-row"><span class="hint">Loading workspace channels&hellip;</span>' +
        '<span class="spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-action="attach-cancel">Cancel</button></div>';
    }
    var candidates = attachCandidates(draft.id);
    if (!candidates.length) {
      return '<div class="bundle-row"><span class="hint">All available Slack channels already use this profile.</span>' +
        '<span class="spacer"></span>' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="attach-new-channel" data-agent="' + esc(draft.id) + '">Add a new channel with this profile</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="attach-cancel">Close</button></div>';
    }
    var agentsById = new Map();
    state.agents.forEach(function (agent) { agentsById.set(agent.id, agent); });
    var options = candidates.map(function (candidate) {
      var current = candidate.assignment ? agentsById.get(candidate.assignment.agentId) : null;
      return '<option value="' + esc(candidate.channelId) + '"' +
        (candidate.channelId === state.attachChannelSelected ? " selected" : "") + '>' + esc(channelLabel(candidate)) +
        (current ? ' &mdash; currently ' + esc(current.name) : "") + '</option>';
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
    var concrete = concreteAssignmentsForAgent(draft.id);
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
    return '<div class="callout">' + icon("exclamation-triangle", "ic-l g") + '<span>Disable ' + esc(draft.name || "this profile") + '? ' + scope + ' Threads already underway finish on the config they started with.</span></div>' +
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
      return html + '<div class="combo-group">no providers configured</div><div class="combo-foot">No provider keys on this install yet. Type any provider/model specifier to pin one now, or set <span class="mono" style="color:var(--text-2);">SLACK_TAG_MODEL</span> (<span class="mono" style="color:var(--text-2);">provider/model</span>) as an offline/dev fallback so an unpinned profile still replies.</div>' + settingsRow + '</div>';
    }
    return html + '<div class="combo-foot">Anthropic and OpenAI list their live models; OpenRouter and Workers AI show your starred favorites. Type any provider/model specifier.</div>' + settingsRow + '</div>';
  }

  // ---- Audit Logs > Memory -------------------------------------------------

  function memoryScopes() { return state.memoryScopes || []; }

  function memoryScopeForChannel(workspaceId, channelId) {
    var matches = memoryScopes().filter(function (scope) {
      return scope.workspaceId === workspaceId && scope.channelId === channelId;
    });
    return matches.find(function (scope) { return scope.lifecycle === "active"; }) || matches[0] || null;
  }

  function channelAuditSectionHtml(assignment) {
    var scope = memoryScopeForChannel(assignment.workspaceId, assignment.channelId);
    var count = scope ? Number(scope.entryCount || 0) : 0;
    var countText = state.memoryScopes === null
      ? (state.memoryScopesError ? "Memory count unavailable" : "Loading memory&hellip;")
      : count + " saved " + (count === 1 ? "memory" : "memories");
    var note = count > 0
      ? "Review what Chickpea remembers and correct anything outdated."
      : "Nothing saved yet. Ask Chickpea to remember something in Slack.";
    var accessibleCount = state.memoryScopes === null
      ? "saved memories"
      : count + " saved " + (count === 1 ? "memory" : "memories");
    var memoryRow = '<div class="bundle-row channel-memory-row"><div class="channel-memory-summary">' +
      '<span class="channel-memory-total">' + countText + '</span><span class="channel-memory-note">' + esc(note) + '</span></div>' +
      '<span class="spacer"></span><button type="button" class="btn btn-soft btn-sm" data-action="open-channel-memory"' +
      ' data-workspace="' + esc(assignment.workspaceId) + '" data-channel="' + esc(assignment.channelId) + '"' +
      ' data-store="' + esc(scope && scope.storeId || "") + '" aria-label="Review ' + esc(accessibleCount) + ' for ' + esc(channelLabel(assignment)) + '">Review memory</button></div>';
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
    return '<section class="section channel-audit-section"><div class="section-head"><div><h2 class="section-title">Audit</h2>' +
      '<p class="hint">Review this channel\\'s saved memory and scheduled work.</p></div></div>' +
      '<div class="channel-audit-rows">' + memoryRow + scheduledRow + '</div></section>';
  }

  function selectedMemoryScope() {
    var exact = memoryScopes().find(function (scope) {
      return scope.storeId === state.memorySelection.storeId && scope.channelId === state.memorySelection.channelId;
    });
    if (exact) return exact;
    if (!state.memorySelection.storeId && state.memorySelection.channelId) {
      var matches = memoryScopes().filter(function (scope) { return scope.channelId === state.memorySelection.channelId; });
      return matches.find(function (scope) { return scope.lifecycle === "active"; }) || matches[0] || null;
    }
    return null;
  }

  function selectedMemoryAssignment() {
    if (!state.memorySelection.channelId) return null;
    return state.assignments.find(function (assignment) {
      return assignment.workspaceId !== "*" && assignment.channelId === state.memorySelection.channelId;
    }) || null;
  }

  function auditRailHtml() {
    var scopes = memoryScopes();
    var html = '<nav class="rail audit-rail" aria-label="Memory scopes"><div class="rail-context">' +
      '<div class="rail-head"><span class="section-eyebrow">Audit logs</span></div>' +
      '<div class="platform-row active"><span class="platform-logo slack-logo-image" aria-hidden="true"></span>Slack</div>';
    if (state.memoryScopesLoading && !state.memoryScopes) {
      return html + '<div class="empty" style="margin:8px; padding:12px;"><p class="hint">Loading memory scopes&hellip;</p></div></div>' + sectionSwitcherHtml() + '</nav>';
    }
    if (state.memoryScopesError) {
      return html + '<div class="empty" style="margin:8px; padding:12px;"><p class="field-error">' + esc(state.memoryScopesError) + '</p><button type="button" class="btn btn-ghost btn-sm" data-action="memory-retry-scopes">Retry</button></div></div>' + sectionSwitcherHtml() + '</nav>';
    }
    if (!scopes.length) {
      return html + '<div class="ws-row">Workspace</div><div class="empty" style="margin:8px; padding:12px;"><p class="hint">No channel memories yet</p></div></div>' + sectionSwitcherHtml() + '</nav>';
    }
    var workspaces = [];
    scopes.forEach(function (scope) {
      var workspace = workspaces.find(function (candidate) { return candidate.id === scope.workspaceId; });
      if (!workspace) { workspace = { id: scope.workspaceId, scopes: [] }; workspaces.push(workspace); }
      workspace.scopes.push(scope);
    });
    workspaces.forEach(function (workspace) {
      html += '<div class="ws-row">' + icon("chevron-down") + esc(railGroupLabel(workspace.id)) + '</div>';
      workspace.scopes.forEach(function (scope) {
        var active = scope.storeId === state.memorySelection.storeId && scope.channelId === state.memorySelection.channelId;
        var privacy = scope.privacy === "private" ? "Private" : "Workspace shared";
        if (scope.lifecycle !== "active") privacy += " · " + scope.lifecycle;
        html += '<button type="button" class="chan-item' + (active ? " active" : "") + '" data-action="select-memory-scope" data-store="' + esc(scope.storeId) + '" data-channel="' + esc(scope.channelId) + '">' +
          '<span class="chan-name audit-channel-name">' + auditChannelMarkerHtml(scope.privacy) + '<span>' + esc(scope.displayName || scope.channelId) + '</span></span>' +
          '<span class="chan-meta">' + esc(privacy) + ' · ' + Number(scope.entryCount || 0) + '</span></button>';
      });
    });
    return html + '</div>' + sectionSwitcherHtml() + '</nav>';
  }

  function auditChannelMarkerHtml(privacy) {
    if (privacy !== "private") return '<span class="audit-channel-marker" aria-hidden="true">#</span>';
    return '<span class="audit-channel-marker" aria-hidden="true"><svg class="ic" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.25 7V4.75a2.75 2.75 0 0 1 5.5 0V7m-6.5 0h7.5A1.25 1.25 0 0 1 13 8.25v5a1.25 1.25 0 0 1-1.25 1.25h-7.5A1.25 1.25 0 0 1 3 13.25v-5A1.25 1.25 0 0 1 4.25 7Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  }

  function auditTabsHtml() {
    var scheduled = state.auditDomain === "scheduled-work";
    return '<div class="audit-tabs" role="tablist" aria-label="Audit domains">' +
      '<button type="button" class="audit-tab' + (scheduled ? " active" : "") + '" role="tab" aria-selected="' + (scheduled ? "true" : "false") + '" data-action="audit-tab-scheduled">Scheduled work</button>' +
      '<button type="button" class="audit-tab' + (!scheduled ? " active" : "") + '" role="tab" aria-selected="' + (!scheduled ? "true" : "false") + '" data-action="audit-tab-memory">Memory</button>' +
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
    var assignment = assignmentByKey(workspaceId, channelId);
    return assignment ? channelLabel(assignment) : "#" + String(channelId || "channel");
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
    state.assignments.filter(function (assignment) { return assignment.workspaceId !== "*"; }).forEach(function (assignment) {
      var workspace = workspaces.find(function (candidate) { return candidate.id === assignment.workspaceId; });
      if (!workspace) { workspace = { id: assignment.workspaceId, channels: [] }; workspaces.push(workspace); }
      if (!workspace.channels.some(function (candidate) { return candidate.channelId === assignment.channelId; })) workspace.channels.push(assignment);
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
      return "Each occurrence re-resolves current channel membership, profile, connections, credentials, repository grants, and policy. It has the same authority as a live @mention in the owning channel; saved or fetched content cannot widen that authority.";
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

  function auditMemoryMainHtml() {
    var scope = selectedMemoryScope();
    var head = '<div class="audit-main-head"><h1 class="page-title">Audit logs</h1></div>' + auditTabsHtml();
    if (state.memoryScopesLoading && !state.memoryScopes) return head + '<div class="empty"><p class="hint">Loading memory&hellip;</p></div>';
    if (state.memoryScopesError) return head + '<div class="empty"><p class="field-error">' + esc(state.memoryScopesError) + '</p><button type="button" class="btn btn-ghost" data-action="memory-retry-scopes">Retry</button></div>';
    if (!scope) {
      var requestedAssignment = selectedMemoryAssignment();
      var emptyTitle = requestedAssignment
        ? "No memories saved in " + channelLabel(requestedAssignment)
        : "No memory selected";
      var emptyCopy = requestedAssignment
        ? "Saved memories for this channel will appear here after a member asks Chickpea to remember something in Slack."
        : "Choose a channel scope to review its generated index and saved Markdown files.";
      return head + '<div class="empty"><h2 class="section-title">' + esc(emptyTitle) + '</h2><p class="hint">' + esc(emptyCopy) + '</p></div>';
    }
    var sourceLabel = "#" + (scope.displayName || scope.channelId);
    var banner = scope.privacy === "public"
      ? '<div class="memory-banner">Memories saved in ' + esc(sourceLabel) + ' can help Chickpea respond across this workspace. In Slack, they can only be changed from ' + esc(sourceLabel) + '.</div>'
      : '<div class="memory-banner">Memories saved in this private channel are used only here. They are never shared with other channels.</div>';
    return head + banner +
      '<div class="memory-layout"><section class="memory-pane" aria-label="Memory files"><div class="memory-pane-title">Files</div>' + memoryFilesHtml() + '</section>' +
      '<section class="memory-pane memory-editor" aria-label="Memory editor">' + memoryEditorHtml() + '</section></div>' +
      '<div class="memory-live" role="status" aria-live="polite">' + esc(state.memoryNotice || state.memoryError) + '</div>';
  }

  function memoryFilesHtml() {
    if (state.memoryFilesLoading) return '<p class="hint">Loading files&hellip;</p>';
    if (state.memoryFilesError) return '<p class="field-error">' + esc(state.memoryFilesError) + '</p><button type="button" class="btn btn-ghost btn-sm" data-action="memory-retry-files">Retry</button>';
    var files = state.memoryFiles || [];
    if (!files.length) return '<p class="hint">No projected files are available.</p>';
    return '<div class="memory-file-list">' + files.map(function (file) {
      var key = file.generated ? "MEMORY.md" : file.entryId;
      var active = state.memorySelectedFile === key;
      return '<button type="button" class="memory-file' + (active ? " active" : "") + '" data-action="select-memory-file" data-file="' + esc(key) + '">' +
        '<span class="memory-file-name">' + esc(file.name) + '</span>' +
        '<span class="memory-file-meta">' + (file.generated ? "Generated · read-only" : esc(file.status || "active") + " · v" + Number(file.version || 0)) + '</span></button>';
    }).join("") + '</div>';
  }

  function memoryEditorHtml() {
    if (state.memoryFilesLoading || state.memoryBusy === "load") return '<p class="hint">Loading selection&hellip;</p>';
    if (state.memorySelectedFile === "MEMORY.md") {
      var index = (state.memoryFiles || []).find(function (file) { return file.generated; });
      return '<div class="memory-editor-head"><div><div class="memory-editor-title">MEMORY.md</div><p class="hint">Generated index · changes are made through individual files.</p></div><span class="badge badge-off">Read-only</span></div>' +
        '<pre class="memory-source">' + esc(index && index.content || '# Channel Memory Index\\n\\n') + '</pre>';
    }
    if (!state.memorySelectedFile) return '<div class="empty"><p class="hint">Select a file to view, edit, or delete it.</p></div>';
    if (!state.memoryDetail || !state.memoryDraft) return '<p class="hint">Loading entry&hellip;</p>';
    var entry = state.memoryDetail.entry;
    var review = state.memoryDetail.unresolvedReview;
    var reviewHtml = review ? '<div class="memory-review"><strong>Review requested</strong><span>' + esc(review.reasonCode || "Needs operator review") + '</span><span class="spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-action="memory-resolve-review">Mark reviewed</button></div>' : '';
    var status = entry.status === "forgotten" ? '<span class="badge badge-off">Forgotten</span>' : '<span class="badge badge-on"><span class="dot"></span>' + esc(entry.status) + '</span>';
    var editor = entry.status === "forgotten" ? '<p class="hint">Content was irreversibly removed. Tombstone metadata and body-free history remain for audit integrity.</p>' :
      '<div class="form-grid"><label class="field"><span class="field-label">Name</span><input class="input mono" value="' + esc(entry.slug) + '" readonly aria-readonly="true"></label>' +
      '<label class="field"><span class="field-label">Type</span><span class="select-wrap"><select class="input" data-action="memory-type">' + ["fact", "decision", "project", "feedback", "preference"].map(function (type) { return '<option value="' + type + '"' + (state.memoryDraft.type === type ? " selected" : "") + '>' + type + '</option>'; }).join("") + '</select><span class="select-caret">' + icon("chevron-down") + '</span></span></label>' +
      '<label class="field full"><span class="field-label">Description</span><input class="input" data-action="memory-description" value="' + esc(state.memoryDraft.description) + '"></label>' +
      '<label class="field full"><span class="field-label">Markdown body</span><textarea class="textarea mono" data-action="memory-body" rows="12">' + esc(state.memoryDraft.body) + '</textarea></label></div>' +
      '<div class="memory-editor-actions"><button type="button" class="btn btn-primary" data-action="memory-save"' + (!state.memoryDirty || state.memoryBusy ? " disabled" : "") + '>' + (state.memoryBusy === "save" ? "Saving&hellip;" : "Save changes") + '</button>' +
      '<button type="button" class="btn btn-ghost" data-action="memory-discard"' + (!state.memoryDirty || state.memoryBusy ? " disabled" : "") + '>Discard</button>' +
      '<button type="button" class="btn btn-danger" data-action="memory-delete-open"' + (state.memoryBusy ? " disabled" : "") + '>Delete memory</button></div>' + memoryConflictHtml();
    return '<div class="memory-editor-head"><div><div class="memory-editor-title">' + esc(entry.slug) + '.md</div><p class="hint">Version ' + Number(entry.version) + ' · modified ' + esc(formatMemoryDate(entry.modifiedAt)) + '</p></div>' + status + '</div>' + reviewHtml + editor + memoryHistoryHtml() +
      (entry.status !== "forgotten" ? '<details><summary class="field-label">Projected Markdown</summary><pre class="memory-source">' + esc(state.memoryDetail.projected || "") + '</pre></details>' : '');
  }

  function memoryHistoryHtml() {
    var history = state.memoryHistory || [];
    if (!history.length) return '';
    return '<details><summary class="field-label">Revision history (' + history.length + ')</summary><div class="memory-history">' + history.slice().reverse().map(function (revision) {
      return '<div class="memory-history-row"><span class="mono">v' + Number(revision.version) + '</span><strong>' + esc(revision.operation) + '</strong><span class="spacer"></span><span class="hint">' + esc(formatMemoryDate(revision.createdAt)) + '</span></div>';
    }).join("") + '</div></details>';
  }

  function memoryConflictHtml() {
    var conflict = state.memoryConflict;
    if (!conflict) return '';
    var latest = conflict.latest;
    return '<div class="memory-review"><div><strong>Newer version available</strong><p class="hint">Your draft is preserved. Compare it with version ' + Number(latest.version) + ' before deciding.</p>' +
      '<details><summary class="field-label">View latest saved content</summary><pre class="memory-source">Type: ' + esc(latest.type) + '\\nDescription: ' + esc(latest.description) + '\\n\\n' + esc(latest.body) + '</pre></details></div><span class="spacer"></span>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="memory-use-latest">Use latest and discard draft</button></div>';
  }

  function memoryDeleteModalHtml() {
    if (!state.memoryDeleteConfirm || !state.memoryDetail) return '';
    return '<div class="modal-backdrop"><div class="modal-card" role="dialog" aria-modal="true" aria-label="Delete memory">' +
      '<h2 class="modal-title">Delete ' + esc(state.memoryDetail.entry.slug) + '?</h2>' +
      '<p class="modal-body">This permanently removes the canonical memory body and the content from every stored revision in Chickpea. Body-free audit tombstones and revision metadata remain. Prior exports, Slack or provider logs, backups, and Flue transcripts may still retain copies; Chickpea cannot retract them.</p>' +
      '<div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="memory-delete-cancel">Cancel</button><span class="spacer"></span><button type="button" class="btn btn-danger" data-action="memory-delete-confirm">Delete permanently</button></div></div></div>';
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
      state: "current",
      status: ""
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
    if (filters.status) query.set("status", filters.status);
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

  function openAuditLogs(storeId, channelId, entryId) {
    state.view = "audit";
    state.profileScreen = "list";
    state.auditDomain = "memory";
    state.memorySelection = { storeId: storeId || "", channelId: channelId || "", entryId: entryId || "" };
    state.memoryFilesRequestId += 1;
    state.memoryEntryRequestId += 1;
    state.memorySelectedFile = entryId || "";
    state.memoryError = "";
    state.memoryNotice = "";
    render();
    loadMemoryScopes();
  }

  function loadMemoryScopes() {
    if (state.memoryScopesLoading) return Promise.resolve();
    state.memoryScopesLoading = true;
    state.memoryScopesError = "";
    render();
    return api("/admin/api/audit/memory/scopes").then(function (body) {
      state.memoryScopes = body.scopes || [];
      state.memoryScopesLoading = false;
      var selected = selectedMemoryScope();
      if (!selected && state.memoryScopes.length && !state.memorySelection.channelId) {
        selected = state.memoryScopes[0];
      }
      if (selected) state.memorySelection = { storeId: selected.storeId, channelId: selected.channelId, entryId: state.memorySelection.entryId || "" };
      render();
      if (selected) return loadMemoryFiles();
    }).catch(function (error) {
      state.memoryScopesLoading = false;
      state.memoryScopesError = error.serverMessage || error.message || "Could not load memory scopes.";
      render();
    });
  }

  function selectMemoryScope(storeId, channelId) {
    if (state.memoryDirty) { state.memoryError = "Save or discard the current draft before changing channels."; render(); return; }
    if (state.memoryBusy && state.memoryBusy !== "load") { state.memoryError = "Wait for the current memory action to finish before changing channels."; render(); return; }
    state.memorySelection = { storeId: storeId, channelId: channelId, entryId: "" };
    state.memoryFilesRequestId += 1;
    state.memoryEntryRequestId += 1;
    state.memorySelectedFile = "";
    state.memoryDetail = null;
    state.memoryDraft = null;
    state.memoryHistory = [];
    state.memoryConflict = null;
    state.memoryNotice = "";
    state.memoryError = "";
    render();
    loadMemoryFiles();
  }

  function loadMemoryFiles() {
    var scope = selectedMemoryScope();
    if (!scope) return Promise.resolve();
    var requestId = ++state.memoryFilesRequestId;
    var storeId = scope.storeId;
    var channelId = scope.channelId;
    state.memoryFilesLoading = true;
    state.memoryFilesError = "";
    render();
    return api("/admin/api/audit/memory/stores/" + encodeURIComponent(scope.storeId) + "/files?sourceChannelId=" + encodeURIComponent(scope.channelId)).then(function (body) {
      if (requestId !== state.memoryFilesRequestId || state.memorySelection.storeId !== storeId || state.memorySelection.channelId !== channelId) return;
      state.memoryFiles = body.files || [];
      state.memoryFilesLoading = false;
      var requested = state.memorySelection.entryId;
      var hasRequested = requested && state.memoryFiles.some(function (file) { return file.entryId === requested; });
      state.memorySelectedFile = hasRequested ? requested : "MEMORY.md";
      state.memorySelection.entryId = hasRequested ? requested : "";
      render();
      if (hasRequested) return loadMemoryEntry(requested);
    }).catch(function (error) {
      if (requestId !== state.memoryFilesRequestId || state.memorySelection.storeId !== storeId || state.memorySelection.channelId !== channelId) return;
      state.memoryFilesLoading = false;
      state.memoryFilesError = error.serverMessage || error.message || "Could not load memory files.";
      render();
    });
  }

  function selectMemoryFile(key) {
    if (state.memoryDirty) { state.memoryError = "Save or discard the current draft before opening another file."; render(); return; }
    if (state.memoryBusy && state.memoryBusy !== "load") { state.memoryError = "Wait for the current memory action to finish before opening another file."; render(); return; }
    state.memoryEntryRequestId += 1;
    state.memorySelectedFile = key;
    state.memorySelection.entryId = key === "MEMORY.md" ? "" : key;
    state.memoryDetail = null;
    state.memoryDraft = null;
    state.memoryHistory = [];
    state.memoryConflict = null;
    state.memoryError = "";
    state.memoryNotice = "";
    render();
    if (key !== "MEMORY.md") loadMemoryEntry(key);
  }

  function loadMemoryEntry(entryId) {
    var requestId = ++state.memoryEntryRequestId;
    state.memoryBusy = "load";
    render();
    return Promise.all([
      api("/admin/api/audit/memory/entries/" + encodeURIComponent(entryId)),
      api("/admin/api/audit/memory/entries/" + encodeURIComponent(entryId) + "/history")
    ]).then(function (parts) {
      if (requestId !== state.memoryEntryRequestId || state.memorySelectedFile !== entryId) return;
      state.memoryDetail = parts[0];
      state.memoryHistory = parts[1].revisions || [];
      state.memoryDraft = {
        description: parts[0].entry.description || "",
        type: parts[0].entry.type || "fact",
        body: parts[0].entry.body || ""
      };
      state.memoryDirty = false;
      state.memoryBusy = "";
      state.memoryIdempotencyKey = "";
      state.memoryConflict = null;
      render();
    }).catch(function (error) {
      if (requestId !== state.memoryEntryRequestId || state.memorySelectedFile !== entryId) return;
      state.memoryBusy = "";
      state.memoryError = error.serverMessage || error.message || "Could not load this memory.";
      render();
    });
  }

  function memoryMutationKey(prefix) {
    if (!state.memoryIdempotencyKey) state.memoryIdempotencyKey = prefix + "-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    return state.memoryIdempotencyKey;
  }

  function markMemoryDirty() {
    state.memoryDirty = true;
    state.memoryError = "";
    state.memoryNotice = "";
    state.memoryIdempotencyKey = "";
    state.memoryConflict = null;
    var save = document.querySelector('[data-action="memory-save"]');
    var discard = document.querySelector('[data-action="memory-discard"]');
    if (save) save.disabled = false;
    if (discard) discard.disabled = false;
  }

  function saveMemoryEntry() {
    if (!state.memoryDetail || !state.memoryDraft || !state.memoryDirty || state.memoryBusy) return;
    var entry = state.memoryDetail.entry;
    state.memoryBusy = "save";
    state.memoryError = "";
    state.memoryNotice = "";
    render();
    return api("/admin/api/audit/memory/entries/" + encodeURIComponent(entry.entryId), {
      method: "PUT",
      headers: { "content-type": "application/json", "idempotency-key": memoryMutationKey("edit") },
      body: JSON.stringify({ expectedVersion: entry.version, description: state.memoryDraft.description, type: state.memoryDraft.type, body: state.memoryDraft.body })
    }).then(function (body) {
      state.memoryDetail.entry = body.entry;
      state.memoryDetail.projected = body.projected;
      state.memoryDraft = { description: body.entry.description, type: body.entry.type, body: body.entry.body };
      state.memoryDirty = false;
      state.memoryBusy = "";
      state.memoryIdempotencyKey = "";
      state.memoryNotice = "Memory saved.";
      // loadMemoryFiles already reloads the selected entry. A second explicit
      // load raced the operator's next keystroke and could repaint their draft.
      return loadMemoryFiles();
    }).catch(function (error) {
      state.memoryBusy = "";
      if (error.payload && error.payload.error === "memory_version_conflict") {
        state.memoryError = "This memory changed elsewhere (now version " + Number(error.payload.currentVersion) + "). Your draft is preserved; reload before saving again.";
        state.memoryIdempotencyKey = "";
        api("/admin/api/audit/memory/entries/" + encodeURIComponent(entry.entryId)).then(function (body) {
          state.memoryConflict = { latest: body.entry };
          render();
        }).catch(function () { render(); });
      } else {
        state.memoryError = error.serverMessage || error.message || "Could not save memory. Retry will reuse the same request key.";
      }
      render();
    });
  }

  function discardMemoryDraft() {
    if (!state.memoryDetail) return;
    var entry = state.memoryDetail.entry;
    state.memoryDraft = { description: entry.description || "", type: entry.type || "fact", body: entry.body || "" };
    state.memoryDirty = false;
    state.memoryIdempotencyKey = "";
    state.memoryError = "";
    state.memoryConflict = null;
    render();
  }

  function useLatestMemoryEntry() {
    if (!state.memoryConflict || !state.memoryConflict.latest) return;
    var latest = state.memoryConflict.latest;
    state.memoryDetail.entry = latest;
    state.memoryDraft = { description: latest.description || "", type: latest.type || "fact", body: latest.body || "" };
    state.memoryDirty = false;
    state.memoryIdempotencyKey = "";
    state.memoryConflict = null;
    state.memoryError = "";
    state.memoryNotice = "Loaded the latest saved version.";
    render();
    loadMemoryEntry(latest.entryId);
  }

  function deleteMemoryEntry() {
    if (!state.memoryDetail || state.memoryBusy) return;
    var entry = state.memoryDetail.entry;
    state.memoryDeleteConfirm = false;
    state.memoryBusy = "delete";
    state.memoryError = "";
    render();
    api("/admin/api/audit/memory/entries/" + encodeURIComponent(entry.entryId), {
      method: "DELETE",
      headers: { "content-type": "application/json", "idempotency-key": memoryMutationKey("delete") },
      body: JSON.stringify({ expectedVersion: entry.version, acknowledgeIrreversible: true })
    }).then(function () {
      state.memoryBusy = "";
      state.memoryDirty = false;
      state.memoryIdempotencyKey = "";
      state.memoryNotice = "Memory deleted from Chickpea. Its canonical body and revision content were removed; body-free audit records remain, and prior exports, Slack or provider logs, backups, and Flue transcripts may still retain copies.";
      return loadMemoryFiles();
    }).catch(function (error) {
      state.memoryBusy = "";
      state.memoryError = error.serverMessage || error.message || "Could not delete memory.";
      render();
    });
  }

  function resolveMemoryReview() {
    if (!state.memoryDetail || !state.memoryDetail.unresolvedReview || state.memoryBusy) return;
    var entry = state.memoryDetail.entry;
    var review = state.memoryDetail.unresolvedReview;
    state.memoryBusy = "review";
    state.memoryError = "";
    render();
    api("/admin/api/audit/memory/entries/" + encodeURIComponent(entry.entryId) + "/reviews/" + encodeURIComponent(review.eventId) + "/resolve", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": memoryMutationKey("review") },
      body: JSON.stringify({ expectedVersion: entry.version, resolution: "confirmed" })
    }).then(function () {
      state.memoryBusy = "";
      state.memoryNotice = "Review resolved.";
      return loadMemoryEntry(entry.entryId);
    }).catch(function (error) {
      state.memoryBusy = "";
      state.memoryError = error.serverMessage || error.message || "Could not resolve review.";
      render();
    });
  }

  function formatMemoryDate(value) {
    var date = new Date(Number(value));
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown time";
  }

  // ---- Settings: model providers (cards 13-14) -----------------------------

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
      '<span class="hint">Removes stored GitHub App credentials from Chickpea. Environment-configured App credentials stay active, and repository selections on profiles stay saved.</span></div>' +
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
      '<p class="hint">Connect GitHub once, then grant repository access per profile.</p></div>' + badge + '</div>';
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

    var beta = '<div class="callout"><p class="field-label">Updating an older Sandbox beta?</p><p class="hint">Keep the Sandbox build profile before your next update to retain the binding. Choosing the default slim profile intentionally removes Container access and leaves runtime enablement ineffective until you reinstall.</p></div>';
    return '<section class="section" id="sandbox-settings">' + head + body + paidNote + beta + live + progress + '</section>';
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
      '<p class="hint">GitHub access comes from profile repository grants. These are the only optional package hosts.</p>' + hostRows + '</div>' +
      '</div></details>' +
      '<div><button type="button" class="btn btn-soft" data-action="sandbox-save"' + disabled + '>' + (state.sandboxSaving === "advanced" ? "Saving&hellip;" : "Save advanced settings") + '</button></div>';
  }

  function managedSlackIdentity(identityId) {
    return (state.slackIdentities.identities || []).find(function (identity) {
      return identity.id === identityId;
    }) || null;
  }

  function managedIdentityAvatarHtml(identity) {
    var name = (identity && identity.displayName) || "Chickpea";
    if (identity && identity.avatarUrl) {
      return '<span class="slack-identity-avatar"><img src="' + esc(identity.avatarUrl) + '" alt="Slack avatar for @' + esc(name) + '"></span>';
    }
    return '<span class="slack-identity-avatar" aria-hidden="true">' + esc(name.slice(0, 1).toUpperCase() || "C") + '</span>';
  }

  function slackIdentityAvatarSettingsLinkHtml(identity) {
    if (!identity || !identity.consoleUrl) return "";
    return '<a class="btn btn-soft btn-sm" href="' + esc(identity.consoleUrl) + '" target="_blank" rel="noopener noreferrer">Change avatar image in Slack &nearr;</a>';
  }

  function managedIdentityStatus(identity) {
    if (identity.kind === "workspace_default" && identity.lifecycle === "setup_incomplete") return "Not connected";
    if (identity.lifecycle === "setup_incomplete") return "Setup incomplete";
    if (identity.lifecycle === "credentials_pending") return "Signing secret unverified";
    if (identity.lifecycle === "retired") return "Retired locally";
    if (identity.health === "uninstalled") return "Uninstalled in Slack";
    if (identity.health === "unauthorized") return "No longer authorized in Slack";
    if (identity.healthDetail === "not_in_channel") return "Not in channel";
    if (identity.health === "disconnected") return "Disconnected locally";
    if (identity.lifecycle === "degraded" || identity.health === "degraded") return "Slack identity unavailable";
    return "Connected";
  }

  function managedIdentityBadgeHtml(identity) {
    var status = managedIdentityStatus(identity);
    var healthy = status === "Connected";
    return '<span class="badge ' + (healthy ? "badge-on" : "badge-off") + '"><span class="dot"></span>' + esc(status) + '</span>';
  }

  function managedIdentityDmText(identity) {
    if (!identity.globalDmAllowed && identity.dmState === "on") return "Off by workspace control";
    if (identity.dmState === "needs_setup") return "Needs a Profile";
    if (identity.dmState === "off") return "Off";
    return identity.dmProfile ? "Go to " + identity.dmProfile.name : "Profile unavailable";
  }

  function managedIdentityCredentialText(identity) {
    if (identity.kind === "workspace_default" && identity.lifecycle === "setup_incomplete") return "Connect from Channels";
    if (identity.credentialProvenance === "workspace_default") return "Workspace credentials";
    if (identity.credentialProvenance === "stored") return "Stored credentials";
    return "No credentials";
  }

  function managedIdentityCredentialDetail(identity) {
    if (identity.credentialProvenance === "workspace_default") return "Workspace credentials are never shown here.";
    if (identity.credentialProvenance === "stored") return "Stored credentials are write-only and never shown here.";
    return "No credentials are stored for this identity.";
  }

  function slackIdentityListRowHtml(identity) {
    var actionLabel = slackIdentityOpenLabel(identity);
    var action = slackIdentityOpenAction(identity);
    var profileCount = (identity.profiles || []).length;
    var profileUsage = "Used by " + profileCount + " Profile" + (profileCount === 1 ? "" : "s");
    var dmMeta = slackIdentityNeedsSetup(identity)
      ? '<div class="identity-meta"><strong>Profile usage</strong><span>' + esc(profileUsage) + '</span></div>'
      : '<div class="identity-meta"><strong>Direct messages</strong><span>' + esc(managedIdentityDmText(identity)) + '</span><span>' + esc(profileUsage) + '</span></div>';
    return '<div class="identity-row">' + managedIdentityAvatarHtml(identity) +
      '<div class="slack-identity-copy"><span class="slack-identity-name">@' + esc(identity.displayName || "Chickpea") + '</span>' +
      '<span class="hint">' + (identity.kind === "workspace_default" ? "Workspace default" : "Dedicated Slack app") + '</span></div>' +
      '<div class="identity-meta"><strong>Status</strong>' + managedIdentityBadgeHtml(identity) + '<span>' + esc(managedIdentityCredentialText(identity)) + '</span></div>' +
      dmMeta +
      '<button type="button" class="btn btn-soft btn-sm" data-action="' + action + '" data-identity="' + esc(identity.id) + '">' + esc(actionLabel) + '</button></div>';
  }

  function slackIdentityListHtml() {
    var identities = state.slackIdentities.identities || [];
    var rows = identities.map(slackIdentityListRowHtml).join("");
    var create = '<button type="button" class="btn btn-primary i-lead" data-action="slack-identity-create-open">' + icon("plus") + 'Add Slack identity</button>';
    return '<div class="section-head"><div><h1 class="page-title">Slack identities</h1>' +
      '<p class="hint">Manage the Slack apps Chickpea can reply through. Profiles choose an identity under Replies as.</p></div>' + create + '</div>' +
      (state.slackIdentityNotice ? '<p class="inline-status" role="status">' + esc(state.slackIdentityNotice) + '</p>' : '') +
      (!state.slackIdentities.globalDmAllowed ? '<div class="callout">The workspace DM ceiling is off. Identity-level DM settings are preserved, but no Slack identity admits DM work.</div>' : '') +
      '<div class="identity-list">' + (rows || '<div class="empty"><p class="hint">The workspace-default identity appears after Slack is installed.</p></div>') + '</div>';
  }

  function enabledIdentityProfileOptions(selectedId) {
    return state.agents.filter(function (agent) { return agent.enabled; }).map(function (agent) {
      return '<option value="' + esc(agent.id) + '"' + (agent.id === selectedId ? " selected" : "") + '>' + esc(agent.name) + '</option>';
    }).join("");
  }

  function slackIdentityCreateHtml() {
    var draft = state.slackIdentityCreateDraft;
    return '<button type="button" class="btn btn-ghost btn-sm" data-action="slack-identities-back">&larr; All identities</button>' +
      '<div class="section-head"><div><h1 class="page-title">Add a Slack identity</h1><p class="hint">This is optional. Each distinct mention, avatar, and DM conversation requires another Slack app installation and invitations to the channels where it should answer.</p></div></div>' +
      '<form class="section identity-wizard" data-action="slack-identity-create-form">' +
      '<div class="callout">A dedicated identity is a real Slack app, not a cosmetic sender name. Profiles can share it after setup.</div>' +
      '<div class="form-grid"><div class="field"><label class="field-label" for="identity-app-name">Slack app name</label><input class="input" id="identity-app-name" name="appName" maxlength="35" required value="' + esc(draft.appName) + '" data-action="slack-identity-create-app-name"><p class="hint">Shown in Slack app settings. 35 characters maximum.</p></div>' +
      '<div class="field"><label class="field-label" for="identity-bot-name">Mention name</label><input class="input" id="identity-bot-name" name="displayName" maxlength="80" required value="' + esc(draft.displayName) + '" data-action="slack-identity-create-display-name"><p class="hint">Slack turns this into the bot&rsquo;s native mention after installation.</p></div></div>' +
      '<div class="field"><label class="field-label" for="identity-dm-profile">DMs handled by</label><span class="select-wrap"><select class="input" id="identity-dm-profile" name="initialDmAgentId" data-action="slack-identity-create-dm">' + enabledIdentityProfileOptions(draft.initialDmAgentId) + '</select>' + icon("chevron-down", "select-caret") + '</span><p class="hint">This Profile handles future DMs to the new app. Creating from Settings does not change its Replies as selection.</p></div>' +
      (state.slackIdentityActionError ? '<p class="field-error" role="alert">' + esc(state.slackIdentityActionError) + '</p>' : '') +
      '<div class="save-bar"><button type="button" class="btn btn-ghost" data-action="slack-identities-back">Cancel</button><span class="spacer"></span><button type="submit" class="btn btn-primary"' + (state.slackIdentityBusy ? " disabled" : "") + '>' + (state.slackIdentityBusy ? "Creating&hellip;" : "Continue to Slack setup") + '</button></div></form>';
  }

  function identityStepHtml(number, title, body, active, complete) {
    return '<div class="identity-step' + (active ? " active" : "") + '"><div class="identity-step-head"><span class="identity-step-number">' + (complete ? "&#10003;" : number) + '</span><strong>' + esc(title) + '</strong></div>' + body + '</div>';
  }

  function slackIdentitySetupHtml() {
    if (state.slackIdentityDetailLoading) return '<div class="empty"><p class="hint">Loading identity setup&hellip;</p></div>';
    if (state.slackIdentityDetailError || !state.slackIdentityDetail) {
      return '<button type="button" class="btn btn-ghost btn-sm" data-action="slack-identities-back">&larr; All identities</button><div class="empty"><p class="field-error">' + esc(state.slackIdentityDetailError || "Identity setup is unavailable.") + '</p><button type="button" class="btn btn-soft" data-action="slack-identity-detail-retry">Retry</button></div>';
    }
    var detail = state.slackIdentityDetail;
    var identity = detail.identity;
    if (identity.lifecycle === "connected" || identity.lifecycle === "degraded") {
      state.slackIdentityScreen = "detail";
      return slackIdentityDetailHtml();
    }
    var setup = detail.setup || {};
    var stage = state.slackIdentitySetupStage;
    var names = state.slackIdentitySetupDraft;
    var reconnecting = identity.setupReconnecting === true;
    var intentBody = identity.lifecycle === "setup_incomplete" && !reconnecting
      ? '<form data-action="slack-identity-setup-names-form"><div class="form-grid"><div class="field"><label class="field-label">Slack app name</label><input class="input" name="appName" maxlength="35" required value="' + esc(names.appName) + '" data-action="slack-identity-setup-app-name"></div><div class="field"><label class="field-label">Mention name</label><input class="input" name="displayName" maxlength="80" required value="' + esc(names.displayName) + '" data-action="slack-identity-setup-display-name"></div></div><button type="submit" class="btn btn-soft btn-sm"' + (state.slackIdentityBusy ? " disabled" : "") + '>Save names</button></form>'
      : '<div class="kv"><dt>Slack app name</dt><dd>' + esc(names.appName || identity.displayName || "Identity") + '</dd><dt>Mention name</dt><dd>@' + esc(names.displayName || identity.displayName || "Identity") + '</dd></div><p class="hint">These installed names are read-only here. Change the live name later in Slack.</p>';
    var manifestBody = '<p class="hint">Slack opens a prefilled manifest. Review it, choose <b>Create</b>, and install the app in <b>' + esc(connectedTeamName()) + '</b>. After Chickpea validates its credentials, you can open the exact Slack page to change its avatar.</p>' +
      (setup.manifestUrl ? '<a class="btn btn-primary i-lead" href="' + esc(setup.manifestUrl) + '" target="_blank" rel="noopener noreferrer" data-action="slack-identity-manifest-open">Create app in Slack &nearr;</a>' : '<p class="field-error">' + esc(setup.manifestError || "The manifest could not be generated. Edit the names and try again.") + '</p>') +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="slack-identity-credentials-open">I installed the app</button>';
    var credentialBody = stage >= 3 ? '<form data-action="slack-identity-credentials-form"><p class="hint">Paste the Bot User OAuth Token and Signing Secret from this app. If Slack says the permission scopes changed, choose <b>Reinstall to Workspace</b> and Allow before copying the token. They are write-only and disappear from the browser after submission.</p><div class="form-grid"><div class="field"><label class="field-label">Bot User OAuth Token</label><input class="input mono" type="password" autocomplete="off" name="botToken" placeholder="xoxb-&hellip;" value="' + esc(state.slackIdentityCredentialDraft.botToken) + '" data-action="slack-identity-credential-token"></div><div class="field"><label class="field-label">Signing Secret</label><input class="input mono" type="password" autocomplete="off" name="signingSecret" value="' + esc(state.slackIdentityCredentialDraft.signingSecret) + '" data-action="slack-identity-credential-secret"></div></div><button type="submit" class="btn btn-primary"' + (state.slackIdentityBusy ? " disabled" : "") + '>' + (state.slackIdentityBusy === "connect" ? "Checking&hellip;" : "Validate credentials") + '</button></form>' : '<p class="hint">Install the Slack app first, then continue here.</p>';
    var setupAvatarAction = identity.lifecycle === "credentials_pending" && identity.consoleUrl
      ? '<div class="action-well" style="align-items:center;">' + managedIdentityAvatarHtml(identity) + '<div style="display:flex; flex-direction:column; gap:3px; flex:1;"><span class="field-label">Current Slack avatar</span><span class="hint">Slack owns this image. Change it there, then return here to finish.</span></div>' + slackIdentityAvatarSettingsLinkHtml(identity) + '</div>'
      : "";
    var verifyBody = identity.lifecycle === "credentials_pending" ? setupAvatarAction + '<p class="hint">In Slack, save the prefilled Request URL so Slack sends its signed challenge. Then verify it here. If the challenge expired, use Slack&rsquo;s Retry button and try again.</p><button type="button" class="btn btn-primary" data-action="slack-identity-verify"' + (state.slackIdentityBusy ? " disabled" : "") + '>' + (state.slackIdentityBusy === "verify" ? "Verifying&hellip;" : "Verify signed callback") + '</button>' : '<p class="hint">Available after the credentials are validated.</p>';
    var attachmentNote = reconnecting
      ? "This identity is paused until Slack signs the new callback. Verification does not change any Profile&rsquo;s Replies as selection."
      : identity.setupSourceProfileId
      ? "Your current Profile identity stays unchanged until all checks pass."
      : "Completing a Settings-origin setup does not change any Profile&rsquo;s Replies as selection.";
    var cancelBody = reconnecting
      ? '<div class="callout"><b>Reconnect in progress.</b> Replacement credentials are already stored. Finish signed verification, or paste another valid credential pair to restart this step; this established identity cannot be deleted as a setup draft.</div>'
      : '<div class="danger-panel"><div class="danger-copy"><span class="danger-title">Cancel this setup</span><span class="hint">Any pasted credentials and pending callback are erased before the draft is removed. A Profile-origin setup keeps its previous Replies as identity.</span></div><button type="button" class="btn btn-danger btn-sm" data-action="slack-identity-cancel-open"' + (state.slackIdentityBusy ? " disabled" : "") + '>Cancel setup</button></div>';
    return '<button type="button" class="btn btn-ghost btn-sm" data-action="slack-identities-back">&larr; All identities</button><div class="section-head"><div><h1 class="page-title">' + (reconnecting ? "Reconnect " : "Set up ") + '@' + esc(identity.displayName || "identity") + '</h1><p class="hint">Resume safely at any time. ' + attachmentNote + '</p></div></div><div class="identity-wizard">' +
      identityStepHtml(1, "Choose identity and DM routing", intentBody, stage === 1, stage > 1) +
      identityStepHtml(2, "Create and install the Slack app", manifestBody, stage === 2, stage > 2) +
      identityStepHtml(3, "Paste write-only credentials", credentialBody, stage === 3, stage > 3) +
      identityStepHtml(4, "Set avatar and verify Slack", verifyBody, stage === 4, false) +
      (state.slackIdentityActionError ? '<p class="field-error" role="alert">' + esc(state.slackIdentityActionError) + '</p>' : '') +
      (state.slackIdentityNotice ? '<p class="inline-status" role="status">' + esc(state.slackIdentityNotice) + '</p>' : '') +
      cancelBody + '</div>';
  }

  function identityProfilesHtml(identity) {
    var profiles = identity.profiles || [];
    if (!profiles.length) return '<p class="hint">No Profile currently selects this identity under Replies as.</p>';
    return '<div class="identity-profile-list">' + profiles.map(function (profile) {
      return '<div class="identity-profile-row"><span>' + esc(profile.name) + '</span><span class="badge ' + (profile.enabled ? "badge-on" : "badge-off") + '">' + (profile.enabled ? "Enabled" : "Disabled") + '</span></div>';
    }).join("") + '</div>';
  }

  function slackIdentityDetailHtml() {
    if (state.slackIdentityDetailLoading) return '<div class="empty"><p class="hint">Loading Slack identity&hellip;</p></div>';
    if (state.slackIdentityDetailError || !state.slackIdentityDetail) {
      return '<button type="button" class="btn btn-ghost btn-sm" data-action="slack-identities-back">&larr; All identities</button><div class="empty"><p class="field-error">' + esc(state.slackIdentityDetailError || "Identity unavailable.") + '</p><button type="button" class="btn btn-soft" data-action="slack-identity-detail-retry">Retry</button></div>';
    }
    var identity = state.slackIdentityDetail.identity;
    var isDefault = identity.kind === "workspace_default";
    var observed = identity.observedAt ? new Date(identity.observedAt).toLocaleString() : "Not refreshed yet";
    var consoleLink = slackIdentityAvatarSettingsLinkHtml(identity);
    var dmOptions = enabledIdentityProfileOptions(state.slackIdentityDmDraft.dmAgentId);
    var dmReady = identity.lifecycle === "connected" || identity.lifecycle === "degraded";
    var dmDestination = identity.dmProfile ? identity.dmProfile.name : "the selected Profile";
    var dmBody = '<p class="hint">Each Slack identity has its own DM conversation. Choose which Profile handles it; memory stays with the Slack conversation.</p>' +
      (!dmReady && state.slackIdentityDmDraft.dmState === "on" ? '<div class="callout">DMs will go to ' + esc(dmDestination) + ' once this identity is connected.</div>' : '') +
      (!identity.globalDmAllowed ? '<div class="callout">The workspace DM ceiling is off, so this identity is effectively off even if its remembered setting is on.</div>' : '') +
      '<div class="form-grid"><div class="field"><label class="field-label">Direct messages</label><span class="select-wrap"><select class="input" data-action="slack-identity-dm-state"><option value="on"' + (state.slackIdentityDmDraft.dmState === "on" ? " selected" : "") + '>On</option><option value="off"' + (state.slackIdentityDmDraft.dmState === "off" ? " selected" : "") + '>Off</option></select>' + icon("chevron-down", "select-caret") + '</span></div><div class="field"><label class="field-label">DMs handled by</label><span class="select-wrap"><select class="input" data-action="slack-identity-dm-agent">' + dmOptions + '</select>' + icon("chevron-down", "select-caret") + '</span></div></div><button type="button" class="btn btn-soft btn-sm" data-action="slack-identity-dm-save"' + (state.slackIdentityBusy || identity.lifecycle === "retired" ? " disabled" : "") + '>Save DM behavior</button>';
    var reconnect = state.slackIdentityReconnectOpen ? '<form data-action="slack-identity-reconnect-form"><div class="form-grid"><div class="field"><label class="field-label">New Bot User OAuth Token</label><input class="input mono" type="password" name="botToken" autocomplete="off" value="' + esc(state.slackIdentityCredentialDraft.botToken) + '" data-action="slack-identity-credential-token"></div><div class="field"><label class="field-label">New Signing Secret</label><input class="input mono" type="password" name="signingSecret" autocomplete="off" value="' + esc(state.slackIdentityCredentialDraft.signingSecret) + '" data-action="slack-identity-credential-secret"></div></div><div style="display:flex; gap:8px;"><button type="button" class="btn btn-ghost btn-sm" data-action="slack-identity-reconnect-cancel">Cancel</button><button type="submit" class="btn btn-primary btn-sm"' + (state.slackIdentityBusy ? " disabled" : "") + '>Validate new credentials</button></div></form>' : '<button type="button" class="btn btn-soft btn-sm" data-action="slack-identity-reconnect-open"' + (isDefault || identity.lifecycle === "retired" ? " disabled" : "") + '>Reconnect or rotate</button>';
    var blockers = [];
    if ((identity.profiles || []).length) blockers.push("move " + identity.profiles.length + " Profile" + (identity.profiles.length === 1 ? "" : "s"));
    if (identity.dmState !== "off") blockers.push("turn DMs off");
    if (identity.pendingDeliveryCount) blockers.push("wait for " + identity.pendingDeliveryCount + " pending deliver" + (identity.pendingDeliveryCount === 1 ? "y" : "ies"));
    var retireBody = isDefault ? '<p class="hint">The workspace-default identity cannot be retired. Disconnect it from the Slack workspace overview after every credentialed dedicated identity is canceled or retired.</p>' : identity.lifecycle === "retired" ? '<p class="hint">This non-secret tombstone remains while old thread snapshots and delivery references can still name it. The Slack app was not uninstalled or revoked.</p>' : '<p class="hint">Local retirement deletes Chickpea&rsquo;s credentials but does not uninstall or revoke the Slack app. Old frozen threads may become unavailable.</p>' + (blockers.length ? '<p class="field-error">Before retiring: ' + esc(blockers.join(", ")) + '.</p>' : '') + '<button type="button" class="btn btn-danger btn-sm" data-action="slack-identity-retire-open"' + (blockers.length || state.slackIdentityBusy ? " disabled" : "") + '>Retire locally</button>';
    return '<button type="button" class="btn btn-ghost btn-sm" data-action="slack-identities-back">&larr; All identities</button>' +
      '<div class="section-head"><div style="display:flex; align-items:center; gap:12px;">' + managedIdentityAvatarHtml(identity) + '<div><h1 class="page-title">@' + esc(identity.displayName || "Chickpea") + '</h1><p class="hint">' + (isDefault ? "Workspace default" : "Dedicated Slack app") + '</p></div></div>' + managedIdentityBadgeHtml(identity) + '</div>' +
      (state.slackIdentityNotice ? '<p class="inline-status" role="status">' + esc(state.slackIdentityNotice) + '</p>' : '') +
      (state.slackIdentityActionError ? '<p class="field-error" role="alert">' + esc(state.slackIdentityActionError) + '</p>' : '') +
      '<div class="identity-detail-grid"><section class="section"><div class="section-head"><div><h2 class="section-title">Appearance</h2><p class="hint">Slack is the source of truth.</p></div></div><div class="kv"><dt>Last refreshed</dt><dd>' + esc(observed) + '</dd></div><div class="action-well">' + consoleLink + '<button type="button" class="btn btn-ghost btn-sm" data-action="slack-identity-detail-refresh"' + (state.slackIdentityBusy ? " disabled" : "") + '>' + icon("arrow-path") + 'Refresh</button></div></section>' +
      '<section class="section"><div class="section-head"><div><h2 class="section-title">Profile usage</h2><p class="hint">Profiles select this identity under Replies as. Channel assignments still choose behavior.</p></div></div>' + identityProfilesHtml(identity) + '</section>' +
      '<section class="section"><div class="section-head"><div><h2 class="section-title">Direct messages</h2></div></div>' + dmBody + '</section>' +
      '<section class="section"><div class="section-head"><div><h2 class="section-title">Connection</h2><p class="hint">' + esc(managedIdentityCredentialDetail(identity)) + '</p></div></div>' + reconnect + '</section></div>' +
      '<div class="danger-panel"><div class="danger-copy"><span class="danger-title">' + (isDefault ? "Workspace identity" : "Retire identity") + '</span>' + retireBody + '</div></div>';
  }

  function slackIdentitiesSettingsHtml() {
    if (state.slackIdentityScreen === "create") return slackIdentityCreateHtml();
    if (state.slackIdentityScreen === "setup") return slackIdentitySetupHtml();
    if (state.slackIdentityScreen === "detail") return slackIdentityDetailHtml();
    return slackIdentityListHtml();
  }

  function settingsMainHtml() {
    if (state.settingsSection === "slack") return slackIdentitiesSettingsHtml();
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
        '<p class="hint">Connect the credentials Chickpea can use. OpenAI can keep both an API key and ChatGPT subscription connected, with one method selected for all OpenAI calls.</p></div></div>' +
        modelCatalogStatusHtml() + rows + '</section>';
    }
    return head +
      settingsPanelHtml("slack", slackIdentitiesSettingsHtml()) +
      settingsPanelHtml("providers", providerSection) +
      settingsPanelHtml("github", githubSectionHtml()) +
      settingsPanelHtml("sandbox", sandboxSectionHtml()) +
      settingsPanelHtml("outbound", egressSectionHtml());
  }

  function settingsPanelHtml(id, body) {
    return '<div class="settings-panel" data-settings-panel="' + id + '"' + (state.settingsSection === id ? '' : ' hidden') + '>' + body + '</div>';
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
    var body = "";
    if (ui.removeOpen) body = removeConfirmHtml(id, summary);
    else if (ui.open) body = pasteBodyHtml(id, ui, meta);
    else if (isFavoriteProvider(id)) body = favManagerHtml(id);
    if (id === "openai") return openAiProviderRowHtml(summary, ui, body, meta);
    var head = '<div class="prov-head">' +
      '<div class="prov-id"><span class="prov-name">' + esc(meta.name) + '</span>' +
      '<span class="prov-sub">' + esc(meta.sub) + ' &middot; <span class="mono-frag">' + esc(meta.frag) + '</span>' + (meta.suffix ? esc(meta.suffix) : "") + '</span></div>' +
      providerStatusHtml(id, summary) +
      providerActionsHtml(id, summary, ui) +
      '</div>';
    return '<div class="prov-row">' + head + (body ? '<div class="prov-body">' + body + '</div>' : "") + '</div>';
  }

  function openAiProviderRowHtml(summary, ui, apiEditor, meta) {
    var subscription = summary.subscription || { state: "disconnected", updatedAt: 0 };
    var apiConnected = summary.status === "stored" || summary.status === "env";
    var subscriptionConnected = subscription.state === "connected" || subscription.state === "account_change_confirmation_required";
    var activeMethod = summary.activeAuthMethod === "subscription" ? "subscription" : "api_key";
    var connectedCount = (apiConnected ? 1 : 0) + (subscriptionConnected ? 1 : 0);
    var showSelection = connectedCount === 2;
    var apiBadge = '<span class="badge ' + (apiConnected ? "badge-on" : "badge-off") + '"><span class="dot"></span>' + (apiConnected ? "Connected" : "Not connected") + '</span>';
    var apiSource = summary.status === "env" ? "Environment managed" : summary.status === "stored" ? "Saved in Chickpea" : "Platform billing";
    var apiSelected = showSelection && activeMethod === "api_key";
    var apiInUse = apiSelected ? '<span class="badge badge-on"><span class="dot"></span>Selected</span>' : "";
    var apiOption = '<div class="openai-auth-option ' + (apiSelected ? "active" : "") + '"><div class="openai-auth-head">' +
      '<div class="openai-auth-copy"><span class="openai-auth-title">API key</span><span class="openai-auth-meta">' + esc(apiSource) + '</span></div>' +
      apiInUse + apiBadge + providerActionsHtml("openai", summary, ui) + '</div>' +
      (apiEditor ? '<div class="openai-auth-editor">' + apiEditor + '</div>' : "") + '</div>';
    var head = '<div class="prov-head"><div class="prov-id"><span class="prov-name">' + esc(meta.name) + '</span>' +
      '<span class="prov-sub">' + esc(meta.sub) + ' &middot; <span class="mono-frag">' + esc(meta.frag) + '</span></span></div>' +
      '<div class="prov-status"><span class="hint">' + connectedCount + ' of 2 connected</span></div></div>';
    return '<div class="prov-row">' + head + '<div class="prov-body">' +
      openAiAuthMethodControlHtml(summary, apiConnected, subscriptionConnected) +
      '<div class="openai-auth-list">' + apiOption + openAiSubscriptionHtml(subscription, activeMethod, showSelection) + '</div></div></div>';
  }

  function openAiAuthMethodControlHtml(summary, apiConnected, subscriptionConnected) {
    if (!apiConnected || !subscriptionConnected) return "";
    var saved = summary.activeAuthMethod === "subscription" ? "subscription" : "api_key";
    var draft = state.openAiAuthMethodDraft === "subscription" ? "subscription" : "api_key";
    var changed = draft !== saved;
    var selectedLabel = draft === "subscription" ? "ChatGPT subscription" : "OpenAI API key";
    var hint = changed
      ? "Save to use " + selectedLabel + " for every OpenAI call."
      : "Applies to every OpenAI model and profile.";
    var disabled = state.openAiAuthMethodBusy || !changed;
    return '<div class="openai-auth-choice"><label class="field-label" for="openai-auth-method">Use for OpenAI calls</label>' +
      '<div class="openai-auth-choice-row"><span class="select-wrap"><select class="input" id="openai-auth-method" data-action="openai-auth-method"' + (state.openAiAuthMethodBusy ? " disabled" : "") + '>' +
      '<option value="subscription"' + (draft === "subscription" ? " selected" : "") + '>ChatGPT subscription</option>' +
      '<option value="api_key"' + (draft === "api_key" ? " selected" : "") + '>OpenAI API key</option></select>' + icon("chevron-down", "select-caret") + '</span>' +
      '<button type="button" class="btn btn-primary" data-action="openai-auth-method-save"' + (disabled ? " disabled" : "") + '>' + (state.openAiAuthMethodBusy ? "Saving&hellip;" : "Save") + '</button></div>' +
      '<p class="hint">' + esc(hint) + '</p>' +
      (state.openAiAuthMethodError ? '<p class="field-error" role="alert">' + esc(state.openAiAuthMethodError) + '</p>' : "") + '</div>';
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

  function openAiSubscriptionSummary() {
    return providerSummaryById("openai").subscription || { state: "disconnected", updatedAt: 0 };
  }

  function openAiSubscriptionFailureText(code) {
    if (code === "auth_reconnect_required") return "Authorization expired or was revoked. Reconnect before OpenAI calls can continue.";
    if (code === "authorization_expired") return "The authorization window expired. Start again when you are ready.";
    if (code === "entitlement_denied") return "This ChatGPT account is not entitled to the requested model.";
    if (code === "subscription_quota_exhausted") return "The ChatGPT subscription quota is exhausted. Chickpea will not switch to API billing.";
    if (code === "client_rejected" || code === "originator_rejected") return "OpenAI rejected Chickpea's experimental client identity. Subscription calls are stopped.";
    if (code === "protocol_drift" || code === "invalid_response") return "OpenAI's private interface changed. Subscription calls are stopped until Chickpea is updated.";
    if (code === "request_timeout" || code === "provider_unavailable") return "OpenAI subscription service is temporarily unavailable. Try again without changing billing methods.";
    return "Subscription authorization needs attention.";
  }

  function openAiSubscriptionHtml(status, activeMethod, showSelection) {
    var attempt = state.openAiSubscriptionAttempt;
    var busy = state.openAiSubscriptionBusy;
    var stateName = status.state || "disconnected";
    var badge = stateName === "connected"
      ? '<span class="badge badge-on"><span class="dot"></span>Connected</span>'
      : stateName === "authorizing"
        ? '<span class="badge badge-off"><span class="dot"></span>Authorizing</span>'
        : stateName === "account_change_confirmation_required"
          ? '<span class="badge badge-off"><span class="dot"></span>Confirm account change</span>'
          : stateName === "reconnect_required"
            ? '<span class="badge badge-off"><span class="dot"></span>Reconnect required</span>'
            : '<span class="badge badge-off"><span class="dot"></span>Not connected</span>';
    var actions = "";
    var detail = "";
    if (stateName === "authorizing" && attempt) {
      detail = '<div class="callout"><span><b>Open the authorization page, then enter this one-time code:</b><br>' +
        '<a href="' + esc(attempt.verificationUri) + '" target="_blank" rel="noopener noreferrer">' + esc(attempt.verificationUri) + ' &nearr;</a><br>' +
        '<span class="mono" style="font-size:1.15rem; letter-spacing:.08em;">' + esc(attempt.userCode) + '</span> ' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="openai-subscription-copy-code">Copy code</button>' +
        (state.openAiSubscriptionCopyStatus ? '<span class="inline-status" role="status">' + esc(state.openAiSubscriptionCopyStatus) + '</span>' : "") +
        '</span></div>';
      actions = '<button type="button" class="btn btn-soft btn-sm" data-action="openai-subscription-poll"' + (busy ? " disabled" : "") + '>' + (busy === "poll" ? "Checking&hellip;" : "Check connection") + '</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="openai-subscription-cancel"' + (busy ? " disabled" : "") + '>Cancel</button>';
    } else if (stateName === "authorizing") {
      detail = '<p class="hint">Authorization was started in another page or before this reload. The code and browser capability cannot be recovered here; wait for that page to finish, or retry after the attempt expires.</p>';
    } else if (stateName === "account_change_confirmation_required" && attempt) {
      detail = '<div class="callout">This would replace the connected ChatGPT account with <span class="mono">' + esc(status.accountFingerprint || "a different account") + '</span>. OpenAI calls stay on the current account until you confirm.</div>';
      actions = '<button type="button" class="btn btn-primary btn-sm" data-action="openai-subscription-confirm-account"' + (busy ? " disabled" : "") + '>Confirm account change</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="openai-subscription-cancel"' + (busy ? " disabled" : "") + '>Keep current account</button>';
    } else if (stateName === "connected") {
      detail = status.accountFingerprint ? '<p class="hint">Account <span class="mono">' + esc(status.accountFingerprint) + '</span></p>' : "";
      actions = '<button type="button" class="btn btn-soft btn-sm" data-action="openai-subscription-start"' + (busy ? " disabled" : "") + '>Reconnect</button>' +
        '<button type="button" class="btn btn-danger btn-sm" data-action="openai-subscription-disconnect-open"' + (busy ? " disabled" : "") + '>Disconnect</button>';
    } else {
      if (status.failureCode) detail = '<p class="field-error" role="alert">' + esc(openAiSubscriptionFailureText(status.failureCode)) + '</p>';
      actions = '<button type="button" class="btn btn-primary btn-sm" data-action="openai-subscription-start"' + (busy ? " disabled" : "") + '>' + (busy === "start" ? "Starting&hellip;" : stateName === "reconnect_required" ? "Reconnect subscription" : "Connect subscription") + '</button>';
    }
    if (state.openAiSubscriptionDisconnectConfirm) {
      detail += '<div class="danger-panel"><div class="danger-copy"><span class="danger-title">Disconnect the ChatGPT subscription?</span><span class="hint">Stored tokens and account identity are deleted immediately. A connected API key becomes the OpenAI method automatically; without one, OpenAI calls stop.</span></div>' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="openai-subscription-disconnect-cancel">Keep connected</button>' +
        '<button type="button" class="btn btn-danger btn-sm" data-action="openai-subscription-disconnect-confirm"' + (busy ? " disabled" : "") + '>Disconnect</button></div>';
      actions = "";
    }
    var subscriptionSelected = showSelection && activeMethod === "subscription";
    var inUse = subscriptionSelected ? '<span class="badge badge-on"><span class="dot"></span>Selected</span>' : "";
    return '<div class="openai-auth-option ' + (subscriptionSelected ? "active" : "") + '"><div class="openai-auth-head"><div class="openai-auth-copy">' +
      '<span class="openai-auth-title">ChatGPT subscription</span><span class="openai-auth-meta">ChatGPT plan</span></div>' + inUse + badge +
      (actions ? '<div class="prov-actions">' + actions + '</div>' : "") + '</div>' +
      detail + (state.openAiSubscriptionError ? '<p class="field-error" role="alert">' + esc(state.openAiSubscriptionError) + '</p>' : "") + '</div>';
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
    var subscriptionReady = id === "openai" && summary && summary.subscription && (
      summary.subscription.state === "connected" || summary.subscription.state === "account_change_confirmation_required"
    );
    if (subscriptionReady) {
      consequence = lead + 'The connected ChatGPT subscription becomes the OpenAI method automatically.';
    } else if (count === 0) {
      consequence = lead + 'No profiles are pinned to an ' + esc(meta.name) + ' model right now, so nothing stops answering. ' + envNote;
    } else {
      consequence = lead + '<b style="font-weight:500; color:var(--text);">' + count + ' profile' + (count === 1 ? "" : "s") + '</b> ' + (count === 1 ? "is" : "are") +
        ' pinned to an ' + esc(meta.name) + ' model &mdash; ' + names + '. They keep their pin, but until an ' + esc(meta.name) +
        ' key returns each fails at reply time: the thread gets one sanitized line &mdash; <i>&ldquo;I reached the Slack thread, but the model provider call failed before completion.&rdquo;</i> &mdash; and no provider error leaks to Slack. Re-pin them to another provider to keep answering. ' + envNote;
    }
    var errLine = summary && provUiFor(id).removeError ? '<p class="field-error">' + esc(provUiFor(id).removeError) + '</p>' : "";
    return '<div class="callout">' + icon("exclamation-triangle", "ic-l g") + '<span>' + consequence + '</span></div>' + errLine +
      '<div style="display:flex; gap:10px;">' +
      '<button type="button" class="btn btn-soft btn-sm" data-action="prov-remove-cancel" data-provider="' + esc(id) + '">Keep key</button>' +
      '<button type="button" class="btn btn-danger btn-sm" data-action="prov-remove-confirm" data-provider="' + esc(id) + '">Remove key</button></div>';
  }

  function favSearchCountLabel(id) {
    var count = providerModelCount(id, providerSummaryById(id));
    if (id === "openrouter") return (count != null ? count : "many") + " models";
    return (count != null ? count : "many") + " text-generation models";
  }

  function favManagerHtml(id) {
    var isOr = id === "openrouter";
    var query = (favUiFor(id).query) || "";
    var count = providerModelCount(id, providerSummaryById(id));
    var preamble = isOr ? "" : '<p class="hint">No key to manage. The <span class="mono" style="color:var(--text-2);">env.AI</span> binding lists models and runs turns on the Cloudflare target with zero credentials &mdash; this is the model a keyless button deploy answers with. Catalog-free <span class="mono" style="color:var(--text-2);">cloudflare/*</span> models declare no context window, so auto-compaction stays off for them.</p>';
    var intro = isOr
      ? '<p class="hint">OpenRouter serves ' + esc(favSearchCountLabel(id)) + ', so the profile picker shows only the ones you star here. Search the live list &mdash; name, context length, and price per row &mdash; then star to add.</p>'
      : '<p class="hint">The binding lists ' + esc(favSearchCountLabel(id)) + ' and keeps growing, so the profile picker shows only the ones you star here &mdash; same as OpenRouter. Search the live <span class="mono" style="color:var(--text-2);">env.AI.models()</span> list, then star to add. Four defaults ship pre-starred, so the keyless picker works out of the box.</p>';
    var search = '<input class="input" type="search" value="' + esc(query) + '" placeholder="' + esc((count != null ? "Search " + count + " " : "Search ") + (isOr ? "OpenRouter" : "Workers AI") + " models…") + '" aria-label="Search ' + (isOr ? "OpenRouter" : "Workers AI") + ' models" data-action="fav-search" data-provider="' + esc(id) + '">';
    var foot = isOr
      ? '<p class="hint">Star adds a model to every profile\\'s OpenRouter group; unstar removes it. Prices are input / output per 1M tokens, straight from OpenRouter\\'s public list.</p>'
      : '<p class="hint">Star adds a model to every profile\\'s Workers AI group; unstar removes it. No per-row price or context here: Workers AI is billed in Neurons through the binding, and <span class="mono" style="color:var(--text-2);">cloudflare/*</span> models declare no context window. <span class="mono" style="color:var(--text-2);">@cf/zai-org/glm-5.2</span> is the seed default a keyless deploy pins &mdash; keep it starred to keep that default in the picker.</p>';
    return preamble +
      '<p class="field-label">Models in your picker</p>' + intro + search +
      '<div id="fav-results-' + esc(id) + '">' + favResultsHtml(id) + '</div>' +
      '<div id="fav-starred-' + esc(id) + '">' + favStarredHtml(id) + '</div>' +
      foot;
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
    return header + '<div class="fav-list">' + matches.map(function (model) { return favRowHtml(id, model, false); }).join("") + '</div>';
  }

  function favStarredHtml(id) {
    var favs = favoritesFor(id);
    var models = state.providerModels[id] || [];
    var byId = {};
    models.forEach(function (model) { byId[model.id] = model; });
    var header = '<p class="fav-sub" style="padding:6px 0 3px;">In your picker &middot; ' + favs.length + ' starred</p>';
    if (favs.length === 0) return header + '<p class="fav-empty">Nothing starred yet. Search above and star a model to add it to the picker.</p>';
    var rows = favs.map(function (mid) { return favRowHtml(id, byId[mid] || { id: mid }, true); }).join("");
    return header + '<div class="fav-list">' + rows + '</div>';
  }

  function favRowHtml(id, model, on) {
    var metaHtml = "";
    if (id === "openrouter") {
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
      "github-settings": "github",
      "sandbox-settings": "sandbox",
      "egress-settings": "outbound"
    };
    var section = aliases[String(value || "")] || String(value || "");
    return ["slack", "providers", "github", "sandbox", "outbound"].includes(section) ? section : "providers";
  }

  function resetSlackIdentityManagement(screen) {
    state.slackIdentityGeneration += 1;
    state.slackIdentityScreen = screen || "list";
    state.slackIdentitySelectedId = "";
    state.slackIdentityDetail = null;
    state.slackIdentityDetailLoading = false;
    state.slackIdentityDetailError = "";
    state.slackIdentityBusy = "";
    state.slackIdentityActionError = "";
    state.slackIdentityNotice = "";
    state.slackIdentityConfirm = null;
    state.slackIdentitySetupStage = 2;
    state.slackIdentityReconnectOpen = false;
    state.slackIdentityCredentialDraft = { botToken: "", signingSecret: "" };
    state.slackIdentitySetupDraft = { appName: "", displayName: "" };
    state.slackIdentityDmDraft = { dmState: "off", dmAgentId: "" };
    if (screen === "create") {
      var firstEnabled = state.agents.find(function (agent) { return agent.enabled; });
      state.slackIdentityCreateDraft = {
        appName: "",
        displayName: "",
        initialDmAgentId: firstEnabled ? firstEnabled.id : ""
      };
    }
  }

  function openSlackIdentitiesRoute(identityId, suffix) {
    state.view = "settings";
    state.settingsSection = "slack";
    state.profileScreen = "list";
    resetSlackIdentityManagement(identityId ? (suffix === "setup" ? "setup" : "detail") : "list");
    state.slackIdentitySelectedId = identityId || "";
    render();
    if (identityId) loadSlackIdentityDetail(identityId);
  }

  function mergeSlackIdentitySummary(identity) {
    if (!identity || !identity.id) return;
    var items = state.slackIdentities.identities || [];
    var index = items.findIndex(function (candidate) { return candidate.id === identity.id; });
    if (index >= 0) items[index] = identity;
    else items.push(identity);
  }

  function loadSlackIdentityDetail(identityId) {
    if (!identityId) return Promise.resolve(null);
    var generation = state.slackIdentityGeneration;
    state.slackIdentityDetailLoading = true;
    state.slackIdentityDetailError = "";
    render();
    return api("/admin/api/slack-identities/" + encodeURIComponent(identityId)).then(function (body) {
      if (state.slackIdentityGeneration !== generation || state.slackIdentitySelectedId !== identityId) return null;
      state.slackIdentityDetail = body;
      state.slackIdentityDetailLoading = false;
      state.slackIdentityCredentialDraft = { botToken: "", signingSecret: "" };
      if (body.setup) {
        state.slackIdentitySetupDraft = {
          appName: body.setup.appName || "",
          displayName: body.setup.botDisplayName || ""
        };
      }
      state.slackIdentitySetupStage = body.identity && body.identity.lifecycle === "credentials_pending" ? 4 : 2;
      state.slackIdentityDmDraft = {
        dmState: body.identity.dmState === "on" ? "on" : "off",
        dmAgentId: body.identity.dmAgentId || ""
      };
      mergeSlackIdentitySummary(body.identity);
      render();
      return body;
    }).catch(function (error) {
      if (state.slackIdentityGeneration !== generation || state.slackIdentitySelectedId !== identityId) return null;
      state.slackIdentityDetailLoading = false;
      state.slackIdentityDetailError = error.serverMessage || error.message || "Could not load this Slack identity.";
      render();
      return null;
    });
  }

  function slackIdentityActionErrorText(error) {
    var code = error && error.payload && error.payload.error;
    if (code === "workspace_mismatch") return "That Slack app belongs to a different workspace. Install it in " + connectedTeamName() + " and try again.";
    if (code === "app_already_connected") return "That Slack app is already connected to another identity.";
    if (code === "challenge_invalid_signature") return "Slack's signed callback did not match this Signing Secret. Recopy the secret, retry the Request URL in Slack, and try again.";
    if (code === "challenge_expired") return "Slack's signed callback expired. Use Retry beside the Request URL in Slack, then verify again.";
    if (code === "challenge_missing") return "No signed Slack callback is waiting yet. Save or retry the Request URL in Slack, then verify again.";
    if (code === "slack_unreachable") return "Slack could not be reached. Nothing changed; try again when Slack is available.";
    if (code === "slack_identity_changed" || code === "slack_identity_credentials_changed") return "This Slack identity changed in another session. Reload it and try again.";
    return (error && (error.serverMessage || error.message)) || "Could not update this Slack identity.";
  }

  function slackIdentityActionIsCurrent(generation, identityId) {
    return state.slackIdentityGeneration === generation &&
      (!identityId || state.slackIdentitySelectedId === identityId);
  }

  function createManagedSlackIdentity(form) {
    if (state.slackIdentityBusy) return;
    var appName = String(form.get("appName") || "").trim();
    var displayName = String(form.get("displayName") || "").trim();
    var dmAgentId = String(form.get("initialDmAgentId") || "");
    if (!appName || !displayName || !dmAgentId) {
      state.slackIdentityActionError = "Choose both names and an enabled Profile to handle DMs.";
      render();
      return;
    }
    state.slackIdentityBusy = "create";
    state.slackIdentityActionError = "";
    var generation = state.slackIdentityGeneration;
    render();
    postJson("/admin/api/slack-identities", "POST", {
      source: "settings",
      initialDmAgentId: dmAgentId,
      appName: appName,
      displayName: displayName
    }).then(function (body) {
      if (!slackIdentityActionIsCurrent(generation, "")) return;
      mergeSlackIdentitySummary(body.identity);
      state.slackIdentityBusy = "";
      openSlackIdentitiesRoute(body.identity.id, "setup");
    }).catch(function (error) {
      if (!slackIdentityActionIsCurrent(generation, "")) return;
      state.slackIdentityBusy = "";
      state.slackIdentityActionError = slackIdentityActionErrorText(error);
      render();
    });
  }

  function saveSlackIdentitySetupNames(form) {
    var detail = state.slackIdentityDetail;
    if (!detail || state.slackIdentityBusy) return;
    state.slackIdentityBusy = "names";
    state.slackIdentityActionError = "";
    var generation = state.slackIdentityGeneration;
    var identityId = detail.identity.id;
    render();
    postJson(
      "/admin/api/slack-identities/" + encodeURIComponent(detail.identity.id) + "/setup",
      "PATCH",
      {
        expectedRevision: detail.identity.connectionRevision,
        appName: String(form.get("appName") || "").trim(),
        displayName: String(form.get("displayName") || "").trim()
      }
    ).then(function (body) {
      if (!slackIdentityActionIsCurrent(generation, identityId)) return;
      state.slackIdentityDetail = body;
      state.slackIdentitySetupDraft = { appName: body.setup.appName, displayName: body.setup.botDisplayName };
      state.slackIdentityBusy = "";
      state.slackIdentityNotice = "Names saved. The manifest link now uses them.";
      mergeSlackIdentitySummary(body.identity);
      render();
    }).catch(function (error) {
      if (!slackIdentityActionIsCurrent(generation, identityId)) return;
      state.slackIdentityBusy = "";
      state.slackIdentityActionError = slackIdentityActionErrorText(error);
      render();
    });
  }

  function connectManagedSlackIdentity(form, reconnecting) {
    var detail = state.slackIdentityDetail;
    if (!detail || state.slackIdentityBusy) return;
    var botToken = String(form.get("botToken") || "").trim();
    var signingSecret = String(form.get("signingSecret") || "").trim();
    if (!botToken || !signingSecret) {
      state.slackIdentityActionError = "Paste both the Bot User OAuth Token and Signing Secret.";
      render();
      return;
    }
    state.slackIdentityBusy = "connect";
    state.slackIdentityActionError = "";
    var generation = state.slackIdentityGeneration;
    var identityId = detail.identity.id;
    render();
    postJson(
      "/admin/api/slack-identities/" + encodeURIComponent(detail.identity.id) + "/connect",
      "POST",
      {
        expectedRevision: detail.identity.connectionRevision,
        botToken: botToken,
        signingSecret: signingSecret
      }
    ).then(function (body) {
      state.slackIdentityCredentialDraft = { botToken: "", signingSecret: "" };
      if (!slackIdentityActionIsCurrent(generation, identityId)) return;
      state.slackIdentityBusy = "";
      state.slackIdentityReconnectOpen = false;
      state.slackIdentityScreen = "setup";
      state.slackIdentitySetupStage = 4;
      state.slackIdentityDetail.identity = body.identity;
      state.slackIdentityNotice = reconnecting ? "New credentials validated. Verify Slack's signed callback to finish reconnecting." : "Credentials validated and cleared from this browser.";
      mergeSlackIdentitySummary(body.identity);
      render();
    }).catch(function (error) {
      state.slackIdentityCredentialDraft = { botToken: "", signingSecret: "" };
      if (!slackIdentityActionIsCurrent(generation, identityId)) return;
      state.slackIdentityBusy = "";
      state.slackIdentityActionError = slackIdentityActionErrorText(error);
      render();
    });
  }

  function verifyManagedSlackIdentity() {
    var detail = state.slackIdentityDetail;
    if (!detail || state.slackIdentityBusy) return;
    state.slackIdentityBusy = "verify";
    state.slackIdentityActionError = "";
    var generation = state.slackIdentityGeneration;
    var identityId = detail.identity.id;
    render();
    postJson(
      "/admin/api/slack-identities/" + encodeURIComponent(detail.identity.id) + "/verify",
      "POST",
      { expectedRevision: detail.identity.connectionRevision }
    ).then(function (body) {
      if (!slackIdentityActionIsCurrent(generation, identityId)) return;
      state.slackIdentityBusy = "";
      state.slackIdentityScreen = "detail";
      state.slackIdentityDetail = { identity: body.identity, setup: null };
      state.slackIdentityNotice = body.attachedProfileId
        ? "Identity connected and attached to its creating Profile."
        : "Identity connected. No Profile's Replies as selection was changed.";
      state.slackIdentityDmDraft = { dmState: body.identity.dmState, dmAgentId: body.identity.dmAgentId || "" };
      mergeSlackIdentitySummary(body.identity);
      render();
    }).catch(function (error) {
      if (!slackIdentityActionIsCurrent(generation, identityId)) return;
      state.slackIdentityBusy = "";
      state.slackIdentityActionError = slackIdentityActionErrorText(error);
      render();
    });
  }

  function refreshManagedSlackIdentity() {
    var detail = state.slackIdentityDetail;
    if (!detail || state.slackIdentityBusy) return;
    state.slackIdentityBusy = "refresh";
    state.slackIdentityActionError = "";
    var generation = state.slackIdentityGeneration;
    var identityId = detail.identity.id;
    render();
    postJson(
      "/admin/api/slack-identities/" + encodeURIComponent(detail.identity.id) + "/refresh",
      "POST",
      { expectedRevision: detail.identity.connectionRevision }
    ).then(function (body) {
      if (!slackIdentityActionIsCurrent(generation, identityId)) return;
      state.slackIdentityBusy = "";
      state.slackIdentityDetail.identity = body.identity;
      state.slackIdentityNotice = "Refreshed Slack-owned appearance and connection health.";
      mergeSlackIdentitySummary(body.identity);
      render();
    }).catch(function (error) {
      if (!slackIdentityActionIsCurrent(generation, identityId)) return;
      state.slackIdentityBusy = "";
      state.slackIdentityActionError = slackIdentityActionErrorText(error);
      render();
    });
  }

  function applySlackIdentityConfirmation() {
    var detail = state.slackIdentityDetail;
    var confirmation = state.slackIdentityConfirm;
    if (!detail || !confirmation || state.slackIdentityBusy) return;
    var identity = detail.identity;
    var generation = state.slackIdentityGeneration;
    state.slackIdentityBusy = confirmation.type;
    state.slackIdentityActionError = "";
    render();
    var request;
    if (confirmation.type === "cancel") {
      request = postJson("/admin/api/slack-identities/" + encodeURIComponent(identity.id) + "/cancel", "POST", { expectedRevision: identity.connectionRevision, deleteDraft: true });
    } else if (confirmation.type === "retire") {
      request = postJson("/admin/api/slack-identities/" + encodeURIComponent(identity.id) + "/retire", "POST", { expectedRevision: identity.connectionRevision });
    } else {
      request = postJson("/admin/api/slack-identities/" + encodeURIComponent(identity.id) + "/dms", "PATCH", {
        expectedRevision: identity.connectionRevision,
        dmState: confirmation.dmState,
        dmAgentId: confirmation.dmAgentId
      });
    }
    request.then(function (body) {
      if (!slackIdentityActionIsCurrent(generation, identity.id)) return;
      state.slackIdentityBusy = "";
      state.slackIdentityConfirm = null;
      if (confirmation.type === "cancel") {
        state.slackIdentities.identities = state.slackIdentities.identities.filter(function (candidate) { return candidate.id !== identity.id; });
        resetSlackIdentityManagement("list");
        state.slackIdentityNotice = "Setup canceled after its stored credentials and callback were erased.";
        render();
        return;
      }
      state.slackIdentityDetail.identity = body.identity;
      mergeSlackIdentitySummary(body.identity);
      if (confirmation.type === "retire") {
        state.slackIdentityNotice = body.message || "Retired locally. The Slack app was not uninstalled or revoked.";
      } else {
        state.slackIdentityDmDraft = { dmState: body.identity.dmState, dmAgentId: body.identity.dmAgentId || "" };
        state.slackIdentityNotice = "DM behavior updated for future turns.";
      }
      render();
    }).catch(function (error) {
      if (!slackIdentityActionIsCurrent(generation, identity.id)) return;
      state.slackIdentityBusy = "";
      state.slackIdentityActionError = slackIdentityActionErrorText(error);
      render();
    });
  }

  function openSettings(sectionId) {
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
      resetSlackIdentityManagement("list");
      render();
      return;
    }
    render();
    loadSettings().then(render);
    loadModelCatalogStatus().then(render);
    loadGithubStatus().then(render);
    loadEgress().then(render);
    loadSandboxStatus().then(render);
  }

  function loadGithubStatus() {
    var requestId = ++state.githubStatusRequestId;
    state.githubError = "";
    return api("/admin/api/github/status").then(function (body) {
      if (requestId !== state.githubStatusRequestId) return;
      state.githubStatus = body;
      state.githubStatusLoaded = true;
      state.githubBusy = "";
    }).catch(function (error) {
      if (requestId !== state.githubStatusRequestId) return;
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

  function loadRepositoryPickerRepos() {
    var picker = state.repositoryPicker;
    if (!picker) return Promise.resolve();
    var requestId = (picker.requestId || 0) + 1;
    picker.requestId = requestId;
    picker.loading = true;
    picker.error = "";
    render();
    focusRepositorySearch();
    var source = String(picker.installationId);
    var path = "/admin/api/github/installations/" + encodeURIComponent(source) + "/repos?q=" + encodeURIComponent(picker.query || "") + "&page=1";
    return api(path).then(function (body) {
      if (state.repositoryPicker !== picker || picker.requestId !== requestId) return;
      picker.repos = (body && body.repos) || [];
      picker.totalCount = Number((body && body.totalCount) || 0);
      picker.truncated = !!(body && body.truncated);
      // Accumulate every name this picker session has confirmed the current
      // App installation can reach before adopting an older unbound grant.
      picker.seenFullNames = picker.seenFullNames || {};
      picker.repos.forEach(function (repo) {
        if (repo && repo.fullName) picker.seenFullNames[repo.fullName] = true;
      });
      picker.loading = false;
      picker.error = "";
      render();
      focusRepositorySearch();
    }).catch(function (error) {
      if (state.repositoryPicker !== picker || picker.requestId !== requestId) return;
      picker.loading = false;
      picker.error = (error && (error.serverMessage || error.message)) || "Could not load repositories.";
      render();
      focusRepositorySearch();
    });
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
      selectedFullNames: selected,
      loading: true,
      error: "",
      requestId: 0
    };
    loadRepositoryPickerRepos();
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

  function scheduleRepositorySearch(query) {
    var picker = state.repositoryPicker;
    if (!picker) return;
    picker.query = query;
    // Invalidate the currently running query immediately. Otherwise its
    // response can land during this query's debounce window and briefly show
    // results for the previous text beneath the new input value.
    picker.requestId = (picker.requestId || 0) + 1;
    if (repositorySearchTimer && typeof clearTimeout === "function") clearTimeout(repositorySearchTimer);
    repositorySearchTimer = null;
    var run = function () {
      repositorySearchTimer = null;
      if (state.repositoryPicker === picker) loadRepositoryPickerRepos();
    };
    if (typeof setTimeout === "function") repositorySearchTimer = setTimeout(run, 250);
    else run();
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

  function loadSettings() {
    state.settingsError = "";
    return api("/admin/api/providers").then(function (body) {
      state.settings = body;
      state.settingsLoaded = true;
      var openAi = providerSummaryById("openai");
      if (!state.openAiAuthMethodDirty) {
        state.openAiAuthMethodDraft = openAi.activeAuthMethod === "subscription" ? "subscription" : "api_key";
      }
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
      state.settingsError = error.message;
      state.settingsLoaded = true;
    });
  }

  function loadModelCatalogStatus() {
    var requestId = ++state.modelCatalogRequestId;
    state.modelCatalogError = "";
    return api("/admin/api/model-catalog").then(function (body) {
      if (requestId !== state.modelCatalogRequestId) return;
      state.modelCatalog = body;
      state.modelCatalogLoaded = true;
    }).catch(function (error) {
      if (requestId !== state.modelCatalogRequestId) return;
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

  function saveOpenAiAuthMethod() {
    if (state.openAiAuthMethodBusy || !state.openAiAuthMethodDirty) return;
    var method = state.openAiAuthMethodDraft === "subscription" ? "subscription" : "api_key";
    state.openAiAuthMethodBusy = true;
    state.openAiAuthMethodError = "";
    render();
    postJson("/admin/api/providers/openai/auth-method", "PUT", { method: method }).then(function (body) {
      state.openAiAuthMethodBusy = false;
      state.openAiAuthMethodDirty = false;
      state.openAiAuthMethodError = "";
      providerSummaryById("openai").activeAuthMethod = body.activeAuthMethod;
      invalidateOpenAiProviderModels();
      render();
      return refreshModels();
    }).catch(function (error) {
      state.openAiAuthMethodBusy = false;
      state.openAiAuthMethodError = (error && (error.serverMessage || error.message)) || "Could not change the OpenAI authentication method.";
      render();
    });
  }

  function setOpenAiSubscriptionStatus(status) {
    var summary = providerSummaryById("openai");
    summary.subscription = status;
  }

  function invalidateOpenAiProviderModels() {
    state.providerModels.openai = null;
    state.providerModelsError.openai = false;
    favUiFor("openai").error = "";
  }

  function scheduleOpenAiSubscriptionPoll() {
    var attempt = state.openAiSubscriptionAttempt;
    if (!attempt || typeof setTimeout !== "function") return;
    var capability = attempt.attemptCapability;
    var delay = Math.max(0, Math.min(60000, Number(attempt.nextPollAt || Date.now()) - Date.now()));
    setTimeout(function () {
      if (state.openAiSubscriptionAttempt && state.openAiSubscriptionAttempt.attemptCapability === capability) {
        pollOpenAiSubscription();
      }
    }, delay);
  }

  function startOpenAiSubscription() {
    if (state.openAiSubscriptionBusy) return;
    state.openAiSubscriptionBusy = "start";
    state.openAiSubscriptionError = "";
    state.openAiSubscriptionDisconnectConfirm = false;
    render();
    postJson("/admin/api/providers/openai/subscription/start", "POST", {}).then(function (started) {
      state.openAiSubscriptionBusy = "";
      state.openAiSubscriptionAttempt = started;
      state.openAiSubscriptionCopyStatus = "";
      setOpenAiSubscriptionStatus({ state: "authorizing", updatedAt: Date.now() });
      render();
      scheduleOpenAiSubscriptionPoll();
    }).catch(function (error) {
      state.openAiSubscriptionBusy = "";
      state.openAiSubscriptionError = openAiSubscriptionFailureText(error && error.message);
      render();
    });
  }

  function pollOpenAiSubscription() {
    var attempt = state.openAiSubscriptionAttempt;
    if (!attempt || state.openAiSubscriptionBusy) return;
    state.openAiSubscriptionBusy = "poll";
    state.openAiSubscriptionError = "";
    render();
    postJson("/admin/api/providers/openai/subscription/poll", "POST", {
      attemptCapability: attempt.attemptCapability
    }).then(function (result) {
      state.openAiSubscriptionBusy = "";
      if (result.state === "pending") {
        attempt.expiresAt = result.expiresAt;
        attempt.nextPollAt = result.nextPollAt;
        render();
        scheduleOpenAiSubscriptionPoll();
        return;
      }
      setOpenAiSubscriptionStatus(result);
      if (result.state === "connected") {
        state.openAiSubscriptionAttempt = null;
        invalidateOpenAiProviderModels();
        return loadSettings().then(function () { refreshModels(); render(); });
      }
      render();
      refreshModels();
    }).catch(function (error) {
      state.openAiSubscriptionBusy = "";
      state.openAiSubscriptionError = openAiSubscriptionFailureText(error && error.message);
      if (error && (error.message === "authorization_expired" || error.message === "authorization_missing" || error.message === "attempt_forbidden")) {
        state.openAiSubscriptionAttempt = null;
      }
      render();
    });
  }

  function cancelOpenAiSubscription() {
    var attempt = state.openAiSubscriptionAttempt;
    if (!attempt || state.openAiSubscriptionBusy) return;
    state.openAiSubscriptionBusy = "cancel";
    state.openAiSubscriptionError = "";
    render();
    postJson("/admin/api/providers/openai/subscription/cancel", "POST", {
      attemptCapability: attempt.attemptCapability
    }).then(function (status) {
      state.openAiSubscriptionBusy = "";
      state.openAiSubscriptionAttempt = null;
      setOpenAiSubscriptionStatus(status);
      render();
    }).catch(function (error) {
      state.openAiSubscriptionBusy = "";
      state.openAiSubscriptionError = openAiSubscriptionFailureText(error && error.message);
      render();
    });
  }

  function confirmOpenAiSubscriptionAccount() {
    var attempt = state.openAiSubscriptionAttempt;
    if (!attempt || state.openAiSubscriptionBusy) return;
    state.openAiSubscriptionBusy = "confirm";
    state.openAiSubscriptionError = "";
    render();
    postJson("/admin/api/providers/openai/subscription/confirm-account", "POST", {
      attemptCapability: attempt.attemptCapability
    }).then(function (status) {
      state.openAiSubscriptionBusy = "";
      state.openAiSubscriptionAttempt = null;
      setOpenAiSubscriptionStatus(status);
      invalidateOpenAiProviderModels();
      return loadSettings().then(function () { refreshModels(); render(); });
    }).catch(function (error) {
      state.openAiSubscriptionBusy = "";
      state.openAiSubscriptionError = openAiSubscriptionFailureText(error && error.message);
      render();
    });
  }

  function disconnectOpenAiSubscriptionConnection() {
    if (state.openAiSubscriptionBusy) return;
    state.openAiSubscriptionBusy = "disconnect";
    state.openAiSubscriptionError = "";
    render();
    api("/admin/api/providers/openai/subscription", { method: "DELETE" }).then(function (body) {
      state.openAiSubscriptionBusy = "";
      state.openAiSubscriptionAttempt = null;
      state.openAiSubscriptionDisconnectConfirm = false;
      setOpenAiSubscriptionStatus(body.status);
      invalidateOpenAiProviderModels();
      return loadSettings().then(function () { refreshModels(); render(); });
    }).catch(function (error) {
      state.openAiSubscriptionBusy = "";
      state.openAiSubscriptionError = openAiSubscriptionFailureText(error && error.message);
      render();
    });
  }

  function copyOpenAiSubscriptionCode() {
    var code = state.openAiSubscriptionAttempt && state.openAiSubscriptionAttempt.userCode;
    if (!code || !navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(code).then(function () {
      state.openAiSubscriptionCopyStatus = "Copied";
      render();
    }).catch(function () {
      state.openAiSubscriptionCopyStatus = "Copy failed — select the code manually";
      render();
    });
  }

  function seedEgressDraft(policy) {
    var domains = (policy.domains || []).slice();
    if (policy.mode === "allowlist" && domains.length === 0) domains.push("");
    egressDraft = { mode: policy.mode, domains: domains };
  }

  function loadEgress() {
    state.egressError = "";
    return api("/admin/api/egress").then(function (body) {
      state.egress = body.policy;
      seedEgressDraft(body.policy);
      state.egressLoaded = true;
    }).catch(function (error) {
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

  function loadSandboxStatus() {
    state.sandboxError = "";
    return api("/admin/api/sandbox/status").then(function (body) {
      state.sandboxStatus = body;
      seedSandboxDraft(body);
      state.sandboxLoaded = true;
    }).catch(function (error) {
      state.sandboxStatus = null;
      state.sandboxError = (error && (error.serverMessage || error.message)) || "Could not load sandbox settings.";
      state.sandboxLoaded = true;
    });
  }

  function sandboxMutationError(error, fallback) {
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
      state.sandboxError = sandboxMutationError(error, "Could not request Sandbox installation.");
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
      state.sandboxError = sandboxMutationError(error, "Could not cancel the installation request.");
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
      state.sandboxError = sandboxMutationError(error, "Could not check Sandbox installation.");
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
      state.sandboxError = sandboxMutationError(error, "Could not save Sandbox settings.");
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
      state.sandboxError = sandboxMutationError(error, "Could not save Sandbox settings.");
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
      if (state.view === "settings" || state.modelPickerOpen) render();
    }).catch(function (error) {
      // Mark the fetch failed so the picker falls back to the provider's static
      // suggestions for this provider (offline), and the Settings manager shows
      // its own error string.
      state.providerModelsError[id] = true;
      favUiFor(id).error = favModelsErrorText(id, error);
      if (state.view === "settings" || state.modelPickerOpen) render();
    });
  }

  function refreshModels() {
    return api("/admin/api/models").then(function (body) { state.models = body; }).catch(function () {});
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
    render();
  }

  function closeModelPicker() {
    if (!state.modelPickerOpen) return;
    state.modelPickerOpen = false;
    state.modelPickerFilter = "";
    render();
  }

  // A keystroke in the Model input both pins the free-text value (draft) and
  // narrows the open picker to matching specifiers (F6 filter). Typing opens the
  // picker if it was closed. A full re-render rebuilds the popover, so restore
  // focus + caret to the input afterward (a no-op in the test harness, which
  // does not track the input element).
  function filterModelPicker(target) {
    state.profileDraft.model = target.value;
    state.modelPickerFilter = target.value;
    markProfileDirty();
    if (!state.modelPickerOpen) { openModelPicker(); return; }
    var caret = null;
    try { caret = target.selectionStart; } catch (error) { caret = null; }
    render();
    var input = document.getElementById("p-model");
    if (input && input.focus) {
      input.focus();
      if (caret != null && input.setSelectionRange) {
        try { input.setSelectionRange(caret, caret); } catch (error) { /* ignore */ }
      }
    }
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
      return '<span class="layer-tag ' + (ember ? "ember" : "") + '">' + esc(layer.label) + '</span><span class="' + (ember ? "from-addendum" : "") + '">' + esc(layer.text) + '</span>';
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
      name: "",
      instructions: "",
      enabled: true,
      model: "",
      // New profiles carry no custom skills; the array is what the API persists.
      skills: [],
      // New profiles carry no Connections either; the array is what the API persists.
      mcpServers: [],
      apiConnections: [],
      repositories: [],
      // Empty means inherit the workspace-default Slack identity. __new__ is a
      // browser-only setup intent and is never sent in the generic Profile body.
      slackIdentityId: "",
      acknowledgeUnenumeratedChannels: false,
      pendingSecrets: {},
      removedConnections: [],
      pendingApiSecrets: {},
      removedApiConnections: []
    };
  }

  function cloneAgent(agent) {
    return {
      id: agent.id,
      name: agent.name,
      instructions: agent.instructions,
      enabled: agent.enabled,
      model: agent.model || "",
      // Deep-copy each skill so the inline editor never mutates the shared
      // state.agents entry — a discard/reopen must show the persisted values.
      skills: (agent.skills || []).map(function (skill) {
        return { name: skill.name, description: skill.description, instructions: skill.instructions, enabled: skill.enabled };
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
      slackIdentityId: agent.slackIdentityId || "",
      acknowledgeUnenumeratedChannels: false,
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
    var modelInput = document.getElementById("p-model");
    var instructionsInput = document.getElementById("p-instr");
    if (nameInput) draft.name = nameInput.value.trim();
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

  // The dirty -> enabled rule for the save bar lives in saveBarHtml; this
  // mirrors it for the keystroke path, which skips a full render to preserve
  // textarea focus.
  function syncSaveBar() {
    var discard = document.querySelector('[data-action="discard-channel"]');
    var save = document.querySelector('[data-action="save-channel"]');
    if (discard) discard.disabled = !state.dirty;
    if (save) save.disabled = !state.dirty;
  }

  function channelDraftFrom(assignment) {
    return {
      enabled: assignment ? assignment.enabled : true,
      channelPromptAddendum: (assignment && assignment.channelPromptAddendum) || "",
      participationMode: (assignment && assignment.participationMode) || "ambient"
    };
  }

  function selectActive(workspaceId, channelId) {
    state.channelScreen = "detail";
    state.active = { workspaceId: workspaceId, channelId: channelId };
    var assignment = activeAssignment();
    state.channelDraft = channelDraftFrom(assignment);
    state.channelFormDraft.workspaceId = workspaceId || state.channelFormDraft.workspaceId;
    state.dirty = false;
    state.saveError = "";
    // The invite reminder belongs to the just-added channel; drop it when the
    // operator navigates elsewhere.
    state.addChannelInvite = "";
    // Re-render when the resolution lands — the click handler's synchronous
    // render() only paints the "Resolving..." placeholder.
    Promise.all([
      loadEffective(),
      loadChannelScheduledRoutines(workspaceId, channelId)
    ]).then(render);
  }

  var onboardingPollTimer = null;
  var onboardingPollRequest = false;

  function onboardingResponseSignature(value) {
    if (!value) return "";
    return [value.revision, value.stage, value.tryStartedAt, value.completedAt].join("|");
  }

  function loadOnboarding(shouldRender) {
    return api("/admin/api/onboarding").then(function (body) {
      var changed = onboardingResponseSignature(state.onboarding) !== onboardingResponseSignature(body) || !!state.onboardingError;
      state.onboarding = body;
      state.onboardingError = "";
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
    if (choose && isSlackConnected() && !state.slackChannels && !state.slackChannelsLoading) {
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
      state.onboardingError = "Setup is missing its workspace or Default profile. Refresh and try again.";
      render();
      return;
    }
    state.onboardingBusy = true;
    state.onboardingError = "";
    render();
    var savedAssignment = null;
    putAssignment(workspace.id, channel.id, agent.id, true, undefined, channel.name).then(function (result) {
      if (!result || result.isMember !== true) {
        state.onboardingBusy = false;
        state.onboardingError = result && result.isMember === false
          ? "Chickpea could not join #" + channel.name + ". Invite @Chickpea there, then Refresh and try again."
          : "Chickpea could not verify that it joined #" + channel.name + ". Refresh and try again.";
        render();
        return null;
      }
      savedAssignment = result && result.assignment;
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
      if (savedAssignment) {
        state.assignments = state.assignments.filter(function (assignment) {
          return assignment.workspaceId !== savedAssignment.workspaceId || assignment.channelId !== savedAssignment.channelId;
        });
        state.assignments.push(savedAssignment);
      }
      render();
    }).catch(function (error) {
      state.onboardingBusy = false;
      state.onboardingError = addChannelErrorText(error);
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

  function refreshData(loadIdentityAfterRender) {
    return Promise.all([
      api("/admin/api/agents"),
      api("/admin/api/assignments"),
      api("/admin/api/models"),
      // Resilient on purpose: the connection card is auxiliary — if this
      // endpoint fails, the rest of the admin page must still render.
      api("/admin/api/slack-connection").catch(function () { return null; }),
      api("/admin/api/slack-behavior").then(function (body) {
        return { body: body, error: "" };
      }).catch(function (error) {
        return { body: null, error: error.serverMessage || error.message || "Could not load Slack behavior." };
      }),
      api("/admin/api/audit/memory/scopes").then(function (body) {
        return { scopes: body.scopes || [], error: "" };
      }).catch(function (error) {
        return { scopes: null, error: error.serverMessage || error.message || "Could not load memory counts." };
      }),
      api("/admin/api/slack-identities").catch(function () {
        return { identities: [], globalDmAllowed: true };
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
      })
    ]).then(function (parts) {
      state.agents = parts[0].agents || [];
      state.assignments = parts[1].assignments || [];
      state.models = parts[2];
      state.slack = parts[3];
      state.slackBehavior = parts[4].body;
      state.slackBehaviorError = parts[4].error;
      state.slackBehaviorBusy = "";
      state.memoryScopes = parts[5].scopes;
      state.memoryScopesError = parts[5].error;
      state.slackIdentities = parts[6] || { identities: [], globalDmAllowed: true };
      state.onboarding = parts[7].body;
      state.onboardingError = parts[7].error;
      if (state.active) {
        var assignment = activeAssignment();
        if (assignment) {
          state.channelDraft = channelDraftFrom(assignment);
        }
      }
      syncChannelFormWorkspacePrefill();
      if (state.active) {
        return Promise.all([
          loadEffective(),
          loadChannelScheduledRoutines(state.active.workspaceId, state.active.channelId)
        ]);
      }
      return loadEffective();
    }).then(function () {
      render();
      if (loadIdentityAfterRender !== false) loadSlackIdentityForCurrentView();
    }).catch(function (error) {
      document.querySelector(".main-inner").innerHTML = '<div class="empty"><p class="field-label">Admin failed to load</p><p class="error">' + esc(error.message) + '</p></div>';
    });
  }

  function loadEffective() {
    state.effective = null;
    state.effectiveError = "";
    if (!state.active) return Promise.resolve();
    return api("/admin/api/effective-config?workspaceId=" + encodeURIComponent(state.active.workspaceId) + "&channelId=" + encodeURIComponent(state.active.channelId))
      .then(function (body) { state.effective = body.config; })
      .catch(function (error) { state.effectiveError = error.serverMessage || error.message; });
  }

  function putAssignment(workspaceId, channelId, agentId, enabled, addendum, label, participationMode) {
    var body = { workspaceId: workspaceId, channelId: channelId, agentId: agentId, enabled: enabled };
    var normalizedLabel = normalizeChannelLabel(label);
    if (normalizedLabel) body.channelLabel = normalizedLabel;
    if (addendum !== undefined) body.channelPromptAddendum = addendum;
    if (participationMode === "ambient" || participationMode === "mention_only") body.participationMode = participationMode;
    return postJson("/admin/api/assignments", "PUT", body);
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
    // Outside-click closes the open Model combobox (F6). A click inside the
    // combo (the input, an option, or the Settings row) is left to the
    // data-action branch below; anything else dismisses the popover. Guarded by
    // closest so it is inert unless a real .model-combo ancestor exists.
    if (state.modelPickerOpen && event.target && event.target.closest) {
      var insideCombo = event.target.closest(".model-combo");
      if (!insideCombo) closeModelPicker();
    }
    var target = event.target.closest("[data-action]");
    if (!target) return;
    var action = target.getAttribute("data-action");

    if (state.teamRemoveConfirm) {
      if (action === "team-remove-cancel") {
        state.teamRemoveConfirm = null;
        render();
      } else if (action === "team-remove-confirm") {
        var confirmedMembershipId = state.teamRemoveConfirm.membershipId;
        state.teamRemoveConfirm = null;
        updateTeamMembership(confirmedMembershipId, "status", "removed");
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
        focusSlackDisconnectAction("slack-disconnect-open");
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
        focusSlackDisconnectAction("github-disconnect-open");
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

    if (state.memoryDeleteConfirm) {
      if (action === "memory-delete-cancel") {
        state.memoryDeleteConfirm = false;
        render();
      } else if (action === "memory-delete-confirm") {
        deleteMemoryEntry();
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
    if (state.view === "audit" && state.memoryDirty && (
      action === "open-channels" || action === "open-profiles" || action === "open-team" || action === "open-settings" ||
      action === "open-audit" || action === "open-usage" || action === "go-home" || action === "audit-tab-scheduled"
    )) {
      state.memoryError = "Save or discard the current memory draft before navigating away.";
      render();
      return;
    }

    // Disconnect is an atomic transition. Do not let navigation or another
    // action make the operation appear canceled while its request is live.
    if (state.githubBusy === "disconnect") return;

    // A credential replacement is a short, atomic transition. Do not let a
    // navigation or second connection action make it look canceled while the
    // POST is still live. Read-only connection tests may finish in the
    // background, but they cannot overlap another connection operation.
    if (state.slackConnectionBusy === "update") return;
    if (state.slackConnectionBusy && (
      action === "slack-test" ||
      action === "slack-update-open" ||
      action === "slack-update-close" ||
      action === "slack-disconnect-open"
    )) return;

    // Unsaved-changes guard. The modal's own buttons resolve it; while it is
    // open, no other click acts; and an attempt to leave a dirty editor opens
    // it instead of navigating.
    if (action === "leave-cancel") { state.leavePrompt = null; render(); return; }
    if (action === "leave-discard") { performProfileLeave(state.leavePrompt); return; }
    if (action === "leave-save") {
      var pendingLeave = state.leavePrompt;
      state.leavePrompt = null;
      saveProfile(function () { performProfileLeave(pendingLeave); });
      return;
    }
    if (state.leavePrompt) { return; }
    if (action === "edit-profile" && state.profileScreen === "edit" && target.getAttribute("data-agent") === state.editingAgentId) return;
    if (state.profileScreen === "edit" && state.profileDirty && isEditLeaveAction(action)) {
      state.leavePrompt = {
        action: action,
        agent: (target.getAttribute("data-agent") || ""),
        section: (target.getAttribute("data-section") || "")
      };
      render();
      return;
    }

    // Channels is the platform overview. Concrete rows remain detail screens
    // underneath it; the brand and top-level Channels button always return here.
    if (action === "open-channels") { openChannels(); }
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
    if (action === "team-dismiss-reset") { state.teamResetLink = ""; state.teamNotice = ""; render(); }
    if (action === "team-copy-link" && state.teamInviteLink) {
      var copiedInviteLink = state.teamInviteLink;
      var copyVersion = state.teamInviteCopyVersion + 1;
      var copyFailureMessage = "Copy failed. Select the join link below and copy it manually.";
      state.teamInviteCopyVersion = copyVersion;
      var showManualInviteCopy = function () {
        if (state.teamInviteCopyVersion !== copyVersion || state.teamInviteLink !== copiedInviteLink) return;
        state.teamInviteManualCopy = true;
        state.teamError = copyFailureMessage;
        render();
      };
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        showManualInviteCopy();
        return;
      }
      var clipboardWrite;
      try {
        clipboardWrite = navigator.clipboard.writeText(copiedInviteLink);
      } catch (_error) {
        showManualInviteCopy();
        return;
      }
      Promise.resolve(clipboardWrite).then(function () {
        if (state.teamInviteCopyVersion !== copyVersion || state.teamInviteLink !== copiedInviteLink) return;
        state.teamInviteCopied = true;
        state.teamInviteManualCopy = false;
        if (state.teamError === copyFailureMessage) state.teamError = "";
        render();
      }).catch(showManualInviteCopy);
    }
    if (action === "team-copy-invitation") {
      var invitationLink = target.getAttribute("data-link") || "";
      if (invitationLink) {
        navigator.clipboard.writeText(invitationLink).then(function () {
          state.teamNotice = "Join link copied.";
          render();
        }).catch(function () {
          state.teamError = "Copy failed. Reload the page and try again.";
          render();
        });
      } else {
        state.teamError = "This join link is no longer available to copy. Revoke it before creating a replacement.";
        render();
      }
    }
    if (action === "team-revoke") { revokeTeamInvitation(target.getAttribute("data-invitation") || ""); }
    if (action === "team-reset-password") { createTeamPasswordReset(target.getAttribute("data-membership") || ""); }
    if (action === "team-remove-open") {
      var removeMembershipId = target.getAttribute("data-membership") || "";
      var removeMember = state.team && (state.team.members || []).find(function (member) { return member.id === removeMembershipId; });
      if (removeMember && removeMember.role !== "owner" && !state.teamBusy) {
        state.teamRemoveConfirm = {
          membershipId: removeMember.id,
          email: removeMember.email || "",
          displayName: removeMember.displayName || ""
        };
        render();
      }
    }
    if (action === "team-copy-reset" && state.teamResetLink) {
      navigator.clipboard.writeText(state.teamResetLink).then(function () {
        state.teamNotice = "Password reset link copied.";
        render();
      }).catch(function () {
        state.teamError = "Copy failed. Select the reset link and copy it manually.";
        render();
      });
    }
    if (action === "open-usage" && USAGE_ADMIN_UI) { openUsage(); }
    if (action === "open-audit") { openAuditLogs("", "", ""); }
    // Brand-as-home: the reliable exit back to the Channels overview.
    if (action === "go-home") { openChannels(); }
    // Stepper: mark step 1 done and reveal step 2. Not preventing default lets
    // the Create anchor still open Slack in a new tab.
    if (action === "advance-slack-step") { state.slackStep = 2; state.slackError = ""; state.slackRepair = null; render(); }
    if (action === "slack-app-created") { state.slackStep = 3; state.slackError = ""; state.slackRepair = null; render(); }
    if (action === "back-to-slack-create") { resetOnboardingSlackContinuation(true); state.slackStep = 1; render(); }
    if (action === "slack-permissions-open" && state.slackOnboardingContinuation && !state.slackConnectionBusy) {
      state.slackOnboardingContinuation = {
        phase: "awaiting",
        consoleUrl: state.slackOnboardingContinuation.consoleUrl || "",
        note: "Finish in Slack, then return to this tab and check again."
      };
      render();
    }
    if (action === "slack-permissions-check" && state.slackOnboardingContinuation && !state.slackConnectionBusy) {
      submitSlackCredentialPair(state.slackDraft.botToken, state.slackDraft.signingSecret);
    }
    if (action === "slack-permissions-start-over" && state.slackOnboardingContinuation && !state.slackConnectionBusy) {
      resetOnboardingSlackContinuation(true);
      state.slackStep = 3;
      state.slackOnboardingFocus = "onboarding-signing-secret";
      render();
    }
    if (action === "refresh-onboarding-channels") { loadSlackChannels(true); }
    if (action === "retry-onboarding") { state.onboardingError = ""; loadOnboarding(true); }
    if (action === "copy-onboarding-prompt") { copyOnboardingPrompt(); }
    if (action === "dismiss-slack-toast") { state.slackToastDismissed = true; render(); }
    if (action === "select-channel") { state.view = "channels"; state.channelScreen = "detail"; selectActive(target.getAttribute("data-workspace"), target.getAttribute("data-channel")); render(); }
    if (action === "open-channel-memory") {
      openAuditLogs(target.getAttribute("data-store") || "", target.getAttribute("data-channel") || "", "");
    }
    if (action === "open-channel-scheduled") {
      openChannelScheduledWork(target.getAttribute("data-workspace") || "", target.getAttribute("data-channel") || "");
    }
    if (action === "toggle-add-channel") { openAddChannel(); }
    if (action === "cancel-add-channel") { state.addChannelOpen = false; state.addChannelManual = false; state.addChannelError = ""; state.addChannelAgentId = ""; render(); }
    if (action === "refresh-channels") { loadSlackChannels(true); }
    if (action === "slack-identity-refresh") { loadSlackIdentity(true, true); }
    if (action === "slack-identity-create-open") {
      resetSlackIdentityManagement("create");
      render();
    }
    if (action === "slack-identities-back") {
      resetSlackIdentityManagement("list");
      render();
    }
    if (action === "slack-identity-open-setup") {
      openSlackIdentitiesRoute(target.getAttribute("data-identity") || "", "setup");
    }
    if (action === "slack-identity-open-detail") {
      openSlackIdentitiesRoute(target.getAttribute("data-identity") || "", "");
    }
    if (action === "slack-identity-detail-retry" && state.slackIdentitySelectedId) {
      loadSlackIdentityDetail(state.slackIdentitySelectedId);
    }
    if (action === "slack-identity-credentials-open") {
      state.slackIdentitySetupStage = 3;
      state.slackIdentityActionError = "";
      render();
    }
    if (action === "slack-identity-verify") { verifyManagedSlackIdentity(); }
    if (action === "slack-identity-detail-refresh") { refreshManagedSlackIdentity(); }
    if (action === "slack-identity-reconnect-open") {
      state.slackIdentityReconnectOpen = true;
      state.slackIdentityCredentialDraft = { botToken: "", signingSecret: "" };
      state.slackIdentityActionError = "";
      render();
    }
    if (action === "slack-identity-reconnect-cancel") {
      state.slackIdentityReconnectOpen = false;
      state.slackIdentityCredentialDraft = { botToken: "", signingSecret: "" };
      state.slackIdentityActionError = "";
      render();
    }
    if (action === "slack-identity-dm-save" && state.slackIdentityDetail) {
      state.slackIdentityConfirm = {
        type: "dm",
        dmState: state.slackIdentityDmDraft.dmState,
        dmAgentId: state.slackIdentityDmDraft.dmAgentId
      };
      state.slackIdentityActionError = "";
      render();
    }
    if (action === "slack-identity-cancel-open") {
      state.slackIdentityConfirm = { type: "cancel" };
      state.slackIdentityActionError = "";
      render();
    }
    if (action === "slack-identity-retire-open") {
      state.slackIdentityConfirm = { type: "retire" };
      state.slackIdentityActionError = "";
      render();
    }
    if (action === "slack-identity-confirm-cancel" && !state.slackIdentityBusy) {
      state.slackIdentityConfirm = null;
      state.slackIdentityActionError = "";
      render();
    }
    if (action === "slack-identity-confirm-apply") { applySlackIdentityConfirmation(); }
    if (action === "slack-behavior-retry") { loadSlackBehavior(); }
    if (action === "slack-test") { testSlackConnection(); }
    if (action === "slack-update-open" && slackConnectionMutable()) { state.addChannelOpen = false; state.slackUpdateOpen = true; state.slackError = ""; state.slackRepair = null; render(); }
    if (action === "slack-update-close" && !state.slackConnectionBusy) { state.slackUpdateOpen = false; state.slackDraft = { botToken: "", signingSecret: "" }; state.slackError = ""; state.slackRepair = null; render(); }
    if (action === "slack-disconnect-open" && slackConnectionMutable()) {
      state.slackDisconnectConfirm = true;
      state.slackDisconnectError = "";
      render();
    }
    if (action === "toggle-manual-channel") { state.addChannelManual = !state.addChannelManual; state.addChannelError = ""; render(); }
    if (action === "toggle-swap") { state.swapOpen = !state.swapOpen; render(); }
    if (action === "attach-selected-profile") { attachSelectedProfile(); }
    if (action === "detach-profile") { detachProfile(); }
    if (action === "discard-channel") { var a = activeAssignment(); if (a) selectActive(a.workspaceId, a.channelId); render(); }
    if (action === "save-channel") { saveChannel(); }
    // Profiles master-detail navigation + form actions.
    if (action === "new-profile") { openNewProfile(); }
    if (action === "edit-profile") { var selected = agentById(target.getAttribute("data-agent")); if (selected) openProfileEditor(selected); }
    if (action === "profiles-back") { state.profileScreen = "list"; state.profileDraft = null; state.editingAgentId = null; resetProfileTransientState(); render(); }
    // Capability tab switch. The keystroke mirrors keep the draft in sync, so
    // no collectProfileDraft here — its trim() would strip whitespace out of
    // text the user is mid-typing. showProfileTab's guard also makes
    // re-clicking the active pill a free no-op instead of a full re-render.
    if (action === "profile-tab" && state.profileDraft) {
      showProfileTab(target.getAttribute("data-tab") || "instructions");
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
    if (action === "repo-picker-retry") { loadRepositoryPickerRepos(); }
    if (action === "repo-picker-apply") { applyRepositoryPicker(); }
    // Inline title rename: open the input seeded with the current name, focused
    // and selected. Commit is Enter/blur; Escape reverts to prev.
    if (action === "profile-rename" && state.profileDraft) {
      state.profileRenaming = { prev: state.profileDraft.name };
      render();
      var renameInput = document.getElementById("p-name");
      if (renameInput) { renameInput.focus(); renameInput.select(); }
    }
    // Footer "Add to channels" picker.
    if (action === "attach-open" && state.profileDraft) { openProfileAttachPicker(); }
    if (action === "attach-new-channel") { state.attachPicker = false; state.attachChannelSelected = ""; state.attachError = ""; openAddChannel(target.getAttribute("data-agent") || ""); }
    if (action === "attach-cancel") { state.attachPicker = false; state.attachChannelSelected = ""; state.attachError = ""; render(); }
    if (action === "attach-channel-confirm" && state.profileDraft) { attachProfileToChannel(); }
    if (action === "cancel-create") { state.profileScreen = "list"; state.profileDraft = null; resetProfileTransientState(); render(); }
    // Settings (model-providers) is a separate destination that lands with its
    // own build; the affordance is present per the approved model-field design.
    if (action === "open-settings") { openSettings(target.getAttribute("data-section") || ""); }
    if (action === "settings-section") {
      var nextSettingsSection = normalizeSettingsSection(target.getAttribute("data-section") || "providers");
      if (nextSettingsSection === "slack") openSettings("slack");
      else {
        state.settingsSection = nextSettingsSection;
        render();
      }
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
    if (action === "audit-tab-memory" && state.auditDomain !== "memory") { openAuditLogs("", "", ""); }
    if (action === "scheduled-retry") { loadScheduledRoutines(); }
    if (action === "scheduled-apply-filters") {
      state.scheduledSelection = "";
      state.scheduledDetail = null;
      state.scheduledDetailTab = "overview";
      state.scheduledRoutines = null;
      loadScheduledRoutines();
    }
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
    if (action === "memory-retry-scopes") { loadMemoryScopes(); }
    if (action === "select-memory-scope") { selectMemoryScope(target.getAttribute("data-store") || "", target.getAttribute("data-channel") || ""); }
    if (action === "memory-retry-files") { loadMemoryFiles(); }
    if (action === "select-memory-file") { selectMemoryFile(target.getAttribute("data-file") || "MEMORY.md"); }
    if (action === "memory-save") { saveMemoryEntry(); }
    if (action === "memory-discard") { discardMemoryDraft(); }
    if (action === "memory-use-latest") { useLatestMemoryEntry(); }
    if (action === "memory-delete-open" && state.memoryDetail) { state.memoryDeleteConfirm = true; render(); }
    if (action === "memory-resolve-review") { resolveMemoryReview(); }
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
    if (action === "openai-auth-method-save") { saveOpenAiAuthMethod(); }
    if (action === "openai-subscription-start") { startOpenAiSubscription(); }
    if (action === "openai-subscription-poll") { pollOpenAiSubscription(); }
    if (action === "openai-subscription-cancel") { cancelOpenAiSubscription(); }
    if (action === "openai-subscription-confirm-account") { confirmOpenAiSubscriptionAccount(); }
    if (action === "openai-subscription-copy-code") { copyOpenAiSubscriptionCode(); }
    if (action === "openai-subscription-disconnect-open") { state.openAiSubscriptionDisconnectConfirm = true; state.openAiSubscriptionError = ""; render(); }
    if (action === "openai-subscription-disconnect-cancel") { state.openAiSubscriptionDisconnectConfirm = false; render(); }
    if (action === "openai-subscription-disconnect-confirm") { disconnectOpenAiSubscriptionConnection(); }
    if (action === "fav-star") { toggleFavorite(target.getAttribute("data-provider"), target.getAttribute("data-model")); }
    // Open the Model combobox (F6) when the input is clicked/focused. The input
    // carries data-action="profile-model"; the same action feeds keystrokes to
    // the filter in the input listener below.
    if (action === "profile-model") { openModelPicker(); }
    if (action === "pick-model") { var modelInput = document.getElementById("p-model"); if (modelInput) modelInput.value = target.getAttribute("data-model") || ""; collectProfileDraft(); state.profileDirty = true; closeModelPicker(); }
    if (action === "save-profile") { saveProfile(); }
    if (action === "discard-profile") { discardProfile(); }
    if (action === "delete-profile") { deleteProfile(); }
    if (action === "detach-channel") { detachProfileChannel(target.getAttribute("data-workspace"), target.getAttribute("data-channel")); }
    if (action === "open-channel-from-profile") { state.view = "channels"; state.channelScreen = "detail"; state.profileScreen = "list"; selectActive(target.getAttribute("data-workspace"), target.getAttribute("data-channel")); render(); }
    if (action === "disable-keep") { state.disableConfirm = false; render(); }
    if (action === "disable-confirm") { if (state.profileDraft) state.profileDraft.enabled = false; state.disableConfirm = false; state.profileDirty = true; render(); }
    // Custom-skills editor: open blank / open seeded / remove / save / cancel.
    // Each editor open captures the current field text off state.skillEditor so
    // the inline error survives a re-render (input handlers mirror keystrokes).
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
          else { saved.enabled = skills[editor.index] ? skills[editor.index].enabled : true; skills[editor.index] = saved; }
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
    if (action === "import-browse-retry") { loadSkillImportRepositories(); }
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
    if (action === "team-invite-email") {
      state.teamInviteDraft.email = target.value;
      state.teamError = "";
    }
    if (state.memoryDraft) {
      if (action === "memory-description") { state.memoryDraft.description = target.value; markMemoryDirty(); }
      if (action === "memory-body") { state.memoryDraft.body = target.value; markMemoryDirty(); }
    }
    if (action === "scheduled-filter-workspace") state.scheduledFilters.workspaceId = target.value;
    if (action === "scheduled-filter-channel") state.scheduledFilters.channelId = target.value;
    if (action === "channel-addendum") {
      state.channelDraft.channelPromptAddendum = target.value;
      state.dirty = true;
      state.saveError = "";
      syncSaveBar();
    }
    // Mirror the wizard inputs into state so unrelated re-renders (e.g. the
    // channel toggle) do not wipe a half-pasted credential.
    if (action === "slack-bot-token") { state.slackDraft.botToken = target.value; }
    if (action === "slack-signing-secret") { state.slackDraft.signingSecret = target.value; }
    if (action === "slack-identity-create-app-name") { state.slackIdentityCreateDraft.appName = target.value; }
    if (action === "slack-identity-create-display-name") { state.slackIdentityCreateDraft.displayName = target.value; }
    if (action === "slack-identity-setup-app-name") { state.slackIdentitySetupDraft.appName = target.value; }
    if (action === "slack-identity-setup-display-name") { state.slackIdentitySetupDraft.displayName = target.value; }
    if (action === "slack-identity-credential-token") { state.slackIdentityCredentialDraft.botToken = target.value; }
    if (action === "slack-identity-credential-secret") { state.slackIdentityCredentialDraft.signingSecret = target.value; }
    // Preserve a half-typed manual channel id across re-renders.
    if (action === "manual-channel-input") { state.channelFormDraft.channelId = target.value; }
    // Mirror the import source into state without a re-render so the input keeps
    // focus; "Find skills" reads it off state.skillImport.
    if (action === "import-source" && state.skillImport) { state.skillImport.source = target.value; state.skillImport.error = ""; }
    // Mirror the pasted provider key into state so a re-render (e.g. a validate
    // spinner) never wipes it; the favorites search re-renders only its own
    // results container to keep the input focused.
    if (action === "prov-key-input") { provUiFor(target.getAttribute("data-provider")).key = target.value; }
    if (action === "github-org-input") { state.githubOrg = target.value; }
    if (action === "repo-search") { scheduleRepositorySearch(target.value); }
    if (action === "import-browse-search") { scheduleSkillImportRepositorySearch(target.value); }
    if (action === "egress-domain-input") {
      var egressInputIndex = Number(target.getAttribute("data-index"));
      if (!state.egressSaving && egressInputIndex >= 0 && egressInputIndex < egressDraft.domains.length) egressDraft.domains[egressInputIndex] = target.value;
    }
    if (action === "fav-search") { updateFavSearch(target.getAttribute("data-provider"), target.value); }
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
        if (action === "conn-field-url") {
          connEditor.url = target.value;
          markProfileDirty();
          // Sync the Test button's disabled state directly (no re-render, so
          // the input keeps focus) — the URL is now its only gate, and nothing
          // else re-renders between typing the URL and clicking Test.
          var connTestButton = document.querySelector('[data-action="conn-test"]');
          if (connTestButton) connTestButton.disabled = !String(connEditor.url || "").trim();
        }
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
    if (action === "onboarding-channel-select") {
      state.onboardingChannelSelected = target.value;
      render();
    }
    if (action === "slack-identity-create-dm") state.slackIdentityCreateDraft.initialDmAgentId = target.value;
    if (action === "slack-identity-dm-state") state.slackIdentityDmDraft.dmState = target.value === "on" ? "on" : "off";
    if (action === "slack-identity-dm-agent") state.slackIdentityDmDraft.dmAgentId = target.value;
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
      state.usageGroupBy = ["channel", "profile", "provider", "model"].includes(usageGroup) ? usageGroup : "channel";
      state.usageOperationFilter = null;
      syncUsageQueryUrl();
      loadUsage(true);
    }
    if (action === "memory-type" && state.memoryDraft) {
      state.memoryDraft.type = target.value;
      markMemoryDirty();
      render();
    }
    if (action === "scheduled-filter-scope") {
      var scopeParts = String(target.value || "").split("|");
      state.scheduledFilters.workspaceId = scopeParts[0] === "workspace" || scopeParts[0] === "channel" ? scopeParts[1] || "" : "";
      state.scheduledFilters.channelId = scopeParts[0] === "channel" ? scopeParts[2] || "" : "";
      state.scheduledFilters.status = "";
      state.scheduledSelection = "";
      state.scheduledDetail = null;
      state.scheduledInspector = false;
      state.scheduledRoutines = null;
      loadScheduledRoutines();
    }
    if (action === "scheduled-filter-state") {
      var scheduledState = String(target.value || "current");
      state.scheduledFilters.state = ["current", "active", "paused", "completed", "disabled", "all"].includes(scheduledState) ? scheduledState : "current";
      state.scheduledFilters.status = "";
      state.scheduledSelection = "";
      state.scheduledDetail = null;
      state.scheduledInspector = false;
      state.scheduledRoutines = null;
      loadScheduledRoutines();
    }
    if (action === "scheduled-filter-status") state.scheduledFilters.status = target.value;
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
    if (action === "openai-auth-method" && !state.openAiAuthMethodBusy) {
      state.openAiAuthMethodDraft = target.value === "subscription" ? "subscription" : "api_key";
      state.openAiAuthMethodDirty = state.openAiAuthMethodDraft !== (providerSummaryById("openai").activeAuthMethod === "subscription" ? "subscription" : "api_key");
      state.openAiAuthMethodError = "";
      render();
    }
    if (action === "channel-enabled") {
      state.channelDraft.enabled = target.checked;
      state.dirty = true;
      render();
    }
    if (action === "channel-participation") {
      state.channelDraft.participationMode = target.value === "mention_only" ? "mention_only" : "ambient";
      state.dirty = true;
      render();
    }
    if (action === "slack-behavior") {
      saveSlackBehavior(target.getAttribute("data-setting"), !!target.checked);
    }
    // Remember the picked channel so a Refresh / re-render keeps the selection.
    if (action === "select-channel-option") { state.addChannelSelected = target.value; }
    if (action === "attach-channel-option") { state.attachChannelSelected = target.value; }
    if (action === "profile-slack-identity" && state.profileDraft) {
      state.profileDraft.slackIdentityId = target.value || "";
      state.profileDraft.acknowledgeUnenumeratedChannels = false;
      state.profileError = "";
      markProfileDirty();
      render();
    }
    if (action === "profile-identity-wildcard-ack" && state.profileDraft) {
      state.profileDraft.acknowledgeUnenumeratedChannels = !!target.checked;
      state.profileError = "";
      markProfileDirty();
      render();
    }
    // Profile enable toggle: enabling is harmless, but turning OFF an assigned
    // profile stops it answering everywhere — confirm before staging that.
    if (action === "profile-enable-toggle" && state.profileDraft) {
      if (target.checked) { state.profileDraft.enabled = true; state.disableConfirm = false; state.profileDirty = true; render(); }
      else if (allAssignmentsForAgent(state.profileDraft.id).length > 0) { state.disableConfirm = true; render(); }
      else { state.profileDraft.enabled = false; state.profileDirty = true; render(); }
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
    // Connection auth mode select. Advanced mode keeps an existing OAuth row
    // visible as a read-only compatibility option; choosing another mode
    // explicitly stages the OAuth credential cleanup on save.
    if (action === "conn-auth" && state.connectionEditor) {
      state.connectionEditor.authMode = target.value === "bearer" ? "bearer" : "none";
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
  });

  document.addEventListener("submit", function (event) {
    var form = event.target;
    var action = form.getAttribute("data-action");
    if (!action) return;
    event.preventDefault();
    if (action === "team-invite-form") createTeamInvitation();
    if (action === "add-channel-form") addChannel(new FormData(form));
    if (action === "onboarding-channel-form") startOnboardingTry(new FormData(form));
    if (action === "slack-connect-form") submitSlackConnection(new FormData(form));
    if (action === "slack-identity-create-form") createManagedSlackIdentity(new FormData(form));
    if (action === "slack-identity-setup-names-form") saveSlackIdentitySetupNames(new FormData(form));
    if (action === "slack-identity-credentials-form") connectManagedSlackIdentity(new FormData(form), false);
    if (action === "slack-identity-reconnect-form") connectManagedSlackIdentity(new FormData(form), true);
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

  document.addEventListener("keydown", function (event) {
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
    if (state.memoryDeleteConfirm && (event.key === "Escape" || event.key === "Esc")) {
      event.preventDefault();
      state.memoryDeleteConfirm = false;
      render();
      var restoreMemoryDelete = document.querySelector('[data-action="memory-delete-open"]');
      if (restoreMemoryDelete && restoreMemoryDelete.focus) restoreMemoryDelete.focus();
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
      focusSlackDisconnectAction("github-disconnect-open");
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
      focusSlackDisconnectAction("slack-disconnect-open");
      return;
    }
    if (state.profileRenaming) {
      if (event.key === "Enter") { event.preventDefault(); closeProfileRename(false); return; }
      if (event.key === "Escape" || event.key === "Esc") { closeProfileRename(true); return; }
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
      var order = ["instructions", "skills", "connections", "repositories"];
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
        state.memoryDirty ||
        state.slackConnectionBusy === "update" ||
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
      if (state.slackConnectionBusy === "update" || state.slackConnectionBusy === "disconnect") {
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
      if (state.profileScreen === "edit" && state.profileDirty && targetPath !== canonicalPath()) {
        history.pushState(null, "", canonicalPath());
        state.leavePrompt = { action: "route", path: targetPath };
        render();
        return;
      }
      if (state.memoryDirty && targetPath !== canonicalPath()) {
        history.pushState(null, "", canonicalPath());
        state.memoryError = "Save or discard the current memory draft before navigating away.";
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
    state.view = "profiles";
    resetProfileTransientState();
    var target = targetAgentId ? agentById(targetAgentId) : null;
    if (target) {
      state.profileScreen = "edit";
      state.editingAgentId = target.id;
      state.profileLastAgentId = target.id;
      state.profileDraft = cloneAgent(target);
    } else {
      state.profileScreen = "list";
      state.profileDraft = null;
      state.editingAgentId = null;
    }
    render();
  }

  function openChannels() {
    if (state.view === "onboarding") resetOnboardingSlackContinuation(true);
    state.view = "channels";
    state.channelScreen = "overview";
    state.profileScreen = "list";
    state.disableConfirm = false;
    state.addChannelOpen = false;
    state.slackUpdateOpen = false;
    state.slackDisconnectConfirm = false;
    if (isSlackConnected()) {
      if (!state.slackBehavior) loadSlackBehavior();
      if (!state.slackChannels && !state.slackChannelsLoading) loadSlackChannels(false);
    }
    render();
    loadSlackIdentityForCurrentView();
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

  function loadSlackIdentity(force, shouldRender) {
    if (!isSlackConnected()) {
      state.slackIdentity = null;
      state.slackIdentityError = "";
      state.slackIdentityLoading = false;
      state.slackIdentityRequestId += 1;
      return Promise.resolve(null);
    }
    if (!force && (state.slackIdentity || state.slackIdentityLoading)) {
      return Promise.resolve(state.slackIdentity);
    }
    var requestId = ++state.slackIdentityRequestId;
    state.slackIdentityLoading = true;
    state.slackIdentityError = "";
    if (shouldRender !== false) render();
    return api("/admin/api/slack-identity").then(function (body) {
      if (requestId !== state.slackIdentityRequestId) return null;
      state.slackIdentity = body;
      state.slackIdentityLoading = false;
      if (shouldRender !== false) render();
      return body;
    }).catch(function (error) {
      if (requestId !== state.slackIdentityRequestId) return null;
      state.slackIdentity = null;
      state.slackIdentityLoading = false;
      state.slackIdentityError = error.serverMessage || "Slack identity could not be loaded.";
      if (shouldRender !== false) render();
      return null;
    });
  }

  function loadSlackIdentityForCurrentView() {
    if (
      state.view === "channels" &&
      state.channelScreen === "overview" &&
      isSlackConnected() &&
      !state.slackIdentity &&
      !state.slackIdentityLoading
    ) {
      void loadSlackIdentity(false, true);
    }
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
      state.slackTestStatus = { ok: false, message: slackErrorText(error.message, error.detail, error.serverMessage, error.payload) };
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
      state.slackIdentity = null;
      state.slackIdentityError = "";
      state.slackIdentityLoading = false;
      state.slackIdentityRequestId += 1;
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
    if (!ensureSlackChannelsLoaded()) render();
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
    var requestId = ++state.slackChannelsRequestId;
    state.slackChannelsLoading = true;
    state.slackChannelsError = null;
    render();
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
      render();
    }).catch(function (error) {
      if (requestId !== state.slackChannelsRequestId) return null;
      state.slackChannelsLoading = false;
      state.slackChannelsError = {
        text: slackChannelsErrorText(error),
        code: error && error.message === "slack_list_failed" ? (error.detail || "") : ((error && error.message) || "")
      };
      render();
    });
  }

  function slackChannelsErrorText(error) {
    if (error && error.message === "slack_not_configured") return "Connect @Chickpea first to list channels.";
    if (error && error.message === "slack_list_failed" && error.detail === "missing_scope") {
      return "Slack permissions are out of date. Reinstall Chickpea in Slack, then paste the refreshed bot token.";
    }
    if (error && error.message === "slack_list_failed" && error.detail) {
      return "Slack could not list channels (" + error.detail + ").";
    }
    return (error && (error.serverMessage || error.message)) || "Could not load channels.";
  }

  function slackOAuthSettingsUrl() {
    var appId = state.slackIdentity && state.slackIdentity.appId;
    return appId && /^[A-Z0-9]+$/i.test(appId)
      ? "https://api.slack.com/apps/" + encodeURIComponent(appId) + "/oauth"
      : "https://api.slack.com/apps";
  }

  function slackScopeReinstallLinkHtml() {
    return '<a class="btn btn-soft btn-sm" href="' + esc(slackOAuthSettingsUrl()) + '" target="_blank" rel="noopener noreferrer">Reinstall in Slack &nearr;</a>';
  }

  function slackScopeCredentialRepairHtml(storedActionHtml) {
    if (slackConnectionMutable()) return storedActionHtml;
    return '<p class="hint">After reinstalling, replace <span class="mono">SLACK_BOT_TOKEN</span> in your deployment and redeploy Chickpea.</p>';
  }

  function addChannelErrorText(error) {
    if (error && error.serverMessage) return error.serverMessage;
    var message = error && error.message;
    if (message === "channel_not_found") return "Slack could not find that channel in the connected workspace. Check the ID, and invite the connected Slack app if it is private.";
    if (message === "workspace_mismatch") return "That channel belongs to a different workspace than the one Chickpea is connected to.";
    if (message === "unknown_agent") return "The profile no longer exists. Reload and try again.";
    return message || "Could not add the channel.";
  }

  function channelInviteWarning(channelName) {
    return "#" + channelName + " was added, but the connected Slack app isn't a member of it yet, so it won't hear mentions there. Invite it to #" + channelName + " in Slack — no need to come back here.";
  }

  function addChannel(formData) {
    var agent = agentById(state.addChannelAgentId) || defaultAgent();
    var fail = function (message) { state.addChannelError = message; render(); };
    if (!agent) { fail("Create a profile before adding a channel."); return; }
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
    // The rail add is for NEW channels — refuse to silently steal one already
    // assigned to another profile (server would happily overwrite it).
    if (assignmentByKey(workspaceId, channelId)) {
      fail("Channel " + channelId + " is already assigned. Select it from the list to edit.");
      return;
    }
    putAssignment(workspaceId, channelId, agent.id, true, undefined, label).then(function (result) {
      state.addChannelOpen = false;
      state.addChannelManual = false;
      state.addChannelError = "";
      state.addChannelAgentId = "";
      state.channelFormDraft.channelId = "";
      state.active = { workspaceId: workspaceId, channelId: channelId };
      state.channelScreen = "detail";
      // Slack's authoritative name (server override) becomes the display label.
      var savedLabel = normalizeChannelLabel((result && result.assignment && result.assignment.channelLabel) || label || channelId);
      state.addChannelInvite = result && result.isMember === false
        ? channelInviteWarning(savedLabel)
        : "";
      return refreshData();
    }).catch(function (error) { fail(addChannelErrorText(error)); });
  }

  function attachSelectedProfile() {
    var assignment = activeAssignment();
    var select = document.querySelector('[data-role="swap-profile"]');
    if (!assignment || !select) return;
    // Swap only the profile; keep the channel's persisted enabled/instructions
    // so an unsaved textarea edit is not committed as a side effect.
    putAssignment(assignment.workspaceId, assignment.channelId, select.value, assignment.enabled, assignment.channelPromptAddendum, assignment.channelLabel, assignment.participationMode).then(function () {
      state.swapOpen = false;
      return refreshData();
    }).catch(function (error) { state.saveError = error.message; render(); });
  }

  function detachProfile() {
    var assignment = activeAssignment();
    if (!assignment) return;
    api("/admin/api/assignments?workspaceId=" + encodeURIComponent(assignment.workspaceId) + "&channelId=" + encodeURIComponent(assignment.channelId), { method: "DELETE" }).then(function () {
      state.active = null;
      return refreshData();
    }).catch(function (error) { state.saveError = error.message; render(); });
  }

  function saveChannel() {
    var assignment = activeAssignment();
    if (!assignment) return;
    putAssignment(assignment.workspaceId, assignment.channelId, assignment.agentId, state.channelDraft.enabled, state.channelDraft.channelPromptAddendum, assignment.channelLabel, state.channelDraft.participationMode).then(function () {
      state.dirty = false;
      state.saveError = "";
      return refreshData();
    }).catch(function (error) { state.saveError = error.message; render(); });
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
    else { saved.enabled = skills[editor.index] ? skills[editor.index].enabled : true; skills[editor.index] = saved; }
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
      var presetMatchesPolicy = !!matchedPreset &&
        matchedPreset.auth.kind === connectionAuthKind(conn) &&
        (matchedPreset.url === conn.url ||
          (matchedPreset.id === "supabase" && !!supabaseSetup && validSupabaseProjectRef(supabaseSetup.projectRef)));
      editor.preset = presetMatchesPolicy ? matchedPreset : null;
      if (editor.preset) {
        editor.view = "recommended";
        if (editor.preset.id === "supabase" && supabaseSetup) {
          editor.supabaseProjectRef = supabaseSetup.projectRef;
          editor.supabaseReadOnly = supabaseSetup.readOnly;
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
        location.assign(authorizationUrl.href);
      }).catch(function (error) {
        showOAuthStartError(connectionId, error);
      });
    }, function () {
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
      editor.toolAccessError = "This connection is no longer available. Reload the profile and try again.";
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

  function loadSkillImportRepositories() {
    var imp = state.skillImport;
    var browse = imp && imp.browse;
    if (!imp || !browse || browse.chooseAccount || !browse.installationId) return Promise.resolve();
    var requestId = (browse.requestId || 0) + 1;
    browse.requestId = requestId;
    browse.loading = true;
    browse.error = "";
    rerenderSkillImportBrowse();
    focusSkillImportBrowseSearch();
    var path = "/admin/api/github/installations/" + encodeURIComponent(String(browse.installationId)) + "/repos?q=" + encodeURIComponent(browse.query || "") + "&page=1";
    return api(path).then(function (body) {
      if (state.skillImport !== imp || imp.browse !== browse || browse.requestId !== requestId) return;
      browse.repos = (body && body.repos) || [];
      browse.totalCount = Number((body && body.totalCount) || 0);
      browse.truncated = !!(body && body.truncated);
      browse.loading = false;
      browse.error = "";
      rerenderSkillImportBrowse();
      focusSkillImportBrowseSearch();
    }).catch(function (error) {
      if (state.skillImport !== imp || imp.browse !== browse || browse.requestId !== requestId) return;
      browse.loading = false;
      browse.error = (error && (error.serverMessage || error.message)) || "Could not load repositories.";
      rerenderSkillImportBrowse();
      focusSkillImportBrowseSearch();
    });
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
    loadSkillImportRepositories();
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

  function scheduleSkillImportRepositorySearch(query) {
    var imp = state.skillImport;
    var browse = imp && imp.browse;
    if (!imp || !browse || browse.chooseAccount) return;
    browse.query = query;
    // Invalidate an in-flight query immediately so it cannot repaint stale
    // results during this query's debounce window.
    browse.requestId = (browse.requestId || 0) + 1;
    if (skillImportSearchTimer && typeof clearTimeout === "function") clearTimeout(skillImportSearchTimer);
    skillImportSearchTimer = null;
    var run = function () {
      skillImportSearchTimer = null;
      if (state.skillImport === imp && imp.browse === browse) loadSkillImportRepositories();
    };
    if (typeof setTimeout === "function") skillImportSearchTimer = setTimeout(run, 250);
    else run();
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
      action === "edit-profile" || action === "new-profile";
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
    } else if (action === "go-home" || action === "open-channels") {
      openChannels();
    } else if (action === "edit-profile") {
      var selected = agentById((pending && pending.agent) || "");
      if (selected) openProfileEditor(selected);
      else enterProfiles(state.profileLastAgentId || ((state.agents[0] && state.agents[0].id) || ""));
    } else if (action === "new-profile") {
      openNewProfile();
    } else if (action === "open-profiles") {
      enterProfiles((pending && pending.agent) || state.profileLastAgentId || ((state.agents[0] && state.agents[0].id) || ""));
    } else {
      state.view = "profiles";
      state.profileScreen = "list";
      render();
    }
  }

  function profileIdentityErrorText(error) {
    var payload = error && error.payload;
    if (payload && payload.error === "agent_slack_dm_handler") {
      var identityLabels = (Array.isArray(payload.identityIds) ? payload.identityIds : []).map(function (identityId) {
        var identity = slackIdentityById(identityId);
        return identity ? identity.displayName : identityId;
      });
      return "This Profile still handles DMs" + (identityLabels.length ? " for " + identityLabels.join(", ") : "") + ". In Settings → Slack → Identities, choose another DM Profile or turn off DMs first.";
    }
    if (payload && payload.error === "slack_identity_not_in_channels") {
      var channels = (payload.channels || []).map(function (channel) {
        return "#" + (channel.label || channel.channelId);
      });
      return "Invite this Slack app to " + channels.join(", ") + " before switching identities.";
    }
    if (payload && payload.error === "slack_identity_unenumerated_channels") {
      return "Acknowledge the wildcard channel warning before switching identities.";
    }
    if (payload && payload.error === "profile_slack_identity_changed") {
      return "This Profile's Slack identity changed in another session. Reload and try again.";
    }
    if (payload && payload.error === "slack_identity_changed") {
      return "This Slack identity changed in another session. Reload and try again.";
    }
    return (error && (error.serverMessage || error.message)) || "Could not change the Slack identity.";
  }

  function profileSlackIdentityIntent(draft) {
    var selectedValue = draft.slackIdentityId || "";
    var persistedValue = profilePersistedSlackIdentityId(draft);
    return {
      selectedValue: selectedValue,
      expectedProfileIdentityId: persistedValue || null,
      acknowledgeUnenumeratedChannels: !!draft.acknowledgeUnenumeratedChannels,
      changed: selectedValue !== persistedValue,
      createNew: selectedValue === NEW_SLACK_IDENTITY_VALUE,
      identity: selectedValue === NEW_SLACK_IDENTITY_VALUE
        ? null
        : slackIdentityById(effectiveSlackIdentityId(selectedValue))
    };
  }

  function attachProfileSlackIdentity(intent, agentId, preflightOnly) {
    if (!intent.identity) {
      var missing = new Error("The selected Slack identity is unavailable. Reload and try again.");
      return Promise.reject(missing);
    }
    var body = {
      expectedRevision: intent.identity.connectionRevision,
      expectedProfileIdentityId: intent.expectedProfileIdentityId,
      acknowledgeUnenumeratedChannels: intent.acknowledgeUnenumeratedChannels
    };
    if (preflightOnly) body.preflightOnly = true;
    return postJson(
      "/admin/api/slack-identities/" + encodeURIComponent(intent.identity.id) +
        "/profiles/" + encodeURIComponent(agentId),
      "POST",
      body
    );
  }

  function completeProfileSlackIdentityIntent(intent, agentId, displayName) {
    if (!intent.changed) return Promise.resolve({ handoff: false });
    if (intent.createNew) {
      return postJson("/admin/api/slack-identities", "POST", {
        source: "profile",
        initialDmAgentId: agentId,
        displayName: displayName
      }).then(function (body) {
        location.assign(body.setupUrl);
        return { handoff: true };
      });
    }
    return attachProfileSlackIdentity(intent, agentId, false).then(function () {
      return { handoff: false };
    });
  }

  function saveProfile(onSaved, onFailed) {
    var draft = collectProfileDraft();
    // Clear any stale field error BEFORE the commit gates below render — a
    // fixed-but-uncleared error would otherwise resurface on a hidden panel.
    state.profileError = "";
    // Commit an open inline skill editor into the draft first — a filled-but-
    // not-"Added" skill must be saved, not silently dropped. Abort on invalid,
    // jumping to the tab that carries the inline error so it is visible.
    if (!commitOpenSkillEditor()) { showProfileTab("skills"); if (onFailed) onFailed(); return; }
    // Same for an open Connections editor — commit it into mcpServers (and stage
    // its typed secrets) before the PATCH, or bail on an inline validation error.
    if (!commitOpenConnectionEditor()) { showProfileTab("connections"); if (onFailed) onFailed(); return; }
    if (!commitOpenApiConnectionEditor()) { showProfileTab("connections"); if (onFailed) onFailed(); return; }
    if (!draft.name) { state.profileError = "Name is required."; render(); if (onFailed) onFailed(); return; }
    if (!draft.instructions) { state.profileError = "Profile instructions are required."; state.profileTab = "instructions"; render(); if (onFailed) onFailed(); return; }
    // An open repository picker holds checkbox changes the user has made but
    // not yet Applied; saving must not silently serialize the stale grant
    // list. Committing equals clicking Apply — which is what the checked
    // boxes said the user wants.
    if (state.repositoryPicker) applyRepositoryPicker();
    var body = {
      name: draft.name,
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
    var identityIntent = profileSlackIdentityIntent(draft);
    if (
      identityIntent.changed &&
      !identityIntent.createNew &&
      profileHasUnenumeratedChannels(draft) &&
      !identityIntent.acknowledgeUnenumeratedChannels
    ) {
      state.profileError = "Acknowledge the wildcard channel warning before switching identities.";
      render();
      if (onFailed) onFailed();
      return;
    }
    // Capture the draft carrying the transient secrets + removals BEFORE the
    // post-save re-clone wipes them, so the secret PUT/DELETE still run.
    var secretsDraft = draft;
    if (isEdit) body.model = draft.model || null;
    else {
      if (draft.model) body.model = draft.model;
      body.id = slugId(draft.name);
    }
    var secretAgentId = isEdit ? draft.id : body.id;
    var preflight = isEdit && identityIntent.changed && !identityIntent.createNew
      ? attachProfileSlackIdentity(identityIntent, draft.id, true)
      : Promise.resolve();
    preflight.then(function () {
      return isEdit
        ? postJson("/admin/api/agents/" + encodeURIComponent(draft.id), "PATCH", body)
        : postJson("/admin/api/agents", "POST", body);
    }).then(async function () {
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
      if (!secretsFailed) {
        var identityCompletion;
        try {
          identityCompletion = await completeProfileSlackIdentityIntent(
            identityIntent,
            secretAgentId,
            draft.name
          );
        } catch (identityError) {
          identityError.profilePolicySaved = true;
          throw identityError;
        }
        if (identityCompletion.handoff) return;
      }
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
              ? "Profile saved, but a credential could not be stored — open the connection and Save again."
              : "Profile saved, but a credential could not be removed — Save again to retry.";
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
      var identityMessage = profileIdentityErrorText(error);
      state.profileError = error && error.profilePolicySaved
        ? "Profile changes were saved, but its Slack identity was not changed. " + identityMessage
        : identityMessage;
      render();
      if (onFailed) onFailed();
    });
  }

  function discardProfile() {
    var saved = agentById(state.editingAgentId);
    state.profileDraft = saved ? cloneAgent(saved) : newProfileDraft();
    state.profileError = "";
    state.profileDirty = false;
    state.disableConfirm = false;
    state.skillEditor = null;
    state.skillImport = null;
    clearCustomConnectionMode();
    state.connectorGallerySearch = "";
    state.connectionRemove = null;
    state.apiConnectionRemove = null;
    resetRepositoryTransientState();
    render();
  }

  function deleteProfileErrorText(error) {
    // The delete button is disabled while assigned, but the server is the guard
    // of record (409 agent_still_assigned) — surface it honestly if it ever races.
    if (error && error.message === "agent_still_assigned") {
      return "This profile is still attached to a channel. Detach it everywhere first.";
    }
    if (error && error.payload && error.payload.error === "agent_slack_dm_handler") {
      return profileIdentityErrorText(error);
    }
    return (error && error.message) || "Could not delete the profile.";
  }

  function deleteProfile() {
    var draft = state.profileDraft;
    if (!draft || !draft.id) return;
    api("/admin/api/agents/" + encodeURIComponent(draft.id), { method: "DELETE" }).then(function () {
      if (state.active && activeAssignment() && activeAssignment().agentId === draft.id) state.active = null;
      state.profileScreen = "list";
      state.profileDraft = null;
      state.editingAgentId = null;
      state.profileError = "";
      return refreshData();
    }).catch(function (error) { state.profileError = deleteProfileErrorText(error); render(); });
  }

  // Attach a catalog channel to this profile. Existing assignments preserve
  // their enabled flag and addendum; previously unassigned channels get the
  // same enabled-by-default contract as the main Add-channel flow.
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
    var assignment = chosen.assignment;
    var enabled = assignment ? assignment.enabled : true;
    var addendum = assignment ? assignment.channelPromptAddendum : undefined;
    var label = assignment && assignment.channelLabel ? assignment.channelLabel : channel.name;
    putAssignment(workspaceId, channel.id, draft.id, enabled, addendum, label, assignment && assignment.participationMode).then(function (result) {
      var savedLabel = normalizeChannelLabel((result && result.assignment && result.assignment.channelLabel) || label || channel.id);
      var needsInvite = result && result.isMember !== undefined ? result.isMember === false : channel.isMember === false;
      state.attachPicker = false;
      state.attachChannelSelected = "";
      state.attachError = "";
      state.attachNotice = needsInvite ? channelInviteWarning(savedLabel) : "";
      return refreshData();
    }).catch(function (error) { state.attachError = addChannelErrorText(error); render(); });
  }

  function detachProfileChannel(workspaceId, channelId) {
    api("/admin/api/assignments?workspaceId=" + encodeURIComponent(workspaceId) + "&channelId=" + encodeURIComponent(channelId), { method: "DELETE" })
      .then(refreshData)
      .catch(function (error) { state.profileError = error.message; render(); });
  }

  // Boot: capture the deep link BEFORE the first data render (which would
  // otherwise sync the URL to the default state), apply it once data is
  // loaded, then turn URL sync on with a replace so landing on /admin becomes
  // the canonical Channels overview without adding a history entry.
  function oauthReturnFromSearch(search) {
    if (!search) return null;
    var params = new URLSearchParams(search);
    var status = params.get("oauth");
    var connectionId = params.get("connection");
    var lane = params.get("lane") === "api" ? "api" : "mcp";
    if (["connected", "cancelled", "failed", "verification_failed"].indexOf(status) < 0) return null;
    if (!connectionId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(connectionId)) return null;
    return { status: status, connectionId: connectionId, lane: lane };
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
  refreshData(false).then(function () {
    if (initialRoute !== "/admin") applyRoute(initialRoute);
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
    syncUrl(true);
    loadSlackIdentityForCurrentView();
  });
})();
</script>
</body>
</html>`;
}

/**
 * Minimal token-entry form for browser GETs of /admin that arrive without a
 * valid session. The credential is submitted in a POST body and exchanged for
 * a hashed session cookie, so it never enters browser history, referrers, or
 * request URLs. This renders only when TAG_ADMIN_TOKEN is set — the gate 404s
 * the whole route otherwise — so it never signals more than "admin exists
 * here". Self-contained LIGHT-mode markup, no external assets, matching the
 * admin page's palette.
 */
export function renderAdminLogin(
  options: { invalidToken?: boolean; returnTo?: string } = {},
): string {
  // The one conditional fragment: a static, non-reflecting error notice (the
  // rejected token is never echoed back into the page).
  const error = options.invalidToken
    ? '<p class="err">That token was not accepted. Check TAG_ADMIN_TOKEN and try again.</p>'
    : '';
  const returnTo = escapeHtmlAttribute(options.returnTo ?? '/admin');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chickpea · Sign in</title>
${ADMIN_FAVICON}
<style>
@import url("https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&family=Quicksand:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap");
:root { --bg:#f4ebd8; --well:#fffdf6; --line:rgba(59,50,32,0.12); --text:#3b3220; --text-2:#6b5c42; --ember:#dda033; --ember-bright:#e5ac44; --danger:#b5473a; --font:Quicksand,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; --radius:13px; }
* { box-sizing:border-box; margin:0; padding:0; }
html { color-scheme:light; }
body { background:var(--bg); color:var(--text-2); font-family:var(--font); min-height:100dvh; display:flex; align-items:center; justify-content:center; padding:24px; -webkit-font-smoothing:antialiased; }
.card { background:var(--well); box-shadow:inset 0 0 0 1px var(--line); border-radius:14px; padding:28px; width:100%; max-width:380px; display:flex; flex-direction:column; gap:14px; }
h1 { color:var(--text); font-size:1.0625rem; font-weight:600; }
.pea-login { display:block; height:44px; width:44px; }
p { font-size:0.8125rem; line-height:1.5; }
.err { color:var(--danger); }
label { color:var(--text); display:block; font-size:0.8125rem; font-weight:500; margin-bottom:6px; }
.mono { font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; }
input { background:#fff; border:0; border-radius:var(--radius); box-shadow:inset 0 0 0 1px rgba(28,25,23,0.15); color:var(--text); font:inherit; font-size:0.875rem; padding:9px 11px; width:100%; }
input:focus-visible { outline:2px solid #b05415; outline-offset:-1px; }
button { align-items:center; background:var(--ember); border:0; border-radius:var(--radius); box-shadow:0 2.5px 0 #b27e1f; color:#3a2a08; cursor:pointer; display:inline-flex; font:inherit; font-size:0.8125rem; font-weight:700; justify-content:center; min-height:36px; padding:8px 14px; }
button:hover { background:var(--ember-bright); }
</style>
</head>
<body>
<form class="card" method="post" action="/admin/login">
  <svg class="pea-login" viewBox="8 9 32 32" aria-hidden="true" focusable="false"><circle cx="24" cy="25" r="15.5" fill="#E3AC45"></circle><circle cx="17" cy="17.5" r="4.2" fill="#F4D084"></circle><circle cx="18.5" cy="24" r="1.9" fill="#3B3220"></circle><circle cx="29.5" cy="24" r="1.9" fill="#3B3220"></circle><path d="M19 29 Q24 32.5 29 29" fill="none" stroke="#3B3220" stroke-width="1.8" stroke-linecap="round"></path><circle cx="15.5" cy="28.5" r="2" fill="#DC8A4F" opacity="0.4"></circle><circle cx="32.5" cy="28.5" r="2" fill="#DC8A4F" opacity="0.4"></circle></svg>
  <h1>Sign in to Chickpea</h1>
  <p>Enter your <span class="mono">TAG_ADMIN_TOKEN</span> to open the admin.</p>
  ${error}
  <div>
    <label for="token">Admin token</label>
    <input id="token" name="token" type="password" autocomplete="off" autofocus placeholder="TAG_ADMIN_TOKEN">
  </div>
  <input name="returnTo" type="hidden" value="${returnTo}">
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;
}

export function renderPasswordLogin(
  options: { invalid?: boolean; returnTo?: string; email?: string } = {},
): string {
  const error = options.invalid
    ? '<div class="error" id="auth-error" role="alert" tabindex="-1">Email or password was not accepted.</div>'
    : '';
  return renderPasswordPage({
    title: 'Sign in to Chickpea',
    eyebrow: 'Welcome back',
    error,
    body: `<form method="post" action="/admin/login">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required autofocus value="${escapeHtmlAttribute(options.email ?? '')}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required ${options.invalid ? 'aria-describedby="auth-error"' : ''}>
      <input name="returnTo" type="hidden" value="${escapeHtmlAttribute(options.returnTo ?? '/admin')}">
      <button type="submit">Sign in</button>
    </form>`,
  });
}

export function renderPasswordOwnerSetupPage(
  options: {
    error?: boolean | PasswordPolicyErrorCode;
    ownerEmail?: string;
  } = {},
): string {
  const errorMessage = options.error === 'too_short'
    ? `Use a password with at least ${PASSWORD_MIN_CODE_POINTS} characters.`
    : options.error === 'too_long'
      ? 'Use a password with no more than 128 characters.'
      : options.error === 'common'
        ? 'That password is too common. Choose a less predictable password.'
        : options.error === 'context'
          ? 'Do not include Chickpea, your organization name, or the name from your email address in the password.'
          : options.error
            ? 'Setup could not be completed. Check the account details and try again.'
            : '';
  const error = errorMessage
    ? `<div class="error" id="auth-error" role="alert" tabindex="-1">${escapeHtmlAttribute(errorMessage)}</div>`
    : '';
  return renderPasswordPage({
    title: 'Create your Chickpea workspace',
    eyebrow: 'Your deployment is ready',
    error,
    intro: 'Create the first owner account. No email service is required.',
    body: `<p id="owner-setup-status" role="status" aria-live="polite">Opening your private setup link&hellip;</p>
    <form id="owner-setup-form" method="post" action="/admin/setup" hidden>
      <label for="owner-email">Email</label>
      <input id="owner-email" name="ownerEmail" type="email" autocomplete="username" required maxlength="320" value="${escapeHtmlAttribute(options.ownerEmail ?? '')}">
      <label for="password">Password <span>${PASSWORD_MIN_CODE_POINTS} or more characters</span></label>
      <input id="password" name="password" type="password" autocomplete="new-password" required minlength="${PASSWORD_MIN_CODE_POINTS}" maxlength="256" aria-describedby="password-help password-error">
      <p id="password-help" class="field-help">Use at least ${PASSWORD_MIN_CODE_POINTS} characters. Spaces are allowed.</p>
      <p id="password-error" class="field-error" role="alert" aria-live="polite" hidden></p>
      <label for="password-confirmation">Confirm password</label>
      <input id="password-confirmation" name="passwordConfirmation" type="password" autocomplete="new-password" required minlength="${PASSWORD_MIN_CODE_POINTS}" maxlength="256" aria-describedby="password-confirmation-error">
      <p id="password-confirmation-error" class="field-error" role="alert" aria-live="polite" hidden></p>
      <input id="owner-setup-capability" name="recoveryToken" type="hidden">
      <button id="owner-setup-submit" type="submit" disabled>Create owner account</button>
    </form><script src="/admin/setup/client.js" defer></script>`,
  });
}

export function renderPasswordChangePage(options: { error?: boolean } = {}): string {
  const error = options.error
    ? '<div class="error" id="auth-error" role="alert" tabindex="-1">Password could not be changed.</div>'
    : '';
  return renderPasswordPage({
    title: 'Change your password',
    eyebrow: 'Account security',
    error,
    intro: 'After this change, Chickpea signs out every browser session and asks you to sign in again.',
    body: `<form method="post" action="/admin/account/password">
      <label for="current-password">Current password</label>
      <input id="current-password" name="currentPassword" type="password" autocomplete="current-password" required>
      <label for="new-password">New password <span>${PASSWORD_MIN_CODE_POINTS} or more characters</span></label>
      <input id="new-password" name="newPassword" type="password" autocomplete="new-password" required minlength="${PASSWORD_MIN_CODE_POINTS}" maxlength="256" aria-describedby="${options.error ? 'auth-error ' : ''}password-help password-error">
      <p id="password-help" class="field-help">Use at least ${PASSWORD_MIN_CODE_POINTS} characters. Spaces are allowed.</p>
      <p id="password-error" class="field-error" role="alert" aria-live="polite" hidden></p>
      <button type="submit">Change password and sign out</button>
    </form><script src="/admin/password/client.js" defer></script>`,
  });
}

export function renderPasswordRecoveryPage(options: { error?: boolean; success?: boolean } = {}): string {
  const error = options.error
    ? '<div class="error" id="auth-error" role="alert" tabindex="-1">Recovery could not be completed.</div>'
    : '';
  if (options.success) {
    return renderPasswordPage({
      title: 'Password recovered',
      eyebrow: 'Recovery complete',
      intro: 'All prior browser sessions were revoked. Sign in normally with the new password.',
      body: '<a class="primary" href="/admin/login">Continue to sign in</a>',
    });
  }
  return renderPasswordPage({
    title: 'Recover the owner account',
    eyebrow: 'Offline recovery',
    error,
    intro: 'This does not sign you in. It replaces one owner password using the deployment recovery secret.',
    body: `<form method="post" action="/admin/recovery">
      <label for="owner-email">Owner email</label>
      <input id="owner-email" name="ownerEmail" type="email" autocomplete="username" required maxlength="320">
      <label for="new-password">New password <span>${PASSWORD_MIN_CODE_POINTS} or more characters</span></label>
      <input id="new-password" name="newPassword" type="password" autocomplete="new-password" required minlength="${PASSWORD_MIN_CODE_POINTS}" maxlength="256" aria-describedby="password-help password-error">
      <p id="password-help" class="field-help">Use at least ${PASSWORD_MIN_CODE_POINTS} characters. Spaces are allowed.</p>
      <p id="password-error" class="field-error" role="alert" aria-live="polite" hidden></p>
      <label for="recovery-token">Deployment recovery secret</label>
      <input id="recovery-token" name="recoveryToken" type="password" autocomplete="off" required ${options.error ? 'aria-describedby="auth-error"' : ''}>
      <button type="submit">Replace owner password</button>
    </form><script src="/admin/password/client.js" defer></script>`,
  });
}

export function passwordFormClientScript(): string {
  return `(function(){
    var input=document.getElementById('new-password');
    var error=document.getElementById('password-error');
    if(!input||!error)return;
    function validate(){
      var remaining=Math.max(0,${PASSWORD_MIN_CODE_POINTS}-Array.from(input.value).length);
      error.textContent=remaining?remaining+' more character'+(remaining===1?'':'s')+' needed.':'';
      error.hidden=!remaining||!input.value;
      if(error.hidden)input.removeAttribute('aria-invalid');else input.setAttribute('aria-invalid','true');
      return remaining===0;
    }
    input.addEventListener('input',validate);
    input.form&&input.form.addEventListener('submit',function(event){if(!validate()){event.preventDefault();input.focus();}});
  })();`;
}

function renderPasswordPage(input: {
  title: string;
  eyebrow: string;
  body: string;
  intro?: string;
  error?: string;
}): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chickpea · ${escapeHtmlAttribute(input.title)}</title>${ADMIN_FAVICON}
<style>
:root{--canvas:#f4ebd8;--card:#fffdf6;--ink:#3b3220;--muted:#6b5c42;--gold:#dda033;--line:rgba(59,50,32,.16);--danger:#a83f34}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--canvas);color:var(--ink);font-family:system-ui,-apple-system,sans-serif;padding:16px}main{width:min(520px,100%);background:var(--card);border:1px solid var(--line);border-radius:20px;padding:clamp(22px,6vw,42px);box-shadow:0 12px 34px rgba(59,50,32,.09)}.eyebrow{margin:0;color:var(--muted);font-size:.78rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em}h1{margin:7px 0 9px;font-size:clamp(1.7rem,7vw,2.45rem);line-height:1.08}p{color:var(--muted);line-height:1.55}label{display:flex;justify-content:space-between;gap:12px;margin:17px 0 6px;font-weight:750}label span{color:var(--muted);font-size:.76rem;font-weight:500}input{width:100%;min-height:46px;border:1px solid var(--line);border-radius:11px;background:#fff;padding:11px 12px;font:inherit}input[aria-invalid="true"]{border-color:var(--danger)}.field-help,.field-error{margin:6px 0 0;font-size:.82rem;line-height:1.4}.field-error{color:var(--danger);font-weight:700}button,.primary{display:flex;align-items:center;justify-content:center;width:100%;min-height:46px;margin-top:22px;border:0;border-radius:12px;background:var(--gold);color:var(--ink);font:inherit;font-weight:800;text-decoration:none;cursor:pointer;box-shadow:0 2.5px 0 #b27e1f;transition:transform .08s ease,box-shadow .08s ease}button:active:not(:disabled){transform:translateY(2px);box-shadow:0 .5px 0 #b27e1f}button[aria-busy="true"]::before{content:"";width:16px;height:16px;margin-right:9px;border:2px solid rgba(59,50,32,.28);border-top-color:var(--ink);border-radius:50%;animation:spin .7s linear infinite}button:disabled{cursor:not-allowed;opacity:.62;box-shadow:none}input:focus-visible,button:focus-visible,.primary:focus-visible{outline:3px solid rgba(176,84,21,.42);outline-offset:2px}.error{margin:16px 0;border-left:4px solid var(--danger);background:#fff3ee;color:var(--danger);padding:12px;font-weight:700;line-height:1.45}[hidden]{display:none!important}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:360px){body{padding:8px}main{border-radius:14px;padding:20px 16px}label{display:block}label span{display:block;margin-top:2px}}
</style></head><body><main aria-labelledby="auth-title"><p class="eyebrow">${escapeHtmlAttribute(input.eyebrow)}</p><h1 id="auth-title">${escapeHtmlAttribute(input.title)}</h1>${input.intro ? `<p>${escapeHtmlAttribute(input.intro)}</p>` : ''}${input.error ?? ''}${input.body}</main></body></html>`;
}

export function renderAuthSetupPage(
  options: {
    state: 'fresh' | 'access_pending';
    error?: boolean;
    origin?: string;
    issuer?: string | null;
    audience?: string | null;
  } = { state: 'fresh' },
): string {
  const heading = options.state === 'fresh'
    ? 'Set up your Chickpea workspace'
    : 'Verify Cloudflare Access';
  const error = options.error
    ? '<p class="error" role="alert">Setup could not be verified. Check the values and try again.</p>'
    : '';
  const origin = escapeHtmlAttribute(options.origin ?? 'https://your-worker.workers.dev');
  const issuer = escapeHtmlAttribute(options.issuer ?? '');
  const audience = escapeHtmlAttribute(options.audience ?? '');
  const verify = options.state === 'access_pending'
    ? `<section class="verify" aria-labelledby="verify-heading">
        <span class="status">Configuration saved</span>
        <h2 id="verify-heading">Continue through Access</h2>
        <p>Open the verification URL in this browser. Cloudflare should ask you to sign in, then Chickpea will match the signed email to the owner claim.</p>
        <a class="primary" href="/admin/setup/verify">Verify identity through Access</a>
        <p class="small">If you return here after an interruption, this step resumes from the saved configuration. It never skips the Access assertion.</p>
      </section>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chickpea · Secure setup</title>
${ADMIN_FAVICON}
<style>
:root { --canvas:#f4ebd8; --card:#fffdf6; --ink:#3b3220; --muted:#6b5c42; --gold:#dda033; --line:rgba(59,50,32,.14); --danger:#b5473a; }
* { box-sizing:border-box; }
body { margin:0; min-height:100dvh; background:var(--canvas); color:var(--ink); font-family:Quicksand,system-ui,sans-serif; padding:32px 20px; }
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
main { width:min(820px,100%); margin:0 auto; }
.progress { display:flex; gap:7px; margin:0 0 16px; padding:0; list-style:none; }
.progress li { flex:1; height:6px; border-radius:999px; background:rgba(59,50,32,.12); }
.progress li.done,.progress li.current { background:var(--gold); }
.card { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:clamp(22px,5vw,40px); box-shadow:0 8px 30px rgba(59,50,32,.08); }
h1 { margin:0 0 8px; font-size:clamp(1.7rem,5vw,2.5rem); }
h2 { margin:28px 0 8px; font-size:1.1rem; }
p,li { color:var(--muted); line-height:1.55; }
ol { padding-left:22px; }
.paths { display:grid; gap:10px; grid-template-columns:1fr 1fr; }
.path { border:1px solid var(--line); border-radius:12px; padding:14px; background:#fff; color:var(--ink); text-align:left; cursor:pointer; }
.path[aria-pressed="true"] { border-color:var(--gold); box-shadow:0 0 0 2px rgba(221,160,51,.2); }
.path h2 { margin:0 0 5px; } .path p { margin:0; }
.guide { display:none; margin-top:14px; border:1px solid var(--line); border-radius:12px; padding:16px; }
.guide.active { display:block; }
.copy-grid { display:grid; gap:9px; margin:14px 0; }
.copy-row { align-items:center; display:grid; gap:8px; grid-template-columns:minmax(0,1fr) auto; }
.copy-value { background:#f8f1df; border:1px solid var(--line); border-radius:10px; font-family:ui-monospace,"SF Mono",Menlo,monospace; overflow-wrap:anywhere; padding:10px 12px; }
label { display:block; font-weight:700; margin:16px 0 6px; }
input,select { width:100%; border:1px solid var(--line); border-radius:10px; padding:11px 12px; font:inherit; background:#fff; }
input:focus-visible,select:focus-visible,button:focus-visible,a:focus-visible { outline:3px solid rgba(221,160,51,.45); outline-offset:2px; }
button,.primary { border:0; border-radius:12px; background:var(--gold); color:var(--ink); padding:12px 18px; font:inherit; font-weight:800; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; }
form > button { margin-top:22px; }
.secondary { background:#fff; border:1px solid var(--line); padding:8px 11px; }
.external { display:inline-flex; margin-top:8px; color:var(--ink); font-weight:800; }
.verify { background:#f8f1df; border:1px solid rgba(221,160,51,.4); border-radius:14px; margin:22px 0; padding:18px; }
.verify h2 { margin:8px 0; }.status { display:inline-block; background:rgba(111,162,91,.16); color:#4e7a3e; border-radius:999px; padding:4px 9px; font-size:.75rem; font-weight:800; }
.small { font-size:.8rem; }
code { background:#f8f1df; border-radius:6px; padding:2px 5px; }
.error { color:var(--danger); font-weight:700; }
@media (max-width:620px) { body { padding:16px 10px; } .paths { grid-template-columns:1fr; } .card { border-radius:14px; } .copy-row { grid-template-columns:1fr; } .copy-row button { width:100%; } }
</style>
</head>
<body>
<main>
  <ol class="progress" aria-label="Setup progress"><li class="done"><span class="sr-only">Deploy complete</span></li><li class="${options.state === 'fresh' ? 'current' : 'done'}"><span class="sr-only">Access configuration</span></li><li class="${options.state === 'access_pending' ? 'current' : ''}"><span class="sr-only">Identity verification</span></li><li><span class="sr-only">Slack setup</span></li></ol>
  <section class="card" aria-labelledby="setup-heading">
    <p class="small"><strong>Advanced manual setup</strong></p>
    <h1 id="setup-heading">${heading}</h1>
    <p>Cloudflare Access signs people in. Chickpea keeps its own members and roles, so changing a role or suspending a person takes effect on their next Chickpea request.</p>
    ${error}
    ${verify}
    <h2>Choose your Cloudflare path</h2>
    <div class="paths">
      <button class="path" type="button" data-path="new" aria-pressed="true"><h2>Create Zero Trust organization</h2><p>Start here if this account has never used Access.</p></button>
      <button class="path" type="button" data-path="existing" aria-pressed="false"><h2>Use an existing Zero Trust organization</h2><p>Reuse your established team name and identity providers.</p></button>
    </div>
    <section class="guide active" data-guide="new"><strong>New to Zero Trust</strong><ol><li>Open the Zero Trust dashboard and activate the Free plan if Cloudflare asks.</li><li>Enable a dedicated verified-email login method, such as email one-time PIN.</li><li>Create one Self-hosted application for the two Admin destinations and one authentication-only policy for that login method.</li></ol></section>
    <section class="guide" data-guide="existing"><strong>Existing Zero Trust team</strong><ol><li>Create a separately named Chickpea verified-email login method and Self-hosted application.</li><li>Attach one authentication-only policy for that login method; do not enumerate Chickpea members.</li><li>Use the two Admin destinations below and leave unrelated applications, policies, and providers unchanged.</li></ol></section>
    <a class="external" href="https://one.dash.cloudflare.com/" target="_blank" rel="noopener noreferrer">Open Cloudflare Zero Trust ↗</a>
    <h2>Protect only Admin</h2>
    <p>Configure both destinations in one Access application. Slack events and OAuth callbacks must remain public.</p>
    <div class="copy-grid">
      <div class="copy-row"><span class="copy-value" data-copy-value>${origin}/admin</span><button class="secondary" type="button" data-copy="${origin}/admin">Copy</button></div>
      <div class="copy-row"><span class="copy-value" data-copy-value>${origin}/admin/*</span><button class="secondary" type="button" data-copy="${origin}/admin/*">Copy</button></div>
    </div>
    <p class="small">Configure this perimeter once. Anyone who verifies an email may reach Chickpea's uniform sign-in denial, but only an existing membership or exact-email invitation grants access. Later teammate changes happen only in Chickpea.</p>
    <h2>Save the Access values</h2>
    <p>Copy the team issuer and application audience from Cloudflare. Saving does not activate the owner; the next step still requires a signed Access assertion.</p>
    <form method="post" action="/admin/setup">
      <label for="owner-email">Owner email</label>
      <input id="owner-email" name="ownerEmail" type="email" autocomplete="email" required>
      <label for="recovery-token">Recovery token</label>
      <input id="recovery-token" name="recoveryToken" type="password" autocomplete="off" required>
      <label for="access-issuer">Cloudflare team issuer</label>
      <input id="access-issuer" name="issuer" type="url" placeholder="https://team.cloudflareaccess.com" value="${issuer}" required>
      <label for="access-audience">Access application audience</label>
      <input id="access-audience" name="audience" autocomplete="off" value="${audience}" required>
      <button type="submit">Save and continue</button>
    </form>
  </section>
</main>
<script>
(function () {
  var pathButtons = document.querySelectorAll('[data-path]');
  pathButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      var selected = button.getAttribute('data-path');
      pathButtons.forEach(function (candidate) {
        candidate.setAttribute('aria-pressed', candidate === button ? 'true' : 'false');
      });
      document.querySelectorAll('[data-guide]').forEach(function (guide) {
        guide.classList.toggle('active', guide.getAttribute('data-guide') === selected);
      });
    });
  });
  document.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      var value = button.getAttribute('data-copy') || '';
      if (!navigator.clipboard || !navigator.clipboard.writeText) return;
      navigator.clipboard.writeText(value).then(function () {
        button.textContent = 'Copied';
      });
    });
  });
})();
</script>
</body>
</html>`;
}

export function renderAuthSetupCompletePage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chickpea · Workspace ready</title>${ADMIN_FAVICON}
<style>
:root { --canvas:#f4ebd8; --card:#fffdf6; --ink:#3b3220; --muted:#6b5c42; --gold:#dda033; --line:rgba(59,50,32,.14); --green:#4e7a3e; }
* { box-sizing:border-box; } body { margin:0; min-height:100dvh; display:grid; place-items:center; background:var(--canvas); color:var(--ink); font-family:Quicksand,system-ui,sans-serif; padding:20px; }
main { width:min(580px,100%); background:var(--card); border:1px solid var(--line); border-radius:20px; padding:clamp(26px,6vw,44px); box-shadow:0 10px 30px rgba(59,50,32,.09); text-align:center; }
.mark { width:54px; height:54px; display:grid; place-items:center; margin:0 auto 18px; border-radius:50%; background:rgba(111,162,91,.16); color:var(--green); font-size:1.6rem; font-weight:900; }
h1 { margin:0 0 8px; font-size:clamp(1.8rem,6vw,2.5rem); } p { color:var(--muted); line-height:1.55; }
a { display:inline-flex; align-items:center; justify-content:center; margin-top:18px; min-height:44px; border-radius:12px; padding:11px 20px; background:var(--gold); color:var(--ink); text-decoration:none; font-weight:800; box-shadow:0 2.5px 0 #b27e1f; }
a:focus-visible { outline:3px solid rgba(221,160,51,.45); outline-offset:3px; }
</style></head><body><main>
  <div class="mark" aria-hidden="true">✓</div>
  <h1>Your Chickpea is ready</h1>
  <p>Your owner account and workspace are ready. Next, connect the Slack app to this workspace.</p>
  <a href="/admin">Continue to Slack setup</a>
</main><script src="/admin/setup/client.js" defer></script></body></html>`;
}

export function renderAuthRecoveryPage(options: { error?: boolean } = {}): string {
  const error = options.error
    ? '<p class="error" role="alert">Recovery could not be verified.</p>'
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chickpea · Access recovery</title>
${ADMIN_FAVICON}
<style>
:root { --canvas:#f4ebd8; --card:#fffdf6; --ink:#3b3220; --muted:#6b5c42; --gold:#dda033; --line:rgba(59,50,32,.14); --danger:#b5473a; }
* { box-sizing:border-box; }
body { margin:0; min-height:100dvh; display:grid; place-items:center; background:var(--canvas); color:var(--ink); font-family:Quicksand,system-ui,sans-serif; padding:24px; }
main { width:min(520px,100%); background:var(--card); border:1px solid var(--line); border-radius:18px; padding:clamp(22px,5vw,36px); box-shadow:0 8px 30px rgba(59,50,32,.08); }
h1 { margin:0 0 8px; font-size:clamp(1.5rem,5vw,2rem); }
p { color:var(--muted); line-height:1.55; }
label { display:block; font-weight:700; margin:16px 0 6px; }
input { width:100%; border:1px solid var(--line); border-radius:10px; padding:11px 12px; font:inherit; }
input:focus-visible,button:focus-visible { outline:3px solid rgba(221,160,51,.45); outline-offset:2px; }
button { margin-top:22px; border:0; border-radius:12px; background:var(--gold); color:var(--ink); padding:12px 18px; font:inherit; font-weight:800; cursor:pointer; }
.error { color:var(--danger); font-weight:700; }
@media (max-width:520px) { body { padding:12px; } main { border-radius:14px; } }
</style>
</head>
<body>
<main aria-labelledby="recovery-heading">
  <h1 id="recovery-heading">Repair Cloudflare Access</h1>
  <p>This does not sign you in. It updates only Chickpea's expected Access application audience after you have repaired the edge policy in Cloudflare.</p>
  ${error}
  <form method="post" action="/admin/recovery">
    <label for="operation">Repair operation</label>
    <select id="operation" name="operation" required>
      <option value="audience">Update Access application audience</option>
      <option value="owner_binding">Replace my owner identity binding</option>
    </select>
    <label for="recovery-token">Offline recovery token</label>
    <input id="recovery-token" name="recoveryToken" type="password" autocomplete="off" required>
    <label for="access-audience">New Access application audience</label>
    <input id="access-audience" name="audience" autocomplete="off">
    <button type="submit">Verify and repair</button>
  </form>
</main>
</body>
</html>`;
}

export function renderAuthMigrationPage(options: { error?: boolean } = {}): string {
  const error = options.error
    ? '<p class="error" role="alert">Migration could not be saved. Your existing Admin login is still active.</p>'
    : '';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chickpea · Upgrade authentication</title>${ADMIN_FAVICON}
<style>
:root { --canvas:#f4ebd8; --card:#fffdf6; --ink:#3b3220; --muted:#6b5c42; --gold:#dda033; --line:rgba(59,50,32,.14); --danger:#b5473a; }
* { box-sizing:border-box; } body { margin:0; min-height:100dvh; background:var(--canvas); color:var(--ink); font-family:Quicksand,system-ui,sans-serif; padding:24px; }
main { width:min(680px,100%); margin:0 auto; background:var(--card); border:1px solid var(--line); border-radius:18px; padding:clamp(22px,5vw,38px); box-shadow:0 8px 30px rgba(59,50,32,.08); }
h1 { margin:0 0 8px; font-size:clamp(1.6rem,5vw,2.3rem); } p,li { color:var(--muted); line-height:1.55; } .notice { border:1px solid var(--line); border-radius:12px; padding:14px; }
label { display:block; font-weight:700; margin:16px 0 6px; } input { width:100%; border:1px solid var(--line); border-radius:10px; padding:11px 12px; font:inherit; }
input:focus-visible,button:focus-visible { outline:3px solid rgba(221,160,51,.45); outline-offset:2px; } button { margin-top:22px; border:0; border-radius:12px; background:var(--gold); color:var(--ink); padding:12px 18px; font:inherit; font-weight:800; cursor:pointer; }
.error { color:var(--danger); font-weight:700; } @media (max-width:560px) { body { padding:12px; } main { border-radius:14px; } }
</style></head><body><main>
  <p>Authentication upgrade</p>
  <h1>Give every person their own identity</h1>
  <p class="notice">Your existing shared Admin token remains usable until a matching Cloudflare Access identity activates the owner account. After activation, it stops authenticating immediately.</p>
  ${error}
  <ol><li>Create or reuse a Cloudflare Zero Trust team.</li><li>Protect both <code>/admin</code> and <code>/admin/*</code> in one Access application.</li><li>Save the issuer and audience here, then verify through Access.</li></ol>
  <form method="post" action="/admin/migrate">
    <label for="owner-email">First owner email</label><input id="owner-email" name="ownerEmail" type="email" autocomplete="email" required>
    <label for="recovery-token">Offline recovery token</label><input id="recovery-token" name="recoveryToken" type="password" autocomplete="off" required>
    <label for="access-issuer">Cloudflare team issuer</label><input id="access-issuer" name="issuer" type="url" placeholder="https://team.cloudflareaccess.com" required>
    <label for="access-audience">Access application audience</label><input id="access-audience" name="audience" autocomplete="off" required>
    <button type="submit">Save and verify through Access</button>
  </form>
</main></body></html>`;
}

export function renderMemberAccountPage(input: {
  organizationName: string;
  displayName: string | null;
  email: string;
  role: 'owner' | 'admin' | 'member';
  status: 'active' | 'suspended' | 'removed';
}): string {
  const name = escapeHtmlAttribute(input.displayName || input.email);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chickpea · Your account</title>${ADMIN_FAVICON}
<style>
:root { --canvas:#f4ebd8; --card:#fffdf6; --ink:#3b3220; --muted:#6b5c42; --gold:#dda033; --line:rgba(59,50,32,.14); --green:#6fa25b; }
* { box-sizing:border-box; } body { margin:0; min-height:100dvh; display:grid; place-items:center; background:var(--canvas); color:var(--ink); font-family:Quicksand,system-ui,sans-serif; padding:20px; }
main { width:min(560px,100%); background:var(--card); border:1px solid var(--line); border-radius:20px; padding:clamp(24px,6vw,42px); box-shadow:0 10px 30px rgba(59,50,32,.09); }
h1 { margin:8px 0 6px; font-size:clamp(1.65rem,6vw,2.35rem); } p { color:var(--muted); line-height:1.55; } .eyebrow { font-size:.78rem; font-weight:800; text-transform:uppercase; letter-spacing:.08em; }
.account { border:1px solid var(--line); border-radius:14px; padding:16px; margin:22px 0; display:grid; gap:5px; } .email { overflow-wrap:anywhere; } .badge { width:max-content; background:rgba(111,162,91,.16); color:#4e7a3e; border-radius:999px; padding:4px 10px; font-weight:800; font-size:.75rem; }
.button { display:inline-flex; align-items:center; justify-content:center; min-height:42px; padding:10px 18px; border-radius:12px; background:var(--gold); color:var(--ink); font-weight:800; text-decoration:none; box-shadow:0 2.5px 0 #b27e1f; }
.button:focus-visible { outline:3px solid rgba(221,160,51,.45); outline-offset:3px; } .note { margin-top:20px; font-size:.82rem; }
</style></head><body><main>
  <p class="eyebrow">${escapeHtmlAttribute(input.organizationName)}</p>
  <h1>Hi, ${name}</h1>
  <p>Your Chickpea account is active.</p>
  <section class="account" aria-label="Account details">
    <strong>${name}</strong><span class="email">${escapeHtmlAttribute(input.email)}</span>
    ${input.role === 'owner' ? '<span class="badge">Owner</span>' : ''}<span class="badge">${escapeHtmlAttribute(input.status)}</span>
  </section>
  <a class="button" href="slack://open">Open Slack</a>
  <p><a href="/admin/account/password">Change password</a></p>
  <form method="post" action="/admin/logout"><button class="button" type="submit">Sign out</button></form>
  <p class="note">Need help signing in? Ask the Chickpea owner.</p>
</main></body></html>`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
