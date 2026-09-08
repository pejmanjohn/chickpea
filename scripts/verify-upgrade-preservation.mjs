#!/usr/bin/env node
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { outsideGit } from './lib/private-evidence.mjs';
import { assertPrivatePath, readPrivateJson } from './lib/upgrade-receipt.mjs';
import { deploymentFingerprint } from './lib/inspect-deployment.mjs';
import { inventoryDigest, validateInstallation, validateTarget } from './lib/upgrade-installation.mjs';

const SERVICE_FIELDS = ['routes', 'crons', 'observability', 'logpush', 'tailConsumers', 'workersDev'];
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function capture(value) {
  if (value?.schema !== 1 || !timestamp(value.observedAt)) throw new Error('A dated schema-1 capture is required.');
  const target = validateTarget(value.target);
  if (!target.url) throw new Error('Capture must identify the existing HTTPS installation origin.');
  const raw = value.installation;
  if (!Array.isArray(raw?.versions) || raw.versions.some((entry) => !UUID.test(entry?.version_id ?? '')) ||
      !Array.isArray(raw.bindings) || raw.bindings.some((binding) => binding?.type === 'secret_text' &&
        Object.keys(binding).some((key) => !['name', 'type'].includes(key)))) {
    throw new Error('Capture requires exact Worker version IDs and secret names only.');
  }
  if (raw.fingerprint !== deploymentFingerprint(raw.versions)) throw new Error('Serving fingerprint disagrees with captured versions.');
  const installation = validateInstallation(raw);
  const versionSecretNames = raw.bindings.filter((binding) => binding.type === 'secret_text').map((binding) => binding.name).sort();
  if (inventoryDigest(installation.secretNames) !== inventoryDigest(versionSecretNames)) throw new Error('Secret names must describe the captured serving version.');
  const service = value.serviceConfiguration;
  if (service?.source !== 'cloudflare-api' || !timestamp(service.observedAt) || !object(service.values) ||
      Object.keys(service.values).length !== SERVICE_FIELDS.length || SERVICE_FIELDS.some((field) => !Object.hasOwn(service.values, field)) ||
      !Array.isArray(service.values.routes) || !Array.isArray(service.values.crons) || !Array.isArray(service.values.tailConsumers) ||
      !(service.values.observability === null || object(service.values.observability)) ||
      typeof service.values.logpush !== 'boolean' || !object(service.values.workersDev) ||
      typeof service.values.workersDev.enabled !== 'boolean' || typeof service.values.workersDev.previews_enabled !== 'boolean') {
    throw new Error('Complete, dated Cloudflare service configuration capture is required; missing fields cannot be inferred.');
  }
  return { target, observedAt: value.observedAt, installation, service: service.values };
}

/** Compares supplied evidence only; never captures, deploys, or certifies live behavior. */
export function compareUpgradePreservation(beforeValue, afterValue) {
  const before = capture(beforeValue), after = capture(afterValue);
  if (inventoryDigest(before.target) !== inventoryDigest(after.target)) throw new Error('Before and after captures identify different installations.');
  if (Date.parse(after.observedAt) < Date.parse(before.observedAt)) throw new Error('After capture predates before capture.');
  const differences = [];
  for (const field of ['resources', 'variables', 'secretNames']) {
    if (inventoryDigest(before.installation[field]) !== inventoryDigest(after.installation[field])) differences.push(field);
  }
  for (const field of SERVICE_FIELDS) {
    if (inventoryDigest(before.service[field]) !== inventoryDigest(after.service[field])) differences.push(`serviceConfiguration.${field}`);
  }
  const summary = ({ installation, service }) => ({
    version: installation.version, sourceCommit: installation.commit, workerVersion: installation.workerVersion,
    servingFingerprint: installation.fingerprint, resourceDigest: installation.resourceDigest,
    serviceDigest: inventoryDigest(service),
  });
  return { schema: 1, status: differences.length ? 'changed' : 'preserved', differences,
    targetDigest: inventoryDigest(before.target), before: summary(before), after: summary(after) };
}

export function verifyUpgradePreservationFiles({ before, after, output }) {
  for (const file of [before, after, output]) outsideGit(file);
  assertPrivatePath(path.dirname(output), { directory: true });
  const report = compareUpgradePreservation(readPrivateJson(before), readPrivateJson(after));
  const fd = openSync(output, 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    if (args.length !== 6) throw new Error('Usage: node scripts/verify-upgrade-preservation.mjs --before ABS.json --after ABS.json --output ABS.json');
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index].slice(2);
      if (!['--before', '--after', '--output'].includes(args[index]) || Object.hasOwn(options, name)) throw new Error('Use each preservation argument exactly once.');
      options[name] = args[index + 1];
    }
    const report = verifyUpgradePreservationFiles(options);
    console.log(JSON.stringify(report));
    process.exitCode = report.status === 'preserved' ? 0 : 1;
  } catch (error) {
    console.error(error?.code === 'EEXIST' ? 'Output already exists; preserve it and select a new file.' : 'Preservation check refused: ' + error.message);
    process.exitCode = 2;
  }
}
