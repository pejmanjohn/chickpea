import { isCloudflareTarget } from '../config/runtime-target.ts';

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
<title>Tag Team · /admin</title>
<style>
:root {
  --bg: #ffffff;
  --well: #f7f5f2;
  --raise: rgba(28, 25, 23, 0.04);
  --line: rgba(28, 25, 23, 0.08);
  --line-strong: rgba(28, 25, 23, 0.14);
  --text: #201d1a;
  --text-2: #57534c;
  --text-3: #8a857d;
  --ember: #e8833a;
  --ember-deep: #b05415;
  --ember-bright: #f09a55;
  --ember-tint: rgba(232, 131, 58, 0.13);
  --ok: #1f7a44;
  --ok-tint: rgba(31, 122, 68, 0.1);
  --danger: #c03538;
  --danger-tint: rgba(192, 53, 56, 0.08);
  --font: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --radius: 8px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { color-scheme: light; }
body {
  background: var(--bg);
  color: var(--text-2);
  font-family: var(--font);
  font-feature-settings: "cv02", "cv03", "cv04", "cv11";
  font-size: 0.875rem;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
button, input, textarea, select { font: inherit; }
::selection { background: var(--ember-tint); }
.ic   { flex-shrink: 0; height: 16px; width: 16px; }
.ic-l { height: 1lh; }
.step-num, .layer-legend .step .n, .fav-meta, .fav-model { font-variant-numeric: tabular-nums; }
.page-title { color: var(--text); font-size: 1.0625rem; font-weight: 600; letter-spacing: 0; text-wrap: balance; }
.page-title.mono-title { font-family: var(--mono); font-size: 1rem; }
.section-eyebrow {
  color: var(--text-3);
  font-family: var(--mono);
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.field-label { color: var(--text); display: block; font-size: 0.8125rem; font-weight: 500; }
.hint { color: var(--text-3); font-size: 0.8125rem; text-wrap: pretty; }
.mono { font-family: var(--mono); font-size: 0.78125rem; }
.btn {
  align-items: center;
  border: 0;
  border-radius: var(--radius);
  cursor: pointer;
  display: inline-flex;
  font-size: 0.8125rem;
  font-weight: 500;
  gap: 6px;
  justify-content: center;
  min-height: 34px;
  padding: 7px 12px;
  text-decoration: none;
}
.btn:disabled { cursor: not-allowed; opacity: 0.5; }
.btn:focus-visible, .x-btn:focus-visible, .rail-add:focus-visible, .chan-item:focus-visible {
  outline: 2px solid var(--ember-deep);
  outline-offset: 2px;
}
.btn-primary { background: var(--ember); color: #22130a; }
.btn-primary:hover:not(:disabled) { background: var(--ember-bright); }
.btn-soft { background: rgba(28, 25, 23, 0.06); color: var(--text); }
.btn-soft:hover:not(:disabled) { background: rgba(28, 25, 23, 0.09); }
.btn-ghost { background: transparent; color: var(--text-2); }
.btn-ghost:hover:not(:disabled) { background: rgba(28, 25, 23, 0.05); color: var(--text); }
.btn-danger { background: var(--danger-tint); color: #a92c30; }
.btn-danger:hover:not(:disabled) { background: rgba(192, 53, 56, 0.13); }
.btn-sm { border-radius: 6px; font-size: 0.75rem; min-height: 28px; padding: 4px 9px; }
.btn.i-lead { padding-left: 8px; }
.btn-sm.i-lead { padding-left: 6px; }
.input, .textarea {
  background: #fff;
  border: 0;
  border-radius: var(--radius);
  box-shadow: inset 0 0 0 1px rgba(28, 25, 23, 0.15);
  color: var(--text);
  font-size: 0.875rem;
  padding: 8px 11px;
  width: 100%;
}
.input::placeholder, .textarea::placeholder { color: var(--text-3); }
.input:focus-visible, .textarea:focus-visible {
  outline: 2px solid var(--ember-deep);
  outline-offset: -1px;
}
.textarea { line-height: 1.55; min-height: 96px; resize: vertical; }
.input.mono, .textarea.mono { font-size: 0.8125rem; }
/* Native <select> with a custom chevron: the browser's default caret varies by
   OS and does not match the app's icon set, so hide it (appearance:none) and
   overlay the inline chevron-down SVG. The select keeps its full width; the
   wrapper is the positioning context and the SVG is right-aligned, centered,
   and click-through (pointer-events:none). */
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
  background: rgba(28, 25, 23, 0.12);
  border-radius: 999px;
  display: inline-flex;
  flex-shrink: 0;
  padding: 2px;
  position: relative;
  transition: background 0.2s ease-in-out;
  width: 36px;
}
.toggle:has(:checked) { background: var(--ember); }
.toggle .thumb {
  aspect-ratio: 1;
  background: #fff;
  border-radius: 999px;
  box-shadow: 0 1px 2px rgba(28, 25, 23, 0.2);
  transition: transform 0.2s ease-in-out;
  width: 50%;
}
.toggle:has(:checked) .thumb { transform: translateX(100%); }
.toggle input { appearance: none; cursor: pointer; inset: 0; position: absolute; }
.toggle:has(:focus-visible) { outline: 2px solid var(--ember-deep); outline-offset: 2px; }
.badge {
  align-items: center;
  border-radius: 999px;
  display: inline-flex;
  /* Flex child of .section-head: without these it shrinks below content
     width and "Not connected" wraps mid-phrase. */
  flex-shrink: 0;
  font-size: 0.75rem;
  font-weight: 500;
  gap: 5px;
  padding: 2px 9px 2px 6px;
  white-space: nowrap;
}
.badge .dot { background: currentColor; border-radius: 999px; height: 5px; width: 5px; }
.badge-on { background: var(--ok-tint); color: var(--ok); }
.badge-off { background: rgba(28, 25, 23, 0.06); color: var(--text-3); }
.chip {
  background: rgba(28, 25, 23, 0.06);
  border-radius: 5px;
  color: var(--text-2);
  display: inline-flex;
  font-family: var(--mono);
  font-size: 0.71875rem;
  max-width: 100%;
  overflow-wrap: anywhere;
  padding: 2px 7px;
}
.frame { display: flex; flex-direction: column; min-height: 100dvh; }
.topbar {
  align-items: center;
  border-bottom: 1px solid var(--line);
  display: flex;
  gap: 12px;
  height: 54px;
  padding: 0 20px;
  position: relative;
}
.brand { align-items: center; display: flex; flex: 1; gap: 10px; min-width: 0; }
.brand-home { align-items: center; background: none; border: 0; border-radius: 7px; cursor: pointer; display: flex; gap: 10px; min-width: 0; padding: 0; }
.brand-home:focus-visible { outline: 2px solid var(--ember-deep); outline-offset: 2px; }
.avatar {
  align-items: center;
  background: var(--ember-tint);
  border-radius: 7px;
  color: var(--ember-deep);
  display: flex;
  flex-shrink: 0;
  font-size: 0.8125rem;
  font-weight: 600;
  height: 26px;
  justify-content: center;
  width: 26px;
}
.brand-name { color: var(--text); font-size: 0.875rem; font-weight: 600; }
.topbar .actions { align-items: center; display: flex; gap: 8px; }
.body { display: flex; flex: 1; min-height: 0; }
.rail {
  border-right: 1px solid var(--line);
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
  font-weight: 500;
  padding: 6px 10px;
}
.chan-item {
  background: transparent;
  border: 0;
  border-radius: var(--radius);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-left: 12px;
  padding: 8px 10px;
  text-align: left;
  text-decoration: none;
}
.chan-item:hover { background: var(--raise); }
.chan-item.active { background: rgba(28, 25, 23, 0.07); }
.chan-name { color: var(--text); font-family: var(--mono); font-size: 0.8125rem; font-weight: 500; overflow-wrap: anywhere; }
.chan-meta { color: var(--text-3); font-size: 0.71875rem; overflow-wrap: anywhere; }
.rail-add {
  background: none;
  border: 0;
  border-radius: var(--radius);
  align-items: center;
  color: var(--text-3);
  cursor: pointer;
  display: flex;
  font-size: 0.8125rem;
  gap: 7px;
  margin-left: 12px;
  padding: 7px 10px 7px 8px;
  text-align: left;
}
.ws-row .ic { color: var(--text-3); }
.rail-add:hover:not(:disabled) { background: var(--raise); color: var(--text-2); }
.rail-add:disabled { cursor: not-allowed; opacity: 0.5; }
.chan-opt-note { color: var(--text-3); font-size: 0.71875rem; }
.link-btn { background: none; border: 0; color: var(--ember-deep); cursor: pointer; font-size: 0.8125rem; padding: 0; text-decoration: underline; }
.link-btn:hover { color: var(--ember); }
.rail-form {
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 8px 0 0 12px;
  padding-top: 10px;
}
.main { flex: 1; min-width: 0; overflow-y: auto; padding: 26px 32px 48px; }
.main-inner { display: flex; flex-direction: column; gap: 28px; margin: 0 auto; max-width: 760px; }
.main-head { align-items: flex-start; display: flex; gap: 12px; justify-content: space-between; }
.section { border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 14px; padding-top: 20px; }
.section:first-child { border-top: 0; padding-top: 0; }
.section-head { align-items: baseline; display: flex; gap: 10px; justify-content: space-between; }
.section-title { color: var(--text); font-size: 0.875rem; font-weight: 600; text-wrap: balance; }
.field { display: flex; flex-direction: column; gap: 6px; }
.form-grid { display: grid; gap: 16px 18px; grid-template-columns: 1fr 1fr; }
.form-grid .full { grid-column: 1 / -1; }
.bundle-row {
  align-items: center;
  border-radius: var(--radius);
  box-shadow: inset 0 0 0 1px var(--line-strong);
  display: flex;
  gap: 10px;
  min-height: 44px;
  padding: 9px 12px;
}
.bundle-row .b-name { align-items: center; color: var(--text); display: inline-flex; font-size: 0.8125rem; font-weight: 500; gap: 6px; overflow-wrap: anywhere; }
.bundle-row .b-meta { color: var(--text-3); font-family: var(--mono); font-size: 0.71875rem; overflow-wrap: anywhere; }
.bundle-row .spacer { flex: 1; }
.x-btn {
  background: none;
  border: 0;
  border-radius: 5px;
  color: var(--text-3);
  cursor: pointer;
  font-size: 0.875rem;
  line-height: 1;
  padding: 4px 7px;
}
.x-btn:hover { background: rgba(28, 25, 23, 0.06); color: var(--text); }
.well {
  background: var(--well);
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px var(--line);
  padding: 4px 18px;
}
.well dl { display: flex; flex-direction: column; }
.well .kv, .adv-rows .kv {
  border-top: 1px solid var(--line);
  display: grid;
  gap: 16px;
  grid-template-columns: 148px 1fr;
  padding: 11px 0;
}
.well .kv:first-child, .adv-rows .kv:first-child { border-top: 0; }
.well dt, .adv-rows dt { color: var(--text); font-size: 0.8125rem; font-weight: 500; }
.well dd, .adv-rows dd { color: var(--text-2); font-size: 0.8125rem; min-width: 0; }
.well dd.mono, .adv-rows dd.mono { font-size: 0.78125rem; overflow-wrap: anywhere; }
.instructions-preview {
  background: #fff;
  border-left: 2px solid var(--line-strong);
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
  font-family: var(--mono);
  font-size: 0.65625rem;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}
.layer-tag.ember { color: var(--ember-deep); }
.from-addendum { border-left: 2px solid var(--ember); margin-left: -16px; padding-left: 14px; }
details.advanced { border-top: 1px solid var(--line); padding-top: 4px; }
details.advanced summary {
  align-items: center;
  color: var(--text-2);
  cursor: pointer;
  display: flex;
  font-size: 0.875rem;
  font-weight: 600;
  gap: 7px;
  list-style: none;
  padding: 14px 0;
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
  border-top: 1px solid var(--line);
  bottom: 0;
  box-shadow: 0 -6px 20px rgba(28, 25, 23, 0.08);
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
  background: rgba(28, 25, 23, 0.4);
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
  border-radius: 12px;
  box-shadow: 0 24px 60px rgba(28, 25, 23, 0.28);
  max-width: 440px;
  padding: 20px 22px;
  width: 100%;
}
.modal-title { color: var(--text); font-size: 1rem; font-weight: 600; }
.modal-body { color: var(--text-2); font-size: 0.875rem; margin-top: 6px; }
.modal-foot { align-items: center; display: flex; gap: 8px; margin-top: 18px; }
.modal-foot .spacer { flex: 1; }
@media (max-width: 720px) {
  .modal-foot { flex-direction: column-reverse; align-items: stretch; }
  .modal-foot .spacer { display: none; }
}
.error, .field-error { color: var(--danger); font-size: 0.8125rem; }
.empty {
  align-items: flex-start;
  background: var(--well);
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px var(--line);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px;
}
/* ---- profiles master-detail (topbar nav active + role badge) ---- */
.nav-active { background: var(--ember-tint); color: var(--ember-deep); }
.badge-role { background: var(--ember-tint); color: var(--ember-deep); }

/* ---- profiles overview cards ---- */
.pcard {
  background: var(--well);
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px var(--line);
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 16px 18px;
}
.pcard + .pcard { margin-top: 12px; }
.pcard .pcard-head { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; }
.pcard .pcard-name { color: var(--text); font-size: 0.9375rem; font-weight: 600; }
.pcard .pcard-desc { color: var(--text-2); font-size: 0.8125rem; max-width: 62ch; }
.pcard .pcard-foot { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; }
.pcard .pcard-foot .spacer { flex: 1; }

/* ---- allowed-tools editor (checkbox + mono name + description) ---- */
.tool-row {
  align-items: flex-start;
  background: none;
  border: 0;
  border-radius: var(--radius);
  box-shadow: inset 0 0 0 1px var(--line);
  color: inherit;
  cursor: pointer;
  display: flex;
  gap: 11px;
  padding: 11px 13px;
  position: relative;
  text-align: left;
  width: 100%;
}
.tool-row + .tool-row { margin-top: 8px; }
.tool-row:focus-within { outline: 2px solid var(--ember-deep); outline-offset: 2px; }
.tool-check {
  background: #fff;
  border-radius: 5px;
  box-shadow: inset 0 0 0 1px var(--line-strong);
  flex-shrink: 0;
  height: 16px;
  margin-top: 1px;
  position: relative;
  width: 16px;
}
.tool-check.on { background: var(--ember); box-shadow: none; }
.tool-check.on::after {
  background-color: #22130a;
  content: "";
  height: 12px;
  inset: 2px;
  -webkit-mask: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2016%2016%27%3E%3Cpath%20d%3D%27M12.416%203.376a.75.75%200%200%201%20.208%201.04l-5%207.5a.75.75%200%200%201-1.154.114l-3-3a.75.75%200%201%201%201.06-1.06l2.353%202.353%204.493-6.74a.75.75%200%200%201%201.04-.207Z%27%2F%3E%3C%2Fsvg%3E") center / 12px 12px no-repeat;
  mask: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2016%2016%27%3E%3Cpath%20d%3D%27M12.416%203.376a.75.75%200%200%201%20.208%201.04l-5%207.5a.75.75%200%200%201-1.154.114l-3-3a.75.75%200%201%201%201.06-1.06l2.353%202.353%204.493-6.74a.75.75%200%200%201%201.04-.207Z%27%2F%3E%3C%2Fsvg%3E") center / 12px 12px no-repeat;
  position: absolute;
  width: 12px;
}
.tool-check input { appearance: none; cursor: pointer; inset: 0; margin: 0; opacity: 0; position: absolute; }
.tool-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tool-body .t-name { color: var(--text); font-family: var(--mono); font-size: 0.78125rem; font-weight: 500; }
.tool-body .t-desc { color: var(--text-3); font-size: 0.78125rem; }

/* ---- profile custom skills ---- */
.skill-list { display: flex; flex-direction: column; gap: 8px; }
.skill-row {
  align-items: center;
  border-radius: var(--radius);
  box-shadow: inset 0 0 0 1px var(--line-strong);
  display: flex;
  gap: 12px;
  padding: 11px 13px;
}
.skill-row .sk-body { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.skill-row .sk-name { align-items: center; color: var(--text); display: flex; flex-wrap: wrap; font-family: var(--mono); font-size: 0.8125rem; font-weight: 600; gap: 8px; overflow-wrap: anywhere; }
.skill-row .sk-desc { color: var(--text-3); font-size: 0.78125rem; overflow-wrap: anywhere; }
.badge-src {
  background: rgba(28, 25, 23, 0.06);
  border-radius: 999px;
  color: var(--text-3);
  font-family: var(--mono);
  font-size: 0.65625rem;
  font-weight: 500;
  letter-spacing: 0.05em;
  padding: 2px 8px;
  text-transform: uppercase;
  white-space: nowrap;
}
.skill-form {
  background: var(--well);
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px var(--line);
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 18px;
}
.skill-form-actions { align-items: center; display: flex; gap: 8px; justify-content: flex-end; }
.skill-actions { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 720px) {
  .skill-row { align-items: stretch; flex-direction: column; }
}

/* ---- import skills from a URL (panel + picker) ---- */
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
  border-radius: var(--radius);
  box-shadow: inset 0 0 0 1px var(--line-strong);
  cursor: pointer;
  display: flex;
  gap: 11px;
  padding: 11px 13px;
  position: relative;
}
.import-row:focus-within { outline: 2px solid var(--ember-deep); outline-offset: 2px; }
.import-row.on { box-shadow: inset 0 0 0 1px var(--ember-deep); }
.import-check {
  background: #fff;
  border-radius: 5px;
  box-shadow: inset 0 0 0 1px var(--line-strong);
  flex-shrink: 0;
  height: 16px;
  margin-top: 1px;
  position: relative;
  width: 16px;
}
.import-check.on { background: var(--ember); box-shadow: none; }
.import-check.on::after {
  background-color: #22130a;
  content: "";
  height: 12px;
  inset: 2px;
  -webkit-mask: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2016%2016%27%3E%3Cpath%20d%3D%27M12.416%203.376a.75.75%200%200%201%20.208%201.04l-5%207.5a.75.75%200%200%201-1.154.114l-3-3a.75.75%200%201%201%201.06-1.06l2.353%202.353%204.493-6.74a.75.75%200%200%201%201.04-.207Z%27%2F%3E%3C%2Fsvg%3E") center / 12px 12px no-repeat;
  mask: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2016%2016%27%3E%3Cpath%20d%3D%27M12.416%203.376a.75.75%200%200%201%20.208%201.04l-5%207.5a.75.75%200%200%201-1.154.114l-3-3a.75.75%200%201%201%201.06-1.06l2.353%202.353%204.493-6.74a.75.75%200%200%201%201.04-.207Z%27%2F%3E%3C%2Fsvg%3E") center / 12px 12px no-repeat;
  position: absolute;
  width: 12px;
}
.import-check input { appearance: none; cursor: pointer; inset: 0; margin: 0; opacity: 0; position: absolute; }
.import-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.import-name { align-items: center; color: var(--text); display: flex; flex-wrap: wrap; font-family: var(--mono); font-size: 0.8125rem; font-weight: 600; gap: 8px; overflow-wrap: anywhere; }
.import-desc { color: var(--text-3); font-size: 0.78125rem; overflow-wrap: anywhere; }
.badge-src.import-scripts { text-transform: none; letter-spacing: 0; }

/* ---- profile danger zone ---- */
.danger-zone {
  align-items: flex-start;
  background: var(--danger-tint);
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px rgba(192, 53, 56, 0.18);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
}

/* ---- settings: model-provider rows + favorites ---- */
.prov-row { border-radius: 10px; box-shadow: inset 0 0 0 1px var(--line-strong); display: flex; flex-direction: column; }
.prov-row + .prov-row { margin-top: 12px; }
.prov-head { align-items: center; display: flex; flex-wrap: wrap; gap: 10px 12px; padding: 14px 16px; }
.prov-id { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.prov-name { color: var(--text); font-size: 0.9375rem; font-weight: 600; }
.prov-sub { color: var(--text-3); font-size: 0.75rem; }
.prov-sub .mono-frag { font-family: var(--mono); font-size: 0.71875rem; }
.prov-status { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; }
.prov-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; }
.prov-body { border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 13px; padding: 14px 16px; }
.paste-row { display: flex; flex-wrap: wrap; gap: 8px; }
.paste-row .input { flex: 1; min-width: 220px; }
.fav-sub { color: var(--text-3); font-family: var(--mono); font-size: 0.65625rem; letter-spacing: 0.07em; text-transform: uppercase; }
.fav-list { display: flex; flex-direction: column; }
.fav-row { align-items: center; border-top: 1px solid var(--line); display: flex; gap: 10px; padding: 9px 2px; }
.fav-row:first-child { border-top: 0; }
.fav-model { color: var(--text); font-family: var(--mono); font-size: 0.78125rem; min-width: 0; overflow-wrap: anywhere; }
.fav-meta { color: var(--text-3); flex-shrink: 0; font-size: 0.71875rem; margin-left: auto; text-align: right; white-space: nowrap; }
.fav-meta .price { color: var(--text-2); }
.star { background: none; border: 0; color: var(--text-3); cursor: pointer; flex-shrink: 0; font-size: 1rem; line-height: 1; padding: 2px; }
.star.on { color: var(--ember-deep); }
.star:focus-visible { outline: 2px solid var(--ember-deep); outline-offset: 2px; }
.fav-empty { color: var(--text-3); font-size: 0.8125rem; padding: 6px 2px; }
.raw-error {
  background: var(--danger-tint);
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px rgba(192, 53, 56, 0.18);
  color: #a92c30;
  font-family: var(--mono);
  font-size: 0.71875rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
  padding: 10px 12px;
  white-space: pre-wrap;
}

/* ---- model picker Settings action footer (pinned below combo-foot) ---- */
.combo-settings { border-top: 1px solid var(--line); font-size: 0.8125rem; margin-top: 4px; padding: 9px; }
.layer-legend { display: flex; flex-direction: column; gap: 6px; }
.layer-legend .step { align-items: baseline; display: flex; gap: 9px; font-size: 0.8125rem; }
.layer-legend .step .n { color: var(--text-3); font-family: var(--mono); font-size: 0.6875rem; }
.combo-list {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(28, 25, 23, 0.14), inset 0 0 0 1px var(--line);
  display: flex;
  flex-direction: column;
  margin-top: 6px;
  overflow: hidden;
  padding: 5px;
}
.combo-group {
  align-items: baseline;
  color: var(--text-3);
  display: flex;
  gap: 8px;
  font-family: var(--mono);
  font-size: 0.65625rem;
  letter-spacing: 0.07em;
  padding: 8px 9px 4px;
  text-transform: uppercase;
}
.combo-group .src { letter-spacing: 0; text-transform: none; }
.combo-opt {
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--text);
  cursor: pointer;
  font-family: var(--mono);
  font-size: 0.8125rem;
  padding: 6px 9px;
  text-align: left;
  width: 100%;
}
.combo-opt.plain { font-family: var(--font); }
.combo-opt:hover { background: var(--raise); }
.combo-opt.active { background: var(--ember-tint); color: var(--ember-deep); }
.combo-foot { border-top: 1px solid var(--line); color: var(--text-3); font-size: 0.75rem; margin-top: 4px; padding: 8px 9px 4px; }
/* ---- profile Model click-to-open combobox (F6) ---- */
.model-combo { position: relative; }
.model-combo .model-combo-input { padding-right: 32px; }
.model-combo .model-combo-caret {
  color: var(--text-3);
  pointer-events: none;
  position: absolute;
  right: 10px;
  top: 9px;
}
/* The open popover is an elevated overlay under the input so it never reflows
   the form. max-height keeps a long provider list scrollable in place. */
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
.combo-empty { color: var(--text-3); font-size: 0.8125rem; padding: 8px 9px; }
@media (max-width: 720px) {
  .body { flex-direction: column; }
  .rail { border-bottom: 1px solid var(--line); border-right: 0; width: 100%; }
  .main { padding: 20px; }
  .form-grid { grid-template-columns: 1fr; }
  .prov-actions { margin-left: 0; width: 100%; }
  .well .kv, .adv-rows .kv { grid-template-columns: 1fr; gap: 3px; }
  .btn { font-size: 0.875rem; padding: 9px 14px; }
  .btn-sm { font-size: 0.8125rem; padding: 6px 11px; }
  .main-head, .section-head, .bundle-row, .save-bar { align-items: stretch; flex-direction: column; }
  .save-note { margin-right: 0; }
  .save-bar-sticky { padding: 13px 20px calc(13px + env(safe-area-inset-bottom, 0px)); }
  .save-bar-inner { align-items: stretch; flex-direction: column; }
  .save-bar-inner .save-note { margin-right: 0; }
  body { font-size: 1rem; }
  .hint, .field-label { font-size: 0.9375rem; }
  .mono { font-size: 0.9375rem; }
  .input, .textarea { font-size: 1rem; }
  .input.mono, .textarea.mono { font-size: 1rem; }
  .badge { font-size: 0.8125rem; padding: 3px 10px 3px 7px; }
  .chip { font-size: 0.8125rem; }
  .toggle { width: 44px; }
  .ic { height: 18px; width: 18px; }
  .step-num { font-size: 0.9375rem; height: 30px; width: 30px; }
  .success-toast { align-items: flex-start; }
  /* Specificity is bumped with a .topbar prefix so these beat the later
     source-order desktop rules (.topbar-menu{display:none} / summary{display:none});
     media queries add no specificity, so equal-specificity later rules would win. */
  .topbar .topbar-menu { display: inline-flex; }
  .topbar .topbar-menu > summary { display: inline-flex; }
  .topbar .actions-list { display: none; }
  .topbar-menu[open] ~ .actions-list {
    align-items: stretch;
    background: var(--bg);
    border-radius: 10px;
    box-shadow: 0 12px 30px rgba(28, 25, 23, 0.16), inset 0 0 0 1px var(--line);
    display: flex;
    flex-direction: column;
    padding: 6px;
    position: absolute;
    right: 20px;
    top: 50px;
    z-index: 30;
  }
}

/* ---- action buttons never wrap their label when squeezed beside an inline error ---- */
.save-bar .btn { flex-shrink: 0; white-space: nowrap; }

/* ---- topbar hamburger disclosure (mobile navigation only; hidden on desktop) ---- */
.topbar-menu { display: none; }
.topbar-menu > summary {
  align-items: center;
  border-radius: var(--radius);
  color: var(--text-2);
  cursor: pointer;
  display: none;
  list-style: none;
  min-height: 34px;
  padding: 6px 8px;
}
.topbar-menu > summary::-webkit-details-marker { display: none; }
.topbar-menu > summary:hover { background: rgba(28, 25, 23, 0.05); color: var(--text); }
.topbar-menu > summary:focus-visible { outline: 2px solid var(--ember-deep); outline-offset: 2px; }
.actions-list { align-items: center; display: flex; gap: 8px; }

/* ---- wizard steps: scaled-up .layer-legend/.step language ---- */
.stepper { display: flex; flex-direction: column; gap: 22px; }
.step-block { display: flex; gap: 14px; }
.step-block.dimmed { opacity: 0.42; }
.step-num {
  align-items: center;
  border-radius: 999px;
  display: inline-flex;
  flex-shrink: 0;
  font-family: var(--mono);
  font-size: 0.8125rem;
  font-weight: 600;
  height: 26px;
  justify-content: center;
  width: 26px;
}
.step-num.active { background: var(--ember); color: #22130a; }
.step-num.idle { background: rgba(28, 25, 23, 0.08); color: var(--text-3); }
.step-num.done { background: var(--ok-tint); color: var(--ok); }
.step-block.dimmed .step-num { cursor: pointer; }
.advance-step {
  background: none;
  border: 0;
  cursor: pointer;
  display: flex;
  flex: 1;
  gap: 14px;
  padding: 0;
  text-align: left;
}
.advance-step:focus-visible { outline: 2px solid var(--ember-deep); outline-offset: 2px; }
.step-body { display: flex; flex: 1; flex-direction: column; gap: 12px; min-width: 0; }
.step-title { color: var(--text); font-size: 0.875rem; font-weight: 600; }
.step-done-line { align-items: center; display: flex; gap: 10px; min-height: 26px; }
.warn-accent { border-left: 2px solid var(--ember); padding-left: 12px; }
.callout {
  align-items: flex-start;
  background: var(--ember-tint);
  border-radius: 8px;
  color: var(--text-2);
  display: flex;
  font-size: 0.8125rem;
  gap: 9px;
  line-height: 1.5;
  padding: 11px 13px;
}
.callout .g { color: var(--ember-deep); flex-shrink: 0; }
.tiny-label { color: var(--text-3); font-size: 0.6875rem; }

/* ---- paired instruction+field block (Step 2: instruction + the field it fills, coupled in one inset) ---- */
.paste-pair {
  background: var(--well);
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px var(--line);
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
  line-height: 1.5;
}
.paste-pair .pair-head .n {
  align-items: center;
  background: var(--ember-tint);
  border-radius: 999px;
  color: var(--ember-deep);
  display: inline-flex;
  flex-shrink: 0;
  font-family: var(--mono);
  font-size: 0.6875rem;
  font-weight: 600;
  height: 19px;
  justify-content: center;
  position: relative;
  top: 2px;
  width: 19px;
}
.paste-pair .input { background: #fff; }
.spinner {
  animation: ds-spin 0.7s linear infinite;
  border: 2px solid var(--ember-tint);
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
  border-radius: 8px;
  display: flex;
  font-size: 0.8125rem;
  gap: 9px;
  padding: 8px 12px;
}

/* ---- 48px touch targets on icon-only buttons (coarse pointers) ---- */
@media (pointer: coarse) {
  .x-btn { position: relative; }
  .x-btn::after { content: ""; inset: 50%; min-height: 44px; min-width: 44px; position: absolute; transform: translate(-50%, -50%); }
}
</style>
</head>
<body>
<div id="app" class="frame">
  <header class="topbar">
    <div class="brand">
      <span class="avatar">T</span>
      <span class="brand-name">Tag Team</span>
      <span class="chip">${targetChip}</span>
    </div>
    <div class="actions">
      <a class="btn btn-ghost" href="https://api.slack.com/apps" rel="noreferrer">Open Slack console &nearr;</a>
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
  // Fallback only for the very first paint before /admin/api/models resolves;
  // defaultModels() prefers the server-supplied suggestions (single source of
  // truth in src/config/seed.ts) so a bumped seed suggestion never goes stale.
  var DEFAULT_MODELS_FALLBACK = { claude: "anthropic/claude-sonnet-4-6", "workers-ai": "@cf/zai-org/glm-5.2" };
  // Server-resolved runtime target: the Workers AI row is binding-only, so it is
  // shown on Cloudflare and hidden on Node (the inline script has no target check
  // of its own — this is interpolated as a literal boolean at render time).
  var IS_CLOUDFLARE = ${isCloudflare};
  var state = {
    agents: [],
    assignments: [],
    models: { providers: [], defaultModels: DEFAULT_MODELS_FALLBACK },
    active: null,
    effective: null,
    effectiveError: "",
    addChannelOpen: false,
    channelFormDraft: { workspaceId: "", channelId: "", channelLabel: "" },
    addChannelError: "",
    addChannelInvite: "",
    addChannelManual: false,
    addChannelSelected: "",
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
    // Inline custom-skill editor on the profile edit page. null when closed; when
    // open it is { index: <number|null for a new skill>, name, description,
    // instructions, error }. Only one editor is open at a time.
    skillEditor: null,
    // Inline "Import from URL" panel on the profile edit page. null when closed.
    // When open it is { source, loading, error, resolution, selected } where
    // resolution is the /admin/api/skills/resolve payload (null until "Find
    // skills" returns) and selected is a boolean[] parallel to resolution.skills.
    skillImport: null,
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
      "lock-closed": "M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z",
      "arrow-path": "M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08.932.75.75 0 0 1-1.3-.75 6 6 0 0 1 9.44-1.242l.842.84V3.227a.75.75 0 0 1 .75-.75Zm-.911 7.5A.75.75 0 0 1 13.2 11a6 6 0 0 1-9.44 1.241l-.84-.84v1.372a.75.75 0 0 1-1.5 0V9.591a.75.75 0 0 1 .75-.75H5.35a.75.75 0 0 1 0 1.5H3.98l.841.84a4.5 4.5 0 0 0 7.08-.932.75.75 0 0 1 1.025-.272Z",
      "exclamation-triangle": "M6.701 2.25c.577-1 2.02-1 2.598 0l5.196 9a1.5 1.5 0 0 1-1.299 2.25H2.804a1.5 1.5 0 0 1-1.299-2.25l5.196-9ZM8 5a.75.75 0 0 1 .75.75v2.5a.75.75 0 0 1-1.5 0v-2.5A.75.75 0 0 1 8 5Zm0 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
      "bars-3": "M2 4.75A.75.75 0 0 1 2.75 4h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75Zm0 3.5A.75.75 0 0 1 2.75 7.5h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 8.25Zm0 3.5a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75Z"
    };
    return '<svg class="ic' + (extra ? " " + extra : "") + '" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="' + paths[name] + '"/></svg>';
  }

  function defaultModels() {
    return (state.models && state.models.defaultModels) || DEFAULT_MODELS_FALLBACK;
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

  function isWildcardAssignment(assignment) {
    return assignment.workspaceId === "*" || assignment.channelId === "*";
  }

  function defaultAgent() {
    return state.agents[0] || null;
  }

  function render() {
    var app = document.getElementById("app");
    app.innerHTML = topbarHtml() + '<div class="body">' + railHtml() + mainHtml() + "</div>" + leavePromptModalHtml();
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
      '<div class="brand"><button type="button" class="brand-home" data-action="go-home" aria-label="Home"><span class="avatar">T</span><span class="brand-name">Tag Team</span></button><span class="chip">${targetChip}</span></div>' +
      '<details class="topbar-menu"><summary aria-label="Menu">' + icon("bars-3") + '</summary></details>' +
      '<div class="actions actions-list">' + connectedBadge +
      '<a class="btn btn-ghost" href="https://api.slack.com/apps" rel="noreferrer">Open Slack console &nearr;</a>' +
      '<button type="button" class="btn btn-soft' + (state.view === "profiles" ? " nav-active" : "") + '" data-action="open-profiles">Profiles</button>' +
      '<button type="button" class="btn btn-soft' + (state.view === "settings" ? " nav-active" : "") + '" data-action="open-settings">Settings</button></div>' +
      "</header>";
  }

  // The connected workspace's display name for a rail group header: the friendly
  // team name for the workspace Tag is installed in, else the raw workspace id
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
        '<p class="hint">Pick a Slack channel and attach a profile. Tag answers @mentions there.</p>' +
        addChannelButtonHtml("btn btn-soft") +
        '</div>';
      return '<main class="main"><div class="main-inner">' + invite + addPanel + emptyBlock + '</div></main>';
    }
    var agent = agentById(assignment.agentId);
    var enabled = state.channelDraft.enabled;
    return '<main class="main"><div class="main-inner">' + invite + addPanel +
      '<div class="main-head"><div style="display:flex; flex-direction:column; gap:2px;">' +
      '<h1 class="page-title mono-title">' + esc(channelLabel(assignment)) + '</h1>' +
      '<p class="hint">What Tag can do in this channel. It answers mentions here, always as @Tag.</p>' +
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
      '<h1 class="page-title" style="font-size:1.1875rem;">Choose where Tag answers</h1>' +
      '<p class="hint" style="max-width:452px; font-size:0.875rem; line-height:1.55;">Tag only answers where you allow it. Pick a Slack channel to start &mdash; it comes with sensible defaults, and you can customize instructions, model, and tools per channel anytime.</p>' +
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
    // conveyed by the group, and the trailing note flags a channel Tag has not
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
      '<p class="hint">Attach to a Slack channel. Tag answers @mentions there with the ' + esc(defaultAgentName()) + ' profile &mdash; customize it on the channel page after.</p></div>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="cancel-add-channel">Cancel</button></div>';
    if (!isSlackConnected()) {
      return '<section class="section">' + head +
        '<div class="empty"><p class="field-label">Connect Slack first</p>' +
        '<p class="hint">Add the bot token and signing secret above, then come back to pick a channel.</p></div></section>';
    }
    // Workspace — locked to the install (card 05). Never an editable field once
    // teamId is known; the lock icon + "locked" chip make the constraint plain.
    var workspaceRow = '<div class="field"><label class="field-label">Workspace</label>' +
      '<div class="bundle-row"><span class="b-name">' + icon("lock-closed") + esc(connectedTeamName()) + '</span>' +
      '<span class="b-meta">' + esc(connectedTeamId()) + '</span><span class="spacer"></span>' +
      '<span class="chip">locked</span></div>' +
      '<p class="hint">Locked to the workspace Tag is installed in. To use another, reinstall Tag there.</p></div>';
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
    return '<b style="font-weight:500; color:var(--text);">' + text + '</b>';
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
      // creation and the manifest cannot pre-select it (the Acme-vs-Paperplane
      // trap from the first live walkthrough).
      '<p class="hint warn-accent">Slack will ask you to ' + slackStepBoldHint("pick a workspace") + ' &mdash; choose the one you want Tag in. It can&rsquo;t be changed later without reinstalling.</p>' +
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
      slackStepBoldHint("Bot User OAuth Token") + ' &mdash; in the left sidebar, click the <span class="chip">OAuth &amp; Permissions</span> tab &rarr; ' + slackStepBoldHint("Install to Workspace") + ' &rarr; Allow. The token (<span class="chip">xoxb-&hellip;</span>) appears only after you click Install. Copy it.</span></div>' +
      '<input class="input mono" name="botToken" type="password" autocomplete="off" aria-label="Bot token" placeholder="Paste the xoxb-&hellip; token here" value="' + esc(state.slackDraft.botToken) + '" data-action="slack-bot-token"></div>' +
      '<div class="callout">' + icon("exclamation-triangle", "ic-l g") + '<span>Not the App-Level Token (<span class="chip">xapp-&hellip;</span>, that&rsquo;s Socket Mode) and not the deprecated Verification Token. Only <span class="chip">xoxb-&hellip;</span> and the Signing Secret.</span></div>' +
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
    if (message === "internal_error") return "Tag Team could not store the credentials (an internal error). Check the worker logs and try again.";
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
    var meta = agent ? modelLabel(agent) + " · " + toolsLabel(agent.allowedTools) + " · used in " + channelCountLabel(allAssignmentsForAgent(agent.id).length) : "Unknown profile";
    var row = agent
      ? '<div class="bundle-row"><span class="b-name">' + esc(agent.name) + '</span><span class="b-meta">' + esc(meta) + '</span><span class="spacer"></span>' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="open-profiles" data-agent="' + esc(agent.id) + '">Edit</button>' +
        '<button type="button" class="btn btn-soft btn-sm" data-action="toggle-swap">Change</button>' +
        '<button type="button" class="x-btn" data-action="detach-profile" aria-label="Detach profile">' + icon("x-mark") + '</button></div>' +
        (agent.description ? '<p class="hint">' + esc(agent.description) + '</p>' : "")
      : '<div class="empty"><p class="field-label">No profile attached</p><p class="hint">Attach a profile before the channel can answer.</p></div>';
    if (state.swapOpen) {
      row += '<div class="bundle-row"><span class="select-wrap"><select class="input" data-role="swap-profile">' + state.agents.map(function (profile) {
        return '<option value="' + esc(profile.id) + '"' + (profile.id === assignment.agentId ? " selected" : "") + '>' + esc(profile.name) + '</option>';
      }).join("") + '</select>' + icon("chevron-down", "select-caret") + '</span><button type="button" class="btn btn-primary btn-sm" data-action="attach-selected-profile">Attach</button></div>';
    }
    return '<section class="section"><div class="section-head"><div><h2 class="section-title">Profile</h2><p class="hint">The reusable behavior attached to this channel &mdash; instructions, model, and tools.</p></div><button type="button" class="btn btn-ghost btn-sm" data-action="open-profiles">Manage profiles</button></div>' + row + '</section>';
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
        '<div class="kv"><dt>Allowed tools</dt><dd>' + toolsChips(state.effective.allowedTools) + '</dd></div>' +
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

  // The single registered model-facing tool today. Flue has no default tool
  // catalog (tools are app-defined via defineTool or MCP), so the editor renders
  // exactly the tools this install registers — one row plus the "more appear
  // here" hint. Never mock nonexistent tools.
  var AVAILABLE_TOOLS = [
    {
      name: "lookup_channel_brief",
      description: "Read the configured brief for the channel it\\u2019s answering in (name, profile, channel instructions).",
    },
  ];

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

  function toolsCountLabel(tools) {
    var count = (tools && tools.length) || 0;
    if (count === 0) return "no tools";
    return count + " tool" + (count === 1 ? "" : "s");
  }

  // ---- Overview (card 09) --------------------------------------------------

  function profileOverviewHtml() {
    var cards = state.agents.map(profileCardHtml).join("");
    return '<div class="main-head"><div style="display:flex; flex-direction:column; gap:6px;">' +
      '<h1 class="page-title">Profiles</h1>' +
      '<p class="hint" style="max-width:58ch;">A profile is the reusable behavior you attach to a channel &mdash; its instructions, model, and tools. One profile can answer in many channels, and it always replies as <b style="font-weight:500; color:var(--text);">@Tag</b> &mdash; a profile changes how Tag answers, never who it is.</p>' +
      '</div><button type="button" class="btn btn-primary" style="flex-shrink:0;" data-action="new-profile">New profile</button></div>' +
      '<section class="section"><div class="section-head"><div><h2 class="section-title">Your profiles</h2><p class="hint">Everything Tag can be in this workspace.</p></div></div>' +
      (cards || '<div class="empty"><p class="field-label">No profiles yet</p><p class="hint">Create one to give Tag a behavior you can attach to channels.</p></div>') +
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
    var meta = modelPart + " &middot; " + toolsCountLabel(agent.allowedTools) + " &middot; " + usage;
    return '<div class="pcard"><div class="pcard-head"><span class="pcard-name">' + esc(agent.name) + '</span>' + roleBadge + stateBadge + '</div>' +
      (agent.description ? '<p class="pcard-desc">' + esc(agent.description) + '</p>' : "") +
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
      '<p class="hint">Every profile runs one pinned model. Suggestions come from this install\\'s configured providers &mdash; manage them in <button type="button" class="link-btn" data-action="open-settings">Settings &nearr;</button>. Any provider/model specifier works.</p>' +
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

  function allowedToolsHtml(draft) {
    var tools = draft.allowedTools || [];
    var rows = AVAILABLE_TOOLS.map(function (tool) {
      var on = tools.indexOf(tool.name) >= 0;
      return '<label class="tool-row"><span class="tool-check' + (on ? " on" : "") + '">' +
        '<input type="checkbox" data-action="toggle-tool" data-tool="' + esc(tool.name) + '" ' + (on ? "checked" : "") + ' aria-label="Allow ' + esc(tool.name) + '"></span>' +
        '<span class="tool-body"><span class="t-name">' + esc(tool.name) + '</span><span class="t-desc">' + esc(tool.description) + '</span></span></label>';
    }).join("");
    return '<div>' + rows + '</div><p class="hint">Only the tools you check are available to this profile. More appear here as this install registers them.</p>';
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
      '<textarea class="textarea mono" id="skill-instr" placeholder="Markdown playbook the model loads only when it uses this skill." data-action="skill-field-instructions">' + esc(editor.instructions) + '</textarea>' +
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

  function skillsSectionHtml(draft) {
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
    var hint = 'Named playbooks this profile can pull in when a task calls for one. The model always sees each skill&rsquo;s name and description; the full instructions load only when a skill is used.';
    var body = list + newForm + importPanel + addButtons;
    if (!list && !newForm && !importPanel) {
      body = '<div class="empty"><p class="field-label">No custom skills yet</p><p class="hint">Add one to give this profile a named playbook it can load on demand.</p></div>' + addButtons;
    }
    return '<section class="section"><div class="section-head"><div><h2 class="section-title">Skills</h2><p class="hint">' + hint + '</p></div></div>' + body + '</section>';
  }

  function layerLegendHtml() {
    return '<div class="layer-legend"><p class="field-label">How instructions layer at runtime</p>' +
      '<div class="step"><span class="n">1</span><span><b style="font-weight:500; color:var(--text);">Profile instructions</b> &mdash; this section, shared across every channel.</span></div>' +
      '<div class="step"><span class="n">2</span><span><b style="font-weight:500; color:var(--text);">Channel instructions</b> &mdash; appended per channel, set on each channel page.</span></div>' +
      '<div class="step"><span class="n">3</span><span><b style="font-weight:500; color:var(--text);">Guardrail</b> &mdash; always appended by the runtime.</span></div>' +
      '<p class="hint">Each channel\\'s Access summary shows the exact resolved stack.</p></div>';
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
      '<div class="field full"><label class="field-label" for="p-desc">Description</label><input class="input" id="p-desc" name="description" type="text" value="' + esc(draft.description) + '" data-action="profile-desc"><p class="hint">One line, so future-you can tell profiles apart at a glance.</p></div>' +
      '<div class="field full"><label class="field-label" for="p-instr">Instructions</label>' + profileInstructionsFieldHtml(draft, true) + '<p class="hint">These travel with the profile to every channel it&rsquo;s attached to.</p></div>' +
      '<div class="field full"><label class="field-label">Allowed tools</label>' + allowedToolsHtml(draft) + '</div>' +
      '</div></section>' +
      '<div class="save-bar">' + profileGenericErrorHtml() +
      '<button type="button" class="btn btn-ghost" data-action="cancel-create">Cancel</button>' +
      '<button type="button" class="btn btn-primary" data-action="save-profile">Create profile</button></div>';
  }

  // ---- Edit (card 11) + edge states (card 12) ------------------------------

  function profileEditHtml() {
    var draft = state.profileDraft;
    return '<div class="main-head"><div style="display:flex; flex-direction:column; gap:6px;">' +
      '<button type="button" class="link-btn" style="align-self:flex-start;" data-action="profiles-back">&larr; Profiles</button>' +
      '<h1 class="page-title">' + esc(draft.name || "Profile") + '</h1>' +
      // Subtitle is the profile's own description (cards 11/12, spec §129) so the
      // edit head reads as "this profile" — falls back to the generic edit hint
      // for a profile that has no description yet.
      '<p class="hint">' + (draft.description ? esc(draft.description) : 'Edit this reusable behavior. It always replies as <b style="font-weight:500; color:var(--text);">@Tag</b>.') + '</p></div>' +
      '<label style="display:flex; align-items:center; gap:10px;"><span class="hint">' + (draft.enabled ? "Enabled" : "Disabled") + '</span>' +
      '<span class="toggle"><span class="thumb"></span><input type="checkbox" name="profile-enabled" data-action="profile-enable-toggle" ' + (draft.enabled ? "checked" : "") + ' aria-label="Profile enabled"></span></label></div>' +
      disableConfirmHtml(draft) +
      '<section class="section"><div class="section-head"><div><h2 class="section-title">Details</h2></div></div>' +
      '<div class="form-grid">' +
      profileNameFieldHtml(draft) +
      modelFieldHtml(draft) +
      '<div class="field full"><label class="field-label" for="p-desc">Description</label><input class="input" id="p-desc" name="description" type="text" value="' + esc(draft.description) + '" data-action="profile-desc"><p class="hint">One line, so future-you can tell profiles apart at a glance.</p></div>' +
      '</div></section>' +
      '<section class="section"><div class="section-head"><div><h2 class="section-title">Instructions</h2><p class="hint">These travel with the profile to every channel it&rsquo;s attached to.</p></div></div>' +
      '<div class="field">' + profileInstructionsFieldHtml(draft, false) + '</div>' + layerLegendHtml() + '</section>' +
      skillsSectionHtml(draft) +
      '<section class="section"><div class="section-head"><div><h2 class="section-title">Allowed tools</h2></div></div>' + allowedToolsHtml(draft) + '</section>' +
      usedInHtml(draft) +
      dangerZoneHtml(draft) +
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
      rows = '<div class="empty"><p class="field-label">Not attached to any channels yet</p><p class="hint">Attach this profile from a channel page&rsquo;s Profile section.</p></div>';
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

  function dangerZoneHtml(draft) {
    var dm = agentHasDmDefault(draft.id);
    var concrete = concreteAssignmentsForAgent(draft.id);
    var blocked = dm || concrete.length > 0;
    var name = esc(draft.name || "This profile");
    var hint;
    if (!blocked) {
      hint = name + " isn\\u2019t attached to any channels, so it can be deleted. This can\\u2019t be undone.";
    } else if (dm && concrete.length > 0) {
      hint = name + " is the DM default and is attached to " + channelCountLabel(concrete.length) + ", so it can\\u2019t be deleted. Detach it everywhere first.";
    } else if (dm) {
      hint = name + " is the DM default, so it can\\u2019t be deleted. It always answers direct messages.";
    } else {
      var tail = concrete.length === 1 ? "first" : concrete.length === 2 ? "from both" : "from all of them";
      hint = name + " is attached to " + channelCountLabel(concrete.length) + " &mdash; " + joinChannelNames(concrete, true) +
        " &mdash; so it can\\u2019t be deleted. Detach it " + tail + " (or delete those channels\\u2019 assignment) first.";
    }
    return '<div class="danger-zone"><p class="field-label">Delete this profile</p><p class="hint">' + hint + '</p>' +
      '<button type="button" class="btn btn-danger" data-action="delete-profile"' + (blocked ? " disabled" : "") + '>Delete profile</button></div>';
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
      '<p class="hint">Where Tag gets its model keys, and which models show up when you pin one to a profile.</p></div>';
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
      '<p class="hint">A key lets Tag run that provider\\'s models. Environment variables always win over keys stored here &mdash; same rule as the Slack connection. Validating a key makes one live call to the provider\\'s models endpoint, which also loads its model list.</p></div></div>' +
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

  function toolsChips(tools) {
    if (!tools || tools.length === 0) return '<span class="hint">No tools allowed</span>';
    return tools.map(function (tool) { return '<span class="chip">' + esc(tool) + '</span>'; }).join(" ");
  }

  function toolsLabel(tools) {
    return tools && tools.length ? tools.join(" · ") : "no tools";
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
    var base = defaultAgent();
    // A blank profile starts empty (name + instructions are required, so the
    // ghost-example placeholder shows until the operator writes them) and pre-
    // checks the one registered tool, matching the create card.
    return {
      id: "",
      name: "",
      description: "",
      instructions: "",
      enabled: true,
      model: "",
      defaultModels: base ? base.defaultModels : defaultModels(),
      allowedTools: (base && base.allowedTools && base.allowedTools.length) ? base.allowedTools.slice() : ["lookup_channel_brief"],
      // New profiles carry no custom skills; the array is what the API persists.
      skills: []
    };
  }

  function cloneAgent(agent) {
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      instructions: agent.instructions,
      enabled: agent.enabled,
      model: agent.model || "",
      defaultModels: agent.defaultModels || defaultModels(),
      // Copy the array: the tools editor mutates draft.allowedTools in place, and
      // it must not reach through into the shared state.agents entry.
      allowedTools: (agent.allowedTools || []).slice(),
      // Deep-copy each skill so the inline editor never mutates the shared
      // state.agents entry — a discard/reopen must show the persisted values.
      skills: (agent.skills || []).map(function (skill) {
        return { name: skill.name, description: skill.description, instructions: skill.instructions, enabled: skill.enabled };
      })
    };
  }

  function modelWarning(model) {
    if (!model || model.indexOf("/") < 1) return "";
    var provider = model.slice(0, model.indexOf("/"));
    var known = state.models.providers.some(function (item) { return item.configured && item.id === provider; });
    return known ? "" : "Free text accepted; provider not detected in this install.";
  }

  function slugId(name) {
    var slug = String(name || "profile").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!slug) slug = "profile";
    var id = "agent_" + slug;
    if (!agentById(id)) return id;
    return id + "_" + Date.now().toString(36);
  }

  function collectProfileDraft() {
    var draft = state.profileDraft || newProfileDraft();
    var nameInput = document.getElementById("p-name");
    var modelInput = document.getElementById("p-model");
    var descInput = document.getElementById("p-desc");
    var instructionsInput = document.getElementById("p-instr");
    if (nameInput) draft.name = nameInput.value.trim();
    if (modelInput) draft.model = modelInput.value.trim();
    if (descInput) draft.description = descInput.value;
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
    if (action === "cancel-add-channel") { state.addChannelOpen = false; state.addChannelManual = false; state.addChannelError = ""; render(); }
    if (action === "refresh-channels") { loadSlackChannels(true); }
    if (action === "toggle-manual-channel") { state.addChannelManual = !state.addChannelManual; state.addChannelError = ""; render(); }
    if (action === "toggle-swap") { state.swapOpen = !state.swapOpen; render(); }
    if (action === "attach-selected-profile") { attachSelectedProfile(); }
    if (action === "detach-profile") { detachProfile(); }
    if (action === "discard-channel") { var a = activeAssignment(); if (a) selectActive(a.workspaceId, a.channelId); render(); }
    if (action === "save-channel") { saveChannel(); }
    // Profiles master-detail navigation + form actions.
    if (action === "new-profile") { state.view = "profiles"; state.profileScreen = "create"; state.profileDraft = newProfileDraft(); state.editingAgentId = null; state.profileError = ""; state.profileDirty = false; state.disableConfirm = false; state.skillEditor = null; state.skillImport = null; state.modelPickerOpen = false; state.modelPickerFilter = ""; render(); }
    if (action === "edit-profile") { var selected = agentById(target.getAttribute("data-agent")); if (selected) { state.view = "profiles"; state.profileScreen = "edit"; state.editingAgentId = selected.id; state.profileDraft = cloneAgent(selected); state.profileError = ""; state.profileDirty = false; state.disableConfirm = false; state.skillEditor = null; state.skillImport = null; state.modelPickerOpen = false; state.modelPickerFilter = ""; render(); } }
    if (action === "profiles-back") { state.profileScreen = "list"; state.profileDraft = null; state.editingAgentId = null; state.profileError = ""; state.profileDirty = false; state.disableConfirm = false; state.skillEditor = null; state.skillImport = null; state.modelPickerOpen = false; state.modelPickerFilter = ""; render(); }
    if (action === "cancel-create") { state.profileScreen = "list"; state.profileDraft = null; state.profileError = ""; state.profileDirty = false; state.skillEditor = null; state.skillImport = null; state.modelPickerOpen = false; state.modelPickerFilter = ""; render(); }
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
    // Profile form fields: mirror keystrokes into the draft (so a pick-model /
    // tool-toggle re-render keeps typed text) and mark the edit save bar dirty
    // without a full re-render, preserving focus.
    if (state.profileDraft) {
      if (action === "profile-name") { state.profileDraft.name = target.value; markProfileDirty(); }
      if (action === "profile-model") { filterModelPicker(target); }
      if (action === "profile-desc") { state.profileDraft.description = target.value; markProfileDirty(); }
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
    // Profile enable toggle: enabling is harmless, but turning OFF an assigned
    // profile stops it answering everywhere — confirm before staging that.
    if (action === "profile-enable-toggle" && state.profileDraft) {
      if (target.checked) { state.profileDraft.enabled = true; state.disableConfirm = false; state.profileDirty = true; render(); }
      else if (allAssignmentsForAgent(state.profileDraft.id).length > 0) { state.disableConfirm = true; render(); }
      else { state.profileDraft.enabled = false; state.profileDirty = true; render(); }
    }
    // Allowed-tools checkbox: update the draft's tool set and re-render the row.
    if (action === "toggle-tool" && state.profileDraft) {
      collectProfileDraft();
      var toolName = target.getAttribute("data-tool");
      var draftTools = state.profileDraft.allowedTools || [];
      var index = draftTools.indexOf(toolName);
      if (target.checked) { if (index < 0) draftTools.push(toolName); }
      else if (index >= 0) { draftTools.splice(index, 1); }
      state.profileDraft.allowedTools = draftTools;
      state.profileDirty = true;
      render();
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
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" || event.key === "Esc") {
      if (state.leavePrompt) { state.leavePrompt = null; render(); return; }
      if (state.modelPickerOpen) { closeModelPicker(); }
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
  }

  // Land on the Profiles overview (topbar / channel-page "Manage profiles"), or
  // directly on a profile's edit detail when a target id is supplied (the
  // channel-page Profile row's Edit affordance).
  function enterProfiles(targetAgentId) {
    state.view = "profiles";
    state.profileError = "";
    state.profileDirty = false;
    state.disableConfirm = false;
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

  function openAddChannel() {
    state.view = "channels";
    state.addChannelOpen = true;
    state.addChannelError = "";
    state.addChannelInvite = "";
    render();
    // Lazily populate the picker the first time it opens (connected only).
    if (isSlackConnected() && !state.slackChannels && !state.slackChannelsLoading) {
      loadSlackChannels(false);
    }
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
      state.slackChannelsError = error.message === "slack_not_configured"
        ? "Connect Slack first to list channels."
        : (error.serverMessage || error.message || "Could not load channels.");
      render();
    });
  }

  function addChannelErrorText(error) {
    if (error && error.serverMessage) return error.serverMessage;
    var message = error && error.message;
    if (message === "channel_not_found") return "Slack could not find that channel in the connected workspace. Check the ID, and invite @Tag if it is private.";
    if (message === "workspace_mismatch") return "That channel belongs to a different workspace than the one Tag is connected to.";
    if (message === "unknown_agent") return "The profile no longer exists. Reload and try again.";
    return message || "Could not add the channel.";
  }

  function addChannel(formData) {
    var agent = defaultAgent();
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
      state.channelFormDraft.channelId = "";
      state.active = { workspaceId: workspaceId, channelId: channelId };
      // Slack's authoritative name (server override) becomes the display label.
      var savedLabel = normalizeChannelLabel((result && result.assignment && result.assignment.channelLabel) || label || channelId);
      state.addChannelInvite = result && result.isMember === false
        ? "#" + savedLabel + " was added, but @Tag isn't a member of it yet, so it won't hear mentions there. Invite @Tag to #" + savedLabel + " in Slack — no need to come back here."
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
    state.profileError = "";
    state.profileDraft = null;
    state.editingAgentId = null;
    state.disableConfirm = false;
    var action = pending ? pending.action : "profiles-back";
    if (action === "open-settings") {
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
    // Commit an open inline skill editor into the draft first — a filled-but-
    // not-"Added" skill must be saved, not silently dropped. Abort on invalid.
    if (!commitOpenSkillEditor()) return;
    state.profileError = "";
    if (!draft.name) { state.profileError = "Name is required."; render(); return; }
    if (!draft.instructions) { state.profileError = "Profile instructions are required."; render(); return; }
    var body = {
      name: draft.name,
      description: draft.description,
      instructions: draft.instructions,
      enabled: draft.enabled,
      defaultModels: draft.defaultModels || defaultModels(),
      allowedTools: draft.allowedTools || [],
      skills: draft.skills || []
    };
    var isEdit = !!draft.id;
    var request;
    if (isEdit) {
      body.model = draft.model || null;
      request = postJson("/admin/api/agents/" + encodeURIComponent(draft.id), "PATCH", body);
    } else {
      if (draft.model) body.model = draft.model;
      body.id = slugId(draft.name);
      request = postJson("/admin/api/agents", "POST", body);
    }
    request.then(function () {
      state.profileError = "";
      state.profileDirty = false;
      state.disableConfirm = false;
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

  function detachProfileChannel(workspaceId, channelId) {
    api("/admin/api/assignments?workspaceId=" + encodeURIComponent(workspaceId) + "&channelId=" + encodeURIComponent(channelId), { method: "DELETE" })
      .then(refreshData)
      .catch(function (error) { state.profileError = error.message; render(); });
  }

  refreshData();
})();
</script>
</body>
</html>`;
}

/**
 * Minimal token-entry form for browser GETs of /admin that arrive without a
 * valid session. It introduces no new auth path: submitting navigates to
 * /admin?token=<value>, the exact query-token mechanism the admin gate already
 * handles (sets the hashed cookie, then strips the token via redirect). This
 * renders only when TAG_ADMIN_TOKEN is set — the gate 404s the whole route
 * otherwise — so it never signals more than "admin exists here". Self-contained
 * LIGHT-mode markup, no external assets, matching the admin page's palette.
 */
export function renderAdminLogin(options: { invalidToken?: boolean } = {}): string {
  // The one conditional fragment: a static, non-reflecting error notice (the
  // rejected token is never echoed back into the page).
  const error = options.invalidToken
    ? '<p class="err">That token was not accepted. Check TAG_ADMIN_TOKEN and try again.</p>'
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tag Team · Sign in</title>
<style>
:root { --bg:#ffffff; --well:#f7f5f2; --line:rgba(28,25,23,0.12); --text:#201d1a; --text-2:#57534c; --ember:#e8833a; --ember-bright:#f09a55; --danger:#c03538; --font:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; --radius:8px; }
* { box-sizing:border-box; margin:0; padding:0; }
html { color-scheme:light; }
body { background:var(--bg); color:var(--text-2); font-family:var(--font); min-height:100dvh; display:flex; align-items:center; justify-content:center; padding:24px; -webkit-font-smoothing:antialiased; }
.card { background:var(--well); box-shadow:inset 0 0 0 1px var(--line); border-radius:14px; padding:28px; width:100%; max-width:380px; display:flex; flex-direction:column; gap:14px; }
h1 { color:var(--text); font-size:1.0625rem; font-weight:600; }
p { font-size:0.8125rem; line-height:1.5; }
.err { color:var(--danger); }
label { color:var(--text); display:block; font-size:0.8125rem; font-weight:500; margin-bottom:6px; }
.mono { font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; }
input { background:#fff; border:0; border-radius:var(--radius); box-shadow:inset 0 0 0 1px rgba(28,25,23,0.15); color:var(--text); font:inherit; font-size:0.875rem; padding:9px 11px; width:100%; }
input:focus-visible { outline:2px solid #b05415; outline-offset:-1px; }
button { align-items:center; background:var(--ember); border:0; border-radius:var(--radius); color:#22130a; cursor:pointer; display:inline-flex; font:inherit; font-size:0.8125rem; font-weight:500; justify-content:center; min-height:36px; padding:8px 14px; }
button:hover { background:var(--ember-bright); }
</style>
</head>
<body>
<form class="card" method="get" action="/admin">
  <h1>Sign in to Tag Team</h1>
  <p>Enter your <span class="mono">TAG_ADMIN_TOKEN</span> to open the admin.</p>
  ${error}
  <div>
    <label for="token">Admin token</label>
    <input id="token" name="token" type="password" autocomplete="off" autofocus placeholder="TAG_ADMIN_TOKEN">
  </div>
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;
}
