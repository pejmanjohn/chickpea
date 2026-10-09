import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONNECTION_CATALOG_PRESETS } from '../src/config/presets.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import {
  renderCatalogConnectionAccessReviewPage,
  renderCatalogConnectionSetupPage,
  renderManagedConnectionDeparturePage,
  renderManagedConnectionSetupPage,
  renderManagedConnectionSuccessPage,
  renderManagedConnectionUnavailablePage,
  renderManagedConnectionWaitingPage,
  renderSetupClaimPage,
  renderSetupPanelPage,
} from '../src/management/connector-landing-page.ts';
import type { ManagementSetupRecord } from '../src/management/types.ts';
import { unstyledClasses, unusedStyledClasses } from './helpers/unstyled-classes.ts';

const setup: ManagementSetupRecord = {
  setupOperationId: 'setup_connector_page',
  organizationId: 'org_page',
  actorUserId: 'user_page',
  actorMembershipId: 'membership_page',
  origin: {
    kind: 'slack',
    workspaceId: 'T_PAGE',
    channelId: 'D_PAGE',
    threadTs: '1800000000.000100',
    agentId: 'agent_sprout',
  },
  action: 'managed_connection',
  target: {
    kind: 'managed_connection',
    provider: 'hubspot',
    targetId: 'agent:agent_sprout:managed:hubspot:member',
    targetLabel: 'HubSpot',
    expectedRevision: 1,
    agentId: 'agent_sprout',
    agentName: 'Sprout',
    replacement: false,
    ownerKind: 'member',
    accessLane: 'read',
    presetId: 'hubspot-managed',
  },
  scopes: ['hubspot.crm.objects.contacts.read'],
  status: 'pending',
  expiresAt: 1_800_086_400_000,
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_000_000,
};

test('BugSnag setup reviews tools without Meta account fields or permission promises', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    const agent = await config.createAgent({ id: 'agent_bugsnag', name: 'Error Guide', instructions: 'Investigate errors.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [] });
    const bugsnagSetup: ManagementSetupRecord = { ...setup, action: 'catalog_connection', target: { ...setup.target, kind: 'catalog_connection', provider: 'bugsnag', targetLabel: 'BugSnag', presetId: 'bugsnag' } };
    const welcome = renderCatalogConnectionSetupPage({ setup: bugsnagSetup, agent });
    assert.match(welcome, /every project available to the signed-in BugSnag account/);
    assert.match(welcome, /No tools are enabled until you save your choices after sign-in/);
    const page = renderCatalogConnectionAccessReviewPage({
      setup: bugsnagSetup,
      agent,
      accessReview: { approvedAccountIds: [], tools: [
        { name: 'bugsnag_get_error', title: 'Get Error', available: true, selected: true, effect: 'read' },
        { name: 'bugsnag_update_error', title: 'Update Error', available: true, selected: false, effect: 'write' },
      ] },
    });
    assert.match(page, /name="tool:bugsnag_get_error" checked/);
    assert.doesNotMatch(page, /name="tool:bugsnag_update_error" checked/);
    assert.match(page, /Read only/);
    assert.match(page, /May change data/);
    assert.match(page, /every project available to your BugSnag account/);
    assert.doesNotMatch(page, /<textarea|May change ads|ad accounts this Agent/);
  } finally { config.close(); }
});

test('native catalog connectors use the same dedicated Agent setup surface', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    const agent = await config.createAgent({
      id: 'agent_linear',
      name: 'Project Guide',
      instructions: 'Help the team manage projects.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const rendered = renderCatalogConnectionSetupPage({
      setup: {
        ...setup,
        setupOperationId: 'setup_catalog_linear',
        action: 'catalog_connection',
        target: {
          kind: 'catalog_connection',
          provider: 'linear',
          targetId: 'agent:agent_linear:catalog:linear',
          targetLabel: 'Linear',
          expectedRevision: agent.revision,
          agentId: agent.id,
          agentName: agent.name,
          connectionId: 'connection_catalog_linear',
          replacement: false,
          ownerKind: 'member',
          presetId: 'linear',
        },
      },
      agent,
    });

    assert.match(rendered, /Connect Linear to Project Guide/);
    assert.match(rendered, /data-connector-surface="connector-setup"/);
    assert.match(rendered, /<section class="setup-card">/);
    assert.match(rendered, /Who uses this connection\?/);
    assert.match(rendered, /<input[^>]+type="radio"[^>]+name="ownerKind"[^>]+value="member"/);
    assert.match(rendered, /<input[^>]+type="radio"[^>]+name="ownerKind"[^>]+value="team"/);
    assert.doesNotMatch(rendered, /<input[^>]+name="ownerKind"[^>]+checked/);
    assert.match(rendered, /Each person signs in with their own account\. Project Guide uses yours only for your requests\./);
    assert.match(rendered, /One shared account for everyone who can use Project Guide\./);
    assert.doesNotMatch(rendered, /<select|select-control/);
    assert.match(rendered, /<button[^>]+value="authorize" disabled>Continue to Linear<\/button>/);
    assert.match(rendered, /Choose Personal or Team to continue\./);
    assert.match(rendered, /Linear requests native read and write access/);
    assert.match(rendered, /Continue to Linear/);
    assert.doesNotMatch(rendered, /<nav|aria-label="Usage"|data-section-switcher/);
  } finally {
    config.close();
  }
});

test('managed connector pages use the real Chickpea wordmark and approved setup and success copy', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    const agent = await config.createAgent({
      id: 'agent_sprout',
      name: 'Sprout',
      instructions: 'Help the team.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const page = {
      setup,
      agent,
      avatarUrl: 'https://chickpea.example/assets/agents/agent_sprout/avatar/1',
    };
    const renderedSetup = renderManagedConnectionSetupPage(page);
    assert.match(renderedSetup, /role="img" aria-label="Chickpea"/);
    assert.match(renderedSetup, /--chickpea-wordmark-image:url\("\/chickpea-wordmark-512\.png\?v=[a-f0-9]{12}"\)/);
    assert.match(renderedSetup, /Connect HubSpot to Sprout/);
    assert.match(renderedSetup, /Who uses this connection\?/);
    assert.match(renderedSetup, /Pick one to continue\./);
    assert.match(renderedSetup, /Each person signs in with their own account\. Sprout uses yours only for your requests\./);
    assert.match(renderedSetup, /One shared account for everyone who can use Sprout\./);
    assert.match(renderedSetup, /Can search and read CRM records\. Cannot change HubSpot data\./);
    assert.match(renderedSetup, /<input[^>]+type="radio"[^>]+name="ownerKind"[^>]+value="member"/);
    assert.match(renderedSetup, /<input[^>]+type="radio"[^>]+name="ownerKind"[^>]+value="team"/);
    assert.doesNotMatch(renderedSetup, /<input[^>]+name="ownerKind"[^>]+checked/);
    assert.match(renderedSetup, /<button[^>]+value="authorize"[^>]+disabled/);
    assert.match(renderedSetup, /<input[^>]+type="hidden"[^>]+name="access"[^>]+value="read"/);
    assert.doesNotMatch(renderedSetup, /<input[^>]+type="radio"[^>]+name="access"|>Read-only</);
    assert.match(renderedSetup, /Review the permissions requested on the provider/);
    assert.doesNotMatch(renderedSetup, /Read and write unavailable in this flow/);
    assert.match(renderedSetup, /Continue to HubSpot/);
    assert.match(renderedSetup, /<form method="post" action="\/setup\/setup_connector_page\/cancel">/);
    assert.match(renderedSetup, /<button[^>]+form="connector-form"[^>]+value="authorize"/);
    assert.doesNotMatch(renderedSetup, /Chickpea Admin<\/span>/);

    const sheetsSetup = renderManagedConnectionSetupPage({
      ...page,
      writeAvailable: true,
      setup: {
        ...setup,
        target: {
          ...setup.target,
          provider: 'googlesheets',
          targetId: 'agent:agent_sprout:managed:googlesheets:member',
          targetLabel: 'Google Sheets',
          presetId: 'google-sheets',
        },
      },
    });
    assert.match(sheetsSetup, /class="connector-logo" style="--connector-accent:#0F9D58"/);
    assert.match(sheetsSetup, /<input[^>]+type="hidden"[^>]+name="access"[^>]+value="write"/);
    assert.doesNotMatch(sheetsSetup, /read-only|name="access"[^>]+value="read"/);

    const waiting = renderManagedConnectionWaitingPage({ ...page, setup: { ...setup, status: 'authorizing' } });
    assert.match(waiting, /Finishing your HubSpot connection/);
    assert.match(waiting, /\/managed\/poll/);
    assert.match(waiting, /response\.status===403\|\|response\.status===409/);
    assert.match(waiting, /checkFailures>=12/);
    assert.match(waiting, />Start over<\/button>/);
    assert.match(waiting, /action="\/setup\/setup_connector_page\/cancel"/);

    const success = renderManagedConnectionSuccessPage({ ...page, setup: { ...setup, status: 'completed' } });
    assert.match(success, /HubSpot is now connected to Sprout/);
    assert.match(success, /Your personal connection is ready\./);
    assert.doesNotMatch(success, /read-only connection/);
    assert.match(success, /You can close this tab now\./);
    assert.match(success, /class="connection-pair"/);
    assert.match(success, /class="success-copy"/);
    assert.match(success, /class="success-check"/);
    assert.match(success, /class="lead success-summary"/);
    assert.match(success, /\.success-line h1 \{[^}]*white-space: nowrap;/);
    assert.match(success, /\.success-shell \.success-summary \{ font-weight: 400; \}/);
    assert.doesNotMatch(success, /<button/);
    assert.doesNotMatch(success, /Return to Slack/);
    assert.doesNotMatch(success, /Saved connection setup/);

    const selectedSuccess = renderManagedConnectionSuccessPage({
      ...page,
      setup: {
        ...setup,
        status: 'completed',
        connectionAccountId: 'connection_saved',
        completedByUserId: 'user_completer',
        completedByMembershipId: 'membership_completer',
        completedAt: setup.updatedAt,
        tokenDigest: 'private-token-digest',
        browserSessionDigest: 'private-browser-digest',
        receipt: {
          kind: 'connector_connected',
          setupOperationId: setup.setupOperationId,
          connector: 'HubSpot',
          toolkit: 'hubspot',
          agentId: agent.id,
          agentName: agent.name,
          ownerKind: 'team',
          accessLane: 'write',
          completedAt: setup.updatedAt,
        },
      },
    });
    assert.match(selectedSuccess, /Your team connection is ready\./);
    assert.match(selectedSuccess, /You can close this tab now\./);
    assert.doesNotMatch(selectedSuccess, /<details|Saved connection setup/);
    assert.doesNotMatch(selectedSuccess, /setup_connector_page|connection_saved|user_completer|membership_completer/);
    assert.doesNotMatch(selectedSuccess, /private-token-digest|private-browser-digest/);
  } finally {
    config.close();
  }
});

test('managed connector owner chooser uses compact icon cards and requires a choice', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    const agent = await config.createAgent({
      id: 'agent_sprout',
      name: 'Sprout',
      instructions: 'Help the team.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const rendered = renderManagedConnectionSetupPage({ setup, agent });

    assert.match(rendered, /class="owner-option-icon owner-option-icon-personal"/);
    assert.match(rendered, /class="owner-option-icon owner-option-icon-team"/);
    assert.match(rendered, /\.owner-option-icon \{[^}]*height: 32px;[^}]*width: 32px;/s);
    assert.match(rendered, /\.owner-option-icon svg \{ height: 16px; width: 16px; \}/);
    assert.match(rendered, /\.owner-option \{[^}]*min-height: 88px;/s);
    assert.match(rendered, /button\.disabled=!selectedOwner\(\)/);
    assert.doesNotMatch(rendered, /select-control-caret/);
  } finally {
    config.close();
  }
});

test('managed connector copy and success scope stay accurate for a team Gmail handoff', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    const agent = await config.createAgent({
      id: 'agent_mailroom',
      name: 'Mailroom',
      instructions: 'Help the team with email research.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const gmailSetup: ManagementSetupRecord = {
      ...setup,
      setupOperationId: 'setup_connector_gmail_team',
      target: {
        ...setup.target,
        provider: 'gmail',
        targetId: 'agent:agent_mailroom:managed:gmail:team',
        targetLabel: 'Gmail',
        agentId: agent.id,
        agentName: agent.name,
        ownerKind: 'team',
        presetId: 'gmail',
      },
      scopes: ['gmail.profile.read', 'gmail.messages.search'],
    };
    const page = { setup: gmailSetup, agent };
    const renderedSetup = renderManagedConnectionSetupPage(page);
    assert.match(renderedSetup, /Mailroom can use Gmail when you ask./);
    assert.match(renderedSetup, /Can use read-only Gmail capabilities. Cannot change Gmail data./);
    assert.doesNotMatch(renderedSetup, /CRM/);

    const success = renderManagedConnectionSuccessPage({
      ...page,
      setup: { ...gmailSetup, status: 'completed' },
    });
    assert.match(success, /Your team connection is ready./);
    assert.doesNotMatch(success, /Your personal/);
  } finally {
    config.close();
  }
});

function catalogSetup(presetId: string, label: string): ManagementSetupRecord {
  return {
    ...setup,
    setupOperationId: `setup_catalog_${presetId.replaceAll('-', '_')}`,
    action: 'catalog_connection',
    target: {
      kind: 'catalog_connection',
      provider: presetId,
      targetId: `agent:agent_sprout:catalog:${presetId}`,
      targetLabel: label,
      expectedRevision: 1,
      agentId: 'agent_sprout',
      agentName: 'Sprout',
      connectionId: `connection_${presetId}`,
      replacement: false,
      ownerKind: 'member',
      presetId,
    },
    status: 'claimed',
  };
}

const sprout: CustomAgentConfig = {
  id: 'agent_sprout',
  kind: 'user',
  name: 'Sprout',
  revision: 1,
  enabled: true,
  instructions: 'Help the team.',
  skills: [],
  mcpServers: [],
  apiConnections: [],
  repositories: [],
};

test('API-preset connectors ask for their fields in styled inputs inside the setup card', () => {
  const rendered = renderCatalogConnectionSetupPage({ setup: catalogSetup('zendesk', 'Zendesk'), agent: sprout });
  assert.match(rendered, /<section class="setup-card">/);
  assert.match(rendered, /<input class="text-input" id="workspace-subdomain" name="workspaceSubdomain"[^>]+required>/);
  assert.match(rendered, /<input class="text-input" id="connection-credential" name="credential" type="password"[^>]+required>/);
  assert.match(rendered, /<input[^>]+type="radio"[^>]+name="ownerKind"[^>]+value="team"/);
  assert.doesNotMatch(rendered, /<select|owner-select|select-control/);
});

test('every connector and setup page styles each class it uses, and every styled class is used', () => {
  const pages: Array<[string, string]> = CONNECTION_CATALOG_PRESETS.map((preset) => [
    `catalog setup for ${preset.id}`,
    renderCatalogConnectionSetupPage({ setup: catalogSetup(preset.id, preset.name), agent: sprout }),
  ]);
  const metaAds = catalogSetup('meta-ads', 'Meta Ads');
  pages.push(
    ['Meta Ads access review', renderCatalogConnectionAccessReviewPage({
      setup: metaAds,
      agent: sprout,
      accessReview: { approvedAccountIds: ['act_1234567890'], tools: [
        { name: 'ads_get_insights', title: 'Get insights', available: true, selected: true, effect: 'read' },
        { name: 'ads_create_campaign', available: false, selected: false, effect: 'write', requiresEditingAccess: true },
      ] },
    })],
    ['BugSnag access review', renderCatalogConnectionAccessReviewPage({
      setup: catalogSetup('bugsnag', 'BugSnag'),
      agent: sprout,
      accessReview: { approvedAccountIds: [], tools: [] },
    })],
    ['managed setup, read', renderManagedConnectionSetupPage({ setup, agent: sprout })],
    ['managed setup, write', renderManagedConnectionSetupPage({ setup, agent: sprout, writeAvailable: true, failureMessage: 'Try again.' })],
    ['managed waiting', renderManagedConnectionWaitingPage({ setup, agent: sprout })],
    ['managed departure', renderManagedConnectionDeparturePage({ setup, agent: sprout }, 'https://hubspot.example/authorize')],
    ['managed success', renderManagedConnectionSuccessPage({ setup: { ...setup, status: 'completed' }, agent: sprout })],
    ['success for a connector without a logo', renderManagedConnectionSuccessPage({
      setup: { ...setup, status: 'completed', target: { ...setup.target, provider: 'acme', targetLabel: 'Acme CRM', presetId: 'acme' } },
      agent: sprout,
    })],
    ['connection unavailable', renderManagedConnectionUnavailablePage()],
    ['one-use claim', renderSetupClaimPage({ setupId: 'setup_claim', reusable: false })],
    ['reusable claim', renderSetupClaimPage({ setupId: 'setup_claim', reusable: true })],
    ['generic setup panel', renderSetupPanelPage({
      title: 'Connect Gmail',
      surface: 'setup-summary',
      content: '<p class="eyebrow">Chickpea delegated setup</p><h1>Connect Gmail</h1><dl><div><dt>Provider</dt><dd>gmail</dd></div></dl>' +
        '<p class="warning">This will replace the currently connected credential.</p><p class="error">Setup did not complete.</p>' +
        '<form method="post" action="/setup/setup_panel/complete"><label>Credential<input type="password" name="credential" required></label><button type="submit">Continue</button></form>',
    })],
  );
  for (const [name, html] of pages) {
    assert.deepEqual(unstyledClasses(html), [], `${name} uses classes with no CSS rule`);
  }
  assert.deepEqual(unusedStyledClasses(pages.map(([, html]) => html)), [], 'CSS rules style classes no page uses');
});

test('the setup claim page shows a branded loading state and stops it when the link fails', () => {
  const claim = renderSetupClaimPage({ setupId: 'setup_claim', reusable: true });
  assert.match(claim, /data-connector-surface="setup-claim"/);
  assert.match(claim, /role="img" aria-label="Chickpea"/);
  assert.match(claim, /<span class="setup-spinner" id="claim-spinner" aria-hidden="true"><\/span>/);
  assert.match(claim, /<p class="lead" id="status" role="status" aria-live="polite">Checking this secure setup link…<\/p>/);
  assert.match(claim, /function unavailable\(\)\{document\.getElementById\("claim-spinner"\)\.hidden=true;/);
  assert.match(claim, /\.setup-spinner\[hidden\] \{ display: none; \}/);
  assert.match(claim, /prefers-reduced-motion: reduce[^}]*\.setup-spinner \{ animation: none; \}/);
  assert.match(claim, /fetch\("\/setup\/setup_claim\/exchange"/);
  assert.match(renderSetupClaimPage({ setupId: 'setup_claim', reusable: false }), /Checking this one-use setup link…/);
});
