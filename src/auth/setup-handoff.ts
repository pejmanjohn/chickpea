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

/** Login may resume one opaque server-side MCP authorization continuation. */
export function safeSlackLoginDestination(value: string | null | undefined): string {
  const candidate = value?.trim() ?? '';
  if (/^\/auth\/mcp\/resume\/[A-Za-z0-9_-]{43,128}$/.test(candidate)) return candidate;
  if (/^\/setup\/setup_[A-Za-z0-9_-]{1,128}$/.test(candidate)) return candidate;
  return safeSetupDestination(candidate);
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
  var setupState = document.documentElement && document.documentElement.getAttribute
    ? document.documentElement.getAttribute("data-slack-setup-state") : "";
  function announce(message) {
    if (!status) return;
    status.textContent = message;
    status.hidden = false;
  }
  if (!capability) {
    announce("This private setup link is missing or expired. Retry your deployment to create a new link.");
    var guarded = [];
    for (var f = 0; f < fields.length; f += 1) {
      var form = fields[f].form;
      if (!form || guarded.indexOf(form) !== -1) continue;
      guarded.push(form);
      if (form.addEventListener) form.addEventListener("submit", function (event) {
        if (event && event.preventDefault) event.preventDefault();
      });
      var controls = form.querySelectorAll ? form.querySelectorAll("button,input[type=submit]") : [];
      for (var b = 0; b < controls.length; b += 1) controls[b].disabled = true;
    }
  } else if (setupState === "ambiguous_external_effect") {
    announce("Inspect your Slack apps, then adopt the matching app or explicitly restart.");
  }
  capability = "";
})();`;
}

/** Manual app-adoption navigation layered on the setup capability handoff. */
export function slackManualSetupClientScript(): string {
  return `${slackSetupClientScript()}
(function () {
  "use strict";
  var root = document.documentElement;
  var panels = document.querySelectorAll ? document.querySelectorAll("[data-manual-step-panel]") : [];
  if (!root || !panels.length) return;
  var allowed = { create: true, finish: true, credentials: true };
  var initial = root.getAttribute("data-manual-initial-step") || "create";
  initial = allowed[initial] ? initial : "create";
  function show(step, focus) {
    if (!allowed[step]) return;
    root.setAttribute("data-manual-current-step", step);
    for (var i = 0; i < panels.length; i += 1) {
      var active = panels[i].getAttribute("data-manual-step-panel") === step;
      panels[i].hidden = !active;
      panels[i].setAttribute("aria-hidden", active ? "false" : "true");
    }
    if (focus) {
      var heading = document.querySelector ? document.querySelector('[data-manual-step-panel="' + step + '"] h1') : null;
      if (heading && heading.focus) heading.focus();
    }
  }
  if (document.addEventListener) document.addEventListener("click", function (event) {
    var target = event.target && event.target.closest ? event.target.closest("[data-manual-step-target]") : null;
    if (!target) return;
    var step = target.getAttribute("data-manual-step-target") || "";
    if (!allowed[step]) return;
    if (target.tagName !== "A") event.preventDefault();
    show(step, target.tagName !== "A");
  });
  show(initial, false);
})();`;
}

/** Same-origin transition script for CSP-safe navigation to Slack OAuth. */
export function slackAuthorizationHandoffScript(gatewayOrigin?: string): string {
  return `(function () {
  "use strict";
  var link = document.querySelector ? document.querySelector("a[data-slack-authorization-link]") : null;
  if (!link) return;
  try {
    var target = new URL(link.getAttribute("href") || "", location.origin);
    var slackAuthorization = target.origin === "https://slack.com" &&
      (target.pathname === "/oauth/v2/authorize" || target.pathname === "/openid/connect/authorize");
    var gatewayAuthorization = target.origin === ${JSON.stringify(gatewayOrigin ?? '')} &&
      /^\\/install\\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(target.pathname) && !target.search;
    if (target.protocol !== "https:" || (!slackAuthorization && !gatewayAuthorization) ||
        target.username || target.password || target.hash) return;
    location.replace(target.href);
  } catch (_) {}
})();`;
}
