const JOIN_FAVICON = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='8 9 32 32'%3E%3Ccircle cx='24' cy='25' r='15.5' fill='%23E3AC45'/%3E%3Ccircle cx='17' cy='17.5' r='4.2' fill='%23F4D084'/%3E%3Ccircle cx='18.5' cy='24' r='1.9' fill='%233B3220'/%3E%3Ccircle cx='29.5' cy='24' r='1.9' fill='%233B3220'/%3E%3Cpath d='M19 29 Q24 32.5 29 29' fill='none' stroke='%233B3220' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E">`;

export const JOIN_STORAGE_KEY = 'chickpea.invitation.v1';
export const RESET_STORAGE_KEY = 'chickpea.reset.v1';

const JOIN_STYLE = `<style>
:root { --canvas:#f4ebd8; --card:#fffdf6; --ink:#3b3220; --muted:#6b5c42; --gold:#dda033; --line:rgba(59,50,32,.14); --danger:#b5473a; }
* { box-sizing:border-box; } body { margin:0; min-height:100dvh; display:grid; place-items:center; background:var(--canvas); color:var(--ink); font-family:Quicksand,system-ui,sans-serif; padding:20px; }
main { width:min(540px,100%); background:var(--card); border:1px solid var(--line); border-radius:20px; padding:clamp(24px,6vw,42px); box-shadow:0 10px 30px rgba(59,50,32,.09); }
h1 { margin:0 0 8px; font-size:clamp(1.7rem,6vw,2.4rem); } p { color:var(--muted); line-height:1.55; } .identity { background:#f8f1df; border-radius:12px; padding:12px 14px; overflow-wrap:anywhere; margin:18px 0; }
.status { min-height:1.5em; margin-top:14px; font-weight:700; } .error { color:var(--danger); }
form { display:grid; gap:16px; margin-top:22px; } label { display:grid; gap:7px; font-weight:700; }
input { width:100%; min-height:46px; border:1px solid var(--line); border-radius:10px; padding:10px 12px; background:#fff; color:var(--ink); font:inherit; }
input:focus,button:focus,a:focus { outline:3px solid rgba(221,160,51,.34); outline-offset:2px; }
button,.button { display:inline-flex; min-height:46px; align-items:center; justify-content:center; border:0; border-radius:10px; padding:11px 18px; background:var(--ink); color:#fff; font:700 1rem inherit; text-decoration:none; cursor:pointer; }
[hidden] { display:none !important; } .actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:18px; }
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

export function renderResetBootstrapPage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Chickpea · Password reset</title>${JOIN_FAVICON}${JOIN_STYLE}
</head><body><main>
  <h1>Opening your reset link</h1>
  <p>Chickpea is preparing a secure password reset. You will continue automatically.</p>
  <p id="status" class="status" role="status" aria-live="polite">Preparing&hellip;</p>
</main><script src="/reset/bootstrap.js" defer></script></body></html>`;
}

export function resetBootstrapScript(): string {
  return `(function () {
  "use strict";
  var key = ${JSON.stringify(RESET_STORAGE_KEY)};
  var status = document.getElementById("status");
  var params = new URLSearchParams(location.hash.slice(1));
  var credential = params.get("reset") || "";
  var split = credential.indexOf(".");
  var valid = split > 0 && split < credential.length - 1;
  if (valid) {
    try { sessionStorage.setItem(key, credential); } catch (_) { valid = false; }
  }
  history.replaceState(null, "", location.pathname + location.search);
  credential = "";
  if (!valid) {
    sessionStorage.removeItem(key);
    if (status) status.textContent = "This reset link is incomplete. Ask an administrator for a new link.";
    return;
  }
  location.replace("/admin/reset");
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

export function renderPasswordInvitationPage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Chickpea · Join</title>${JOIN_FAVICON}${JOIN_STYLE}
</head><body><main>
  <h1>Join this Chickpea</h1>
  <p id="context">Checking your private invitation&hellip;</p>
  <p id="identity" class="identity" hidden></p>
  <form id="enrollment" hidden>
    <label>Display name<input id="display-name" name="displayName" autocomplete="name" maxlength="128" required></label>
    <label>Create a password<input id="password" name="password" type="password" autocomplete="new-password" minlength="15" maxlength="512" required></label>
    <button type="submit">Create account and join</button>
  </form>
  <div id="existing" hidden><p>That email already has an account. Sign in normally to continue this exact invitation.</p><a class="button" href="/admin/login?returnTo=%2Fadmin%2Fjoin">Sign in to continue</a></div>
  <div id="authenticated" hidden><p>You are signed in as the invited account.</p><button id="accept" type="button">Accept invitation</button></div>
  <p id="status" class="status" role="status" aria-live="polite"></p>
</main><script src="/admin/join/password-client.js" defer></script></body></html>`;
}

export function passwordInvitationClientScript(): string {
  return `(function () {
  "use strict";
  var key = ${JSON.stringify(JOIN_STORAGE_KEY)};
  var status = document.getElementById("status");
  var context = document.getElementById("context");
  var identity = document.getElementById("identity");
  var form = document.getElementById("enrollment");
  var existing = document.getElementById("existing");
  var authenticated = document.getElementById("authenticated");
  var accept = document.getElementById("accept");
  var credential = "";
  try { credential = sessionStorage.getItem(key) || ""; } catch (_) {}
  var split = credential.indexOf(".");
  var operationId = split > 0 ? credential.slice(0, split) : "";
  var token = split > 0 ? credential.slice(split + 1) : "";
  function fail(message) {
    if (status) { status.className = "status error"; status.textContent = message; }
  }
  function post(path, body) {
    return fetch(path, { method:"POST", credentials:"same-origin", headers:{"content-type":"application/json"}, body:JSON.stringify(body) });
  }
  function complete(extra) {
    if (status) { status.className = "status"; status.textContent = "Activating your membership…"; }
    post("/admin/join", Object.assign({ operationId:operationId, token:token }, extra || {})).then(function (response) {
      if (response.status === 409) return response.json().then(function (body) { throw new Error(body.error || "conflict"); });
      if (!response.ok) throw new Error("unavailable");
      return response.json();
    }).then(function (body) {
      try { sessionStorage.removeItem(key); } catch (_) {}
      token = ""; operationId = ""; credential = "";
      location.replace(body.redirect || "/admin/account");
    }).catch(function (error) {
      if (error && error.message === "existing_account") {
        if (form) form.hidden = true;
        if (existing) existing.hidden = false;
        fail("Sign in with the invited email to continue.");
        return;
      }
      fail(error && error.message === "conflict" ? "You are signed in as a different user. Sign out, then reopen this invitation." : "This invitation is unavailable. Ask an administrator for a new link.");
    });
  }
  if (!operationId || !token) { fail("This invitation is unavailable in this browser. Ask an administrator for a new link."); return; }
  post("/admin/join/inspect", { operationId:operationId, token:token }).then(function (response) {
    if (response.status === 409) return response.json().then(function (body) { throw new Error(body.error || "conflict"); });
    if (!response.ok) throw new Error("unavailable");
    return response.json();
  }).then(function (body) {
    if (context) context.textContent = "This private link authorizes enrollment for the invited email below.";
    if (identity) { identity.hidden = false; identity.textContent = body.email; }
    if (body.accountState === "new" && form) form.hidden = false;
    else if (body.accountState === "existing" && existing) existing.hidden = false;
    else if (body.accountState === "authenticated" && authenticated) authenticated.hidden = false;
  }).catch(function (error) {
    fail(error && error.message === "conflict" ? "You are signed in as a different user. Sign out, then reopen this invitation." : "This invitation is unavailable. Ask an administrator for a new link.");
  });
  if (form) form.addEventListener("submit", function (event) {
    event.preventDefault();
    complete({ displayName:document.getElementById("display-name").value, password:document.getElementById("password").value });
  });
  if (accept) accept.addEventListener("click", function () { complete({}); });
})();`;
}

export function renderPasswordResetPage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Chickpea · Reset password</title>${JOIN_FAVICON}${JOIN_STYLE}
</head><body><main>
  <h1>Reset your password</h1>
  <p id="context">Checking your private reset link&hellip;</p>
  <p id="identity" class="identity" hidden></p>
  <form id="reset-form" hidden>
    <label>New password<input id="new-password" name="newPassword" type="password" autocomplete="new-password" minlength="15" maxlength="512" required></label>
    <button type="submit">Replace password</button>
  </form>
  <p id="status" class="status" role="status" aria-live="polite"></p>
</main><script src="/admin/reset/client.js" defer></script></body></html>`;
}

export function passwordResetClientScript(): string {
  return `(function () {
  "use strict";
  var key = ${JSON.stringify(RESET_STORAGE_KEY)};
  var status = document.getElementById("status");
  var context = document.getElementById("context");
  var identity = document.getElementById("identity");
  var form = document.getElementById("reset-form");
  var credential = "";
  try { credential = sessionStorage.getItem(key) || ""; } catch (_) {}
  var split = credential.indexOf(".");
  var operationId = split > 0 ? credential.slice(0, split) : "";
  var token = split > 0 ? credential.slice(split + 1) : "";
  function fail(message) { if (status) { status.className="status error"; status.textContent=message; } }
  function post(body) { return fetch("/admin/reset", { method:"POST", credentials:"same-origin", headers:{"content-type":"application/json"}, body:JSON.stringify(body) }); }
  if (!operationId || !token) { fail("This reset link is unavailable in this browser. Ask an administrator for a new link."); return; }
  post({ operationId:operationId, token:token, inspect:true }).then(function (response) {
    if (response.status === 409) throw new Error("conflict");
    if (!response.ok) throw new Error("unavailable");
    return response.json();
  }).then(function (body) {
    if (context) context.textContent = "This private link can replace the password for the account below.";
    if (identity) { identity.hidden=false; identity.textContent=body.email; }
    if (form) form.hidden=false;
  }).catch(function (error) { fail(error.message === "conflict" ? "You are signed in as a different user. Sign out before using this reset link." : "This reset link is unavailable or expired. Ask an administrator for a new link."); });
  if (form) form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (status) { status.className="status"; status.textContent="Replacing your password…"; }
    post({ operationId:operationId, token:token, newPassword:document.getElementById("new-password").value }).then(function (response) {
      if (response.status === 409) throw new Error("conflict");
      if (!response.ok) throw new Error("unavailable");
      return response.json();
    }).then(function (body) {
      try { sessionStorage.removeItem(key); } catch (_) {}
      token=""; operationId=""; credential="";
      location.replace(body.redirect || "/admin/login");
    }).catch(function (error) { fail(error.message === "conflict" ? "You are signed in as a different user. Sign out before using this reset link." : "The password could not be replaced. Check the password requirements or ask for a new link."); });
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
