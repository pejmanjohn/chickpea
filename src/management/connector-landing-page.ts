import { CHICKPEA_FAVICON_HTML, CHICKPEA_WORDMARK_CSS, CHICKPEA_WORDMARK_HTML } from '../brand/chickpea-mark.ts';
import { CONNECTOR_LOGOS } from '../config/connector-logos.ts';
import { resolveReusableConnectorPreset } from '../config/presets.ts';
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
  const ownerKind = setup.target.ownerKind ?? 'member';
  const accessLane = setup.target.accessLane ?? 'read';
  const ownerHelp = ownerKind === 'team'
    ? `Everyone who can use ${agent.name} can use this connection.`
    : `Only you can use this connection, and only when you invoke ${agent.name}.`;
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
          <div class="connector-row">
            ${connectorLogo(setup)}
            <strong>${escapeHtml(connector)}</strong>
          </div>
          <form id="connector-form" method="post" action="/setup/${encodeURIComponent(setup.setupOperationId)}/authorize">
            <section class="choice-block" aria-labelledby="owner-title">
              <h2 id="owner-title">Who uses this account?</h2>
              <span class="select-control">
                <select class="owner-select" id="connection-owner" name="ownerKind" aria-labelledby="owner-title" aria-describedby="owner-help">
                  <option value="member"${ownerKind === 'member' ? ' selected' : ''}>My connection</option>
                  <option value="team"${ownerKind === 'team' ? ' selected' : ''}>Team connection</option>
                </select>
                <svg class="select-control-caret" aria-hidden="true" focusable="false" viewBox="0 0 16 16">
                  <path d="m3.75 6.25 4.25 4.25 4.25-4.25" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>
                </svg>
              </span>
              <p id="owner-help">${escapeHtml(ownerHelp)}</p>
            </section>
            <section class="choice-block" aria-labelledby="access-title">
              <h2 id="access-title">Access</h2>
              <div class="access-control" role="radiogroup" aria-label="Connector access" aria-describedby="access-help">
                <label><input type="radio" name="access" value="read"${accessLane === 'read' ? ' checked' : ''}><span>Read-only</span></label>
                <label><input type="radio" name="access" value="write"${accessLane === 'write' ? ' checked' : ''}${writeAvailable ? '' : ' disabled'}><span>Read and write</span></label>
              </div>
              <p id="access-help">${escapeHtml(accessSummary)}</p>
            </section>
            <p class="security-copy">Sign-in opens in a secure hosted tab. Chickpea stores the connected-account reference and this Agent&rsquo;s capability ceiling, not provider refresh tokens.</p>
            <p class="flow-alert" id="flow-alert" role="alert"${failureMessage ? '' : ' hidden'}>${escapeHtml(failureMessage)}</p>
          </form>
          <div class="flow-actions">
            <form method="post" action="/setup/${encodeURIComponent(setup.setupOperationId)}/cancel"><button class="text-button" type="submit">Cancel</button></form>
            <button class="primary-button" type="submit" form="connector-form" name="intent" value="authorize">Continue to ${escapeHtml(connector)}</button>
          </div>
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
  const preset = resolveReusableConnectorPreset(presetId) ??
    resolveReusableConnectorPreset(setup.target.targetLabel);
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

function setupScript(input: { agentName: string; connector: string; toolkit: string }): string {
  const readSummary = managedConnectorReadCopy(input.toolkit, input.connector).accessSummary;
  const writeSummary = managedConnectorWriteSummary(input.toolkit, input.connector);
  return `(function(){var form=document.getElementById("connector-form"),owner=document.getElementById("connection-owner"),ownerHelp=document.getElementById("owner-help"),accessHelp=document.getElementById("access-help"),alert=document.getElementById("flow-alert"),button=document.querySelector('button[form="connector-form"][value="authorize"]');if(!form||!owner||!ownerHelp||!accessHelp||!alert||!button)return;var agent=${jsonForScript(input.agentName)},readSummary=${jsonForScript(readSummary)},writeSummary=${jsonForScript(writeSummary)};function update(){ownerHelp.textContent=owner.value==="team"?"Everyone who can use "+agent+" can use this connection.":"Only you can use this connection, and only when you invoke "+agent+".";var access=form.querySelector('input[name="access"]:checked');accessHelp.textContent=access&&access.value==="write"?writeSummary:readSummary}owner.addEventListener("change",update);form.querySelectorAll('input[name="access"]').forEach(function(control){control.addEventListener("change",update)});form.addEventListener("submit",async function(event){event.preventDefault();var label=button.textContent;button.disabled=true;button.textContent="Opening secure sign-in…";alert.hidden=true;try{var response=await fetch(form.action,{method:"POST",headers:{accept:"application/json","content-type":"application/x-www-form-urlencoded;charset=UTF-8","x-requested-with":"chickpea-setup"},body:new URLSearchParams(new FormData(form)),credentials:"same-origin"});var body=await response.json().catch(function(){return {}});if(!response.ok)throw new Error(String(body.message||"Chickpea could not start the secure sign-in. Try again."));var target=new URL(String(body.authorizationUrl||""));if(target.protocol!=="https:")throw new Error("Chickpea received an invalid secure sign-in URL.");location.assign(target.href)}catch(error){alert.textContent=error instanceof Error?error.message:"Chickpea could not start the secure sign-in. Try again.";alert.hidden=false;button.disabled=false;button.textContent=label}});update()})();`;
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
.connector-row {
  align-items: center;
  border-bottom: 1px solid var(--line);
  border-top: 1px solid var(--line);
  display: flex;
  gap: 18px;
  min-height: 110px;
  padding: 18px 16px;
}
.connector-row strong { font-size: 1.5rem; }
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
  border-bottom: 1px solid var(--line);
  margin: 0;
  padding: 28px 16px;
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
.select-control {
  display: block;
  position: relative;
  width: min(530px, 100%);
}
.owner-select {
  align-items: center;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  background: var(--card);
  border: 1px solid rgba(59, 50, 32, .22);
  border-radius: 15px;
  box-shadow: 0 2px 0 rgba(59, 50, 32, .08);
  color: var(--ink);
  cursor: pointer;
  display: block;
  font: inherit;
  font-weight: 800;
  min-height: 58px;
  padding: 0 56px 0 18px;
  width: 100%;
}
.owner-select:focus-visible { outline: 3px solid rgba(176, 84, 21, .42); outline-offset: 3px; }
.select-control-caret {
  color: var(--muted);
  height: 16px;
  pointer-events: none;
  position: absolute;
  right: 20px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
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
.security-copy { border-bottom: 1px solid var(--line); margin: 0; padding: 28px 16px; }
.flow-alert {
  background: #fff0ea;
  border: 1px solid rgba(168, 63, 52, .22);
  border-radius: 12px;
  color: var(--danger);
  font-weight: 700;
  line-height: 1.45;
  padding: 12px 14px;
}
.flow-actions { align-items: center; display: flex; gap: 22px; justify-content: center; margin-top: 28px; }
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
.primary-button:disabled { cursor: wait; opacity: .72; }
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
  .connector-row { min-height: 92px; padding-inline: 4px; }
  .choice-block,
  .security-copy { padding-inline: 4px; }
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
