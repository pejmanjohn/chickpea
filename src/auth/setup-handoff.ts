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
  var submit = document.getElementById("owner-setup-submit");
  var password = document.getElementById("password");
  var passwordError = document.getElementById("password-error");
  var passwordConfirmation = document.getElementById("password-confirmation");
  var passwordConfirmationError = document.getElementById("password-confirmation-error");
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
  function validatePasswordConfirmation(showMessage) {
    if (!password || !passwordConfirmation) return true;
    var valid = Boolean(passwordConfirmation.value) && passwordConfirmation.value === password.value;
    var message = passwordConfirmation.value ? "Passwords do not match." : "Enter your password again.";
    if (passwordConfirmation.setCustomValidity) passwordConfirmation.setCustomValidity(valid ? "" : message);
    if (valid) {
      if (passwordConfirmation.removeAttribute) passwordConfirmation.removeAttribute("aria-invalid");
      if (passwordConfirmationError) { passwordConfirmationError.hidden = true; passwordConfirmationError.textContent = ""; }
    } else if (showMessage) {
      if (passwordConfirmation.setAttribute) passwordConfirmation.setAttribute("aria-invalid", "true");
      if (passwordConfirmationError) { passwordConfirmationError.hidden = false; passwordConfirmationError.textContent = message; }
    }
    return valid;
  }
  function enablePasswordValidation() {
    if (passwordValidationReady) return;
    passwordValidationReady = true;
    if (password && password.addEventListener) {
      password.addEventListener("input", function () { validatePassword(Boolean(password.value)); validatePasswordConfirmation(Boolean(passwordConfirmation && passwordConfirmation.value)); });
      password.addEventListener("blur", function () { validatePassword(Boolean(password.value)); });
    }
    if (passwordConfirmation && passwordConfirmation.addEventListener) {
      passwordConfirmation.addEventListener("input", function () { validatePasswordConfirmation(Boolean(passwordConfirmation.value)); });
      passwordConfirmation.addEventListener("blur", function () { validatePasswordConfirmation(Boolean(passwordConfirmation.value)); });
    }
    if (form.addEventListener) form.addEventListener("submit", function (event) {
      var passwordAccepted = validatePassword(true);
      var confirmationAccepted = validatePasswordConfirmation(true);
      var formAccepted = form.checkValidity ? form.checkValidity() : passwordAccepted && confirmationAccepted;
      if (passwordAccepted && confirmationAccepted && formAccepted) return;
      if (event && event.preventDefault) event.preventDefault();
      if (!passwordAccepted && password && password.focus) password.focus();
      else if (!confirmationAccepted && passwordConfirmation && passwordConfirmation.focus) passwordConfirmation.focus();
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
      status.textContent = "This private setup link is missing or expired. Retry your deployment to create a new link.";
    }
    return;
  }
  if (capabilityInput) capabilityInput.value = capability;
  if (submit) submit.disabled = false;
  form.hidden = false;
  if (status) status.hidden = true;
  capability = "";
  enablePasswordValidation();
})();`;
}
