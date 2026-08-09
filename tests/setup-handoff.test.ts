import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { passwordOwnerSetupClientScript } from '../src/auth/setup-handoff.ts';

const CAPABILITY = '9d'.repeat(32);
const STORAGE_KEY = 'chickpea.owner-setup.v1';

test('owner setup moves the fragment capability into same-tab storage and cleans the URL', () => {
  const stored = new Map<string, string>();
  const historyPaths: string[] = [];
  const form = { hidden: true };
  const status = { hidden: false, className: '', textContent: '' };
  const input = { value: '' };
  const submit = { disabled: true };
  const elements: Record<string, object> = {
    'owner-setup-form': form,
    'owner-setup-status': status,
    'owner-setup-capability': input,
    'owner-setup-submit': submit,
  };

  vm.runInNewContext(passwordOwnerSetupClientScript(), {
    URLSearchParams,
    document: { getElementById(id: string) { return elements[id] ?? null; } },
    history: {
      replaceState(_state: unknown, _title: string, path: string) { historyPaths.push(path); },
    },
    location: { hash: `#setup=${CAPABILITY}`, pathname: '/admin/setup', search: '' },
    sessionStorage: {
      getItem(key: string) { return stored.get(key) ?? null; },
      setItem(key: string, value: string) { stored.set(key, value); },
      removeItem(key: string) { stored.delete(key); },
    },
  }, { filename: 'owner-setup-client.js' });

  assert.equal(stored.get(STORAGE_KEY), CAPABILITY);
  assert.deepEqual(historyPaths, ['/admin/setup']);
  assert.equal(input.value, CAPABILITY);
  assert.equal(form.hidden, false);
  assert.equal(status.hidden, true);
  assert.equal(submit.disabled, false);
});

test('owner setup fails closed when the private fragment capability is unavailable', () => {
  const form = { hidden: true };
  const status = { hidden: false, className: '', textContent: '' };
  const input = { value: '' };
  const submit = { disabled: true };
  const elements: Record<string, object> = {
    'owner-setup-form': form,
    'owner-setup-status': status,
    'owner-setup-capability': input,
    'owner-setup-submit': submit,
  };

  vm.runInNewContext(passwordOwnerSetupClientScript(), {
    URLSearchParams,
    document: { getElementById(id: string) { return elements[id] ?? null; } },
    history: { replaceState() {} },
    location: { hash: '', pathname: '/admin/setup', search: '' },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  });

  assert.equal(form.hidden, true);
  assert.match(status.textContent, /private setup link.*missing or expired/i);
  assert.match(status.textContent, /retry your deployment/i);
  assert.equal(input.value, '');
  assert.equal(submit.disabled, true);
});

test('owner setup gives immediate password-length feedback and blocks short submissions', () => {
  const formListeners: Record<string, (event: { preventDefault(): void }) => void> = {};
  const passwordListeners: Record<string, () => void> = {};
  const passwordError = { hidden: true, textContent: '' };
  const password = {
    value: '',
    customValidity: '',
    focused: false,
    addEventListener(name: string, listener: () => void) { passwordListeners[name] = listener; },
    setCustomValidity(value: string) { this.customValidity = value; },
    setAttribute() {},
    removeAttribute() {},
    focus() { this.focused = true; },
  };
  const form = {
    hidden: true,
    addEventListener(name: string, listener: (event: { preventDefault(): void }) => void) { formListeners[name] = listener; },
    checkValidity() { return password.customValidity === ''; },
    reportValidity() {},
  };
  const elements: Record<string, object> = {
    'owner-setup-form': form,
    'owner-setup-status': { hidden: false, textContent: '' },
    'owner-setup-capability': { value: '' },
    'owner-setup-fallback': { hidden: false },
    'owner-setup-manual-capability': { value: '', addEventListener() {} },
    'owner-setup-manual-continue': { addEventListener() {} },
    'owner-setup-submit': { disabled: true },
    password,
    'password-error': passwordError,
  };
  vm.runInNewContext(passwordOwnerSetupClientScript(), {
    URLSearchParams,
    document: { getElementById(id: string) { return elements[id] ?? null; } },
    history: { replaceState() {} },
    location: { hash: `#setup=${CAPABILITY}`, pathname: '/admin/setup', search: '' },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  });

  password.value = 'short';
  passwordListeners.input?.();
  assert.equal(passwordError.hidden, false);
  assert.match(passwordError.textContent, /3 more characters needed/i);
  let prevented = false;
  formListeners.submit?.({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(password.focused, true);

  password.value = 'long enough';
  passwordListeners.input?.();
  assert.equal(passwordError.hidden, true);
  assert.equal(password.customValidity, '');
});

test('the successful ready page clears the setup capability from same-tab storage', () => {
  const stored = new Map([[STORAGE_KEY, CAPABILITY]]);
  vm.runInNewContext(passwordOwnerSetupClientScript(), {
    URLSearchParams,
    document: { getElementById() { return null; } },
    location: { hash: '', pathname: '/admin/ready', search: '' },
    sessionStorage: {
      getItem(key: string) { return stored.get(key) ?? null; },
      setItem(key: string, value: string) { stored.set(key, value); },
      removeItem(key: string) { stored.delete(key); },
    },
  });
  assert.equal(stored.has(STORAGE_KEY), false);
});
