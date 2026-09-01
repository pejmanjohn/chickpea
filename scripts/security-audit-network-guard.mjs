import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

function normalizedHost(value) {
  if (value === undefined || value === null || value === '') return 'localhost';
  const text = String(value).toLowerCase();
  if (text.startsWith('[')) return text.slice(1, text.indexOf(']'));
  if (net.isIP(text)) return text;
  const colon = text.lastIndexOf(':');
  return colon > -1 && text.indexOf(':') === colon ? text.slice(0, colon) : text;
}

function isLoopback(value) {
  const host = normalizedHost(value);
  return host === 'localhost' || host === '::1' || host === '0.0.0.0' ||
    host === '::' || /^127(?:\.\d{1,3}){3}$/.test(host) ||
    host === '::ffff:127.0.0.1';
}

function targetHost(target, fallback) {
  if (target instanceof URL) return target.hostname;
  if (typeof target === 'string') {
    try {
      return new URL(target).hostname;
    } catch {
      return fallback;
    }
  }
  return target?.hostname ?? target?.host ?? fallback;
}

function blockedError(host) {
  const target = normalizedHost(host);
  const error = new Error(`[audit-network-guard] blocked external connection to ${target}`);
  error.code = 'AUDIT_EXTERNAL_NETWORK_BLOCKED';
  return error;
}

function blocked(host) {
  throw blockedError(host);
}

const originalFetch = globalThis.fetch;
if (originalFetch) {
  globalThis.fetch = function auditGuardedFetch(input, init) {
    const raw = input instanceof Request ? input.url : String(input);
    let url;
    try {
      url = new URL(raw);
    } catch {
      return originalFetch.call(this, input, init);
    }
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !isLoopback(url.hostname)) {
      return Promise.reject(blockedError(url.hostname));
    }
    return originalFetch.call(this, input, init);
  };
}

function guardRequest(module, method) {
  const original = module[method];
  module[method] = function auditGuardedRequest(target, ...args) {
    const options = target && typeof target === 'object' && !(target instanceof URL)
      ? target
      : args.find((arg) => arg && typeof arg === 'object' && !(arg instanceof URL));
    const host = targetHost(target, options?.hostname ?? options?.host);
    if (!isLoopback(host)) blocked(host);
    return original.call(this, target, ...args);
  };
}

guardRequest(http, 'request');
guardRequest(http, 'get');
guardRequest(https, 'request');
guardRequest(https, 'get');

function guardSocket(module, method) {
  const original = module[method];
  module[method] = function auditGuardedSocket(...args) {
    const first = args[0];
    if (typeof first === 'string' && !/^\d+$/.test(first)) {
      return original.apply(this, args);
    }
    const options = first && typeof first === 'object' ? first : undefined;
    const host = options?.host ?? options?.hostname ??
      (typeof args[1] === 'string' ? args[1] : undefined);
    if (!isLoopback(host)) blocked(host);
    return original.apply(this, args);
  };
}

guardSocket(net, 'connect');
guardSocket(net, 'createConnection');
guardSocket(tls, 'connect');
