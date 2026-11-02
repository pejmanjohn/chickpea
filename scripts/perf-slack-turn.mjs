import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, homedir, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  EVENTS_PATH,
  REPO_ROOT,
  assertNodeVersion,
  getFreePort,
  loadFake,
  postSignedEvent,
} from './lib/offline-harness.mjs';
import { classifyCloudflareDeploymentProfile } from './cloudflare-deployment-profile.mjs';
import { mintSetupCapability } from '../src/auth/setup-capability.mjs';

const VISIBLE_METHODS = new Set([
  'agents.sessions.setStatus',
  'assistant.threads.setStatus',
  'reactions.add',
  'chat.startStream',
  'chat.postMessage',
]);
const CLASSIFIER_PROMPT = 'Classify one Slack interaction';
const TS_BASE = 1790000000;
const FINAL_TIMEOUT_MS = 60_000;
const STATE_RPC_SAMPLE_EVERY = 100;
const DEFAULT_RUNS_DIR = join(homedir(), '.chickpea', 'experiments', 'ttr-20261101', 'runs');

function parseFlags(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      turns: { type: 'string', default: '7' },
      'slack-latency-ms': { type: 'string', default: '120' },
      'provider-delay-ms': { type: 'string', default: '1500' },
      'state-rpc-delay-ms': { type: 'string', default: '40' },
      'provider-delay-spread-ms': { type: 'string', default: '750' },
      'thread-replies': { type: 'string', default: '1' },
      'skip-build': { type: 'boolean', default: false },
      out: { type: 'string' },
      'wrangler-log': { type: 'string' },
      label: { type: 'string', default: '' },
    },
  });
  const count = (name, min) => {
    const value = Number(values[name]);
    if (!Number.isInteger(value) || value < min) throw new Error(`--${name} must be an integer >= ${min}`);
    return value;
  };
  const expandHome = (path) => (path?.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
  const wranglerLog = expandHome(values['wrangler-log']);
  return {
    turns: count('turns', 1),
    slackLatencyMs: count('slack-latency-ms', 0),
    providerDelayMs: count('provider-delay-ms', 0),
    stateRpcDelayMs: count('state-rpc-delay-ms', 0),
    providerDelaySpreadMs: count('provider-delay-spread-ms', 0),
    threadReplies: count('thread-replies', 0),
    skipBuild: values['skip-build'],
    out: resolve(expandHome(values.out) ?? join(DEFAULT_RUNS_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)),
    label: values.label,
    wranglerLog: wranglerLog ? resolve(wranglerLog) : undefined,
  };
}

function git(...args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function runtimeRecords(output, event) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const records = [];
  for (const match of text.matchAll(new RegExp(`['"]?event['"]?\\s*:\\s*['"]${event}['"]`, 'g'))) {
    const open = text.lastIndexOf('{', match.index);
    const close = text.indexOf('}', match.index);
    if (open < 0 || close < 0) continue;
    const raw = text.slice(open, close + 1);
    const fields = {};
    const pairs = /['"]?([A-Za-z_]\w*)['"]?\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false)/g;
    for (const [, key, value] of raw.matchAll(pairs)) {
      fields[key] = /^['"]/.test(value) ? value.slice(1, -1) : value === 'true' ? true : value === 'false' ? false : Number(value);
    }
    records.push({ raw, fields });
  }
  return records;
}

function maxIsolateCalls(output) {
  return Math.max(0, ...runtimeRecords(output, 'state_rpc').map(({ fields }) => fields.isolateCalls ?? 0));
}

function finalWireEntry(entries, final) {
  if (!final) return undefined;
  const head = entries[final.index];
  if (head.method !== 'chat.startStream') return head;
  return entries.slice(final.index + 1)
    .find((entry) => entry.method === 'chat.stopStream' && String(entry.body.ts ?? '') === head.responseTs);
}

function wireMetrics(entries, finals, t0) {
  const since = (entry) => (entry ? entry.at - t0 : null);
  const slack = entries.filter((entry) => entry.kind === 'slack');
  const modelCalls = entries.filter((entry) => entry.kind === 'provider' && entry.method === 'chat/completions');
  const finalEntry = finalWireEntry(entries, finals[0]);
  const clear = finalEntry
    ? slack.filter((entry) => entry.at >= finalEntry.at && entry.method === 'assistant.threads.setStatus' &&
      String(entry.body.status ?? '') === '').at(-1)
    : undefined;
  const byMethod = {};
  for (const entry of slack) byMethod[entry.method] = (byMethod[entry.method] ?? 0) + 1;
  const isClassifier = (entry) => JSON.stringify(entry.body).includes(CLASSIFIER_PROMPT);
  return {
    firstVisible: since(slack.find((entry) => VISIBLE_METHODS.has(entry.method))),
    firstVisibleMethod: slack.find((entry) => VISIBLE_METHODS.has(entry.method))?.method ?? null,
    firstModel: since(modelCalls[0]),
    modelCalls: modelCalls.length,
    classifierCalls: modelCalls.filter(isClassifier).length,
    firstText: since(slack.find((entry) => entry.method === 'chat.startStream')),
    final: since(finalEntry),
    finalVia: finalEntry?.method ?? null,
    clear: since(clear),
    slackCalls: slack.length,
    byMethod,
    slackErrors: slack.filter((entry) => entry.ok === false).map((entry) => entry.method),
    finalsCount: finals.length,
    timeline: entries.map((entry) => ({
      method: entry.kind === 'slack' ? entry.method : `model:${isClassifier(entry) ? 'classifier' : entry.method}`,
      at: entry.at - t0,
      ...(entry.respondedAt === undefined ? {} : { respondedAt: entry.respondedAt - t0 }),
    })),
  };
}

function turnLogMetrics(output, logStart) {
  const slice = output.slice(logStart);
  return {
    turnLatency: runtimeRecords(slice, 'turn_latency').map(({ fields }) => ({
      executor: fields.executor,
      outcome: fields.outcome,
      firstWrite: fields.firstWrite,
      admissionToStartMs: fields.admissionToStartMs,
      admissionToFirstWriteMs: fields.admissionToFirstWriteMs,
      admissionToFinalMs: fields.admissionToFinalMs,
      attemptMs: fields.attemptMs,
    })),
    relayAlarms: runtimeRecords(slice, 'relay_alarm').length,
    stateRpc: {
      maxIsolateCallsBefore: maxIsolateCalls(output.slice(0, logStart)),
      maxIsolateCallsAfter: maxIsolateCalls(output),
      slowCalls: runtimeRecords(slice, 'state_rpc').filter(({ fields }) => fields.slow === true).length,
    },
  };
}

function stats(values) {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0, median: null, min: null, max: null };
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  return { n: sorted.length, median, min: sorted[0], max: sorted.at(-1) };
}

function summarize(samples) {
  const summary = {};
  for (const name of ['mention', 'reply']) {
    const group = samples.filter((sample) => sample.case === name);
    if (group.length === 0) continue;
    const methods = {};
    for (const sample of group) {
      for (const [method, count] of Object.entries(sample.byMethod)) methods[method] = (methods[method] ?? 0) + count;
    }
    const rpcDeltas = group.map((sample) => sample.stateRpc.maxIsolateCallsAfter - sample.stateRpc.maxIsolateCallsBefore);
    summary[name] = {
      turns: group.length,
      ...Object.fromEntries(['final', 'firstVisible', 'firstModel', 'firstText', 'ack', 'clear']
        .map((metric) => [metric, stats(group.map((sample) => sample[metric]))])),
      slackCallsMedian: stats(group.map((sample) => sample.slackCalls)).median,
      topMethods: Object.entries(methods).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([method, count]) => ({ method, perTurn: Number((count / group.length).toFixed(2)) })),
      modelCallsMedian: stats(group.map((sample) => sample.modelCalls)).median,
      approxStateRpcsPerTurn: Math.round(rpcDeltas.reduce((sum, delta) => sum + delta, 0) / group.length),
      errors: group.reduce((sum, sample) => sum + sample.errors.length, 0),
      finals: group.reduce((sum, sample) => sum + sample.finalsCount, 0),
    };
  }
  return summary;
}

const cell = (value, width = 6) => String(value ?? '-').padStart(width);

function printTable(samples) {
  const columns = [
    ['case', 8], ['turn', 6], ['ack', 6], ['visible', 8], ['model', 6], ['text', 6], ['final', 6], ['clear', 6],
    ['slack', 6], ['models', 7], ['rpc~', 6], ['finals', 7], ['err', 4], ['tl.start', 9], ['tl.first', 9], ['tl.final', 9],
  ];
  console.log(columns.map(([name, width]) => cell(name, width)).join(' '));
  for (const sample of samples) {
    const latency = sample.turnLatency.find((record) => record.admissionToFinalMs !== undefined) ?? sample.turnLatency[0];
    const row = [
      sample.case, sample.reply === null ? `${sample.turn}` : `${sample.turn}.${sample.reply}`, sample.ack,
      sample.firstVisible, sample.firstModel, sample.firstText, sample.final, sample.clear, sample.slackCalls,
      sample.modelCalls, sample.stateRpc.maxIsolateCallsAfter - sample.stateRpc.maxIsolateCallsBefore,
      sample.finalsCount, sample.errors.length, latency?.admissionToStartMs, latency?.admissionToFirstWriteMs,
      latency?.admissionToFinalMs,
    ];
    console.log(row.map((value, index) => cell(value, columns[index][1])).join(' '));
  }
}

function printSummary(summary) {
  for (const [name, group] of Object.entries(summary)) {
    console.log(`\n${name} (${group.turns} turns), ms from the signed POST: median [min..max]`);
    for (const metric of ['final', 'firstVisible', 'firstModel', 'firstText', 'ack', 'clear']) {
      const { median, min, max, n } = group[metric];
      console.log(`  ${metric.padEnd(13)} ${cell(median)} [${min ?? '-'}..${max ?? '-'}] n=${n}`);
    }
    console.log(`  slack calls median ${group.slackCallsMedian}; model calls median ${group.modelCallsMedian}`);
    console.log(`  top methods per turn: ${group.topMethods.map(({ method, perTurn }) => `${method}=${perTurn}`).join(', ')}`);
    console.log(`  state RPCs per turn ~${group.approxStateRpcsPerTurn} (approximate: 1-in-${STATE_RPC_SAMPLE_EVERY} samples)`);
    console.log(`  errors ${group.errors}; finals ${group.finals}`);
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  assertNodeVersion();
  const smoke = await import('./verify-cf-smoke.mjs');
  const { FakeSlackBackend, STUB_REPLY_MARKER } = await loadFake();
  const backend = new FakeSlackBackend(backendConfig(smoke));
  let wrangler;
  let cleaned;
  const cleanup = () => (cleaned ??= (async () => {
    if (wrangler) await smoke.stopWrangler(wrangler);
    await backend.close();
    rmSync(smoke.PERSIST_DIR, { recursive: true, force: true });
  })());
  process.once('SIGINT', () => {
    console.error('\ninterrupted; stopping wrangler dev');
    void cleanup().finally(() => process.exit(130));
  });

  try {
    if (flags.skipBuild) {
      if (!existsSync(smoke.CF_WRANGLER_CONFIG)) throw new Error('--skip-build needs an existing dist-cf build');
      console.log('• --skip-build: reusing the existing dist-cf build');
    } else {
      smoke.buildCloudflareTarget('core');
    }
    const builtConfig = JSON.parse(readFileSync(smoke.CF_WRANGLER_CONFIG, 'utf8'));
    const head = git('rev-parse', 'HEAD');
    const build = {
      skipped: flags.skipBuild,
      profile: classifyCloudflareDeploymentProfile(builtConfig),
      sourceCommit: builtConfig.vars?.CHICKPEA_SOURCE_COMMIT ?? null,
    };
    if (build.sourceCommit !== head) {
      console.log(`• warning: dist-cf was built from ${build.sourceCommit}, HEAD is ${head}`);
    }

    const setup = await mintSetupCapability();
    smoke.writeSmokeWranglerConfigs(setup);
    smoke.applyLocalAuthMigrations();
    const fake = await backend.listen(await getFreePort());
    smoke.writeDevVars(fake.url);
    if (flags.stateRpcDelayMs > 0) {
      appendFileSync(
        join(REPO_ROOT, 'dist-cf', 'chickpea', '.dev.vars'),
        `CHICKPEA_PERF_STATE_RPC_DELAY_MS=${flags.stateRpcDelayMs}\n`,
      );
    }
    const baseUrl = `http://127.0.0.1:${smoke.PORT}`;
    const eventsUrl = `${baseUrl}${EVENTS_PATH}`;
    wrangler = smoke.spawnWranglerDev();
    if (flags.wranglerLog) {
      mkdirSync(dirname(flags.wranglerLog), { recursive: true });
      const stamp = (chunk) => appendFileSync(
        flags.wranglerLog,
        String(chunk).split('\n').map((line) => `[${Date.now()}] ${line}`).join('\n') + '\n',
      );
      wrangler.child.stdout.on('data', stamp);
      wrangler.child.stderr.on('data', stamp);
    }
    console.log('• waiting for wrangler dev…');
    await smoke.waitForSetupReady(wrangler, baseUrl);
    await smoke.completeSlackNativeSetup(baseUrl, eventsUrl, setup, backend);
    if (smoke.failures.length > 0) throw new Error(`Slack-native setup failed: ${smoke.failures.join('; ')}`);

    const agentId = await publishLocalStubAgent(smoke, baseUrl);
    backend.configure({
      slack: { latencyMs: flags.slackLatencyMs },
      provider: { delayMs: flags.providerDelayMs, delaySpreadMs: flags.providerDelaySpreadMs },
    });
    await backend.quiesce(1500, 30_000);
    const setupTraffic = [...new Set(backend.wireLog.map((entry) => entry.method))];
    console.log(`• ${agentId} on local-stub/smoke-model; setup traffic settled (${backend.wireLog.length} calls)`);

    const runOutputStart = wrangler.getOutput().length;
    const measure = async ({ caseName, turn, reply, payload, threadTs }) => {
      if (wrangler.child.exitCode !== null) throw new Error(`wrangler dev exited (${wrangler.child.exitCode})`);
      backend.reset();
      const logStart = wrangler.getOutput().length;
      const t0 = Date.now();
      const admission = await postSignedEvent(eventsUrl, payload);
      const ack = Date.now() - t0;
      await smoke.waitForFinalCount(backend, 1, FINAL_TIMEOUT_MS);
      await backend.quiesce(400, 8000);
      const entries = [...backend.wireLog];
      const finals = backend.finals();
      const metrics = wireMetrics(entries, finals, t0);
      const errors = [
        ...(admission.status === 200 || admission.status === 202 ? [] : [`ack HTTP ${admission.status}`]),
        ...(finals.length === 1 ? [] : [`${finals.length} finals`]),
        ...(finals.length > 0 && (finals[0].channel !== smoke.CHANNEL || finals[0].threadTs !== threadTs)
          ? [`final landed in ${finals[0].channel}/${finals[0].threadTs}`] : []),
        ...(finals.length > 0 && !finals[0].text.includes(STUB_REPLY_MARKER) ? ['final lacks the stub reply'] : []),
        ...metrics.slackErrors.map((method) => `slack ${method} ok:false`),
      ];
      return {
        case: caseName,
        turn,
        reply,
        eventId: payload.event_id,
        ts: payload.event.ts,
        ack,
        ...metrics,
        ...turnLogMetrics(wrangler.getOutput(), logStart),
        errors,
      };
    };

    const samples = [];
    for (let turn = 0; turn < flags.turns; turn += 1) {
      const threadTs = `${TS_BASE + turn * 100}.000100`;
      const mention = smoke.mentionEvent(`Ev_PERF_${turn}_MENTION`);
      samples.push(await measure({
        caseName: 'mention',
        turn,
        reply: null,
        threadTs,
        payload: {
          ...mention,
          event_time: TS_BASE + turn * 100,
          event: {
            ...mention.event,
            text: `${smoke.defaultAgentMention} what is the capital of France?`,
            ts: threadTs,
            event_ts: threadTs,
          },
        },
      }));
      for (let reply = 0; reply < flags.threadReplies; reply += 1) {
        const ts = `${TS_BASE + turn * 100 + reply + 1}.000100`;
        const template = smoke.threadReplyEvent();
        samples.push(await measure({
          caseName: 'reply',
          turn,
          reply,
          threadTs,
          payload: {
            ...template,
            event_id: `Ev_PERF_${turn}_REPLY_${reply}`,
            event_time: TS_BASE + turn * 100 + reply + 1,
            event: {
              ...template.event,
              text: `${smoke.defaultAgentMention} and its population?`,
              ts,
              event_ts: ts,
              thread_ts: threadTs,
            },
          },
        }));
      }
    }

    const runOutput = wrangler.getOutput().slice(runOutputStart);
    const requested = flags.turns * (1 + flags.threadReplies);
    const completed = samples.filter((sample) => sample.finalsCount === 1 && sample.errors.length === 0).length;
    const errors = samples.reduce((sum, sample) => sum + sample.errors.length, 0);
    const rpcSpan = maxIsolateCalls(wrangler.getOutput()) - maxIsolateCalls(wrangler.getOutput().slice(0, runOutputStart));
    const summary = summarize(samples);
    const report = {
      schema: 'chickpea-perf-slack-turn/v1',
      label: flags.label,
      finishedAt: new Date().toISOString(),
      git: { head, dirty: git('status', '--porcelain').length > 0 },
      build,
      flags,
      host: { node: process.version, platform: process.platform, cpus: cpus().length, loadavg: loadavg() },
      setupTraffic,
      summary,
      stateRpc: {
        approxPerTurn: Math.round(rpcSpan / samples.length),
        note: `max isolateCalls across the measured turns divided by turns; state_rpc logs 1 call in ${STATE_RPC_SAMPLE_EVERY}, so each turn's delta is +-${STATE_RPC_SAMPLE_EVERY}`,
      },
      rawSamples: {
        turnLatency: runtimeRecords(runOutput, 'turn_latency')[0]?.raw ?? null,
        stateRpc: runtimeRecords(runOutput, 'state_rpc')[0]?.raw ?? null,
        relayAlarm: runtimeRecords(runOutput, 'relay_alarm')[0]?.raw ?? null,
      },
      turns: samples,
      errors,
      work: { completed, requested },
    };
    mkdirSync(dirname(flags.out), { recursive: true });
    writeFileSync(flags.out, `${JSON.stringify(report, null, 2)}\n`);

    console.log(`\nslack latency ${flags.slackLatencyMs} ms, provider delay ${flags.providerDelayMs}±${Math.floor(flags.providerDelaySpreadMs / 2)} ms, state rpc delay ${flags.stateRpcDelayMs} ms, build ${build.profile}@${build.sourceCommit}`);
    printTable(samples);
    printSummary(summary);
    console.log(`\nstate RPCs per turn ~${report.stateRpc.approxPerTurn} (${report.stateRpc.note})`);
    for (const [name, raw] of Object.entries(report.rawSamples)) console.log(`raw ${name}: ${raw ?? 'none seen'}`);
    for (const sample of samples.filter((entry) => entry.errors.length > 0)) {
      console.log(`errors in ${sample.case} ${sample.turn}${sample.reply === null ? '' : `.${sample.reply}`}: ${sample.errors.join('; ')}`);
    }
    console.log(`report ${flags.out}`);
    console.log(`errors=${errors} work=${completed}/${requested}`);
    if (samples.some((sample) => sample.finalsCount !== 1)) process.exitCode = 1;
  } catch (error) {
    console.error(`\nFAIL perf-slack-turn: ${error instanceof Error ? error.message : String(error)}`);
    if (wrangler) console.error(`\n--- wrangler dev output (tail) ---\n${wrangler.getOutput().split('\n').slice(-60).join('\n')}`);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

function backendConfig(smoke) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    slack: {
      identity: { appId: smoke.APP_ID, botUserId: smoke.BOT_USER_ID, teamId: smoke.WORKSPACE, teamName: 'Perf Workspace' },
      oauth: {
        appId: smoke.APP_ID,
        clientId: smoke.OAUTH_CLIENT_ID,
        clientSecret: smoke.OAUTH_CLIENT_SECRET,
        configurationToken: smoke.OAUTH_CONFIGURATION_TOKEN,
        signingSecret: smoke.SIGNING_SECRET,
        botToken: smoke.OAUTH_BOT_TOKEN,
        installerUserId: smoke.OWNER_USER_ID,
        privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
        publicJwk: { ...publicKey.export({ format: 'jwk' }), kid: 'perf-rs256', alg: 'RS256', use: 'sig' },
      },
      channels: [{ id: smoke.CHANNEL, name: 'perf-mentions', isMember: true, teamId: smoke.WORKSPACE }],
      channelMembers: { [smoke.CHANNEL]: [smoke.OWNER_USER_ID, smoke.BOT_USER_ID] },
      workspaceUsers: [
        { id: smoke.OWNER_USER_ID, teamId: smoke.WORKSPACE },
        { id: smoke.BOT_USER_ID, teamId: smoke.WORKSPACE, isBot: true, isAppUser: true },
      ],
      directMessages: { [smoke.OWNER_USER_ID]: smoke.ONBOARDING_DM_CHANNEL },
    },
  };
}

async function publishLocalStubAgent(smoke, baseUrl) {
  const expect = (result, status, what) => {
    if (result.status !== status) throw new Error(`${what} failed (HTTP ${result.status} ${JSON.stringify(result.body)})`);
    return result.body;
  };
  expect(await smoke.adminFetch(baseUrl, '/admin/api/model-catalog/mode', {
    method: 'PUT',
    body: JSON.stringify({ mode: 'bundled' }),
  }), 200, 'pinning the bundled model catalog');
  const created = expect(await smoke.adminFetch(baseUrl, '/admin/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      id: 'agent_default',
      name: 'Perf',
      instructions: 'Answer briefly.',
      enabled: true,
      model: 'cloudflare/@cf/zai-org/glm-4.7-flash',
    }),
  }), 201, 'creating the Agent');
  const granted = expect(await smoke.adminFetch(baseUrl, '/admin/api/agents/agent_default/channels', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: smoke.WORKSPACE, channelId: smoke.CHANNEL }),
  }), 201, 'granting the channel');
  const userGroupId = granted?.agent?.slackPresence?.userGroupId;
  if (typeof userGroupId !== 'string' || !/^S[A-Z0-9]+$/.test(userGroupId)) {
    throw new Error('the published Agent has no Slack handle');
  }
  smoke.setDefaultAgentMention(`<!subteam^${userGroupId}>`);
  expect(await smoke.adminFetch(baseUrl, '/admin/api/agents/agent_default', {
    method: 'PATCH',
    body: JSON.stringify({
      expectedRevision: granted.agent.revision ?? created.agent.revision,
      model: 'local-stub/smoke-model',
    }),
  }), 200, 'pinning the local stub model');
  return created.agent.id;
}

await main();
