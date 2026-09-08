import { assertSameInstallation } from './upgrade-installation.mjs';

// A small state machine shared by the CLI and its failure-injection tests.
// Neither a process exit code nor an application version label proves success.
export function recognizeUpgradeState(receipt, initial, current, event) {
  assertSameInstallation(initial, current, { allowVersionChange: true });
  if (current.fingerprint === initial.fingerprint && current.commit === receipt.previous.commit && current.version === receipt.previous.version) return 'previous';
  const recorded = event?.schema === 1 && event.knownVersions?.some((entry) => entry.workerVersion === current.workerVersion && entry.commit === current.commit && entry.version === current.version);
  if (recorded &&
      current.commit === receipt.destination.commit && current.version === receipt.destination.version) return 'destination';
  if (recorded &&
      current.commit === receipt.previous.commit && current.version === receipt.previous.version) return 'recovery';
  throw new Error('An unrelated or unrecorded Worker version is serving. Preserve the receipt and inspect the deployment before continuing.');
}

export async function executePreparedUpgrade({ receipt, initial, direction = receipt.direction ?? 'upgrade', inspect, readEvent, save, deploy, prepare, confirm, recoverDelivery }) {
  if (!['upgrade', 'recover'].includes(direction)) throw new Error('Unknown upgrade direction.');
  const ready = (event, current) => event?.stage === 'ready' && event.workerVersion === current.workerVersion;
  const current = await inspect();
  const event = readEvent();
  const state = recognizeUpgradeState(receipt, initial, current, event);
  if (direction === 'recover' && !['destination', 'recovery'].includes(state)) throw new Error('Recovery requires a recorded upgrade or recovery Worker to be serving.');
  if (direction === 'upgrade' && state === 'recovery') throw new Error('Previous code is serving from recovery. Finish with --recover before starting a new upgrade.');
  if (direction === 'recover' && state === 'recovery' && ready(event, current)) {
    await save({ ...receipt, direction, stage: 'recovered', servingWorkerVersion: current.workerVersion });
    return 'recovered';
  }
  if (direction === 'upgrade' && state === 'destination' && ready(event, current)) {
    await save({ ...receipt, direction, stage: 'succeeded', servingWorkerVersion: current.workerVersion });
    return 'succeeded';
  }
  // A failed readiness check may have uploaded working or broken code. Rebuild
  // and redeploy the same verified source with a fresh readiness proof.
  const source = direction === 'recover' ? receipt.previous : receipt.destination;
  await prepare(source, current);
  if (!(await confirm(source, current, direction))) return 'cancelled';
  let final = await inspect();
  assertSameInstallation(current, final);
  await save({ ...receipt, direction, stage: direction === 'recover' ? 'recovering' : 'deploying' });
  try {
    if (direction === 'recover' && state === 'destination' && receipt.recovery) {
      if (!recoverDelivery) throw new Error('Transport recovery is required before previous code can be deployed.');
      if (!ready(event, current)) {
        // An interrupted upload may never have installed its recovery digest.
        // Repair the same retained candidate before relying on that authority.
        await save({ ...receipt, direction, stage: 'repairing-recovery-authority' });
        await prepare(receipt.destination, final);
        assertSameInstallation(final, await inspect());
        await deploy(receipt.destination, final);
        const repaired = await inspect();
        assertSameInstallation(initial, repaired, { allowVersionChange: true });
        if (recognizeUpgradeState(receipt, initial, repaired, readEvent()) !== 'destination' || !ready(readEvent(), repaired)) {
          throw new Error('Candidate recovery authority readiness was not verified. Previous code was not deployed.');
        }
        final = repaired;
      }
      await save({ ...receipt, direction, stage: 'recovering-delivery' });
      await recoverDelivery(final);
      // The route mutation must not authorize deployment over another operator.
      assertSameInstallation(final, await inspect());
      await save({ ...receipt, direction, stage: 'recovering' });
    }
    await deploy(source, final);
    const serving = await inspect();
    const deployed = readEvent();
    assertSameInstallation(initial, serving, { allowVersionChange: true });
    if (deployed?.schema !== 1 || deployed.stage !== 'ready' || deployed.workerVersion !== serving.workerVersion ||
        serving.commit !== source.commit || serving.version !== source.version) throw new Error('Deployment readiness and serving identity do not agree.');
    const stage = direction === 'recover' ? 'recovered' : 'succeeded';
    await save({ ...receipt, direction, stage, servingWorkerVersion: serving.workerVersion });
    return stage;
  } catch (error) {
    await save({ ...receipt, stage: 'needs-inspection', failure: 'deployment-not-verified', direction });
    throw error;
  }
}

export async function requestDeliveryRecovery({ url, workerVersion, capability, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(new URL('/internal/deployment/recover-delivery', url), {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${capability}`, 'X-Chickpea-Target-Version': workerVersion },
    });
    if (response.status !== 204) throw new Error('Delivery recovery was not verified. Previous code was not deployed; preserve the receipt and retry recovery.');
  } finally { clearTimeout(timeout); }
}
