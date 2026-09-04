#!/usr/bin/env node
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  lstatSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, extname, join, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'chickpea-export-'));
const offlineVerificationEnv = {
  ...process.env,
  // This verifier proves the exported package works without external traffic.
  // Exercise the same public opt-out contract users can select at runtime.
  DO_NOT_TRACK: '1',
};

const term = (...parts) => parts.join('');
const exportPath = (...parts) => posix.join(...parts);
const localUserPathPattern = new RegExp(
  term(
    '(?<![-A-Za-z0-9._/])',
    '\\/',
    'users',
    '\\/',
    '(?!me(?:\\/|$))',
    '[^\\/\\s]+',
    '\\/',
  ),
  'i',
);

const denyPatterns = [
  ['private source project', new RegExp(term('ski', 'llet'), 'i')],
  ['deleted source path', new RegExp(term('docs', '\\/', 'sou', 'rce'), 'i')],
  ['internal product name', new RegExp(term('claude', '[- ]?', 'tag'), 'i')],
  ['private workspace name', new RegExp(term('paper', 'plane'), 'i')],
  ['private company name', new RegExp(term('mag', 'oosh'), 'i')],
  ['private channel name', new RegExp(term('all-', 'paper', 'plane-', 'labs'), 'i')],
  // Require both a home-directory owner and a following path segment. This
  // catches case-insensitive macOS paths while allowing `/users/...` API route
  // segments whose preceding character is part of a URL path.
  ['local user path', localUserPathPattern],
];

const liveVerifierDenyPatterns = [
  ['Slack token', /xox(?:b|p|a|r|s)-[A-Za-z0-9-]{12,}/i],
  ['provider API key', /\bsk-[A-Za-z0-9_-]{16,}\b/],
  ['Slack coordinate', /"(?:workspaceId|teamId|appId|channelId|userId)"\s*:\s*"[A-Z][A-Z0-9]{8,}"/],
];

// `canary` is public rollout vocabulary used by the ledger authority contract,
// so it cannot also serve as a generic private rehearsal marker.

for (const value of [
  term('/', 'Users', '/', 'alice', '/', 'code/project'),
  term('/', 'users', '/', 'bob', '/', '.codex/state'),
]) {
  if (!localUserPathPattern.test(value)) {
    throw new Error(`Local user path deny fixture did not match: ${value}`);
  }
}
for (const value of [
  term('/api/1.0/', 'users', '/', 'me'),
  term('/api/v2/', 'users', '/', 'me.json'),
  term('https://gmail.googleapis.com/gmail/v1/', 'users', '/', 'me/messages'),
  term('/', 'users', '/', 'me', '/messages/send'),
]) {
  if (localUserPathPattern.test(value)) {
    throw new Error(`API route allow fixture matched local user path pattern: ${value}`);
  }
}

// These paths are local agent/tool state or internal working material, not
// public source. `.github/` and `design/` are deliberately absent: both are
// tracked parts of the public repository even though npm does not package them.
const forbiddenSourcePathRoots = [
  exportPath('.agents'),
  exportPath('.claude'),
  exportPath('.codex'),
  exportPath('.gstack'),
  exportPath('.superpowers'),
  exportPath('evidence'),
  exportPath('screenshots'),
  exportPath('transcripts'),
  exportPath('tmp'),
];

const allowedAgentSkillPaths = new Set([
  exportPath('.agents', 'skills', 'chickpea-live-verification', 'SKILL.md'),
]);

const liveVerifierExportPolicy = Object.freeze({
  requiredPaths: new Set([
    exportPath('.agents', 'skills', 'chickpea-live-verification', 'SKILL.md'),
    exportPath('AGENTS.md'),
    exportPath('docs', 'runbooks', 'live-contract-verification.md'),
    exportPath('docs', 'runbooks', 'live-contract-acceptance-v1.md'),
    exportPath('qa', 'live', 'README.md'),
    exportPath('qa', 'live', 'attestation.ts'),
    exportPath('qa', 'live', 'cases', '_shared.ts'),
    exportPath('qa', 'live', 'cases', 'agent-lifecycle.live.ts'),
    exportPath('qa', 'live', 'cases', 'agent-memory.live.ts'),
    exportPath('qa', 'live', 'cases', 'avatar-parity.live.ts'),
    exportPath('qa', 'live', 'cases', 'channel-schedule.live.ts'),
    exportPath('qa', 'live', 'cases', 'connector-ownership-revocation.live.ts'),
    exportPath('qa', 'live', 'cases', 'connector-setup.live.ts'),
    exportPath('qa', 'live', 'cases', 'dm-schedule-privacy.live.ts'),
    exportPath('qa', 'live', 'cases', 'index.ts'),
    exportPath('qa', 'live', 'cases', 'installation-app-home-auth.live.ts'),
    exportPath('qa', 'live', 'cases', 'skill-management.live.ts'),
    exportPath('qa', 'live', 'cases', 'slack-routing.live.ts'),
    exportPath('qa', 'live', 'cli.ts'),
    exportPath('qa', 'live', 'compiler.ts'),
    exportPath('qa', 'live', 'computer-use.ts'),
    exportPath('qa', 'live', 'coordinator.ts'),
    exportPath('qa', 'live', 'doctor.ts'),
    exportPath('qa', 'live', 'drivers', 'operator.ts'),
    exportPath('qa', 'live', 'fixtures', 'skills', 'qa-style-guard', 'SKILL.md'),
    exportPath('qa', 'live', 'generated', 'feature-map.md'),
    exportPath('qa', 'live', 'lessons', 'agent-and-routing.md'),
    exportPath('qa', 'live', 'lessons', 'connectors.md'),
    exportPath('qa', 'live', 'lessons', 'installation-and-auth.md'),
    exportPath('qa', 'live', 'lessons', 'scenario-index.md'),
    exportPath('qa', 'live', 'lessons', 'schedules.md'),
    exportPath('qa', 'live', 'lessons', 'skills-and-memory.md'),
    exportPath('qa', 'live', 'manifest.ts'),
    exportPath('qa', 'live', 'observers', 'capabilities.ts'),
    exportPath('qa', 'live', 'observers', 'chickpea.ts'),
    exportPath('qa', 'live', 'observers', 'cloudflare.ts'),
    exportPath('qa', 'live', 'observers', 'provider.ts'),
    exportPath('qa', 'live', 'observers', 'slack.ts'),
    exportPath('qa', 'live', 'operator', 'SKILL.md'),
    exportPath('qa', 'live', 'privacy.ts'),
    exportPath('qa', 'live', 'private-config.ts'),
    exportPath('qa', 'live', 'public-sources.ts'),
    exportPath('qa', 'live', 'report.ts'),
    exportPath('qa', 'live', 'runner.ts'),
    exportPath('qa', 'live', 'safety', 'cleanup.ts'),
    exportPath('qa', 'live', 'safety', 'errors.ts'),
    exportPath('qa', 'live', 'safety', 'evidence.ts'),
    exportPath('qa', 'live', 'safety', 'journal.ts'),
    exportPath('qa', 'live', 'safety', 'lock.ts'),
    exportPath('qa', 'live', 'safety', 'ui-mutex.ts'),
    exportPath('qa', 'live', 'schema.ts'),
    exportPath('qa', 'live', 'state.ts'),
    exportPath('qa', 'live', 'suites.ts'),
    exportPath('qa', 'live', 'target.example.json'),
  ]),
});

const forbiddenLiveVerifierArtifactPaths = [
  /^qa\/live\/(?:artifacts|evidence|private|resolved|runs|screenshots|transcripts)(?:\/|$)/i,
  /^qa\/live\/.*(?:\.journal\.jsonl|\.snapshot\.json|\.target\.json|\.transcript\.txt)$/i,
  /(?:^|\/)(?:doctor-snapshot|private-target|resolved-target|run-journal|target-overlay)(?:[./-]|$)/i,
];

const allowedPublicDocs = new Set([
  exportPath('docs', 'authentication.md'),
  exportPath('docs', 'shared-gateway-data-handling.md'),
  exportPath('docs', 'design', 'agent-first-admin-prototype', 'design-qa.md'),
  exportPath('docs', 'design', 'agent-first-admin-prototype', 'production-fidelity-qa.md'),
  exportPath('docs', 'design', 'agent-first-admin-prototype', 'src', 'app.jsx'),
  exportPath('docs', 'design', 'agent-first-admin-prototype', 'src', 'assets', 'chickpea-mark.svg'),
  exportPath('docs', 'design', 'agent-first-admin-prototype', 'src', 'styles.css'),
  exportPath('docs', 'plans', '2026-07-28-001-feat-openai-subscription-auth-plan.md'),
  exportPath('docs', 'plans', '2026-08-19-2302-feat-agent-first-slack-platform-plan.md'),
  exportPath('docs', 'reference', 'scheduled-routines.md'),
  exportPath('docs', 'runbooks', 'agent-authoring-evaluation.md'),
  exportPath('docs', 'runbooks', 'auth-db-deployment.md'),
  exportPath('docs', 'runbooks', 'operations.md'),
  exportPath('docs', 'runbooks', 'releasing.md'),
  exportPath('docs', 'runbooks', 'agent-first-acceptance-2026-08-21.md'),
  exportPath('docs', 'runbooks', 'agent-private-use-acceptance-2026-08-27.md'),
  exportPath('docs', 'runbooks', 'coding-sandbox-deployment.md'),
  exportPath('docs', 'runbooks', 'composio-managed-connectors.md'),
  exportPath('docs', 'runbooks', 'product-telemetry.md'),
  exportPath('docs', 'runbooks', 'parallel-live-test-environments.md'),
  exportPath('docs', 'runbooks', 'live-contract-acceptance-v1.md'),
  exportPath('docs', 'runbooks', 'live-contract-verification.md'),
  exportPath('docs', 'runbooks', 'memory-schedules-acceptance.md'),
  exportPath('docs', 'runbooks', 'slack-auth-recovery.md'),
  exportPath('docs', 'runbooks', 'agent-runtime-rollout.md'),
  exportPath('docs', 'runbooks', 'chickpea-system-agent-cutover.md'),
  exportPath('docs', 'runbooks', 'memory-schedules-acceptance.md'),
  exportPath('docs', 'runbooks', 'openai-subscription.md'),
  exportPath('docs', 'runbooks', 'semantic-activity-status.md'),
  exportPath('docs', 'runbooks', 'slack-interaction-operations.md'),
  exportPath('docs', 'runbooks', 'semantic-activity-status.md'),
  exportPath('docs', 'runbooks', 'workspace-management-mcp.md'),
]);

const forbiddenSourcePaths = new Set([
  exportPath('.worktreeinclude'),
  exportPath('design-qa.md'),
]);

const forbiddenBinaryExtensions = new Set([
  '.avif',
  '.gif',
  '.heic',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp4',
  '.pdf',
  '.png',
  '.webp',
]);

const allowedBinaryFiles = new Map([
  [exportPath('assets', 'onboarding', 'ready.webp'), '8e3f24211d5a790cdcd13226fe93689e0a15a286e49d0130d5e4ab4e9aa25601'],
  [exportPath('assets', 'onboarding', 'allow.webp'), '0af3c02803cf862412ac528e0d5ec8d2316b2b48b8ef05014d5474e6b6efa031'],
  [exportPath('assets', 'onboarding', 'bot-token.webp'), 'f17555dcb503bfe75ef50657c106f498950e47a0c374bdaa02d3e6ec099e3e83'],
  [exportPath('assets', 'onboarding', 'create-review.webp'), '2a1f04a89c10933a30555787926cdb7e0407dd77ecc5a630d3f3e6e828f32f78'],
  [exportPath('assets', 'onboarding', 'create-workspace.webp'), '5e02d8aaf0e3727b07e88f4be409ef04b0139ba8796394ce1d075d05349776bd'],
  [exportPath('assets', 'onboarding', 'events.webp'), '3d277865452406913f4ce77cd0dbf40d5218c2d93cfe194d0cb69458a1722986'],
  [exportPath('assets', 'onboarding', 'reinstall.webp'), '25e05848d4c6c284435d225dc9a6424d460bf3c4c210cb292dcda3a5b6d04ad2'],
  [exportPath('assets', 'onboarding', 'signing-secret.webp'), 'f1b05edc9b64c2b598f6ac6b5da26c6d831c77c7434eebacf3589ca777103346'],
  [exportPath('assets', 'onboarding', 'events-retry.webp'), '9a2549d158fba8f6edc9bbee0199585370eeeee8d9a8bfd1b18415ac1a489f8f'],
  [exportPath('assets', 'connectors', 'exa.png'), '277c9f6801afffd060b6891522b7a75062e7da677e439ea1bb7c2e697b35d770'],
  [exportPath('assets', 'connectors', 'fireflies.png'), 'de55a51173478c6412190b6af4867a7e2134a961aa423b569421f33674b714ac'],
  [exportPath('assets', 'connectors', 'gamma.png'), '535376ea3fb0ad62fdb1b6b1c8e0bb3eb51768e988972f8cd8c4455f98af437c'],
  [exportPath('assets', 'connectors', 'granola.png'), 'b33d9874ca62fb40a5070213b6dbd69333a74a8f1b78ffd86093770b468b2b6c'],
  [exportPath('assets', 'connectors', 'incident-io.png'), '900cf222c3221911a4d11397835fd1b262aa37fe62d50a692b2e4f2709621785'],
  [exportPath('assets', 'connectors', 'lunarcrush.png'), '5f68f28ef02527d4918b87efe4076e2725f7363292060a45d225768561e2d482'],
  [exportPath('assets', 'connectors', 'google-search-console.png'), '97db2ff60097307843a6f9bfc5b936735873d3cde4262cb0283f327d3040fa46'],
  [exportPath('assets', 'connectors', 'google-analytics.png'), '424f3b1b23f36f435f3382363bf6482bfb63d3ce36a4e7ac0536b8698453502f'],
  [exportPath('assets', 'connectors', 'google-ads.png'), '5b26cc372386e3fd3cde4fd27e7edbb8d1ef53631456f27f6607880c41110e35'],
  [
    exportPath('assets', 'chickpea-mark.png'),
    '84864d6d3323f7d9d5491a139c0e9e0b0d92b1e076c742d5f4d50e75148b65fb',
  ],
  [
    exportPath('assets', 'chickpea-mark-128.png'),
    'bf7cc48a855350e04559c13ec5736f7ca8eceff6ae4d562ee86009540413924e',
  ],
  [
    exportPath('assets', 'chickpea-favicon-32.png'),
    '201aece87c3bfeb89cb98b61d22a5593b0b862076683d5cd177a7d129c374bb9',
  ],
  [
    exportPath('assets', 'chickpea-wordmark-mask.png'),
    '28bcd4897b6a7dc9513024c206648e21618c0d4a1adaa6608cfca24678e23dbb',
  ],
  [
    exportPath('assets', 'chickpea-wordmark-512.png'),
    'f29e8f737ea742dc0cdf3410f8d59a2159c802abd98bc0d82693ac3a694b1799',
  ],
  [
    exportPath('assets', 'chickpea-wordmark-512-dark.png'),
    '04d4e57a100b3c3eee5215a20de4b74a239df1dd09a8cfe6213b9b9d01a9b22d',
  ],
  [
    exportPath('assets', 'bot-avatar.png'),
    '7f0be0ca98c55c387533ac9d72a6e54382d683c4f9a5d015dbcf3eb0367f83e4',
  ],
  [
    exportPath('assets', 'chickpea-avatars', 'install-default.png'),
    '7f0be0ca98c55c387533ac9d72a6e54382d683c4f9a5d015dbcf3eb0367f83e4',
  ],
  [
    exportPath('assets', 'chickpea-avatars', 'agent-defaults', '01-sage.png'),
    'e2bb3da74917a7aa0be107eb91e6b3f5e863ecfcd9920c27f965a01eebfb5c66',
  ],
  [
    exportPath('assets', 'chickpea-avatars', 'agent-defaults', '02-coral.png'),
    '4a996c1a4c78ebe9f414b9c847ce9a028109bde2f9aba1f749cac66bed61d766',
  ],
  [
    exportPath('assets', 'chickpea-avatars', 'agent-defaults', '03-lilac.png'),
    'c977611ef6e7a938ae1fa63b80b65e72584e3ee74026de55123bb7f55dfa4ec8',
  ],
  [
    exportPath('assets', 'chickpea-avatars', 'agent-defaults', '04-mineral-blue.png'),
    '0150c6d49c9eae7f6eefa8f51507483b351cdfc1d7f6b8118f9111837dab629c',
  ],
  [
    exportPath('assets', 'chickpea-avatars', 'agent-defaults', '05-dusty-rose.png'),
    '71717ab350d142638a9c151fc93166f1033824241f22e57b4246fc16e28e9445',
  ],
  [
    exportPath('assets', 'chickpea-avatars', 'agent-defaults', '06-deep-moss.png'),
    '01d43684babfe9cc2f4a990508fe8d22d00f4fd2e122ae4297131fc1b3bbefa0',
  ],
  [
    exportPath('assets', 'chickpea-avatars', 'agent-defaults', '07-periwinkle.png'),
    '4e9d520f7886e67466c58691f10a8a9fd52cffb25d7bd41010e713c1cde2847b',
  ],
  [
    exportPath('assets', 'chickpea-avatars', 'agent-defaults', '08-seafoam.png'),
    '42400866e0298fbc469e34cb040d98a09c8c76800c2d64d13fc6d36bfe2785df',
  ],
  [
    exportPath('assets', 'chickpea-avatars', 'agent-defaults', '09-warm-oat.png'),
    '46fe38c615dc330eac3a949af2ba205e4140e431a690c35508be730cb5e3ca53',
  ],
  [
    exportPath('assets', 'chickpea-avatars', 'agent-defaults', '10-midnight-indigo.png'),
    '4147759426f1fb1bd70966116fc1372bf25b767cf0cd2f87050dca998a152391',
  ],
  [
    exportPath('assets', 'chickpea-avatars', 'agent-defaults', '11-apricot.png'),
    '6896865cf64e7ec2db2da30beec3aae37b4384df937e3960c4347fc77d724fcc',
  ],
  [
    exportPath('assets', 'chickpea-avatars', 'agent-defaults', '12-muted-berry.png'),
    '04653890b4cf6ffed29cec436ee32733dc014d87f0601988ef602b957d145b8c',
  ],
  [
    exportPath('assets', 'admin-agent.png'),
    'f8a4c44962a044fb8caea27aa24e55f74ba60e47994bab8db3ada886a2428e16',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-agent-first-channel.png'),
    '19f8f0824462b9c564904436894b601c78784356773333141b0eb3ceacec079d',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-agent-first-comparison.png'),
    'ec8b9087540753cbca840527a174f9b439e44d6b8b80abd120dcdf89e66f01f1',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-agent-first-memory.png'),
    'dbf5740d62cc52b0ba2766afe633c0cac34fe206d6e1fa9abe44724e0a958e1d',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-agent-memory-files.png'),
    'e33cc0a7755986711421cbd03cef39f033c6719d5ce0a2ed4058ed1f0b88112d',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-channel-always-on-capabilities.png'),
    'b2f884b47867cd9feb01fdb96ce97e5f65e2da596346c2c025a933b82b99361b',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-channel-annotated.png'),
    '49a257c9b7f8864a640a80ac75acd64f37b4c12cf905446ff1ee86e2d670573a',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-channel.png'),
    '9c76d9c17862dad9b7c5a8c024529396d7bad6e5860ce815105b1198f41effd6',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-channels-index.png'),
    '1b693a6819588b11b01d1bcf134622bef766f5392849eb6ad9f44911ca47f3e6',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-comparison.png'),
    '07a93bd6065a419a073d280bd50c6aa252e5068002c7b26a3cb58e137f58aac7',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-profile-rows.png'),
    '3b7e1988271ba9d16ca7c329bd50572745b50bcb45082797fc23126893c9101d',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-profile-tabs-annotated.png'),
    '870c869362645b1600c767052e529c5bae058cc15471cda00373a79b51b8ed63',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-profile-tabs.png'),
    '347a7c4fcca8d82640c0524c4dfc10b550c22f8560e8d294257c0a78f0247f5e',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-production-agent-instructions.png'),
    '9f742e1a293e6b585a4b811e94c96f17e7e2bdd22fe2639612c096f8d8ba5347',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-production-agent-memory.png'),
    '10b5d06bdbcf074b24cf71ac4409eed28d813580ca4008876d6149249f82b18c',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-production-channel-advanced-diagnostics.png'),
    '675d363689f99bb6426ef3aa5219fa03e613e9760fae65929916fcebfc61ec36',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-production-channel-advanced.png'),
    'bb178b61b20cef765ac7c97cfe1b414bc997bb42a8d6cfe71e3c0f6fe4fa06d1',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-production-channel-detail.png'),
    'd4a8aa09081c309f5c3157c57097c89f34a882c84f2a8c3925d37fb4102c66a1',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-production-channels-index.png'),
    'ca22e88250ca6d2d54358dbd241fef2f9c10eb5d38eef7b5bb5275aaff618a68',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-production-responsive-1000-agent.png'),
    '110344553fd10f862ad3028317170cf720f2dae6f36c879d7449f4a04e734e27',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-production-responsive-1000-channels.png'),
    '90e60a6924866d58df6c749d0a70ef56f63cd256640d8129e649c45db2ae411d',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-production-responsive-200-percent-channel.png'),
    '0dec9a89afe8fb1533dca0544d49b390804babefe2a4ceb885229fec149d196b',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-production-responsive-740-agent.png'),
    'af34d5a59d64b9edf97b9a225f417c0eacc28ece190f65a3f1c7f2580cee515b',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-production-responsive-phone-agent.png'),
    'b8bc2f6b022e89c834befe1652368c47d07fbf460943ab61416cee374e1507e9',
  ],
  [
    exportPath('docs', 'design', 'agent-first-admin-prototype', 'qa-production-responsive-phone-channel.png'),
    '3ada83213e769030cab6525eb67b6b28e171dd8c9df8ba054d89435bf41d7978',
  ],
]);

const allowedLargeTextFiles = new Map();

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed with exit ${result.status}`);
  }
  return result;
}

function capture(command, args, options = {}) {
  if (!options.quiet) {
    console.log(`$ ${[command, ...args].join(' ')}`);
  }
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.toString('utf8') ?? '';
    fail(`${command} ${args.join(' ')} failed with exit ${result.status}: ${detail}`);
  }
  return result.stdout;
}

function readTrackedManifest() {
  const sourceCommit = capture('git', ['rev-parse', '--verify', 'HEAD^{commit}'])
    .toString('utf8')
    .trim();
  if (!/^[0-9a-f]{40,64}$/.test(sourceCommit)) {
    fail(`git rev-parse returned an invalid commit id: ${sourceCommit}`);
  }

  const output = capture('git', [
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    sourceCommit,
  ]);
  const decoded = output.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(output)) {
    fail('Tracked source manifest contains a non-UTF-8 path');
  }

  const records = decoded.split('\0');
  if (records.pop() !== '') {
    fail('git ls-tree returned a non-NUL-terminated manifest');
  }

  const seen = new Set();
  const entries = records.map((record) => {
    const separator = record.indexOf('\t');
    if (separator < 0) {
      fail(`Malformed git ls-tree record: ${record}`);
    }

    const [mode, type, object, ...extra] = record.slice(0, separator).split(' ');
    const path = record.slice(separator + 1);
    if (!mode || !type || !object || extra.length > 0) {
      fail(`Malformed git ls-tree metadata for ${path || '<empty path>'}`);
    }
    if (!/^[0-9a-f]{40,64}$/.test(object)) {
      fail(`Malformed git object id for ${path || '<empty path>'}: ${object}`);
    }
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
      fail(`${path}: unsupported tracked entry (${mode} ${type})`);
    }
    if (
      path.length === 0 ||
      path.includes('\\') ||
      posix.normalize(path) !== path ||
      path.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      fail(`Tracked source manifest contains an unsafe path: ${path}`);
    }
    if (seen.has(path)) {
      fail(`Tracked source manifest contains a duplicate path: ${path}`);
    }
    seen.add(path);
    return { mode, object, path };
  });

  assertNoPathCollisions(entries);
  return { entries, sourceCommit };
}

function assertNoPathCollisions(entries) {
  const aliases = new Map();
  for (const { path } of entries) {
    const alias = path.normalize('NFC').toLowerCase().normalize('NFC');
    const existing = aliases.get(alias);
    if (existing && existing !== path) {
      fail(`Tracked source paths alias on common filesystems: ${existing} and ${path}`);
    }
    aliases.set(alias, path);
  }
}

function assertPublicSourceManifest(entries) {
  const forbidden = entries.filter(
    ({ path }) => {
      const normalizedPath = path.toLowerCase();
      return (
        forbiddenSourcePaths.has(normalizedPath) ||
        (normalizedPath.startsWith('docs/') &&
          !allowedPublicDocs.has(normalizedPath) &&
          !allowedBinaryFiles.has(normalizedPath)) ||
        forbiddenSourcePathRoots.some(
          (root) =>
            (normalizedPath === root || normalizedPath.startsWith(`${root}/`)) &&
            !allowedAgentSkillPaths.has(path),
        )
      );
    },
  );
  if (forbidden.length > 0) {
    fail(
      [
        'OSS export contains forbidden public-source paths:',
        ...forbidden.map(({ path }) => path),
      ].join('\n'),
    );
  }
  assertLiveVerifierSourcePolicy(entries);
}

function isLiveVerifierPublicPath(path) {
  return liveVerifierExportPolicy.requiredPaths.has(path);
}

function isForbiddenLiveVerifierArtifact(path) {
  return forbiddenLiveVerifierArtifactPaths.some((pattern) => pattern.test(path));
}

function assertLiveVerifierSourcePolicy(entries) {
  const paths = new Set(entries.map(({ path }) => path));
  const missing = [...liveVerifierExportPolicy.requiredPaths].filter((path) => !paths.has(path));
  const forbidden = entries
    .map(({ path }) => path)
    .filter(isForbiddenLiveVerifierArtifact);
  const unexpected = entries.map(({ path }) => path)
    .filter((path) => path.startsWith('qa/live/') && !liveVerifierExportPolicy.requiredPaths.has(path));
  if (missing.length > 0 || forbidden.length > 0 || unexpected.length > 0) {
    fail([
      'OSS live verifier source policy failed:',
      ...missing.map((path) => `missing public verifier file: ${path}`),
      ...forbidden.map((path) => `forbidden private verifier artifact: ${path}`),
      ...unexpected.map((path) => `unreviewed verifier file: ${path}`),
    ].join('\n'));
  }
}

function extractHeadArchive(sourceCommit) {
  run('sh', [
    '-c',
    'git archive --format=tar "$1" | tar -x -C "$2"',
    'verify-oss-export',
    sourceCommit,
    scratch,
  ]);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function scanExportTree(entries) {
  const findings = [];
  const blobs = new Map();
  for (const { object, path: rel } of entries) {
    let buffer = blobs.get(object);
    if (!buffer) {
      buffer = capture('git', ['cat-file', 'blob', object], { quiet: true });
      blobs.set(object, buffer);
    }

    const file = join(scratch, rel);
    let fileStat;
    try {
      fileStat = lstatSync(file);
    } catch (error) {
      findings.push(`${rel}: tracked archive entry is missing (${error.code ?? error.message})`);
    }
    if (fileStat && !fileStat.isFile()) {
      findings.push(`${rel}: unsupported non-file archive entry`);
    } else if (fileStat) {
      const extracted = readFileSync(file);
      if (!extracted.equals(buffer)) {
        findings.push(`${rel}: archived bytes differ from tracked blob ${object}`);
      }
    }

    const extension = extname(rel).toLowerCase();
    const size = buffer.length;
    if (forbiddenBinaryExtensions.has(extension)) {
      const expectedHash = allowedBinaryFiles.get(rel);
      if (!expectedHash) {
        findings.push(`${rel}: forbidden binary/image extension ${extension}`);
        continue;
      }

      const actualHash = sha256(buffer);
      if (actualHash !== expectedHash) {
        findings.push(`${rel}: allowed binary hash mismatch (${actualHash})`);
      }
      continue;
    }

    if (size > 5_000_000) {
      const expectedHash = allowedLargeTextFiles.get(rel);
      const actualHash = sha256(buffer);
      if (!expectedHash) {
        findings.push(`${rel}: file is too large for text leak scanning (${size} bytes)`);
        continue;
      }
      if (actualHash !== expectedHash) {
        findings.push(`${rel}: allowed large-text hash mismatch (${actualHash})`);
        continue;
      }
    }

    if (buffer.includes(0)) {
      findings.push(`${rel}: binary content is not allowed in the OSS export`);
      continue;
    }

    const text = buffer.toString('utf8');
    for (const [label, pattern] of denyPatterns) {
      if (pattern.test(text)) {
        findings.push(`${rel}: matched denied term ${label}`);
      }
    }
    if (isLiveVerifierPublicPath(rel)) {
      for (const [label, pattern] of liveVerifierDenyPatterns) {
        if (pattern.test(text)) findings.push(`${rel}: matched denied verifier value ${label}`);
      }
    }
  }

  if (findings.length > 0) {
    fail(`OSS export leak scan failed:\n${findings.join('\n')}`);
  }
}

function verifyNpmPackManifest(entries, packageJson) {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: scratch,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(`npm pack manifest failed:\n${result.stderr || result.stdout}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(result.stdout);
  } catch {
    fail(`npm pack returned invalid JSON:\n${result.stdout}`);
  }
  const files = new Set((manifest[0]?.files ?? []).map((entry) => entry.path));
  const declaredFiles = new Set(packageJson.files ?? []);
  const requiredPackageEntries = [
    '.agents/skills/chickpea-live-verification',
    'AGENTS.md',
    'qa/live',
    'docs/runbooks/live-contract-acceptance-v1.md',
    'docs/runbooks/live-contract-verification.md',
  ];
  const missingPackageEntries = requiredPackageEntries.filter((path) => !declaredFiles.has(path));
  const publicVerifierFiles = entries
    .map(({ path }) => path)
    .filter(isLiveVerifierPublicPath);
  const required = [
    '.agents/skills/chickpea-live-verification/SKILL.md',
    '.dev.vars.example',
    '.env.example',
    'AGENTS.md',
    'LICENSE',
    'NOTICE',
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'AGENTS.md',
    'SETUP_AGENT.md',
    'TELEMETRY.md',
    'assets/admin-agent.png',
    'assets/bot-avatar.png',
    'assets/chickpea-favicon-32.png',
    'assets/chickpea-mark-128.png',
    'assets/chickpea-mark.png',
    'assets/chickpea-wordmark-512.png',
    'assets/chickpea-wordmark-mask.png',
    'config/environments/qa/desired-state.json',
    'config/environments/qa/workspace-recipe.json',
    'scripts/cloudflare-deployment-profile.mjs',
    'scripts/deploy-with-epilogue.mjs',
    'scripts/recover-auth.mjs',
    'docs/authentication.md',
    'docs/shared-gateway-data-handling.md',
    'docs/runbooks/agent-authoring-evaluation.md',
    'docs/runbooks/auth-db-deployment.md',
    'docs/runbooks/operations.md',
    'docs/runbooks/releasing.md',
    'docs/runbooks/agent-first-acceptance-2026-08-21.md',
    'docs/runbooks/coding-sandbox-deployment.md',
    'docs/runbooks/composio-managed-connectors.md',
    'docs/runbooks/product-telemetry.md',
    'docs/runbooks/parallel-live-test-environments.md',
    'docs/runbooks/slack-auth-recovery.md',
    'docs/runbooks/workspace-management-mcp.md',
    'migrations/better-auth/0001_better_auth.sql',
    'qa/live/manifest.ts',
    'qa/live/schema.ts',
    'qa/live/doctor.ts',
    'qa/live/attestation.ts',
    'qa/live/private-config.ts',
    'qa/live/safety/lock.ts',
    'scripts/lib/environment-baseline.mjs',
    'docs/runbooks/live-contract-acceptance-v1.md',
    'docs/runbooks/live-contract-verification.md',
    'docs/runbooks/slack-auth-recovery.md',
    'docs/runbooks/workspace-management-mcp.md',
    'migrations/better-auth/0001_better_auth.sql',
    'qa/live/generated/feature-map.md',
    'qa/live/operator/SKILL.md',
    'qa/live/target.example.json',
    'scripts/flue-build-cf.mjs',
    'slack-app-manifest.json',
    'src/app.ts',
    'src/cloudflare.ts',
    'vite.config.ts',
    'vite.node.config.ts',
    'wrangler.jsonc',
  ];
  const missing = [...new Set([...required, ...publicVerifierFiles])]
    .filter((path) => !files.has(path));
  const forbidden = [...files].filter(
    (path) =>
      path === '.worktreeinclude' ||
      path.startsWith('.claude/') ||
      path.startsWith('.github/') ||
      path.startsWith('design/') ||
      (path.startsWith('config/environments/qa/') && ![
        'config/environments/qa/desired-state.json',
        'config/environments/qa/workspace-recipe.json',
      ].includes(path)) ||
      (path.startsWith('docs/') && !allowedPublicDocs.has(path)) ||
      isForbiddenLiveVerifierArtifact(path) ||
      path.startsWith('tmp/'),
  );
  if (missingPackageEntries.length > 0 || missing.length > 0 || forbidden.length > 0) {
    fail(
      [
        'npm package manifest is not release-clean:',
        ...missingPackageEntries.map((path) => `missing package.json files entry: ${path}`),
        ...missing.map((path) => `missing required file: ${path}`),
        ...forbidden.map((path) => `forbidden packaged file: ${path}`),
      ].join('\n'),
    );
  }
}

function verifyAuthenticationExportContract(packageJson) {
  const bindings = packageJson.cloudflare?.bindings ?? {};
  if (Object.keys(bindings).length !== 0) {
    fail('Consumer Deploy metadata must not prompt for a Chickpea credential');
  }
  const recovery = readFileSync(join(scratch, 'scripts', 'recover-auth.mjs'), 'utf8');
  if (/\bfetch\s*\(/.test(recovery) || /node:https/.test(recovery)) {
    fail('Slack recovery preflight must remain read-only with no HTTP transport');
  }
  const identityTypes = readFileSync(join(scratch, 'src', 'identity', 'types.ts'), 'utf8');
  if (!identityTypes.includes("Omit<Invitation, 'locatorHash'>") ||
      !identityTypes.includes("Omit<PersonalTokenRecord, 'tokenHash'>") ||
      !identityTypes.includes("Omit<BrowserSessionRecord, 'sessionHash'>") ||
      !identityTypes.includes("Omit<AuthOperation, 'capabilityHash'>") ||
      !identityTypes.includes("Omit<SlackSetupTransaction, 'locatorHash'>")) {
    fail('Identity export summary must omit invitation, operation, setup, token, and session locators');
  }
  const example = readFileSync(join(scratch, '.dev.vars.example'), 'utf8');
  const environmentExample = readFileSync(join(scratch, '.env.example'), 'utf8');
  const activeExampleKeys = example.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => line.slice(0, line.indexOf('=')));
  if (activeExampleKeys.length !== 0) {
    fail('Cloudflare Deploy example must expose no active secret prompt');
  }
  if (!/^COMPOSIO_API_KEY=$/m.test(environmentExample) ||
      /^COMPOSIO_API_KEY=.+$/m.test(environmentExample)) {
    fail('OSS environment example must keep the Composio project key optional and empty');
  }
  for (const key of [
    'DO_NOT_TRACK',
    'CHICKPEA_DISABLE_TELEMETRY',
    'CHICKPEA_TELEMETRY_ENVIRONMENT',
  ]) {
    const emptyEntry = new RegExp(`^${key}=$`, 'm');
    const populatedEntry = new RegExp(`^${key}=.+$`, 'm');
    if (!emptyEntry.test(environmentExample) || populatedEntry.test(environmentExample)) {
      fail(`OSS environment example must expose ${key} as an optional empty value`);
    }
  }
  const wrangler = readFileSync(join(scratch, 'wrangler.jsonc'), 'utf8');
  if (/"vars"\s*:/.test(wrangler)) {
    fail('Cloudflare Deploy config must not expose runtime defaults as customer-editable fields');
  }
  if (!/"binding"\s*:\s*"AUTH_DB"/.test(wrangler) ||
      !/"migrations_dir"\s*:\s*"migrations\/better-auth"/.test(wrangler)) {
    fail('Cloudflare config must bind AUTH_DB to the reviewed Better Auth migrations');
  }
  const publicAuthCopy = [
    readFileSync(join(scratch, 'README.md'), 'utf8'),
    readFileSync(join(scratch, 'docs', 'authentication.md'), 'utf8'),
  ].join('\n');
  const managedConnectorCopy = readFileSync(
    join(scratch, 'docs', 'runbooks', 'composio-managed-connectors.md'),
    'utf8',
  );
  if (!/Self-hosters opt in by supplying their own Composio project key/i.test(
    managedConnectorCopy,
  ) || !/Without that key the adapter is dormant/i.test(managedConnectorCopy)) {
    fail('OSS managed-connector docs must explain BYOK setup and no-key fallback');
  }
  if (/Cloudflare Access is the default|Choose \*\*new Zero Trust organization\*\*/i.test(publicAuthCopy)) {
    fail('Public authentication copy still describes Access as the fresh-install default');
  }
  if (/BETTER_AUTH_SECRET\s*=/.test(publicAuthCopy + example)) {
    fail('Public setup material must not expose or request a Better Auth secret');
  }
}

let passed = false;
try {
  console.log(`SCRATCH=${scratch}`);
  const { entries, sourceCommit } = readTrackedManifest();
  assertPublicSourceManifest(entries);
  extractHeadArchive(sourceCommit);
  // GitHub is the distribution surface, so scan every tracked source entry
  // before any package-specific checks.
  // Only immutable HEAD entries are scanned, so npm-generated scratch content
  // cannot expand or otherwise change the source scan's scope.
  scanExportTree(entries);

  if (!existsSync(join(scratch, 'LICENSE'))) {
    fail('Export is missing LICENSE');
  }
  if (!existsSync(join(scratch, 'NOTICE'))) {
    fail('Export is missing NOTICE');
  }

  const packageJson = JSON.parse(readFileSync(join(scratch, 'package.json'), 'utf8'));
  if (packageJson.private !== true || !packageJson.description || packageJson.license !== 'Apache-2.0' || !packageJson.repository) {
    fail('Export package.json must remain private and include its source metadata');
  }

  verifyAuthenticationExportContract(packageJson);

  verifyNpmPackManifest(entries, packageJson);

  run('npm', ['ci'], { cwd: scratch });
  // Artifact contracts must inspect a build of this archive, not skip because
  // dist-cf is absent in a fresh source checkout.
  run('npm', ['run', 'build'], { cwd: scratch });
  run('npm', ['run', 'test:ci'], {
    cwd: scratch,
    env: {
      ...offlineVerificationEnv,
      TAG_DB_PATH: ':memory:',
      SLACK_STATE_DB_PATH: ':memory:',
      CHICKPEA_AUTH_DB_PATH: ':memory:',
    },
  });
  run('node', ['scripts/verify-flue-offline-turn.mjs'], {
    cwd: scratch,
    env: offlineVerificationEnv,
  });
  run('npm', ['run', 'verify:durability'], {
    cwd: scratch,
    env: offlineVerificationEnv,
  });
  run('npm', ['run', 'verify:providers'], {
    cwd: scratch,
    env: offlineVerificationEnv,
  });
  // The default source export is the slim core profile, so its full build and
  // Wrangler dry run must succeed without a Docker-specific escape hatch.
  run('npm', ['run', 'deploy', '--', '--dry-run'], { cwd: scratch });

  console.log('OSS export verification passed');
  passed = true;
} finally {
  if (passed && process.env.KEEP_EXPORT_SCRATCH !== '1') {
    rmSync(scratch, { recursive: true, force: true });
    console.log(`Cleaned SCRATCH=${scratch}`);
  } else {
    console.log(`Export scratch preserved at ${scratch}`);
  }
}
