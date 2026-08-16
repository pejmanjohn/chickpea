const SLACK_SETUP_STORAGE_KEY = 'chickpea.slack-setup.v1';

/** Only a same-origin Admin path may survive an interrupted setup handoff. */
export function safeSetupDestination(value: string | null | undefined): string {
  if (!value) return '/admin';
  const candidate = value.trim();
  if (!/^\/admin(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/.test(candidate)) return '/admin';
  try {
    const base = new URL('https://chickpea.invalid');
    const parsed = new URL(candidate, base);
    if (parsed.origin !== base.origin || parsed.pathname !== candidate || parsed.search || parsed.hash ||
        parsed.username || parsed.password || parsed.pathname === '/admin/api' ||
        parsed.pathname.startsWith('/admin/api/')) return '/admin';
    if (parsed.pathname === '/admin' || parsed.pathname.startsWith('/admin/')) return parsed.pathname;
  } catch {
    // Fall through to the neutral Admin destination.
  }
  return '/admin';
}

/** Fragment capability handoff for the seven-day Slack bootstrap transaction. */
export function slackSetupClientScript(): string {
  return `(function () {
  "use strict";
  var storageKey = ${JSON.stringify(SLACK_SETUP_STORAGE_KEY)};
  var capability = "";
  try {
    var fragment = new URLSearchParams(location.hash.slice(1));
    capability = fragment.get("setup") || "";
    if (capability) sessionStorage.setItem(storageKey, capability);
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  } catch (_) {}
  if (!capability) {
    try { capability = sessionStorage.getItem(storageKey) || ""; } catch (_) {}
  }
  if (capability.length < 32 || capability.length > 512 || /\\s/.test(capability)) {
    capability = "";
    try { sessionStorage.removeItem(storageKey); } catch (_) {}
  }
  var fields = document.querySelectorAll ? document.querySelectorAll("input[data-slack-setup-capability]") : [];
  for (var i = 0; i < fields.length; i += 1) fields[i].value = capability;
  var status = document.getElementById("slack-setup-status");
  if (!capability && status) status.textContent = "This private setup link is missing or expired. Retry your deployment to create a new link.";
  var setupState = document.documentElement && document.documentElement.getAttribute
    ? document.documentElement.getAttribute("data-slack-setup-state") : "";
  var autoResume = document.documentElement && document.documentElement.getAttribute
    ? document.documentElement.getAttribute("data-slack-setup-auto-resume") === "true" : false;
  if (setupState === "ambiguous_external_effect" && status) {
    status.textContent = "Inspect your Slack apps, then adopt the matching app or explicitly restart.";
  }
  var openForm = document.getElementById("slack-setup-open-form");
  if (capability && setupState === "capability_required" && autoResume && openForm) {
    if (status) status.textContent = "Resuming your saved Slack setup…";
    capability = "";
    if (openForm.requestSubmit) openForm.requestSubmit();
    else if (openForm.submit) openForm.submit();
    return;
  }
  capability = "";
})();`;
}
