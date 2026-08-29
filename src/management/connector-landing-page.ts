import { CHICKPEA_FAVICON_HTML, CHICKPEA_WORDMARK_CSS, CHICKPEA_WORDMARK_HTML } from '../brand/chickpea-mark.ts';
import { CONNECTOR_LOGOS } from '../config/connector-logos.ts';
import { resolveConnectorCatalogPreset } from '../config/presets.ts';
import type { CustomAgentConfig } from '../config/types.ts';
import {
  managedConnectorReadCopy,
  managedConnectorWriteSummary,
} from '../connections/managed-copy.ts';
import type { ManagementSetupRecord } from './types.ts';

export interface ManagedConnectionPageInput {
  setup: ManagementSetupRecord;
  agent: CustomAgentConfig;
  avatarUrl?: string;
  failureMessage?: string;
  writeAvailable?: boolean;
}

export function renderManagedConnectionSetupPage(input: ManagedConnectionPageInput): string {
  const { setup, agent } = input;
  const connector = setup.target.targetLabel;
  const connectorCopy = managedConnectorReadCopy(setup.target.provider, connector);
  const accessLane = setup.target.accessLane ?? 'read';
  const accessSummary = accessLane === 'write'
    ? managedConnectorWriteSummary(setup.target.provider, connector)
    : connectorCopy.accessSummary;
  const failureMessage = input.failureMessage ?? '';
  const writeAvailable = input.writeAvailable ?? true;
  return pageShell({
    title: `Connect ${connector} to ${agent.name}`,
    surface: 'connector-setup',
    content: `
      <main class="flow-shell setup-shell" aria-labelledby="flow-title">
        ${brandHeader()}
        <section class="flow-content">
          ${agentIdentity(agent, input.avatarUrl)}
          <h1 id="flow-title">Connect ${escapeHtml(connector)} to ${escapeHtml(agent.name)}</h1>
          <p class="setup-lead">${escapeHtml(agent.name)} can ${escapeHtml(connectorCopy.setupAction)}.<br>Updates still require your confirmation.</p>
          <section class="setup-card">
            <div class="connector-row">
              ${connectorLogo(setup)}
              <strong>${escapeHtml(connector)}</strong>
            </div>
            <form id="connector-form" method="post" action="/setup/${encodeURIComponent(setup.setupOperationId)}/authorize">
              <section class="choice-block owner-choice-block" aria-labelledby="owner-title">
                <h2 id="owner-title">Who uses this connection?</h2>
                <p class="choice-instruction">Pick one to continue.</p>
                <div class="owner-options" role="radiogroup" aria-labelledby="owner-title">
                  <label class="owner-option">
                    <input type="radio" name="ownerKind" value="member" aria-describedby="owner-personal-description">
                    <span class="owner-radio" aria-hidden="true"></span>
                    <span class="owner-option-icon owner-option-icon-personal" aria-hidden="true">${ownerChoiceIcon('member')}</span>
                    <span class="owner-option-copy"><strong>Personal</strong><span id="owner-personal-description">Each person signs in with their own account. ${escapeHtml(agent.name)} uses yours only for your requests.</span></span>
                  </label>
                  <label class="owner-option">
                    <input type="radio" name="ownerKind" value="team" aria-describedby="owner-team-description">
                    <span class="owner-radio" aria-hidden="true"></span>
                    <span class="owner-option-icon owner-option-icon-team" aria-hidden="true">${ownerChoiceIcon('team')}</span>
                    <span class="owner-option-copy"><strong>Team</strong><span id="owner-team-description">One shared account for everyone who can use ${escapeHtml(agent.name)}.</span></span>
                  </label>
                </div>
              </section>
              <section class="choice-block" aria-labelledby="access-title">
                <h2 id="access-title">Access</h2>
                <div class="access-control" role="radiogroup" aria-label="Connector access" aria-describedby="access-help">
                  <label><input type="radio" name="access" value="read"${accessLane === 'read' ? ' checked' : ''}><span>Read-only</span></label>
                  <label><input type="radio" name="access" value="write"${accessLane === 'write' ? ' checked' : ''}${writeAvailable ? '' : ' disabled'}><span>Read and write</span></label>
                </div>
                <p id="access-help">${escapeHtml(accessSummary)}</p>
              </section>
              <p class="security-copy">Sign-in opens in a secure ${escapeHtml(connector)} tab. Chickpea keeps a reference to the connected account and this Agent&rsquo;s access level &mdash; never your password or refresh tokens.</p>
              <p class="flow-alert" id="flow-alert" role="alert"${failureMessage ? '' : ' hidden'}>${escapeHtml(failureMessage)}</p>
            </form>
            <div class="flow-actions">
              <form method="post" action="/setup/${encodeURIComponent(setup.setupOperationId)}/cancel"><button class="text-button" type="submit">Cancel</button></form>
              <button class="primary-button" type="submit" form="connector-form" name="intent" value="authorize" disabled>Continue to ${escapeHtml(connector)}</button>
            </div>
          </section>
        </section>
      </main>
      <script nonce="setup">${setupScript({ agentName: agent.name, connector, toolkit: setup.target.provider })}</script>`,
  });
}

export function renderManagedConnectionDeparturePage(
  input: ManagedConnectionPageInput,
  authorizationUrl: string,
): string {
  const connector = input.setup.target.targetLabel;
  return pageShell({
    title: `Continue to ${connector}`,
    surface: 'connector-departure',
    content: `
      <main class="flow-shell waiting-shell" aria-labelledby="flow-title">
        ${brandHeader()}
        <section class="flow-content centered">
          ${connectionPair(input)}
          <h1 id="flow-title">Continue to ${escapeHtml(connector)}</h1>
          <p class="lead">Open the secure sign-in page to finish connecting ${escapeHtml(connector)} to ${escapeHtml(input.agent.name)}.</p>
          <p class="departure-action"><a class="primary-button" href="${escapeHtml(authorizationUrl)}">Open ${escapeHtml(connector)}</a></p>
        </section>
      </main>`,
  });
}

export function renderManagedConnectionWaitingPage(
  input: ManagedConnectionPageInput,
): string {
  const connector = input.setup.target.targetLabel;
  return pageShell({
    title: `Finishing ${connector} connection`,
    surface: 'connector-waiting',
    content: `
      <main class="flow-shell waiting-shell" aria-labelledby="flow-title">
          ${brandHeader()}
        <section class="flow-content centered">
          ${connectionPair(input)}
          <h1 id="flow-title">Finishing your ${escapeHtml(connector)} connection&hellip;</h1>
          <p class="lead" id="poll-status" role="status" aria-live="polite">Chickpea is checking the connection returned by the provider.</p>
          <p class="small-copy">This may take a moment.</p>
          <form class="waiting-action" method="post" action="/setup/${encodeURIComponent(input.setup.setupOperationId)}/cancel"><button class="text-button" type="submit">Start over</button></form>
        </section>
      </main>
      <script nonce="setup">${pollScript(input.setup.setupOperationId)}</script>`,
  });
}

export function renderManagedConnectionSuccessPage(input: ManagedConnectionPageInput): string {
  const connector = input.setup.target.targetLabel;
  const receipt = input.setup.receipt && 'kind' in input.setup.receipt &&
      input.setup.receipt.kind === 'connector_connected'
    ? input.setup.receipt
    : undefined;
  const ownerKind = receipt?.ownerKind ?? input.setup.target.ownerKind;
  const accessLane = receipt?.accessLane ?? input.setup.target.accessLane;
  const scope = ownerKind === 'team' ? 'team' : 'personal';
  const access = accessLane === 'write' ? 'read and write' : 'read-only';
  return pageShell({
    title: `${connector} connected`,
    surface: 'connector-success',
    content: `
      <main class="flow-shell success-shell" aria-labelledby="flow-title">
        ${brandHeader()}
        <section class="flow-content centered">
          ${connectionPair(input)}
          <div class="success-copy">
            <div class="success-line"><span class="success-check" aria-hidden="true">&#10003;</span><h1 id="flow-title">${escapeHtml(connector)} is now connected to ${escapeHtml(input.agent.name)}</h1></div>
            <p class="lead success-summary">Your ${scope}, ${access} connection is ready.</p>
            <p class="small-copy">You can close this tab now.</p>
          </div>
        </section>
      </main>`,
  });
}

export function renderManagedConnectionUnavailablePage(): string {
  return pageShell({
    title: 'Connection link unavailable',
    surface: 'connector-unavailable',
    content: `
      <main class="flow-shell unavailable-shell" aria-labelledby="flow-title">
        ${brandHeader()}
        <section class="flow-content centered"><h1 id="flow-title">This link is no longer valid</h1><p class="lead">Ask the Agent in Slack for a new connection link.</p></section>
      </main>`,
  });
}

function pageShell(input: { title: string; surface: string; content: string }): string {
  return `<!doctype html><html lang="en" data-connector-surface="${escapeHtml(input.surface)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Chickpea · ${escapeHtml(input.title)}</title>${CHICKPEA_FAVICON_HTML}<style>${PAGE_CSS}</style></head><body>${input.content}</body></html>`;
}

function brandHeader(): string {
  return `<header class="brand-header">${CHICKPEA_WORDMARK_HTML}</header>`;
}

function agentIdentity(agent: CustomAgentConfig, avatarUrl?: string): string {
  return `<div class="agent-identity">${agentAvatar(agent, avatarUrl)}<strong>${escapeHtml(agent.name)}</strong></div>`;
}

function agentAvatar(agent: CustomAgentConfig, avatarUrl?: string): string {
  if (avatarUrl) {
    return `<span class="agent-avatar"><img src="${escapeHtml(avatarUrl)}" alt="" width="64" height="64"></span>`;
  }
  return `<span class="agent-avatar agent-avatar-fallback" aria-hidden="true">${escapeHtml(monogram(agent.name))}</span>`;
}

function connectionPair(input: ManagedConnectionPageInput): string {
  return `<div class="connection-pair" aria-hidden="true">${agentAvatar(input.agent, input.avatarUrl)}<span class="connection-link"><i></i></span>${connectorLogo(input.setup, 'pair-logo')}</div>`;
}

function connectorLogo(setup: ManagementSetupRecord, extraClass = ''): string {
  const presetId = setup.target.presetId ?? setup.target.provider;
  const preset = resolveConnectorCatalogPreset(presetId) ??
    resolveConnectorCatalogPreset(setup.target.targetLabel);
  const logoId = presetId.replace(/-managed$/, '');
  const logo = CONNECTOR_LOGOS[logoId as keyof typeof CONNECTOR_LOGOS] ??
    CONNECTOR_LOGOS[setup.target.provider as keyof typeof CONNECTOR_LOGOS];
  const className = `connector-logo ${extraClass}`.trim();
  const style = ` style="--connector-accent:${preset?.accent ?? '#FF7A59'}"`;
  if (!logo) {
    return `<span class="${className} connector-logo-fallback"${style} aria-hidden="true">${escapeHtml(monogram(setup.target.targetLabel))}</span>`;
  }
  if ('raster' in logo && logo.raster || 'full' in logo && logo.full) {
    return `<span class="${className}"${style} aria-hidden="true">${logo.svg}</span>`;
  }
  return `<span class="${className}"${style} aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor">${logo.svg}</svg></span>`;
}

function ownerChoiceIcon(ownerKind: 'member' | 'team'): string {
  const path = ownerKind === 'team'
    ? 'M6 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm4.75-1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM.75 14.25A5.25 5.25 0 0 1 6 9a5.25 5.25 0 0 1 5.25 5.25.75.75 0 0 1-.75.75h-9a.75.75 0 0 1-.75-.75Zm10.4-6.52a4.76 4.76 0 0 1 4.1 4.72.75.75 0 0 1-.75.75h-1.82a6.75 6.75 0 0 0-1.53-5.47Z'
    : 'M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2.75 14A5.25 5.25 0 0 1 8 8.75 5.25 5.25 0 0 1 13.25 14a.75.75 0 0 1-.75.75h-9A.75.75 0 0 1 2.75 14Z';
  return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="${path}"/></svg>`;
}

function setupScript(input: { agentName: string; connector: string; toolkit: string }): string {
  const readSummary = managedConnectorReadCopy(input.toolkit, input.connector).accessSummary;
  const writeSummary = managedConnectorWriteSummary(input.toolkit, input.connector);
  return `(function(){var form=document.getElementById("connector-form"),owners=form&&form.querySelectorAll('input[name="ownerKind"]'),accessHelp=document.getElementById("access-help"),alert=document.getElementById("flow-alert"),button=document.querySelector('button[form="connector-form"][value="authorize"]');if(!form||!owners||!accessHelp||!alert||!button)return;var readSummary=${jsonForScript(readSummary)},writeSummary=${jsonForScript(writeSummary)};function selectedOwner(){return form.querySelector('input[name="ownerKind"]:checked')}function update(){button.disabled=!selectedOwner();var access=form.querySelector('input[name="access"]:checked');accessHelp.textContent=access&&access.value==="write"?writeSummary:readSummary}owners.forEach(function(control){control.addEventListener("change",update)});form.querySelectorAll('input[name="access"]').forEach(function(control){control.addEventListener("change",update)});form.addEventListener("submit",async function(event){event.preventDefault();if(!selectedOwner()){alert.textContent="Choose Personal or Team to continue.";alert.hidden=false;update();return}var label=button.textContent;button.disabled=true;button.textContent="Opening secure sign-in…";alert.hidden=true;try{var response=await fetch(form.action,{method:"POST",headers:{accept:"application/json","content-type":"application/x-www-form-urlencoded;charset=UTF-8","x-requested-with":"chickpea-setup"},body:new URLSearchParams(new FormData(form)),credentials:"same-origin"});var body=await response.json().catch(function(){return {}});if(!response.ok)throw new Error(String(body.message||"Chickpea could not start the secure sign-in. Try again."));var target=new URL(String(body.authorizationUrl||""));if(target.protocol!=="https:")throw new Error("Chickpea received an invalid secure sign-in URL.");location.assign(target.href)}catch(error){alert.textContent=error instanceof Error?error.message:"Chickpea could not start the secure sign-in. Try again.";alert.hidden=false;button.textContent=label;update()}});update()})();`;
}

function pollScript(setupId: string): string {
  const pollUrl = `/setup/${encodeURIComponent(setupId)}/managed/poll`;
  return `(function(){var attempts=0,checkFailures=0,status=document.getElementById("poll-status");function delay(){return attempts<20?1500:attempts<38?5000:15000}function retry(){checkFailures+=1;if(checkFailures>=12){status.textContent="Chickpea could not check the connection. Reload this page to try again.";return}status.textContent="Chickpea could not check the connection yet. It will try again.";setTimeout(poll,delay())}async function poll(){attempts+=1;try{var response=await fetch(${JSON.stringify(pollUrl)},{method:"POST",headers:{"content-type":"application/json"},body:"{}",credentials:"same-origin"});var body=await response.json().catch(function(){return {}});if(response.ok&&body.status==="connected"){location.replace(location.pathname);return}if(response.status===401){location.replace("/auth/slack/sign-in?destination="+encodeURIComponent(location.pathname));return}if(response.status===403||response.status===409){status.textContent=String(body.message||"This connection can no longer finish from this tab.");return}if(response.status===202){checkFailures=0;if(body.message)status.textContent=String(body.message);setTimeout(poll,delay());return}retry()}catch(_error){retry()}}setTimeout(poll,800)})();`;
}

function jsonForScript(value: string): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function monogram(value: string): string {
  const parts = value.match(/[A-Za-z0-9]+/g) ?? [];
  if (parts.length > 1) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return (parts[0] ?? '?').slice(0, 2).toUpperCase();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]!);
}

const PAGE_CSS = `
:root {
  ${CHICKPEA_WORDMARK_CSS}
  --canvas: #f4ebd8;
  --card: #fffdf6;
  --ink: #3b3220;
  --muted: #6b5c42;
  --gold: #dda033;
  --gold-press: #b27e1f;
  --green: #6fa25b;
  --green-deep: #4f8a3f;
  --line: rgba(59, 50, 32, .16);
  --danger: #a83f34;
}
* { box-sizing: border-box; }
html { color-scheme: light; }
body {
  margin: 0;
  min-height: 100dvh;
  background: var(--canvas);
  color: var(--ink);
  font-family: "Quicksand", ui-rounded, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.flow-shell { min-height: 100dvh; padding: clamp(24px, 6vw, 48px); }
.brand-header { color: var(--ink); height: 42px; }
.brand-wordmark {
  aspect-ratio: 2106 / 518;
  background-color: currentColor;
  display: block;
  height: 25px;
  -webkit-mask: var(--chickpea-wordmark-image) center / contain no-repeat;
  mask: var(--chickpea-wordmark-image) center / contain no-repeat;
}
.flow-content { margin: 0 auto; width: min(720px, 100%); }
.agent-identity {
  align-items: center;
  display: flex;
  gap: 18px;
  justify-content: center;
  margin-bottom: 30px;
}
.agent-identity strong {
  font-family: "Baloo 2", ui-rounded, system-ui, sans-serif;
  font-size: 1.9rem;
}
.agent-avatar {
  align-items: center;
  background: #6e261c;
  border: 1px solid rgba(59, 50, 32, .14);
  border-radius: 18px;
  box-shadow: 0 5px 14px rgba(59, 50, 32, .13);
  display: inline-flex;
  flex: 0 0 auto;
  height: 64px;
  justify-content: center;
  overflow: hidden;
  width: 64px;
}
.agent-avatar img { height: 100%; object-fit: cover; width: 100%; }
.agent-avatar-fallback { color: #fff7d3; font-weight: 850; }
.flow-content > h1,
.success-line h1 {
  font-family: "Baloo 2", ui-rounded, system-ui, sans-serif;
  letter-spacing: -.035em;
  line-height: 1.08;
}
.setup-shell .flow-content > h1 {
  font-size: clamp(2.65rem, 5vw, 3.2rem);
  margin: 0;
  text-align: center;
}
.setup-lead {
  color: var(--muted);
  font-size: 1.15rem;
  line-height: 1.55;
  margin: 16px auto 30px;
  text-align: center;
}
.setup-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 22px;
  box-shadow: 0 12px 34px rgba(59, 50, 32, .09);
  overflow: hidden;
}
.connector-row {
  align-items: center;
  border-bottom: 1px dashed var(--line);
  display: flex;
  gap: 18px;
  min-height: 96px;
  padding: 18px 24px;
}
.connector-row strong { font-size: 1.28rem; }
.connector-row .connector-logo {
  background: transparent;
  border: 0;
  border-radius: 0;
  height: 48px;
  padding: 7px;
  width: 48px;
}
.connector-logo {
  align-items: center;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 13px;
  color: var(--connector-accent, #FF7A59);
  display: inline-flex;
  flex: 0 0 auto;
  height: 60px;
  justify-content: center;
  padding: 12px;
  width: 60px;
}
.connector-logo svg { display: block; height: 100%; width: 100%; }
.connector-logo > svg { fill: currentColor; }
.connector-logo svg[width] { height: 100%; width: 100%; }
.connector-logo-fallback { background: var(--connector-accent, #FF7A59); color: #fff; font-weight: 850; }
.choice-block {
  border-bottom: 0;
  margin: 0;
  padding: 24px;
  position: relative;
}
.choice-block:not(.owner-choice-block)::after {
  border-bottom: 1px dashed var(--line);
  bottom: 0;
  content: "";
  left: 24px;
  position: absolute;
  right: 24px;
}
.choice-block h2 {
  font-family: "Baloo 2", ui-rounded, system-ui, sans-serif;
  font-size: 1.08rem;
  margin: 0 0 10px;
}
.choice-block p,
.security-copy {
  color: var(--muted);
  font-size: .94rem;
  line-height: 1.55;
  margin: 11px 0 0;
}
.owner-choice-block {
  background: #f8f1df;
  border-radius: 16px;
  margin: 16px 18px 12px;
  padding: 18px 16px;
}
.owner-choice-block h2 { margin-bottom: 2px; }
.owner-choice-block .choice-instruction { margin: 0 0 14px; }
.owner-options {
  display: grid;
  gap: 10px;
}
.owner-option {
  align-items: center;
  background: var(--card);
  border: 1px solid rgba(59, 50, 32, .18);
  border-radius: 14px;
  box-shadow: 0 2px 0 rgba(59, 50, 32, .06);
  cursor: pointer;
  display: grid;
  gap: 12px;
  grid-template-columns: 18px 32px minmax(0, 1fr);
  min-height: 88px;
  padding: 12px 15px;
  position: relative;
}
.owner-option:hover { border-color: rgba(178, 126, 31, .45); }
.owner-option:has(input:checked) {
  border-color: var(--gold-press);
  box-shadow: 0 0 0 1px var(--gold-press), 0 2px 0 rgba(59, 50, 32, .06);
}
.owner-option input {
  height: 18px;
  inset: 0;
  margin: 0;
  opacity: 0;
  position: absolute;
  width: 18px;
}
.owner-radio {
  background: var(--card);
  border: 1.5px solid rgba(59, 50, 32, .34);
  border-radius: 50%;
  height: 18px;
  position: relative;
  width: 18px;
}
.owner-option input:checked + .owner-radio { border-color: var(--gold-press); }
.owner-option input:checked + .owner-radio::after {
  background: var(--gold-press);
  border-radius: 50%;
  content: "";
  inset: 3px;
  position: absolute;
}
.owner-option input:focus-visible + .owner-radio { outline: 3px solid rgba(176, 84, 21, .42); outline-offset: 3px; }
.owner-option-icon {
  align-items: center;
  border-radius: 50%;
  display: inline-flex;
  height: 32px;
  justify-content: center;
  width: 32px;
}
.owner-option-icon svg { height: 16px; width: 16px; }
.owner-option-icon-personal { background: rgba(221, 160, 51, .18); color: var(--gold-press); }
.owner-option-icon-team { background: rgba(111, 162, 91, .18); color: var(--green-deep); }
.owner-option-copy { display: grid; gap: 2px; max-width: 520px; min-width: 0; }
.owner-option-copy strong { font-size: .94rem; }
.owner-option-copy span {
  color: var(--muted);
  font-size: .88rem;
  line-height: 1.4;
  text-wrap: pretty;
}
.access-control {
  align-items: stretch;
  background: var(--card);
  border: 1px solid rgba(59, 50, 32, .2);
  border-radius: 15px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  min-height: 56px;
  overflow: hidden;
  width: min(615px, 100%);
}
.access-control label { cursor: pointer; min-width: 0; position: relative; }
.access-control input { opacity: 0; pointer-events: none; position: absolute; }
.access-control span {
  align-items: center;
  color: var(--muted);
  display: flex;
  font-weight: 800;
  height: 100%;
  justify-content: center;
  padding: 0 18px;
}
.access-control input:checked + span { background: var(--gold); color: var(--ink); }
.access-control input:focus-visible + span { outline: 3px solid rgba(176, 84, 21, .42); outline-offset: -4px; }
.access-control input:disabled + span { cursor: not-allowed; opacity: .48; }
.security-copy { margin: 0; padding: 22px 24px 0; }
.flow-alert {
  background: #fff0ea;
  border: 1px solid rgba(168, 63, 52, .22);
  border-radius: 12px;
  color: var(--danger);
  font-weight: 700;
  line-height: 1.45;
  padding: 12px 14px;
}
.flow-actions { align-items: center; display: flex; gap: 16px; justify-content: flex-end; padding: 24px; }
.flow-actions form { margin: 0; }
.flow-actions button { font: inherit; font-weight: 850; }
.primary-button {
  align-items: center;
  background: var(--gold);
  border: 0;
  border-radius: 14px;
  box-shadow: 0 4px 0 var(--gold-press);
  color: var(--ink);
  cursor: pointer;
  display: inline-flex;
  font-weight: 850;
  justify-content: center;
  min-height: 52px;
  padding: 0 22px;
  text-decoration: none;
}
.primary-button:disabled { box-shadow: 0 2px 0 rgba(59, 50, 32, .18); cursor: not-allowed; opacity: .5; }
.primary-button:active { box-shadow: none; transform: translateY(3px); }
.text-button {
  background: transparent;
  border: 0;
  color: var(--muted);
  cursor: pointer;
  min-height: 48px;
  padding: 0 12px;
  text-decoration: underline;
  text-underline-offset: 4px;
}
.primary-button:focus-visible,
.text-button:focus-visible { outline: 3px solid rgba(176, 84, 21, .42); outline-offset: 4px; }
.centered { text-align: center; }
.waiting-shell .flow-content,
.unavailable-shell .flow-content { margin-top: clamp(190px, 26vh, 280px); width: min(760px, 100%); }
.success-shell .flow-content { margin-top: clamp(190px, 26vh, 280px); width: min(980px, 100%); }
.connection-pair { align-items: center; display: flex; justify-content: center; margin: 0 auto 54px; }
.connection-pair .agent-avatar,
.connection-pair .pair-logo { border-radius: 18px; height: 74px; width: 74px; }
.connection-link { align-items: center; display: flex; height: 26px; position: relative; width: 82px; }
.connection-link::before {
  background: var(--green);
  content: "";
  height: 2px;
  left: 0;
  position: absolute;
  right: 0;
}
.connection-link i {
  background: var(--canvas);
  border: 2px solid var(--green);
  border-radius: 50%;
  height: 10px;
  left: 50%;
  position: absolute;
  transform: translateX(-50%);
  width: 10px;
  z-index: 1;
}
.success-copy { display: inline-block; max-width: 100%; text-align: left; }
.success-line { align-items: center; display: flex; gap: 22px; justify-content: flex-start; max-width: 100%; }
.success-line h1 { font-size: clamp(2.1rem, 3vw, 2.5rem); margin: 0; white-space: nowrap; }
.success-check {
  align-items: center;
  background: var(--green-deep);
  border-radius: 50%;
  color: #fff;
  display: inline-flex;
  flex: 0 0 auto;
  font-size: 1.25rem;
  font-weight: 900;
  height: 46px;
  justify-content: center;
  width: 46px;
}
.lead { color: var(--muted); font-size: 1.35rem; font-weight: 700; line-height: 1.55; margin: 22px auto 0; }
.small-copy { color: var(--muted); font-size: 1.18rem; margin: 11px auto 0; }
.departure-action { margin-top: 30px; }
.waiting-action { margin-top: 24px; }
.waiting-action button { font: inherit; font-weight: 850; }
.success-shell .lead,
.success-shell .small-copy { margin-left: 68px; text-align: left; }
.success-shell .success-summary { font-weight: 400; }
.waiting-shell .flow-content > h1,
.unavailable-shell .flow-content > h1 { font-size: clamp(2rem, 5vw, 3rem); margin-bottom: 0; }
@media (max-width: 760px) {
  .success-copy { display: block; }
  .success-line { align-items: flex-start; }
  .success-line h1 { white-space: normal; }
}
@media (max-width: 620px) {
  .flow-shell { padding: 20px; }
  .brand-wordmark { height: 22px; }
  .flow-content { margin-top: 24px; }
  .agent-identity { margin-bottom: 22px; }
  .agent-identity strong { font-size: 1.4rem; }
  .agent-avatar { border-radius: 15px; height: 54px; width: 54px; }
  .setup-shell .flow-content > h1 { font-size: 2.2rem; }
  .setup-lead br { display: none; }
  .setup-card { border-radius: 18px; }
  .connector-row { min-height: 88px; padding-inline: 18px; }
  .choice-block,
  .security-copy { padding-inline: 18px; }
  .owner-option { align-items: start; grid-template-columns: 18px 32px minmax(0, 1fr); }
  .flow-actions { align-items: stretch; flex-direction: column-reverse; }
  .flow-actions form,
  .flow-actions button { width: 100%; }
  .waiting-shell .flow-content,
  .success-shell .flow-content,
  .unavailable-shell .flow-content { margin-top: 80px; }
  .connection-pair .agent-avatar,
  .connection-pair .pair-logo { height: 62px; width: 62px; }
  .connection-link { width: 52px; }
  .success-line h1 { font-size: 1.8rem; }
  .success-check { height: 40px; width: 40px; }
  .success-shell .lead,
  .success-shell .small-copy { margin-left: 62px; text-align: left; }
}
@media (forced-colors: active) {
  .brand-wordmark { background-color: CanvasText; forced-color-adjust: none; }
}
`;
