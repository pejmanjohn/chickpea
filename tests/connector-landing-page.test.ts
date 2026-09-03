import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import {
  renderCatalogConnectionSetupPage,
  renderManagedConnectionSetupPage,
  renderManagedConnectionSuccessPage,
  renderManagedConnectionWaitingPage,
} from '../src/management/connector-landing-page.ts';
import type { ManagementSetupRecord } from '../src/management/types.ts';

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
    assert.match(rendered, /<select[^>]+name="ownerKind"/);
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
    assert.match(renderedSetup, /<input[^>]+type="radio"[^>]+name="access"[^>]+value="read"[^>]+checked/);
    assert.match(renderedSetup, /<input[^>]+type="radio"[^>]+name="access"[^>]+value="write"/);
    assert.doesNotMatch(renderedSetup, /Read and write unavailable in this flow/);
    assert.match(renderedSetup, /Continue to HubSpot/);
    assert.match(renderedSetup, /<form method="post" action="\/setup\/setup_connector_page\/cancel">/);
    assert.match(renderedSetup, /<button[^>]+form="connector-form"[^>]+value="authorize"/);
    assert.doesNotMatch(renderedSetup, /Chickpea Admin<\/span>/);

    const sheetsSetup = renderManagedConnectionSetupPage({
      ...page,
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

    const waiting = renderManagedConnectionWaitingPage({ ...page, setup: { ...setup, status: 'authorizing' } });
    assert.match(waiting, /Finishing your HubSpot connection/);
    assert.match(waiting, /\/managed\/poll/);
    assert.match(waiting, /response\.status===403\|\|response\.status===409/);
    assert.match(waiting, /checkFailures>=12/);
    assert.match(waiting, />Start over<\/button>/);
    assert.match(waiting, /action="\/setup\/setup_connector_page\/cancel"/);

    const success = renderManagedConnectionSuccessPage({ ...page, setup: { ...setup, status: 'completed' } });
    assert.match(success, /HubSpot is now connected to Sprout/);
    assert.match(success, /Your personal, read-only connection is ready\./);
    assert.match(success, /You can close this tab now\./);
    assert.match(success, /class="connection-pair"/);
    assert.match(success, /class="success-copy"/);
    assert.match(success, /class="success-check"/);
    assert.match(success, /class="lead success-summary"/);
    assert.match(success, /\.success-line h1 \{[^}]*white-space: nowrap;/);
    assert.match(success, /\.success-shell \.success-summary \{ font-weight: 400; \}/);
    assert.doesNotMatch(success, /<button/);
    assert.doesNotMatch(success, /Return to Slack/);

    const selectedSuccess = renderManagedConnectionSuccessPage({
      ...page,
      setup: {
        ...setup,
        status: 'completed',
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
    assert.match(selectedSuccess, /Your team, read and write connection is ready\./);
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
    assert.match(renderedSetup, /Mailroom can use Gmail&#39;s read-only capabilities when you ask./);
    assert.match(renderedSetup, /Can use read-only Gmail capabilities. Cannot change Gmail data./);
    assert.doesNotMatch(renderedSetup, /CRM/);

    const success = renderManagedConnectionSuccessPage({
      ...page,
      setup: { ...gmailSetup, status: 'completed' },
    });
    assert.match(success, /Your team, read-only connection is ready./);
    assert.doesNotMatch(success, /Your personal/);
  } finally {
    config.close();
  }
});
