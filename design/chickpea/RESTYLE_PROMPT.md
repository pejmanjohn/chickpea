# Restyle prompt — Chickpea theme for tag-team

Copy-paste brief for the coding agent working in `pejmanjohn/tag-team`.

---

Apply the Chickpea rebrand to the `/admin` UI. This is a **style-only** change.

**Do not change:** any markup structure, class names, ids, data-actions, copy
text, layout system, JS logic, routes, or tests' behavioral expectations.

**Steps:**

1. In `src/admin/page.ts`, replace the entire contents of the FIRST `<style>`
   block (the big one at the top of `renderAdminPage()`, from `:root {` through
   the `@media (pointer: coarse)` rule) with the contents of `chickpea.css`.
   The theme covers the selector set as of commit `cc7395e` (capability tabs
   `.ptabs/.ptab`, connections `.conn-*`/`.seg`, `.title-row`/`.rename-btn`,
   `.profile-foot`), plus legacy `.tool-row`/`.danger-zone` for older builds.
   If classes were added after that commit, style them per BRAND.md.
   - Token names (`--ember`, `--ok`, etc.) are intentionally unchanged; inline
     `style="...var(--ember)..."` strings elsewhere in the file keep working.
   - The logo is delivered as a CSS background on `.avatar`; the `<span
     class="avatar">T</span>` markup stays as-is (the T is hidden via CSS).
2. In the same file, update the small login-page `<style>` block near the
   bottom: swap its `:root` values and button colors per the commented block at
   the end of `chickpea.css` (add the same Google Fonts `@import` line there).
3. Brand copy (the only copy change, do it in the same PR):
   - `<title>Tag Team · /admin</title>` → `Chickpea · /admin`
   - Both `<span class="brand-name">Tag Team</span>` occurrences (first-paint
     skeleton + `topbarHtml()`) → `Chickpea`
   - If reply-attribution copy like "post as @Tag" appears in admin strings,
     change to "@Chickpea". Do NOT touch Slack-side bot naming or manifest.
4. Optional but preferred: in `profileTabsHtml()`, wrap the `.ptabs` bar and
   its `.ptab-panel` siblings in one `<div class="ptab-tray">…</div>`. The CSS
   works without it (the panel pulls flush via a negative margin), but the
   wrapper is more robust if section spacing ever changes.
5. Add `chickpea-mark.svg` to `assets/` (replaces the old avatar art for any
   future use; the CSS embeds its own copy as a data URI).
6. Run the test suite. Update only assertions that check the old brand string
   ("Tag Team") or hardcoded old colors, if any. If a test asserts on class
   names or DOM structure, it must pass unchanged — if it doesn't, the change
   went beyond styling; revert that part.

**Acceptance:**
- Page background is warm tan with the rail and main panel floating as cream
  rounded cards; topbar has no border.
- Primary buttons are chickpea gold with a hard 2px darker shadow that
  physically presses on click.
- Connected/on badges are solid sprout green; toggles turn green when on.
- The topbar shows the smiling chickpea mark instead of the "T" square.
- Fonts: Baloo 2 (headings), Quicksand (UI), JetBrains Mono (code/models).
- No console errors; mobile hamburger menu, sticky save bar, model-picker
  popover, and modals all render and function exactly as before.

Design intent reference: `BRAND.md`.
