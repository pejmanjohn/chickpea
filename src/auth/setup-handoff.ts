import { PASSWORD_MIN_CODE_POINTS } from './password-policy.ts';

const OWNER_SETUP_FRAGMENT_KEY = 'setup';
const OWNER_SETUP_STORAGE_KEY = 'chickpea.owner-setup.v1';

/**
 * Moves the deploy-time owner capability out of the URL fragment before the
 * browser can retain or share it, then supplies it only to the same-origin
 * setup form. The capability remains in same-tab storage across a rejected
 * form so the operator can correct ordinary validation errors without finding
 * the private deploy link again. The ready page loads this script without the
 * form to clear the capability after setup succeeds.
 */
export function passwordOwnerSetupClientScript(): string {
  return `(function () {
  "use strict";
  var fragmentKey = ${JSON.stringify(OWNER_SETUP_FRAGMENT_KEY)};
  var storageKey = ${JSON.stringify(OWNER_SETUP_STORAGE_KEY)};
  var form = document.getElementById("owner-setup-form");
  var status = document.getElementById("owner-setup-status");
  var capabilityInput = document.getElementById("owner-setup-capability");
  var manual = document.getElementById("owner-setup-manual-capability");
  var fallback = document.getElementById("owner-setup-fallback");
  var fallbackContinue = document.getElementById("owner-setup-manual-continue");
  var fallbackError = document.getElementById("owner-setup-manual-error");
  var submit = document.getElementById("owner-setup-submit");
  var password = document.getElementById("password");
  var passwordError = document.getElementById("password-error");
  var passwordMinimum = ${PASSWORD_MIN_CODE_POINTS};
  if (!form) {
    try { sessionStorage.removeItem(storageKey); } catch (_) {}
    return;
  }
  var passwordValidationReady = false;
  function validatePassword(showMessage) {
    if (!password) return true;
    var value = password.value || "";
    var remaining = passwordMinimum - Array.from(value).length;
    var valid = remaining <= 0;
    var message = value ? remaining + " more " + (remaining === 1 ? "character" : "characters") + " needed." : "Enter a password with at least " + passwordMinimum + " characters.";
    if (password.setCustomValidity) password.setCustomValidity(valid ? "" : message);
    if (valid) {
      if (password.removeAttribute) password.removeAttribute("aria-invalid");
      if (passwordError) { passwordError.hidden = true; passwordError.textContent = ""; }
    } else if (showMessage) {
      if (password.setAttribute) password.setAttribute("aria-invalid", "true");
      if (passwordError) { passwordError.hidden = false; passwordError.textContent = message; }
    }
    value = "";
    return valid;
  }
  function enablePasswordValidation() {
    if (passwordValidationReady) return;
    passwordValidationReady = true;
    if (password && password.addEventListener) {
      password.addEventListener("input", function () { validatePassword(Boolean(password.value)); });
      password.addEventListener("blur", function () { validatePassword(Boolean(password.value)); });
    }
    if (form.addEventListener) form.addEventListener("submit", function (event) {
      var passwordAccepted = validatePassword(true);
      var formAccepted = form.checkValidity ? form.checkValidity() : passwordAccepted;
      if (passwordAccepted && formAccepted) return;
      if (event && event.preventDefault) event.preventDefault();
      if (!passwordAccepted && password && password.focus) password.focus();
      if (form.reportValidity) form.reportValidity();
    });
  }
  var capability = "";
  try {
    var fragment = new URLSearchParams(location.hash.slice(1));
    capability = fragment.get(fragmentKey) || "";
    if (capability) sessionStorage.setItem(storageKey, capability);
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  } catch (_) {}
  if (!capability) {
    try { capability = sessionStorage.getItem(storageKey) || ""; } catch (_) {}
  }
  if (capability.length < 32 || capability.length > 512 || /\\s/.test(capability)) {
    capability = "";
    try { sessionStorage.removeItem(storageKey); } catch (_) {}
    if (status) {
      status.textContent = "Open the private setup link from your deploy results. If it is unavailable, enter the setup code manually below.";
    }
    if (fallback) fallback.hidden = false;
    if (manual) manual.addEventListener("input", function () {
      if (fallbackError) { fallbackError.hidden = true; fallbackError.textContent = ""; }
      if (manual.removeAttribute) manual.removeAttribute("aria-invalid");
    });
    if (fallbackContinue) fallbackContinue.addEventListener("click", function () {
      var value = manual && manual.value ? manual.value : "";
      var valid = value.length >= 32 && value.length <= 512 && !/\\s/.test(value);
      if (!valid) {
        if (fallbackError) {
          fallbackError.hidden = false;
          fallbackError.textContent = "Enter the setup code from your deploy results.";
        }
        if (manual && manual.setAttribute) manual.setAttribute("aria-invalid", "true");
        if (manual && manual.focus) manual.focus();
        return;
      }
      try { sessionStorage.setItem(storageKey, value); } catch (_) {}
      if (capabilityInput) capabilityInput.value = value;
      if (manual) manual.value = "";
      if (submit) submit.disabled = false;
      if (fallback) fallback.hidden = true;
      form.hidden = false;
      if (status) status.hidden = true;
      enablePasswordValidation();
      value = "";
    });
    return;
  }
  if (capabilityInput) capabilityInput.value = capability;
  if (submit) submit.disabled = false;
  if (fallback) fallback.hidden = true;
  form.hidden = false;
  if (status) status.hidden = true;
  capability = "";
  enablePasswordValidation();
})();`;
}
