**Comparison Target**

- Source visual truth: `<local-artifacts>/generated_images/019faae1-7b73-77a1-9bfd-4c490f6462af/exec-de9fcbee-b175-424c-864b-d905dc29b424.png`
- Browser-rendered implementation: `http://127.0.0.1:3591/admin/usage`
- Implementation screenshot: `<local-artifacts>/visualizations/2026/07/28/019faae1-7b73-77a1-9bfd-4c490f6462af/admin-navigation/usage-desktop.png`
- Desktop viewport and CSS size: `1487x1058`
- Source pixels: `1487x1058`; implementation pixels: `1487x1058`; device scale factor: `1`. No density normalization was needed.
- State: signed-in local Node Admin, Usage enabled, channel breakdown selected, realistic four-activity usage fixture loaded, desktop section switcher active on Usage.

**Full-view Comparison Evidence**

- Same-input comparison: `<local-artifacts>/visualizations/2026/07/28/019faae1-7b73-77a1-9bfd-4c490f6462af/admin-navigation/usage-comparison-final.png`
- The implementation preserves the selected mockup's hierarchy, warm palette, rail/main proportions, text-only section switcher, active states, usage controls, guidance, summary cards, channel-first tables, and compact density.
- The implementation is slightly roomier inside the main content card because it uses the existing Admin layout tokens. This is an acceptable product-system constraint and does not change hierarchy, wrapping, or above-the-fold information.

**Focused Region Comparison Evidence**

- Navigation comparison: `<local-artifacts>/visualizations/2026/07/28/019faae1-7b73-77a1-9bfd-4c490f6462af/admin-navigation/navigation-focus-comparison.png`
- Usage-header comparison: `<local-artifacts>/visualizations/2026/07/28/019faae1-7b73-77a1-9bfd-4c490f6462af/admin-navigation/usage-top-focus-comparison.png`
- These native-density crops make the section hierarchy, labels, typography, active treatments, controls, guidance, cards, and spacing readable without relying only on the full-page view.

**Required Fidelity Surfaces**

- Fonts and typography: the implementation uses the existing Chickpea display, body, and mono families with the same optical hierarchy as the mockup. Eyebrows, labels, values, metadata, and navigation remain readable with no unexpected wrapping or truncation.
- Spacing and layout rhythm: the rail and main card retain the mockup's rounded two-column frame and measured vertical rhythm. On desktop the rail remains within the `1058px` viewport (`top 68`, `bottom 1042`), the section switcher remains visible (`top 840`, `bottom 1028`), and only the main panel scrolls.
- Colors and visual tokens: cream canvas, white surfaces, ember active tint, dark spend card, muted metadata, green statuses, subtle dividers, shadows, and borders remain consistent with the mockup and existing Admin tokens.
- Image quality and asset fidelity: this screen contains no content imagery. The Chickpea brand mark is the product's existing sharp inline asset used by the Admin rather than a new placeholder or substitute.
- Copy and content: Usage keeps concise provider-limit guidance, plain dollar formatting, channel-first reporting, and activity language. Profiles, Settings categories, and mobile menu labels are short and standalone.

**Findings**

- No actionable P0, P1, or P2 visual, interaction, accessibility, or responsive findings remain.

**Comparison History**

- Pass 1 comparison: `<local-artifacts>/visualizations/2026/07/28/019faae1-7b73-77a1-9bfd-4c490f6462af/admin-navigation/usage-comparison-pass-1.png`
  - [P1] The section switcher was placed at the end of the rail but the overall desktop frame was not viewport-constrained, so long Usage content pushed the supposedly persistent section controls below the visible viewport.
- Fix made:
  - Constrained the desktop frame to `100dvh`, kept the body from expanding beyond the frame, and made the main panel the scrolling region while the rail stays fixed.
- Post-fix evidence:
  - `<local-artifacts>/visualizations/2026/07/28/019faae1-7b73-77a1-9bfd-4c490f6462af/admin-navigation/usage-desktop.png` shows all four section controls visible while the long main table continues below the fold.
  - Browser measurements confirmed no horizontal overflow and a scrollable main panel (`clientHeight 974`, `scrollHeight 1140`).
  - `<local-artifacts>/visualizations/2026/07/28/019faae1-7b73-77a1-9bfd-4c490f6462af/admin-navigation/usage-comparison-final.png` is the same-state post-fix comparison.

**Additional Screen and Responsive Evidence**

- Profiles: `<local-artifacts>/visualizations/2026/07/28/019faae1-7b73-77a1-9bfd-4c490f6462af/admin-navigation/profiles-desktop.png`
- Settings: `<local-artifacts>/visualizations/2026/07/28/019faae1-7b73-77a1-9bfd-4c490f6462af/admin-navigation/settings-desktop.png`
- Mobile Usage: `<local-artifacts>/visualizations/2026/07/28/019faae1-7b73-77a1-9bfd-4c490f6462af/admin-navigation/usage-mobile.png` at `390x844`
- Mobile menu: `<local-artifacts>/visualizations/2026/07/28/019faae1-7b73-77a1-9bfd-4c490f6462af/admin-navigation/mobile-menu.png` at `390x844`
- The mobile layout has no document or main-panel horizontal overflow. The desktop switcher correctly yields to the existing mobile hamburger, which exposes Channels, Profiles, Usage, and Settings with one active section.

**Primary Interactions Tested**

- Switched from Usage to the last-used/first Profile and confirmed the selected profile appears in the contextual rail and main editor.
- Opened Settings and confirmed Model providers is the default category.
- Switched Settings to GitHub and confirmed the route changed to `/admin/settings/github`, only the GitHub panel remained visible, and the contextual active state followed it.
- Verified direct URLs, active section state, realistic Usage tables, disconnected-Slack navigation, and feature-gated Usage behavior in the browser/unit harness.
- Verified the mobile hamburger exposes all primary sections and hides the redundant desktop section switcher.

**Console Errors Checked**

- Browser warnings/errors after the final desktop and mobile interaction pass: none (`[]`).

**Implementation Checklist**

- [x] Remove desktop top navigation and add a persistent text-only section switcher.
- [x] Keep Channels visible and active for channel-owned audit screens.
- [x] Add profile-specific contextual navigation and retain the selected profile.
- [x] Split Settings into Model providers, GitHub, Coding sandbox, and Outbound access routes with one visible panel at a time.
- [x] Preserve the existing mobile hamburger and responsive layout.
- [x] Keep direct links, dirty-profile guards, and disconnected onboarding coherent.
- [x] Verify desktop persistence, mobile overflow, console health, focused tests, full tests, build, and Admin UI verification.

**Follow-up Polish**

- No blocking polish remains. Additional Settings categories can use the same contextual-rail contract without changing primary navigation.

final result: passed
