import { isCloudflareTarget } from '../config/runtime-target.ts';
import { CONNECTOR_LOGOS } from '../config/connector-logos.ts';
import { CONNECTOR_PRESETS } from '../config/presets.ts';

const ADMIN_FAVICON = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='8 9 32 32'%3E%3Ccircle cx='24' cy='25' r='15.5' fill='%23E3AC45'/%3E%3Ccircle cx='17' cy='17.5' r='4.2' fill='%23F4D084'/%3E%3Ccircle cx='18.5' cy='24' r='1.9' fill='%233B3220'/%3E%3Ccircle cx='29.5' cy='24' r='1.9' fill='%233B3220'/%3E%3Cpath d='M19 29 Q24 32.5 29 29' fill='none' stroke='%233B3220' stroke-width='1.8' stroke-linecap='round'/%3E%3Ccircle cx='15.5' cy='28.5' r='2' fill='%23DC8A4F' opacity='0.4'/%3E%3Ccircle cx='32.5' cy='28.5' r='2' fill='%23DC8A4F' opacity='0.4'/%3E%3C/svg%3E">`;

export function renderAdminPage(): string {
  // Target-aware chrome: the header chip and the provider-hint copy differ
  // between the Node and Cloudflare runtimes. Resolved server-side (the inline
  // script has no runtime-target check of its own) and interpolated as plain
  // text into both the first-paint skeleton and the inlined script.
  const isCloudflare = isCloudflareTarget();
  const targetChip = isCloudflare ? 'cloudflare · workers' : 'local · node';
  const providerHint = isCloudflare
    ? 'Read-only &mdash; the Workers AI binding is always available; configure others via wrangler secrets (built-ins) or src/app.ts (custom).'
    : 'Read-only &mdash; configured via .env (built-ins) or src/app.ts (custom).';
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
.btn:focus-visible, .x-btn:focus-visible, .rail-add:focus-visible, .chan-item:focus-visible {
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
/* Cap the whole shell (topbar + card together) so the cream card doesn't track
   ultra-wide viewports; the tan canvas absorbs the extra width on both sides. */
.frame { display: flex; flex-direction: column; margin: 0 auto; max-width: 1080px; min-height: 100dvh; width: 100%; }
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
  width: 248px;
}
.rail-head { align-items: center; display: flex; justify-content: space-between; padding: 0 10px 10px; }
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
.rail-add:disabled { cursor: not-allowed; opacity: 0.5; }
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
.main-inner { display: flex; flex-direction: column; gap: 26px; margin: 0 auto; max-width: 760px; }
.main-head { align-items: flex-start; display: flex; gap: 12px; justify-content: space-between; }
.section { border-top: 1.5px dashed rgba(59, 50, 32, 0.15); display: flex; flex-direction: column; gap: 13px; padding-top: 18px; }
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
details.advanced { border-top: 1.5px dashed rgba(59, 50, 32, 0.15); padding-top: 4px; }
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
.paste-row { display: flex; flex-wrap: wrap; gap: 9px; }
.paste-row .input { flex: 1; min-width: 220px; }
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
  .main { padding: 20px; }
  .form-grid { grid-template-columns: 1fr; }
  .prov-actions { margin-left: 0; width: 100%; }
  .well .kv, .adv-rows .kv { grid-template-columns: 1fr; gap: 3px; }
  .btn { font-size: 0.875rem; padding: 9px 15px; }
  .btn-sm { font-size: 0.8125rem; padding: 6px 12px; }
  .main-head, .section-head, .bundle-row, .save-bar { align-items: stretch; flex-direction: column; }
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

/* ---- profile capability tabs (Instructions / Skills / Connections) ----
   "Ringed tray": the tab bar and its visible panel read as ONE cream container
   outlined by a 1.5px ring, with a dashed seam under the tabs. The active tab
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
  border-bottom: 1.5px dashed rgba(59, 50, 32, 0.13);
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
.gallery-row-name { font-weight: 600; }
.gallery-row-spacer { margin-left: auto; }
.gallery-empty { color: var(--text-3); font-size: 0.8125rem; padding: 14px 4px; }
.conn-logo { align-items: center; border-radius: 8px; display: inline-flex; flex: none; height: 30px; justify-content: center; width: 30px; }
.conn-logo-mono { color: #fff; font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.02em; }
.conn-logo-img { background: #fff; box-shadow: inset 0 0 0 1px var(--line); }
.conn-logo-img svg { max-width: 20px; max-height: 20px; height: auto; width: auto; }
.conn-logo-raster { overflow: hidden; }
.conn-logo-raster img { display: block; width: 100%; height: 100%; object-fit: cover; }
.conn-title, .conn-recommended-head { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; }
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
@media (max-width: 720px) {
  .skill-row.conn-row { align-items: stretch; flex-direction: column; }
}

/* ---- profile footer (delete / add-to-channels / usage) ---- */
.profile-foot { align-items: center; border-top: 1.5px dashed rgba(59, 50, 32, 0.15); display: flex; flex-wrap: wrap; gap: 10px; padding-top: 20px; }

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
      <a class="btn btn-ghost" href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">Open Slack console &nearr;</a>
      <button type="button" class="btn btn-soft" disabled>Profiles</button>
      <button type="button" class="btn btn-soft" disabled>Settings</button>
    </div>
  </header>
  <div class="body">
    <nav class="rail" aria-label="Channels">
      <div class="rail-head"><span class="section-eyebrow">Slack channels</span><span class="hint">&hellip;</span></div>
      <div class="ws-row"><svg class="ic" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"/></svg>Workspace</div>
    </nav>
    <main class="main"><div class="main-inner"><div class="empty"><h1 class="page-title">Loading admin...</h1><p class="hint">Reading local configuration.</p></div></div></main>
  </div>
</div>
<script>
(function () {
  // Server-resolved runtime target: the Workers AI row is binding-only, so it is
  // shown on Cloudflare and hidden on Node (the inline script has no target check
  // of its own — this is interpolated as a literal boolean at render time).
  var IS_CLOUDFLARE = ${isCloudflare};
  var CONNECTOR_PRESETS = ${JSON.stringify(CONNECTOR_PRESETS).replace(/</g, '\\u003c')};
  var CONNECTOR_LOGOS = ${JSON.stringify(CONNECTOR_LOGOS).replace(/</g, '\\u003c')};
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
    slackChannelsError: "",
    slackChannelsLoading: false,
    swapOpen: false,
    channelDraft: { enabled: true, channelPromptAddendum: "" },
    dirty: false,
    saveError: "",
    // Master-detail Profiles destination (replaces the retired profile modal):
    // "channels" is the default channel view; "profiles" swaps the main panel to
    // the overview/create/edit screens driven by profileScreen.
    view: "channels",
    profileScreen: "list",
    profileDirty: false,
    disableConfirm: false,
    editingAgentId: null,
    profileDraft: null,
    profileError: "",
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
    // When open it is { source, loading, error, resolution, selected } where
    // resolution is the /admin/api/skills/resolve payload (null until "Find
    // skills" returns) and selected is a boolean[] parallel to resolution.skills.
    skillImport: null,
    // Inline Connections (remote MCP server) editor on the profile edit page.
    // null when closed; when open it is a working copy of one connection plus
    // TRANSIENT secrets (bearerToken + headerValues) that live ONLY here and are
    // PUT to the settings store on save, then cleared — they never enter the
    // profile PATCH body. { index: <number|null for new>, id, displayName, url,
    // transport, authMode, headerNames, headerValues, bearerToken,
    // enabled, testing, testError, discoveredTools, checked (bool[] parallel to
    // discoveredTools), lifecycleStatus, statusText, lastCheckedAt, sources
    // (secret presence from a prior save: {bearer, headers}), error }.
    connectionEditor: null,
    connectorGallerySearch: "",
    // Index of the connection pending removal (its confirm modal is open), or
    // null. The DELETE of its secrets is issued on the next profile save.
    connectionRemove: null,
    // When the user tries to leave a dirty profile editor, this holds the
    // pending navigation { action, agent } and the confirm modal is shown.
    leavePrompt: null,
    slack: null,
    slackDraft: { botToken: "", signingSecret: "" },
    slackError: "",
    slackBusy: false,
    // First-run stepper: step 1 (create the app) until the operator opens the
    // manifest, then step 2 (install, copy & paste). Client-side only — Slack
    // owns app creation, so there is no server signal for the transition.
    slackStep: 1,
    // Set from a just-completed connect (POST result carries team + botName);
    // drives the dismissable success toast in the connected funnel.
    slackToast: null,
    slackToastDismissed: false,
    // Settings (model-providers) destination. state.settings holds the last
    // /admin/api/providers payload; provUi/favUi carry the per-provider paste,
    // remove-confirmation, and favorites-search UI state; favorites and
    // providerModels cache the loaded arrays so the managers render without a
    // round trip per keystroke.
    settings: null,
    settingsLoaded: false,
    settingsError: "",
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
    providerModelsError: {}
  };

  // Inline Heroicons (micro, 16px) — solid unless noted. Colour inherits from
  // the parent via currentColor; never override fill in CSS.
  function icon(name, extra) {
    var paths = {
      "chevron-down": "M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z",
      check: "M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 1 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z",
      "x-mark": "M2.22 2.22a.75.75 0 0 1 1.06 0L8 6.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L9.06 8l4.72 4.72a.75.75 0 1 1-1.06 1.06L8 9.06l-4.72 4.72a.75.75 0 0 1-1.06-1.06L6.94 8 2.22 3.28a.75.75 0 0 1 0-1.06Z",
      plus: "M8.75 3.75a.75.75 0 0 0-1.5 0v3.5h-3.5a.75.75 0 0 0 0 1.5h3.5v3.5a.75.75 0 0 0 1.5 0v-3.5h3.5a.75.75 0 0 0 0-1.5h-3.5v-3.5Z",
      pencil: "M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.596.892l-.848 2.047a.75.75 0 0 0 .98.98l2.047-.848a2.75 2.75 0 0 0 .892-.596l4.263-4.262a1.75 1.75 0 0 0 0-2.474Z",
      "lock-closed": "M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z",
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
    state.skillImport = null;
    state.connectionEditor = null;
    state.connectorGallerySearch = "";
    state.connectionRemove = null;
    state.modelPickerOpen = false;
    state.modelPickerFilter = "";
  }

  // Open a profile's edit screen (from a click or a route), resetting every
  // transient editor state.
  function openProfileEditor(selected) {
    state.view = "profiles";
    state.profileScreen = "edit";
    state.editingAgentId = selected.id;
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
    if (state.view === "settings") return "/admin/settings";
    if (state.view === "profiles") {
      if (state.profileScreen === "create") return "/admin/profiles/new";
      if (state.profileScreen === "edit" && state.editingAgentId) return "/admin/profiles/" + encodeURIComponent(state.editingAgentId);
      return "/admin/profiles";
    }
    if (state.active) return "/admin/channels/" + encodeURIComponent(state.active.workspaceId) + "/" + encodeURIComponent(state.active.channelId);
    return "/admin";
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
    if (parts[1] === "settings") { openSettings(); return; }
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
      state.profileScreen = "list";
      selectActive(parts[2], parts[3]);
      render();
      return;
    }
    state.view = "channels";
    state.profileScreen = "list";
    state.disableConfirm = false;
    render();
  }

  function render() {
    var app = document.getElementById("app");
    app.innerHTML = topbarHtml() + '<div class="body">' + railHtml() + mainHtml() + "</div>" + leavePromptModalHtml() + connectionRemoveModalHtml();
    syncUrl();
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
    // The connection indicator flips to the header once Slack is live (the
    // stepper's section badge disappears with the stepper). The actions live in
    // a normal .actions row that is always visible on desktop; the <details>
    // hamburger is a mobile-only sibling that reveals the SAME row via the
    // "[open] ~ .actions-list" rule (a closed <details> would UA-hide its own
    // children on every viewport, so the actions must not live inside it).
    var connectedBadge = isSlackConnected()
      ? '<span class="badge badge-on"><span class="dot"></span>Connected</span>'
      : "";
    // The brand doubles as a home affordance back to the channel view — the one
    // reliable exit from the Profiles destination when the channel rail is empty
    // (e.g. a not-yet-connected install with no channels to click back to).
    return '<header class="topbar">' +
      '<div class="brand"><button type="button" class="brand-home" data-action="go-home" aria-label="Home"><span class="avatar">T<svg class="pea" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><circle cx="24" cy="25" r="15.5" fill="#E3AC45"></circle><circle cx="17" cy="17.5" r="4.2" fill="#F4D084"></circle><g class="pea-eyes"><circle class="pea-eye" cx="18.5" cy="24" r="1.9" fill="#3B3220"></circle><circle class="pea-eye" cx="29.5" cy="24" r="1.9" fill="#3B3220"></circle></g><g class="pea-lids"><path d="M16.4 24.2 Q18.5 22 20.6 24.2" fill="none" stroke="#3B3220" stroke-width="1.8" stroke-linecap="round"></path><path d="M27.4 24.2 Q29.5 22 31.6 24.2" fill="none" stroke="#3B3220" stroke-width="1.8" stroke-linecap="round"></path></g><path class="pea-smile" d="M19 29 Q24 32.5 29 29" fill="none" stroke="#3B3220" stroke-width="1.8" stroke-linecap="round"></path><path class="pea-grin" d="M18.5 28.5 Q24 35.5 29.5 28.5 Z" fill="#3B3220"></path><circle class="pea-blush" cx="15.5" cy="28.5" r="2" fill="#DC8A4F"></circle><circle class="pea-blush" cx="32.5" cy="28.5" r="2" fill="#DC8A4F"></circle></svg></span><span class="brand-name">Chickpea</span></button><span class="chip">${targetChip}</span></div>' +
      '<details class="topbar-menu"><summary aria-label="Menu">' + icon("bars-3") + '</summary></details>' +
      '<div class="actions actions-list">' + connectedBadge +
      '<a class="btn btn-ghost" href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">Open Slack console &nearr;</a>' +
      '<button type="button" class="btn btn-soft' + (state.view === "profiles" ? " nav-active" : "") + '" data-action="open-profiles">Profiles</button>' +
      '<button type="button" class="btn btn-soft' + (state.view === "settings" ? " nav-active" : "") + '" data-action="open-settings">Settings</button></div>' +
      "</header>";
  }

  // The connected workspace's display name for a rail group header: the friendly
  // team name for the workspace Chickpea is installed in, else the raw workspace id
  // (multiple workspaces can be grouped; only the connected one has a name).
  function railGroupLabel(workspaceId) {
    if (isSlackConnected() && workspaceId === connectedTeamId() && state.slack.teamName) return state.slack.teamName;
    return workspaceId || "Workspace";
  }

  function railHtml() {
    // Not connected → the whole screen is the Connect stepper; the rail (and its
    // add affordance) stay gated off until Slack is live.
    if (state.slack && !state.slack.connected) return "";
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
    var html = '<nav class="rail" aria-label="Channels">' +
      '<div class="rail-head"><span class="section-eyebrow">Slack channels</span><span class="hint" style="font-size:0.6875rem;">' + channels.length + '</span></div>';
    if (channels.length === 0) {
      html += '<div class="ws-row">' + icon("chevron-down") + esc(railGroupLabel(connectedTeamId())) + '</div>' +
        '<div class="empty" style="margin:8px 0 8px 12px; padding:12px;"><p class="hint" style="margin:0;">No channels yet</p></div>';
    } else {
      groups.forEach(function (group) {
        html += '<div class="ws-row">' + icon("chevron-down") + esc(railGroupLabel(group.workspaceId)) + '</div>';
        group.assignments.forEach(function (assignment) {
          var active = state.active && state.active.workspaceId === assignment.workspaceId && state.active.channelId === assignment.channelId;
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
      (addDisabled ? ' disabled title="Connect Slack first"' : '') + '>' + icon("plus") + 'Add channel</button>';
    if (addDisabled) {
      html += '<p class="hint" style="margin-left:12px; padding:0 10px;">Connect Slack first</p>';
    }
    return html + '</nav>';
  }

  function mainHtml() {
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
        '<p class="hint">Pick a Slack channel and attach a profile. Chickpea answers @mentions there.</p>' +
        addChannelButtonHtml("btn btn-soft") +
        '</div>';
      return '<main class="main"><div class="main-inner">' + invite + addPanel + emptyBlock + '</div></main>';
    }
    var agent = agentById(assignment.agentId);
    var enabled = state.channelDraft.enabled;
    return '<main class="main"><div class="main-inner">' + invite + addPanel +
      '<div class="main-head"><div style="display:flex; flex-direction:column; gap:2px;">' +
      '<h1 class="page-title mono-title">' + esc(channelLabel(assignment)) + '</h1>' +
      '<p class="hint">What Chickpea can do in this channel. It answers mentions here, always as @Tag.</p>' +
      '</div><label style="display:flex; align-items:center; gap:10px;"><span class="hint">' + (enabled ? "Enabled" : "Disabled") + '</span>' +
      '<span class="toggle"><span class="thumb"></span><input type="checkbox" data-action="channel-enabled" ' + (enabled ? "checked" : "") + ' aria-label="Channel enabled"></span></label></div>' +
      profileSectionHtml(agent, assignment) +
      channelInstructionsHtml() +
      accessSummaryHtml() +
      advancedHtml(assignment) +
      saveBarHtml() +
      slackBottom +
      '</div></main>';
  }

  // ---- Connected funnel (card 04) ------------------------------------------

  function successToastHtml() {
    if (!state.slackToast || state.slackToastDismissed) return "";
    var team = state.slackToast.team;
    var botName = state.slackToast.botName || "Tag";
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
      '<p class="hint">Want proof right now? DM <span class="mono" style="color:var(--text-2);">@Tag</span> &mdash; direct messages already work.</p>' +
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
      (disabled ? ' disabled title="Connect Slack first"' : '') + '>Add channel</button>';
  }

  function inviteReminderHtml() {
    if (!state.addChannelInvite) return "";
    return '<div class="empty" style="border-left:2px solid var(--ember);"><p class="field-label">Invite Tag to finish</p>' +
      '<p class="hint">' + esc(state.addChannelInvite) + '</p></div>';
  }

  function channelOptionsHtml() {
    var channels = (state.slackChannels && state.slackChannels.channels) || [];
    if (channels.length === 0) {
      return '<option value="">No channels found &mdash; invite @Tag, then Refresh</option>';
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
      '<p class="hint">Attach to a Slack channel. Chickpea answers @mentions there with the ' + esc(addChannelAgentName()) + ' profile &mdash; customize it on the channel page after.</p></div>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="cancel-add-channel">Cancel</button></div>';
    if (!isSlackConnected()) {
      return '<section class="section">' + head +
        '<div class="empty"><p class="field-label">Connect Slack first</p>' +
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
      selector = '<div class="field"><label class="field-label">Channel</label>' +
        '<p class="field-error">' + esc(state.slackChannelsError) + '</p>' +
        '<div>' + refreshBtn + '</div></div>';
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
        '<p class="hint">Don\\'t see it? Invite @Tag to the channel in Slack, then click Refresh. ' +
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
        '<div class="step-body"><div class="step-done-line"><span class="step-title">Create your Slack app</span>' +
        '<span class="hint" style="color:var(--ok);">App created</span></div></div></div>';
    }
    return '<div class="step-block">' +
      '<span class="step-num active">1</span>' +
      '<div class="step-body">' +
      '<div class="step-title">Create your Slack app</div>' +
      '<p class="hint">Opens Slack with a manifest that pre-fills everything, including this install&rsquo;s events URL.</p>' +
      '<div class="field" style="gap:4px;"><span class="tiny-label">Events URL (already in the manifest)</span>' +
      '<span class="chip">' + esc(conn.requestUrl) + '</span></div>' +
      '<div><a class="btn btn-primary" href="' + esc(conn.manifestUrl) + '" target="_blank" rel="noreferrer" data-action="advance-slack-step">Create your Slack app &nearr;</a></div>' +
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
    var validateBtn = state.slackBusy
      ? '<button type="submit" class="btn btn-primary" disabled><span class="spinner"></span>Validating&hellip;</button>'
      : '<button type="submit" class="btn btn-primary">Validate &amp; save</button>';
    var validateTail = state.slackError
      ? '<span class="field-error">' + esc(state.slackError) + '</span>'
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
      slackStepBoldHint("Bot User OAuth Token") + ' &mdash; in the left sidebar, click the <span class="chip">OAuth &amp; Permissions</span> tab. Under the <span class="chip">OAuth Tokens</span> heading, click the green ' + slackStepBoldHint("Install to (your workspace)") + ' button &rarr; Allow. The token (<span class="chip">xoxb-&hellip;</span>) appears there after installing. Copy it.</span></div>' +
      '<input class="input mono" name="botToken" type="password" autocomplete="off" aria-label="Bot token" placeholder="Paste the xoxb-&hellip; token here" value="' + esc(state.slackDraft.botToken) + '" data-action="slack-bot-token"></div>' +
      '<div class="full" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">' + validateBtn + validateTail + '</div>' +
      '</form></div></div>';
  }

  function slackStepperHtml() {
    var conn = state.slack;
    if (!conn) return "";
    return '<section class="section"><div class="section-head"><div><h2 class="section-title">Connect Slack</h2>' +
      '<p class="hint">Two steps: create the app, then install it and paste two values back as you copy them.</p></div>' +
      '<span class="badge badge-off"><span class="dot"></span>Not connected</span></div>' +
      '<div class="stepper">' + slackStep1Html(conn) + slackStep2Html() + '</div></section>' +
      '<details class="advanced"><summary>Request URL shows as unverified?</summary>' +
      '<div class="adv-rows" style="padding-bottom:14px;"><p class="hint">Open ' + slackStepBoldHint("Event Subscriptions") + ' in Slack and click ' + slackStepBoldHint("Retry") + ' &mdash; the worker echoes the verification challenge even before these credentials are saved.</p></div></details>' +
      '<details class="advanced"><summary>Where credentials come from</summary>' +
      '<div class="adv-rows" style="padding-bottom:14px;">' + slackCredentialsWellHtml(conn) + '</div></details>';
  }

  function slackErrorText(message, detail) {
    if (message === "slack_auth_failed") return "Slack rejected the bot token (auth.test failed" + (detail ? ": " + detail : "") + "). Re-copy the xoxb- token and try again.";
    if (message === "slack_unreachable") return "Could not reach the Slack API to validate the token. Check connectivity and try again.";
    if (message === "internal_error") return "Chickpea could not store the credentials (an internal error). Check the worker logs and try again.";
    return detail ? message + ": " + detail : message;
  }

  function submitSlackConnection(formData) {
    // Submitting the paste form means step 2 is the active surface — pin it so a
    // validation error renders against the fields (not a collapsed step).
    state.slackStep = 2;
    var botToken = String(formData.get("botToken") || "").trim();
    var signingSecret = String(formData.get("signingSecret") || "").trim();
    state.slackDraft = { botToken: botToken, signingSecret: signingSecret };
    if (!botToken) { state.slackError = "Bot token is required."; render(); return; }
    if (!signingSecret) { state.slackError = "Signing secret is required."; render(); return; }
    state.slackError = "";
    state.slackBusy = true;
    render();
    postJson("/admin/api/slack-connection", "POST", { botToken: botToken, signingSecret: signingSecret }).then(function (result) {
      state.slackBusy = false;
      state.slackDraft = { botToken: "", signingSecret: "" };
      // The connected funnel's success toast is driven off the POST result
      // (team + botName): the follow-up GET reports connected but not botName,
      // so capture them here. Reset the stepper for any later reconnect.
      state.slackToast = { team: (result && result.team) || "", botName: (result && result.botName) || "" };
      state.slackToastDismissed = false;
      state.slackStep = 1;
      return refreshData();
    }).catch(function (error) {
      state.slackBusy = false;
      state.slackError = slackErrorText(error.message, error.detail);
      render();
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
        '<div class="kv"><dt>Replies as</dt><dd>Tag &mdash; the install-wide Slack identity shared by every channel</dd></div>' +
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
      '<p class="hint" style="max-width:58ch;">A profile is the reusable behavior you attach to a channel &mdash; its instructions, model, skills, and connections. One profile can answer in many channels, and it always replies as <b style="font-weight:500; color:var(--text);">@Tag</b> &mdash; a profile changes how Chickpea answers, never who it is.</p>' +
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
    var meta = modelPart + " &middot; " + usage;
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
    if (code === "rate_limited") return "GitHub rate limit hit. Try again in a little while.";
    if (code === "github_error") return "GitHub had trouble with that request. Try again in a moment.";
    if (code === "unrecognized_source") return "That does not look like a repo, a GitHub URL, or a skills.sh link.";
    return "Could not import skills from that source.";
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
    return '<div class="import-summary"><span>' + summary + notes + '</span>' + selectAll + "</div>" +
      listOrEmpty + actions;
  }

  function skillImportPanelHtml(imp) {
    // Before "Find skills" resolves: the source input + Find/Cancel actions.
    if (!imp.resolution) {
      var findLabel = imp.loading ? "Finding&hellip;" : "Find skills";
      return '<div class="skill-form import-panel">' +
        '<div class="field"><label class="field-label" for="import-source">Import from a URL</label>' +
        '<input class="input mono" id="import-source" type="text" value="' + esc(imp.source) + '" placeholder="owner/repo, a GitHub URL, or a skills.sh link" data-action="import-source">' +
        '<p class="hint">Paste a repo, a GitHub link, or a skills.sh page. Narrow to one skill with owner/repo@skill.</p></div>' +
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

  // ---- Capability tabs (Instructions / Skills / Connections) ---------------

  // One panel is visible at a time; the other two stay MOUNTED but [hidden] so
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
      connections: !!state.connectionEditor
    };
    var tabs = [
      { id: "instructions", label: "Instructions", count: 0 },
      { id: "skills", label: "Skills", count: (draft.skills || []).length },
      { id: "connections", label: "Connections", count: (draft.mcpServers || []).length }
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
    var q = String(state.connectorGallerySearch || "").trim().toLowerCase();
    var shown = (CONNECTOR_PRESETS || []).filter(function (preset) {
      return !q || preset.name.toLowerCase().indexOf(q) >= 0;
    }).slice().sort(function (a, b) {
      var an = a.name.toLowerCase();
      var bn = b.name.toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    var rows = shown.map(function (preset) {
      return '<div class="gallery-row">' + connectorLogoHtml(preset) +
        '<span class="gallery-row-name">' + esc(preset.name) + '</span>' +
        '<span class="gallery-row-spacer"></span>' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="conn-preset" data-preset="' + esc(preset.id) + '">Connect</button></div>';
    }).join("");
    var list = shown.length
      ? '<div class="gallery-list">' + rows + '</div>'
      : '<div class="gallery-empty">No connectors match &ldquo;' + esc(state.connectorGallerySearch) + '&rdquo;.</div>';
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
    return '<span class="conn-pill conn-pill-off">Not tested</span>';
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
    var rows = tools.map(function (tool, index) {
      var on = checked[index] !== false;
      var meta = tool.description ? '<span class="tool-desc">' + esc(tool.description) + '</span>' : "";
      return '<label class="conn-tool">' +
        '<span class="import-check' + (on ? " on" : "") + '"><input type="checkbox" data-action="conn-tool-toggle" data-index="' + index + '" ' + (on ? "checked" : "") + ' aria-label="Allow ' + esc(tool.name) + '"></span>' +
        '<span class="tool-body"><span class="tool-name">' + esc(tool.name) + '</span>' + meta + '</span></label>';
    }).join("");
    var count = tools.length;
    return '<div class="field"><label class="field-label">Discovered tools &mdash; Connected &middot; ' + count + ' tool' + (count === 1 ? "" : "s") + '</label>' +
      '<p class="hint">All checked by default. Uncheck write-capable tools you don&rsquo;t need.</p>' +
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
    var testDisabled = !String(editor.url || "").trim();
    var toolsHtml = connectionToolsHtml(editor);
    var testError = editor.testError ? '<p class="field-error">' + esc(editor.testError) + '</p>' : "";
    var testLabel = editor.testing ? "Testing&hellip;" : (editor.lifecycleStatus === "ready" ? "Re-test connection" : "Test connection");
    return '<div><button type="button" class="btn btn-soft btn-sm" data-action="conn-test"' + (testDisabled ? " disabled" : "") + '>' + testLabel + '</button>' + testError + '</div>' +
      toolsHtml +
      (editor.error ? '<p class="field-error">' + esc(editor.error) + '</p>' : "") +
      '<div class="skill-form-actions">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="conn-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="conn-save-row">' + (isNew ? "Add connection" : "Save connection") + '</button></div>';
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
    } else {
      var headerName = preset.auth.headerName;
      var headerSources = (editor.sources && editor.sources.headers) || {};
      var headerStored = headerSources[headerName] && headerSources[headerName] !== "missing";
      var headerPlaceholder = headerStored ? "\\u2022\\u2022\\u2022\\u2022 stored" : preset.auth.placeholder;
      tokenHtml = '<div class="field"><label class="field-label">API key</label>' +
        '<input class="input mono" type="password" autocomplete="off" value="' + esc((editor.headerValues || [])[0] || "") + '" placeholder="' + esc(headerPlaceholder) + '" data-action="conn-header-value" data-index="0"></div>';
    }
    var docsHtml = preset.tokenDocsHint ? '<p class="hint">' + esc(preset.tokenDocsHint) + '</p>' : "";
    if (preset.tokenDocsUrl) {
      docsHtml += '<a class="hint-link" href="' + esc(preset.tokenDocsUrl) + '" target="_blank" rel="noopener noreferrer">Where do I find this?</a>';
    }
    var notesHtml = preset.notes ? '<p class="hint">' + esc(preset.notes) + '</p>' : "";
    return '<div class="conn-recommended-head">' +
      connectorLogoHtml(preset) +
      '<span class="field-label">' + esc(preset.name) + '</span>' +
      '<span class="conn-url-chip mono">' + esc(connectionHost(editor.url)) + '</span></div>' +
      tokenHtml + docsHtml + notesHtml + connectionEditorCompletionHtml(editor);
  }

  function connectionEditorFormHtml(editor) {
    var bearerStored = editor.sources && editor.sources.bearer && editor.sources.bearer !== "missing";
    var bearerPlaceholder = bearerStored ? "\\u2022\\u2022\\u2022\\u2022 stored" : "Paste token \\u2014 stored, never returned by the API";
    var authHtml = '<div class="field"><label class="field-label" for="conn-auth">Authentication</label>' +
      '<div class="select-wrap"><select class="input" id="conn-auth" data-action="conn-auth">' +
      '<option value="none"' + (editor.authMode === "none" ? " selected" : "") + '>None</option>' +
      '<option value="bearer"' + (editor.authMode === "bearer" ? " selected" : "") + '>Bearer token</option>' +
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
    return '<div class="skill-form">' + viewToggle +
      '<div class="field"><label class="field-label" for="conn-name">Name</label>' +
      '<input class="input" id="conn-name" type="text" value="' + esc(editor.displayName) + '" placeholder="Linear" data-action="conn-field-name"></div>' +
      '<div class="field"><label class="field-label" for="conn-url">Server URL</label>' +
      '<input class="input mono" id="conn-url" type="text" value="' + esc(editor.url) + '" placeholder="https://mcp.example.com/mcp" data-action="conn-field-url">' +
      '<p class="hint">https only. The tool prefix is ' + esc(editor.id || connectionSlug(editor.displayName) || "id") + '.</p></div>' +
      '<div class="field"><label class="field-label">Transport</label>' + transportSegmentHtml(editor.transport) + '</div>' +
      authHtml +
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
    return "";
  }

  function connectionsPanelHtml(draft) {
    var servers = draft.mcpServers || [];
    var editor = state.connectionEditor;
    var rows = servers.map(function (conn, index) {
      if (editor && editor.index === index) return connectionEditorFormHtml(editor);
      var transportLabel = conn.transport === "sse" ? "SSE" : "Streamable HTTP";
      var connPreset = conn.presetId ? presetById(conn.presetId) : null;
      var nameHtml = connPreset
        ? '<span class="conn-title">' + connectorLogoHtml(connPreset) + '<span class="sk-name" style="font-family:inherit;">' + esc(conn.displayName) + '</span></span>'
        : '<span class="sk-name" style="font-family:inherit;">' + esc(conn.displayName) + '</span>';
      return '<div class="skill-row conn-row">' +
        '<div class="sk-body">' + nameHtml +
        '<span class="conn-host">' + esc(connectionHost(conn.url)) + '</span>' +
        '<span class="conn-meta"><span class="badge-src">' + transportLabel + '</span>' + connectionStatusPill(conn) + '</span></div>' +
        '<span class="toggle"><span class="thumb"></span><input type="checkbox" data-action="conn-toggle" data-index="' + index + '" ' + (conn.enabled ? "checked" : "") + ' aria-label="Connection enabled"></span>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="conn-edit" data-index="' + index + '">Edit</button>' +
        '<button type="button" class="x-btn" data-action="conn-remove" data-index="' + index + '" aria-label="Remove connection">&times;</button></div>';
    }).join("");
    var list = rows ? '<div class="skill-list">' + rows + '</div>' : "";
    var newForm = (editor && (editor.index === null || editor.index === undefined)) ? '<div class="skill-list">' + connectionEditorFormHtml(editor) + '</div>' : "";
    var gallery = editor ? "" : connectorGalleryHtml();
    var hint = 'Remote MCP servers this profile can call.';
    var security = '<p class="conn-security">Your profile stores connection policy and tool approvals only &mdash; tokens live in the settings store and are never returned by the API.</p>';
    var body = list + newForm + gallery;
    return '<p class="hint ptab-hint">' + hint + '</p>' + body + security;
  }

  // The Remove-connection confirm modal. Rendered only while state.connectionRemove
  // is a valid index. Reuses the shared modal chrome.
  function connectionRemoveModalHtml() {
    if (state.connectionRemove === null || state.connectionRemove === undefined) return "";
    var draft = state.profileDraft;
    var servers = (draft && draft.mcpServers) || [];
    var conn = servers[state.connectionRemove];
    if (!conn) return "";
    return '<div class="modal-backdrop">' +
      '<div class="modal-card" role="dialog" aria-modal="true" aria-label="Remove connection">' +
      '<h2 class="modal-title">Remove ' + esc(conn.displayName) + '?</h2>' +
      '<p class="modal-body">This drops the connection and its tool approvals from this profile. Its stored token and header values are deleted when you save.</p>' +
      '<div class="modal-foot"><span class="spacer"></span>' +
      '<button type="button" class="btn btn-ghost" data-action="conn-remove-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-danger" data-action="conn-remove-confirm">Remove connection</button>' +
      '</div></div></div>';
  }

  function profileNameFieldHtml(draft) {
    var err = state.profileError === "Name is required.";
    return '<div class="field"><label class="field-label" for="p-name">Name</label>' +
      '<input class="input" id="p-name" name="name" type="text" value="' + esc(draft.name) + '"' + (err ? ' style="outline:2px solid var(--danger); outline-offset:-1px;"' : "") + ' data-action="profile-name">' +
      '<p class="hint">Shown here in /admin only. Replies in Slack always post as @Tag.</p>' +
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
    return '<p class="field-error">' + esc(state.profileError) + '</p>';
  }

  // ---- Create (card 10) ----------------------------------------------------

  function profileCreateHtml() {
    var draft = state.profileDraft || newProfileDraft();
    return '<div style="display:flex; flex-direction:column; gap:6px;">' +
      '<button type="button" class="link-btn" style="align-self:flex-start;" data-action="profiles-back">&larr; Profiles</button>' +
      '<h1 class="page-title">New profile</h1>' +
      '<p class="hint">Create a reusable behavior you can attach to channels. It always replies as <b style="font-weight:500; color:var(--text);">@Tag</b>.</p></div>' +
      '<section class="section"><div class="section-head"><div><h2 class="section-title">Details</h2></div></div>' +
      '<div class="form-grid">' +
      profileNameFieldHtml(draft) +
      modelFieldHtml(draft) +
      '</div></section>' +
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
      '<p class="hint">Edit this reusable behavior. It always replies as <b style="font-weight:500; color:var(--text);">@Tag</b>.</p></div>' +
      '<label style="display:flex; align-items:center; gap:10px;"><span class="hint">' + (draft.enabled ? "Enabled" : "Disabled") + '</span>' +
      '<span class="toggle"><span class="thumb"></span><input type="checkbox" name="profile-enabled" data-action="profile-enable-toggle" ' + (draft.enabled ? "checked" : "") + ' aria-label="Profile enabled"></span></label></div>' +
      disableConfirmHtml(draft) +
      '<section class="section"><div class="section-head"><div><h2 class="section-title">Details</h2></div></div>' +
      '<div class="form-grid">' +
      modelFieldHtml(draft) +
      '</div></section>' +
      profileTabsHtml(draft) +
      usedInHtml(draft) +
      profileFooterHtml(draft) +
      '<div class="save-bar-sticky' + (state.profileDirty ? "" : " is-clean") + '">' +
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
      return '<div class="bundle-row"><span class="hint">Connect Slack first to list workspace channels.</span>' +
        '<span class="spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-action="attach-cancel">Close</button></div>';
    }
    if (state.slackChannelsError) {
      return '<div class="bundle-row"><span class="field-error">' + esc(state.slackChannelsError) + '</span>' +
        '<span class="spacer"></span><button type="button" class="btn btn-soft btn-sm" data-action="refresh-channels">Retry</button>' +
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

  function settingsMainHtml() {
    var head = '<div style="display:flex; flex-direction:column; gap:6px;">' +
      '<h1 class="page-title">Settings</h1>' +
      '<p class="hint">Where Chickpea gets its model keys, and which models show up when you pin one to a profile.</p></div>';
    if (state.settingsError) {
      return head + '<div class="empty"><p class="field-label">Settings failed to load</p><p class="error">' + esc(state.settingsError) + '</p></div>';
    }
    if (!state.settingsLoaded || !state.settings) {
      return head + '<div class="empty"><p class="field-label">Loading providers&hellip;</p><p class="hint">Reading provider key status.</p></div>';
    }
    var providers = (state.settings.providers || []).filter(function (provider) {
      // Workers AI is binding-only — shown on Cloudflare, hidden on Node.
      return provider.id !== "workers-ai" || IS_CLOUDFLARE;
    });
    var rows = providers.map(providerRowHtml).join("");
    return head +
      '<section class="section"><div class="section-head"><div><h2 class="section-title">Model providers</h2>' +
      '<p class="hint">A key lets Chickpea run that provider\\'s models. Environment variables always win over keys stored here &mdash; same rule as the Slack connection. Validating a key makes one live call to the provider\\'s models endpoint, which also loads its model list.</p></div></div>' +
      rows +
      '<p class="hint">More providers appear here as this install registers them in <span class="mono" style="color:var(--text-2);">src/app.ts</span>.</p></section>';
  }

  function providerRowHtml(summary) {
    var id = summary.id;
    var meta = providerMeta(id);
    var ui = state.provUi[id] || {};
    var body = "";
    if (ui.removeOpen) body = removeConfirmHtml(id, summary);
    else if (ui.open) body = pasteBodyHtml(id, ui, meta);
    else if (isFavoriteProvider(id)) body = favManagerHtml(id);
    var head = '<div class="prov-head">' +
      '<div class="prov-id"><span class="prov-name">' + esc(meta.name) + '</span>' +
      '<span class="prov-sub">' + esc(meta.sub) + ' &middot; <span class="mono-frag">' + esc(meta.frag) + '</span>' + (meta.suffix ? esc(meta.suffix) : "") + '</span></div>' +
      providerStatusHtml(id, summary) +
      providerActionsHtml(id, summary, ui) +
      '</div>';
    return '<div class="prov-row">' + head + (body ? '<div class="prov-body">' + body + '</div>' : "") + '</div>';
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
        chip = '<span class="badge badge-on"><span class="dot"></span>Via environment</span>';
        parts = ["Read-only"];
      }
      if (count != null) parts.push(count + " models");
      if (favCount != null) parts.push(favCount + " in your picker");
    } else if (status === "stored") {
      chip = '<span class="badge badge-on"><span class="dot"></span>Stored</span>';
      parts = ["Saved here"];
      if (count != null) parts.push(count + " models available");
      if (favCount != null) parts.push(favCount + " in your picker");
    } else {
      return '<div class="prov-status"><span class="badge badge-off"><span class="dot"></span>Missing</span></div>';
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

  function openSettings() {
    state.view = "settings";
    state.profileScreen = "list";
    state.disableConfirm = false;
    render();
    loadSettings().then(render);
  }

  function loadSettings() {
    state.settingsError = "";
    return api("/admin/api/providers").then(function (body) {
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
      state.settingsError = error.message;
      state.settingsLoaded = true;
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
      mcpServers: []
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
      mcpServers: (agent.mcpServers || []).map(cloneConnection)
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
    if (conn.lastCheckedAt !== undefined) copy.lastCheckedAt = conn.lastCheckedAt;
    return copy;
  }

  function modelWarning(model) {
    if (!model || model.indexOf("/") < 1) return "";
    var provider = model.slice(0, model.indexOf("/"));
    var entry = state.models.providers.find(function (item) { return item.id === provider; });
    if (!entry) return "Free text accepted; provider not detected in this install.";
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
    if (state.profileTab === tab) return;
    state.profileTab = tab;
    render();
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
    }
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
      channelPromptAddendum: (assignment && assignment.channelPromptAddendum) || ""
    };
  }

  function selectActive(workspaceId, channelId) {
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
    loadEffective().then(render);
  }

  function refreshData() {
    return Promise.all([
      api("/admin/api/agents"),
      api("/admin/api/assignments"),
      api("/admin/api/models"),
      // Resilient on purpose: the connection card is auxiliary — if this
      // endpoint fails, the rest of the admin page must still render.
      api("/admin/api/slack-connection").catch(function () { return null; })
    ]).then(function (parts) {
      state.agents = parts[0].agents || [];
      state.assignments = parts[1].assignments || [];
      state.models = parts[2];
      state.slack = parts[3];
      var channels = concreteAssignments();
      if (!state.active && channels[0]) {
        state.active = { workspaceId: channels[0].workspaceId, channelId: channels[0].channelId };
      }
      if (state.active) {
        var assignment = activeAssignment();
        if (assignment) {
          state.channelDraft = channelDraftFrom(assignment);
        }
      }
      syncChannelFormWorkspacePrefill();
      return loadEffective();
    }).then(render).catch(function (error) {
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

  function putAssignment(workspaceId, channelId, agentId, enabled, addendum, label) {
    var body = { workspaceId: workspaceId, channelId: channelId, agentId: agentId, enabled: enabled };
    var normalizedLabel = normalizeChannelLabel(label);
    if (normalizedLabel) body.channelLabel = normalizedLabel;
    if (addendum !== undefined) body.channelPromptAddendum = addendum;
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
    if (state.profileScreen === "edit" && state.profileDirty && isEditLeaveAction(action)) {
      state.leavePrompt = { action: action, agent: (target.getAttribute("data-agent") || "") };
      render();
      return;
    }

    // Profiles is now a main-panel destination — open lands on the overview,
    // or (with a data-agent) directly on that profile's edit detail (the
    // channel-page Profile row's Edit affordance).
    if (action === "open-profiles") { enterProfiles(target.getAttribute("data-agent")); }
    // Brand-as-home: the reliable exit back to the channel view from Profiles.
    if (action === "go-home") { state.view = "channels"; state.profileScreen = "list"; state.disableConfirm = false; render(); }
    // Stepper: mark step 1 done and reveal step 2. Not preventing default lets
    // the Create anchor still open Slack in a new tab.
    if (action === "advance-slack-step") { state.slackStep = 2; render(); }
    if (action === "dismiss-slack-toast") { state.slackToastDismissed = true; render(); }
    if (action === "select-channel") { state.view = "channels"; selectActive(target.getAttribute("data-workspace"), target.getAttribute("data-channel")); render(); }
    if (action === "toggle-add-channel") { openAddChannel(); }
    if (action === "cancel-add-channel") { state.addChannelOpen = false; state.addChannelManual = false; state.addChannelError = ""; state.addChannelAgentId = ""; render(); }
    if (action === "refresh-channels") { loadSlackChannels(true); }
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
    if (action === "open-settings") { openSettings(); }
    if (action === "prov-add-key") { openProviderPaste(target.getAttribute("data-provider"), "add"); }
    if (action === "prov-change-key") { openProviderPaste(target.getAttribute("data-provider"), "change"); }
    if (action === "prov-cancel-key") { closeProviderPaste(target.getAttribute("data-provider")); }
    if (action === "prov-validate") { validateProviderKey(target.getAttribute("data-provider")); }
    if (action === "prov-remove") { openProviderRemove(target.getAttribute("data-provider")); }
    if (action === "prov-remove-cancel") { closeProviderRemove(target.getAttribute("data-provider")); }
    if (action === "prov-remove-confirm") { removeProviderKey(target.getAttribute("data-provider")); }
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
    if (action === "open-channel-from-profile") { state.view = "channels"; state.profileScreen = "list"; selectActive(target.getAttribute("data-workspace"), target.getAttribute("data-channel")); render(); }
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
    if (action === "import-skills") { collectProfileDraft(); state.skillEditor = null; state.skillImport = { source: "", loading: false, error: "", resolution: null, selected: [] }; render(); }
    if (action === "import-cancel") { state.skillImport = null; render(); }
    if (action === "import-find") { findSkillsFromSource(); }
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
      state.connectorGallerySearch = "";
      state.connectionEditor = newConnectionEditor();
      render();
    }
    if (action === "conn-preset") {
      var connPresetId = target.getAttribute("data-preset");
      var selectedPreset = presetById(connPresetId);
      if (selectedPreset) {
        collectProfileDraft();
        state.connectorGallerySearch = "";
        state.connectionEditor = editorFromPreset(selectedPreset);
        render();
      }
    }
    if (action === "conn-view" && state.connectionEditor) {
      state.connectionEditor.view = target.getAttribute("data-view") === "advanced" ? "advanced" : "recommended";
      render();
    }
    if (action === "conn-edit") {
      collectProfileDraft();
      var connEditIndex = Number(target.getAttribute("data-index"));
      var connEditServer = (state.profileDraft.mcpServers || [])[connEditIndex];
      if (connEditServer) { state.connectorGallerySearch = ""; state.connectionEditor = editorFromConnection(connEditIndex, connEditServer); render(); }
    }
    if (action === "conn-cancel") { state.connectionEditor = null; render(); }
    if (action === "conn-remove") {
      collectProfileDraft();
      state.connectionRemove = Number(target.getAttribute("data-index"));
      render();
    }
    if (action === "conn-remove-cancel") { state.connectionRemove = null; render(); }
    if (action === "conn-remove-confirm") {
      var removeConnIndex = state.connectionRemove;
      var removeServers = (state.profileDraft && state.profileDraft.mcpServers) || [];
      if (removeConnIndex !== null && removeConnIndex >= 0 && removeConnIndex < removeServers.length) {
        // Record the id so its secrets are DELETEd on the next save, even though
        // the row is gone from the array now.
        rememberRemovedConnection(removeServers[removeConnIndex]);
        removeServers.splice(removeConnIndex, 1);
        state.profileDraft.mcpServers = removeServers;
        // If the open editor pointed at a shifted index, just close it — simplest
        // correct behavior.
        state.connectionEditor = null;
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
    if (action === "conn-test") { testConnection(); }
    if (action === "conn-save-row") { commitConnectionRow(); }
  });

  document.addEventListener("input", function (event) {
    var target = event.target;
    var action = target.getAttribute && target.getAttribute("data-action");
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
    // Preserve a half-typed manual channel id across re-renders.
    if (action === "manual-channel-input") { state.channelFormDraft.channelId = target.value; }
    // Mirror the import source into state without a re-render so the input keeps
    // focus; "Find skills" reads it off state.skillImport.
    if (action === "import-source" && state.skillImport) { state.skillImport.source = target.value; }
    // Mirror the pasted provider key into state so a re-render (e.g. a validate
    // spinner) never wipes it; the favorites search re-renders only its own
    // results container to keep the input focused.
    if (action === "prov-key-input") { provUiFor(target.getAttribute("data-provider")).key = target.value; }
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
    }
  });

  document.addEventListener("change", function (event) {
    var target = event.target;
    var action = target.getAttribute && target.getAttribute("data-action");
    if (action === "channel-enabled") {
      state.channelDraft.enabled = target.checked;
      state.dirty = true;
      render();
    }
    // Remember the picked channel so a Refresh / re-render keeps the selection.
    if (action === "select-channel-option") { state.addChannelSelected = target.value; }
    if (action === "attach-channel-option") { state.attachChannelSelected = target.value; }
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
    // Connection auth mode select (None / Bearer). Re-render to show/hide the
    // bearer paste field.
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
      markProfileDirty();
      render();
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
    if (action === "add-channel-form") addChannel(new FormData(form));
    if (action === "slack-connect-form") submitSlackConnection(new FormData(form));
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
    if (state.profileRenaming) {
      if (event.key === "Enter") { event.preventDefault(); closeProfileRename(false); return; }
      if (event.key === "Escape" || event.key === "Esc") { closeProfileRename(true); return; }
    }
    if (event.key === "Escape" || event.key === "Esc") {
      if (state.leavePrompt) { state.leavePrompt = null; render(); return; }
      if (state.modelPickerOpen) { closeModelPicker(); }
    }
    // ARIA tabs keyboard contract for the capability tab bar: Left/Right (and
    // Home/End) move focus AND activate; the roving tabindex in profileTabsHtml
    // keeps exactly one pill in the document Tab order.
    var tabButton = event.target && event.target.closest && event.target.closest(".ptab");
    if (tabButton && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      var order = ["instructions", "skills", "connections"];
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
      if (state.profileScreen === "edit" && state.profileDirty) {
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
      if (state.profileScreen === "edit" && state.profileDirty && targetPath !== canonicalPath()) {
        history.pushState(null, "", canonicalPath());
        state.leavePrompt = { action: "route", path: targetPath };
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
      state.profileDraft = cloneAgent(target);
    } else {
      state.profileScreen = "list";
      state.profileDraft = null;
      state.editingAgentId = null;
    }
    render();
  }

  function openAddChannel(agentId) {
    state.view = "channels";
    state.addChannelOpen = true;
    state.addChannelError = "";
    state.addChannelInvite = "";
    state.addChannelAgentId = agentId || "";
    if (!ensureSlackChannelsLoaded()) render();
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
    state.slackChannelsLoading = true;
    state.slackChannelsError = "";
    render();
    return api("/admin/api/slack-channels" + (refresh ? "?refresh=1" : "")).then(function (body) {
      state.slackChannels = body;
      state.slackChannelsLoading = false;
      // Adopt the workspace identity the proxy backfilled so the locked
      // Workspace field and the connection card both name it, even on installs
      // that predate team persistence.
      if (state.slack) {
        if (body.teamId) state.slack.teamId = body.teamId;
        if (body.teamName) state.slack.teamName = body.teamName;
      }
      render();
    }).catch(function (error) {
      state.slackChannelsLoading = false;
      state.slackChannelsError = slackChannelsErrorText(error);
      render();
    });
  }

  function slackChannelsErrorText(error) {
    if (error && error.message === "slack_not_configured") return "Connect Slack first to list channels.";
    if (error && error.message === "slack_list_failed" && error.detail) {
      return "Slack could not list channels (" + error.detail + ").";
    }
    return (error && (error.serverMessage || error.message)) || "Could not load channels.";
  }

  function addChannelErrorText(error) {
    if (error && error.serverMessage) return error.serverMessage;
    var message = error && error.message;
    if (message === "channel_not_found") return "Slack could not find that channel in the connected workspace. Check the ID, and invite @Tag if it is private.";
    if (message === "workspace_mismatch") return "That channel belongs to a different workspace than the one Chickpea is connected to.";
    if (message === "unknown_agent") return "The profile no longer exists. Reload and try again.";
    return message || "Could not add the channel.";
  }

  function channelInviteWarning(channelName) {
    return "#" + channelName + " was added, but @Tag isn't a member of it yet, so it won't hear mentions there. Invite @Tag to #" + channelName + " in Slack — no need to come back here.";
  }

  function addChannel(formData) {
    var agent = agentById(state.addChannelAgentId) || defaultAgent();
    var fail = function (message) { state.addChannelError = message; render(); };
    if (!agent) { fail("Create a profile before adding a channel."); return; }
    if (!isSlackConnected()) { fail("Connect Slack first."); return; }
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
    putAssignment(assignment.workspaceId, assignment.channelId, select.value, assignment.enabled, assignment.channelPromptAddendum, assignment.channelLabel).then(function () {
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
    putAssignment(assignment.workspaceId, assignment.channelId, assignment.agentId, state.channelDraft.enabled, state.channelDraft.channelPromptAddendum, assignment.channelLabel).then(function () {
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
      // Secret presence is inferred from the persisted policy (secrets-by-
      // reference): a saved bearer connection means a token was stored, a saved
      // headerName means that header value was stored. A freshly typed value
      // overrides the placeholder. Blank for a new connection.
      sources: { bearer: "missing", headers: {} },
      error: ""
    };
  }

  function editorFromPreset(preset) {
    var authMode = preset.auth.kind === "bearer" ? "bearer" : "none";
    var headerNames = preset.auth.kind === "header" ? [preset.auth.headerName] : [];
    var headerValues = preset.auth.kind === "header" ? [""] : [];
    return Object.assign(newConnectionEditor(), {
      index: null,
      preset: preset,
      presetId: preset.id,
      view: "recommended",
      displayName: preset.name,
      url: preset.url,
      transport: preset.transport,
      id: preset.id,
      authMode: authMode,
      headerNames: headerNames,
      headerValues: headerValues
    });
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
    editor.headerNames = (conn.headerNames || []).slice();
    editor.headerValues = editor.headerNames.map(function () { return ""; });
    editor.enabled = !!conn.enabled;
    editor.lifecycleStatus = conn.lifecycleStatus || "pending";
    editor.statusText = conn.statusText || "";
    editor.lastCheckedAt = conn.lastCheckedAt !== undefined ? conn.lastCheckedAt : null;
    editor.discoveredTools = (conn.discoveredTools || []).map(function (tool) {
      var t = { name: tool.name };
      if (tool.title !== undefined) t.title = tool.title;
      if (tool.description !== undefined) t.description = tool.description;
      return t;
    });
    var approved = conn.allowedTools || [];
    editor.checked = editor.discoveredTools.map(function (tool) { return approved.indexOf(tool.name) >= 0; });
    var headerSources = {};
    editor.headerNames.forEach(function (name) { headerSources[name] = "stored"; });
    editor.sources = { bearer: conn.authMode === "bearer" ? "stored" : "missing", headers: headerSources };
    editor.presetId = conn.presetId;
    if (conn.presetId) {
      editor.preset = presetById(conn.presetId) || null;
      if (editor.preset) editor.view = "recommended";
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
    var checked = editor.checked || [];
    var allowed = discovered.filter(function (tool, i) { return checked[i] !== false; }).map(function (tool) { return tool.name; });
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
    if (editor.lastCheckedAt) conn.lastCheckedAt = editor.lastCheckedAt;
    if (editor.presetId) conn.presetId = editor.presetId;
    return conn;
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
    var servers = (state.profileDraft && state.profileDraft.mcpServers) || [];
    var validationError = validateConnectionEditor(editor, servers);
    if (validationError) { editor.error = validationError; render(); return; }
    var conn = connectionFromEditor(editor);
    var prior = (editor.index === null || editor.index === undefined) ? null : servers[editor.index];
    if (editor.index === null || editor.index === undefined) { servers.push(conn); }
    else { servers[editor.index] = conn; }
    state.profileDraft.mcpServers = servers;
    stagePendingSecrets(conn.id, editor, prior);
    state.connectionEditor = null;
    markProfileDirty();
    render();
  }

  // Commit a filled-but-not-"Added" connection editor into the draft on save, so
  // a typed connection is never silently dropped. Mirrors commitOpenSkillEditor:
  // returns false (and keeps the editor open with an inline error) if invalid.
  function commitOpenConnectionEditor() {
    var editor = state.connectionEditor;
    if (!editor) return true;
    // A completely empty editor is discarded silently.
    if (!String(editor.displayName || "").trim() && !String(editor.url || "").trim()) {
      state.connectionEditor = null;
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
    state.connectionEditor = null;
    return true;
  }

  // After the profile PATCH succeeds, PUT any staged secrets and DELETE the
  // secrets of removed connections, then clear the transient state. Runs
  // fire-and-forget: a secret write failure must not block the saved profile.
  function flushConnectionSecrets(draft, agentId) {
    var pending = (draft && draft.pendingSecrets) || {};
    var removed = (draft && draft.removedConnections) || [];
    // A same-slug remove + re-add in one save stages BOTH a DELETE and a PUT for
    // that id. Skip the DELETE when a value-bearing PUT is pending for the same
    // id, so an out-of-order DELETE can't clobber the just-stored secret. (Any
    // header the re-add dropped is left orphaned but inert — turn time only
    // sends headers named on the current connection.)
    function pendingHasValue(id) {
      var e = pending[id];
      return !!e && (e.bearerToken !== undefined || e.headers !== undefined);
    }
    removed.forEach(function (entry) {
      if (pendingHasValue(entry.id)) return;
      postJson("/admin/api/agents/" + encodeURIComponent(agentId) + "/mcp/secrets/" + encodeURIComponent(entry.id), "DELETE", { headerNames: entry.headerNames || [] }).catch(function () {});
    });
    Object.keys(pending).forEach(function (id) {
      var entry = pending[id];
      var body = { headerNames: entry.headerNames || [] };
      if (entry.bearerToken !== undefined) body.bearerToken = entry.bearerToken;
      if (entry.headers !== undefined) body.headers = entry.headers;
      if (entry.removeHeaderNames && entry.removeHeaderNames.length) body.removeHeaderNames = entry.removeHeaderNames;
      if (entry.clearBearer) body.clearBearer = true;
      // Round-trip when there is a value to store OR an orphan to clean up.
      if (body.bearerToken !== undefined || body.headers !== undefined || body.removeHeaderNames !== undefined || body.clearBearer !== undefined) {
        postJson("/admin/api/agents/" + encodeURIComponent(agentId) + "/mcp/secrets/" + encodeURIComponent(id), "PUT", body).catch(function () {});
      }
    });
    // Clear the transient secret state — typed values never survive a save.
    if (draft) { draft.pendingSecrets = {}; draft.removedConnections = []; }
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
    imp.loading = true;
    imp.error = "";
    render();
    postJson("/admin/api/skills/resolve", "POST", { source: source }).then(function (body) {
      var current = state.skillImport;
      // The panel may have been closed while the request was in flight.
      if (!current) return;
      var resolution = body && body.resolution ? body.resolution : { owner: "", repo: "", skills: [], capped: false, skipped: 0 };
      current.loading = false;
      current.error = "";
      current.resolution = resolution;
      current.selected = (resolution.skills || []).map(function () { return true; });
      render();
    }).catch(function (error) {
      var current = state.skillImport;
      if (!current) return;
      current.loading = false;
      current.error = (error && error.serverMessage) || skillImportFallback(error && error.message);
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
    return action === "open-profiles" || action === "open-settings" ||
      action === "go-home" || action === "profiles-back";
  }

  // Perform a confirmed leave — the edit draft is dropped and the pending
  // navigation is carried out. Used by both "Discard & leave" and the
  // after-save continuation.
  function performProfileLeave(pending) {
    state.leavePrompt = null;
    state.profileDirty = false;
    state.skillEditor = null;
    state.skillImport = null;
    state.connectionEditor = null;
    state.connectorGallerySearch = "";
    state.connectionRemove = null;
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
      openSettings();
    } else if (action === "go-home") {
      state.view = "channels";
      state.profileScreen = "list";
      render();
    } else {
      state.view = "profiles";
      state.profileScreen = "list";
      render();
    }
  }

  function saveProfile(onSaved) {
    var draft = collectProfileDraft();
    // Clear any stale field error BEFORE the commit gates below render — a
    // fixed-but-uncleared error would otherwise resurface on a hidden panel.
    state.profileError = "";
    // Commit an open inline skill editor into the draft first — a filled-but-
    // not-"Added" skill must be saved, not silently dropped. Abort on invalid,
    // jumping to the tab that carries the inline error so it is visible.
    if (!commitOpenSkillEditor()) { showProfileTab("skills"); return; }
    // Same for an open Connections editor — commit it into mcpServers (and stage
    // its typed secrets) before the PATCH, or bail on an inline validation error.
    if (!commitOpenConnectionEditor()) { showProfileTab("connections"); return; }
    if (!draft.name) { state.profileError = "Name is required."; render(); return; }
    if (!draft.instructions) { state.profileError = "Profile instructions are required."; state.profileTab = "instructions"; render(); return; }
    var body = {
      name: draft.name,
      instructions: draft.instructions,
      enabled: draft.enabled,
      skills: draft.skills || [],
      // POLICY ONLY. connectionFromEditor / cloneConnection strip secrets by
      // construction — no token or header VALUE is ever in this array.
      mcpServers: draft.mcpServers || []
    };
    var isEdit = !!draft.id;
    // Capture the draft carrying the transient secrets + removals BEFORE the
    // post-save re-clone wipes them, so the secret PUT/DELETE still run.
    var secretsDraft = draft;
    var request;
    if (isEdit) {
      body.model = draft.model || null;
      request = postJson("/admin/api/agents/" + encodeURIComponent(draft.id), "PATCH", body);
    } else {
      if (draft.model) body.model = draft.model;
      body.id = slugId(draft.name);
      request = postJson("/admin/api/agents", "POST", body);
    }
    var secretAgentId = isEdit ? draft.id : body.id;
    request.then(function () {
      state.profileError = "";
      state.profileDirty = false;
      state.disableConfirm = false;
      // Persist secrets by reference and clear the transient state — typed tokens
      // never survive a save. Fire-and-forget: a secret write failure must not
      // block the saved profile.
      flushConnectionSecrets(secretsDraft, secretAgentId);
      if (isEdit) {
        // Stay on the editor; re-clone the draft from the refreshed agent so the
        // form reflects exactly what persisted (and the save bar re-disables).
        // If a leave was requested (Save changes in the guard modal), carry it
        // out now that the save succeeded, instead of staying on the editor.
        return refreshData().then(function () {
          var saved = agentById(state.editingAgentId);
          if (saved) state.profileDraft = cloneAgent(saved);
          if (onSaved) { onSaved(); } else { render(); }
        });
      }
      // Create → return to the overview so the new profile shows in the list.
      state.profileScreen = "list";
      state.profileDraft = null;
      state.editingAgentId = null;
      return refreshData();
    }).catch(function (error) { state.profileError = error.serverMessage || error.message; render(); });
  }

  function discardProfile() {
    var saved = agentById(state.editingAgentId);
    state.profileDraft = saved ? cloneAgent(saved) : newProfileDraft();
    state.profileError = "";
    state.profileDirty = false;
    state.disableConfirm = false;
    state.skillEditor = null;
    state.skillImport = null;
    state.connectionEditor = null;
    state.connectorGallerySearch = "";
    state.connectionRemove = null;
    render();
  }

  function deleteProfileErrorText(error) {
    // The delete button is disabled while assigned, but the server is the guard
    // of record (409 agent_still_assigned) — surface it honestly if it ever races.
    if (error && error.message === "agent_still_assigned") {
      return "This profile is still attached to a channel. Detach it everywhere first.";
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
    putAssignment(workspaceId, channel.id, draft.id, enabled, addendum, label).then(function (result) {
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
  // loaded, then turn URL sync on with a replace so landing on /admin doesn't
  // add a history entry for the auto-selected channel.
  var initialRoute = canNavigate ? location.pathname : "/admin";
  refreshData().then(function () {
    if (initialRoute !== "/admin") applyRoute(initialRoute);
    routeReady = true;
    syncUrl(true);
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

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
