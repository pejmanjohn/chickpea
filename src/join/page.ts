const JOIN_FAVICON = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='8 9 32 32'%3E%3Ccircle cx='24' cy='25' r='15.5' fill='%23E3AC45'/%3E%3Ccircle cx='17' cy='17.5' r='4.2' fill='%23F4D084'/%3E%3Ccircle cx='18.5' cy='24' r='1.9' fill='%233B3220'/%3E%3Ccircle cx='29.5' cy='24' r='1.9' fill='%233B3220'/%3E%3Cpath d='M19 29 Q24 32.5 29 29' fill='none' stroke='%233B3220' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E">`;

export const JOIN_STORAGE_KEY = 'chickpea.invitation.v1';

const JOIN_STYLE = `<style>
:root { --canvas:#f4ebd8; --card:#fffdf6; --ink:#3b3220; --muted:#6b5c42; --gold:#dda033; --line:rgba(59,50,32,.14); --danger:#b5473a; }
* { box-sizing:border-box; } body { margin:0; min-height:100dvh; display:grid; place-items:center; background:var(--canvas); color:var(--ink); font-family:Quicksand,system-ui,sans-serif; padding:20px; }
main { width:min(540px,100%); background:var(--card); border:1px solid var(--line); border-radius:20px; padding:clamp(24px,6vw,42px); box-shadow:0 10px 30px rgba(59,50,32,.09); }
h1 { margin:0 0 8px; font-size:clamp(1.7rem,6vw,2.4rem); } p { color:var(--muted); line-height:1.55; } .identity { background:#f8f1df; border-radius:12px; padding:12px 14px; overflow-wrap:anywhere; margin:18px 0; }
.status { min-height:1.5em; margin-top:14px; font-weight:700; } .error { color:var(--danger); }
</style>`;

export function renderJoinBootstrapPage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Chickpea · Join</title>${JOIN_FAVICON}${JOIN_STYLE}
</head><body><main>
  <h1>Opening your invitation</h1>
  <p>Chickpea is preparing a secure sign-in. You will continue automatically.</p>
  <p id="status" class="status" role="status" aria-live="polite">Preparing&hellip;</p>
</main><script src="/join/bootstrap.js" defer></script></body></html>`;
}

export function joinBootstrapScript(): string {
  return `(function () {
  "use strict";
  var key = ${JSON.stringify(JOIN_STORAGE_KEY)};
  var status = document.getElementById("status");
  var params = new URLSearchParams(location.hash.slice(1));
  var credential = params.get("invite") || "";
  var split = credential.indexOf(".");
  var valid = split > 0 && split < credential.length - 1;
  if (valid) {
    try {
      sessionStorage.setItem(key, credential);
    } catch (_) {
      valid = false;
    }
  }
  history.replaceState(null, "", location.pathname + location.search);
  credential = "";
  if (!valid) {
    sessionStorage.removeItem(key);
    if (status) status.textContent = "This invitation is incomplete. Ask an administrator for a new invitation link.";
    return;
  }
  location.replace("/admin/join");
})();`;
}

export function renderInvitationJoinPage(input: { email: string }): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Chickpea · Join</title>${JOIN_FAVICON}${JOIN_STYLE}
</head><body><main>
  <h1>Joining this Chickpea</h1>
  <p>Your email has been verified. Chickpea is matching it to the invitation and activating your membership.</p>
  <p class="identity">Signed in as <strong>${escapeHtml(input.email)}</strong></p>
  <p id="status" class="status" role="status" aria-live="polite">Accepting invitation&hellip;</p>
</main><script src="/admin/join/client.js" defer></script></body></html>`;
}

export function invitationJoinClientScript(): string {
  return `(function () {
  "use strict";
  var key = ${JSON.stringify(JOIN_STORAGE_KEY)};
  var status = document.getElementById("status");
  var credential = "";
  try { credential = sessionStorage.getItem(key) || ""; } catch (_) {}
  try { sessionStorage.removeItem(key); } catch (_) {}
  var split = credential.indexOf(".");
  var invitationId = split > 0 ? credential.slice(0, split) : "";
  var token = split > 0 ? credential.slice(split + 1) : "";
  credential = "";
  if (!invitationId || !token) {
    if (status) {
      status.className = "status error";
      status.textContent = "This invitation is unavailable in this browser. Ask an administrator for a new link.";
    }
    return;
  }
  fetch("/admin/join", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invitationId: invitationId, token: token })
  }).then(function (response) {
    token = "";
    invitationId = "";
    if (!response.ok) throw new Error("unavailable");
    return response.json();
  }).then(function (body) {
    location.replace(body.redirect || "/admin/account");
  }).catch(function () {
    token = "";
    invitationId = "";
    if (status) {
      status.className = "status error";
      status.textContent = "This invitation could not be accepted. Ask an administrator for a new link.";
    }
  });
})();`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
