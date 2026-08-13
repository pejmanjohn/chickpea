import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowSquareOut,
  Brain,
  CaretDown,
  CaretRight,
  Check,
  CheckCircle,
  Copy,
  Gear,
  GithubLogo,
  Hash,
  Lightning,
  MagnifyingGlass,
  Plus,
  Robot,
  SlackLogo,
  Sparkle,
  Stack,
  X,
} from "@phosphor-icons/react";
import chickpeaMark from "./assets/chickpea-mark.svg";

const skillOptions = [
  { id: "project-health", name: "Project health", note: "Find blockers and work at risk" },
  { id: "status-updates", name: "Status updates", note: "Turn project activity into concise updates" },
  { id: "research-briefs", name: "Research briefs", note: "Synthesize sources into a useful brief" },
  { id: "incident-triage", name: "Incident triage", note: "Organize reports and next actions" },
  { id: "release-notes", name: "Release notes", note: "Draft customer-friendly release summaries" },
  { id: "customer-insight", name: "Customer insight", note: "Group feedback and surface themes" },
];

const connectorOptions = [
  { id: "linear", name: "Linear", iconUrl: "https://cdn.simpleicons.org/linear/5E6AD2" },
  { id: "drive", name: "Google Drive", iconUrl: "https://cdn.simpleicons.org/googledrive" },
  { id: "notion", name: "Notion", iconUrl: "https://cdn.simpleicons.org/notion/24211B" },
  { id: "asana", name: "Asana", iconUrl: "https://cdn.simpleicons.org/asana/F06A6A" },
  { id: "sentry", name: "Sentry", iconUrl: "https://cdn.simpleicons.org/sentry/5B3A86" },
  { id: "gmail", name: "Gmail", iconUrl: "https://cdn.simpleicons.org/gmail/EA4335" },
];

const repositoryOptions = [
  { id: "web-app", name: "acme/web-app", note: "Product code" },
  { id: "docs", name: "acme/docs", note: "Product documentation" },
  { id: "marketing", name: "acme/marketing-site", note: "Marketing site" },
  { id: "data", name: "acme/data-pipelines", note: "Analytics jobs" },
];

const availableChannels = [
  { id: "all-acme-inc", name: "all-acme-inc" },
  { id: "product", name: "product" },
  { id: "customer-feedback", name: "customer-feedback" },
  { id: "eng-releases", name: "eng-releases" },
];

function createAgentMemoryFiles(agentName) {
  return [
    {
      id: "MEMORY.md",
      name: "MEMORY.md",
      generated: true,
      content: `# ${agentName} Memory Index\n\n- [operating-rhythm](operating-rhythm.md) — How Acme keeps projects moving.\n- [product-priorities](product-priorities.md) — Current product focus and tradeoffs.\n- [team-preferences](team-preferences.md) — Durable ways the team prefers to work.\n`,
    },
    {
      id: "operating-rhythm",
      name: "operating-rhythm.md",
      generated: false,
      status: "active",
      version: 4,
      modified: "Aug 12, 2026",
      type: "project",
      description: "How Acme keeps projects moving.",
      body: "# Operating rhythm\n\n- Surface blockers before weekly planning.\n- Name an owner for every next step.\n- Ask before creating or changing work in connected tools.",
    },
    {
      id: "product-priorities",
      name: "product-priorities.md",
      generated: false,
      status: "active",
      version: 2,
      modified: "Aug 10, 2026",
      type: "decision",
      description: "Current product focus and tradeoffs.",
      body: "# Product priorities\n\n1. Make onboarding feel effortless.\n2. Prove value with a useful first Slack reply.\n3. Prefer reversible actions until a person confirms.",
    },
    {
      id: "team-preferences",
      name: "team-preferences.md",
      generated: false,
      status: "active",
      version: 3,
      modified: "Aug 8, 2026",
      type: "preference",
      description: "Durable ways the team prefers to work.",
      body: "# Team preferences\n\n- Keep updates concise and action-oriented.\n- Link decisions back to their source.\n- Raise uncertainty instead of quietly guessing.",
    },
  ];
}

const initialAgents = [
  {
    id: "default",
    name: "Default Agent",
    tagline: "Acme’s operations teammate",
    instructions:
      "You are Chickpea, Acme Inc’s operations teammate. Help the team keep projects moving, turn scattered context into clear decisions, and leave every request with an actionable next step.",
    skills: ["project-health", "status-updates", "research-briefs", "incident-triage", "release-notes"],
    connectors: ["linear", "drive", "notion", "asana", "sentry", "gmail"],
    repositories: ["web-app", "docs", "marketing"],
    channels: ["all-acme-inc", "product"],
    directMessages: true,
    memoryFiles: createAgentMemoryFiles("Default Agent"),
  },
  {
    id: "release-scribe",
    name: "Release Scribe",
    tagline: "Turns shipped work into updates",
    instructions:
      "Track what ships, identify the customer impact, and draft clear release updates. Ask before publishing anything externally.",
    skills: ["release-notes", "status-updates"],
    connectors: ["linear", "drive"],
    repositories: ["web-app", "docs"],
    channels: ["eng-releases"],
    directMessages: false,
    memoryFiles: createAgentMemoryFiles("Release Scribe"),
  },
  {
    id: "customer-insights",
    name: "Customer Insights",
    tagline: "Finds themes in customer feedback",
    instructions:
      "Turn customer conversations into evidence-backed themes, product gaps, and recommended next steps. Preserve links to the source feedback.",
    skills: ["customer-insight", "research-briefs"],
    connectors: ["notion", "asana", "gmail"],
    repositories: ["docs"],
    channels: ["customer-feedback"],
    directMessages: false,
    memoryFiles: createAgentMemoryFiles("Customer Insights"),
  },
];

function selectedItems(options, ids) {
  return ids.map((id) => options.find((option) => option.id === id)).filter(Boolean);
}

function ConnectorLogo({ connector }) {
  return <img className="connector-logo" src={connector.iconUrl} alt="" />;
}

function clampCopy(value, limit = 140) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trim()}…`;
}

function Brand() {
  return (
    <button className="brand" type="button" onClick={() => window.dispatchEvent(new CustomEvent("go-agent"))}>
      <img src={chickpeaMark} alt="" />
      <strong>Chickpea</strong>
      <span>cloudflare · workers</span>
    </button>
  );
}

function IconButton({ label, children, onClick }) {
  return (
    <button className="icon-button" aria-label={label} title={label} type="button" onClick={onClick}>
      {children}
    </button>
  );
}

function Sidebar({ view, agents, selectedAgentId, onSelectAgent, onOpenChannels }) {
  return (
    <aside className="sidebar">
      <Brand />
      <div className="sidebar-section">
        <p className="eyebrow">Agents</p>
        <div className="slack-row">
          <SlackLogo weight="fill" aria-hidden="true" />
          <span>Slack</span>
          <small><i />Connected</small>
        </div>
        <div className="workspace-row"><CaretDown size={14} /> Acme Inc</div>
        <nav className="agent-nav" aria-label="Agents">
          {agents.map((agent) => (
            <button
              key={agent.id}
              className={view === "agent" && selectedAgentId === agent.id ? "active" : ""}
              type="button"
              onClick={() => onSelectAgent(agent.id)}
            >
              <span className={`agent-nav-icon ${agent.id}`}><Robot weight="fill" /></span>
              <span className="agent-nav-copy"><strong>{agent.name}</strong><small>{agent.channels.length} {agent.channels.length === 1 ? "channel" : "channels"}</small></span>
            </button>
          ))}
          <button className="sidebar-add" type="button"><Plus size={15} /> New Agent</button>
        </nav>
      </div>
      <nav className="primary-nav" aria-label="Admin areas">
        <button className={view === "agent" || view === "channel" ? "active" : ""} type="button" onClick={() => onSelectAgent(selectedAgentId)}>Agents</button>
        <button className={view === "channels" ? "active" : ""} type="button" onClick={onOpenChannels}>Channels</button>
        <button type="button">Team</button>
        <button type="button">Usage</button>
        <button type="button">Settings</button>
        <button type="button">Account</button>
      </nav>
    </aside>
  );
}

function ChannelsIndexPage({ agents, onOpenChannel, onOpenAgent, toast }) {
  const [query, setQuery] = useState("");
  const assignments = availableChannels.map((channel) => {
    const assignedAgent = agents.find((item) => item.channels.includes(channel.id));
    return { channel, agent: assignedAgent };
  });
  const visibleAssignments = assignments.filter(({ channel, agent }) => `${channel.name} ${agent?.name || "unconfigured"}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <main className="content channels-index-page">
      <Header
        kicker="Slack"
        title="Channels"
        actions={<button className="primary-button" type="button" onClick={() => toast("Add Slack channel flow opened")}><Plus /> Add channel</button>}
      />
      <p className="page-intro">See where Chickpea works and which Agent handles each channel.</p>

      <section className="channels-overview-card">
        <div className="channels-overview-summary">
          <div><strong>{assignments.filter((item) => item.agent).length}</strong><span>configured channels</span></div>
          <div><strong>{agents.length}</strong><span>active Agents</span></div>
          <span className="ready-chip"><CheckCircle weight="fill" /> Slack connected</span>
        </div>
        <label className="channels-search"><MagnifyingGlass /><input aria-label="Find a channel or Agent" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a channel or Agent" /></label>
      </section>

      <section className="channels-index-list" aria-label="Configured channels">
        <div className="channels-index-head"><span>Channel</span><span>Agent</span><span>Behavior</span><span>Status</span><span /></div>
        {visibleAssignments.map(({ channel, agent }) => (
          <div className="channels-index-row" key={channel.id}>
            <button className="channels-index-channel" type="button" onClick={() => agent && onOpenChannel(channel.id, agent.id)}>
              <span className="channel-hash"><Hash weight="bold" /></span>
              <span><strong>{channel.name}</strong><small>Acme Inc</small></span>
            </button>
            {agent ? (
              <button className="channels-index-agent" type="button" onClick={() => onOpenAgent(agent.id)}>
                <span className={`agent-nav-icon ${agent.id}`}><Robot weight="fill" /></span>
                <span><strong>{agent.name}</strong><small>{agent.tagline}</small></span>
              </button>
            ) : <span className="unconfigured-label">No Agent</span>}
            <span className="channels-index-behavior"><strong>Mentions + useful moments</strong><small>Ambient participation on</small></span>
            <span className={agent ? "channel-status ready" : "channel-status"}><i />{agent ? "Ready" : "Needs setup"}</span>
            <button className="row-chevron" type="button" aria-label={`Open ${channel.name}`} onClick={() => agent && onOpenChannel(channel.id, agent.id)}><CaretRight /></button>
          </div>
        ))}
        {visibleAssignments.length === 0 ? <div className="channels-empty">No channels or Agents match “{query}”.</div> : null}
      </section>
    </main>
  );
}

function Header({ title, kicker, actions }) {
  return (
    <header className="page-header">
      <div>
        {kicker ? <p className="eyebrow">{kicker}</p> : null}
        <h1>{title}</h1>
      </div>
      <div className="header-actions">{actions}</div>
    </header>
  );
}

function PreviewPill({ children, icon, onClick, tone = "plain" }) {
  return (
    <button className={`preview-pill ${tone}`} type="button" onClick={onClick}>
      {icon}
      <span>{children}</span>
    </button>
  );
}

function MorePill({ count, onClick }) {
  if (count <= 0) return null;
  return <PreviewPill onClick={onClick} tone="more">+{count} more</PreviewPill>;
}

function AgentPage({ agent, setAgent, openChannel, openManager, openChannels, toast }) {
  const skills = selectedItems(skillOptions, agent.skills);
  const connectors = selectedItems(connectorOptions, agent.connectors);
  const repositories = selectedItems(repositoryOptions, agent.repositories);
  const channels = selectedItems(availableChannels, agent.channels);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("skills");
  const [selectedMemoryId, setSelectedMemoryId] = useState("operating-rhythm");
  const selectedMemory = agent.memoryFiles.find((file) => file.id === selectedMemoryId) || agent.memoryFiles[0];
  const [memoryDraft, setMemoryDraft] = useState({ type: "fact", description: "", body: "" });

  useEffect(() => {
    if (selectedMemory.generated) {
      setMemoryDraft({ type: "fact", description: "", body: "" });
      return;
    }
    setMemoryDraft({ type: selectedMemory.type, description: selectedMemory.description, body: selectedMemory.body });
  }, [agent.id, selectedMemory.id, selectedMemory.generated, selectedMemory.version]);

  function saveMemoryFile() {
    if (selectedMemory.generated) return;
    setAgent((current) => ({
      ...current,
      memoryFiles: current.memoryFiles.map((file) => file.id === selectedMemory.id ? {
        ...file,
        ...memoryDraft,
        version: file.version + 1,
        modified: "Just now",
      } : file),
    }));
    toast(`${selectedMemory.name} saved`);
  }

  function discardMemoryChanges() {
    if (selectedMemory.generated) return;
    setMemoryDraft({ type: selectedMemory.type, description: selectedMemory.description, body: selectedMemory.body });
    toast("Memory changes discarded");
  }

  function deleteMemoryFile() {
    if (selectedMemory.generated) return;
    setAgent((current) => ({ ...current, memoryFiles: current.memoryFiles.filter((file) => file.id !== selectedMemory.id) }));
    setSelectedMemoryId("MEMORY.md");
    toast(`${selectedMemory.name} deleted`);
  }

  const tabContent = {
    instructions: {
      description: "The role, priorities, and boundaries this Agent follows in every channel.",
      body: <label className="tab-instruction-editor"><span className="sr-only">Agent instructions</span><textarea aria-label="Agent instructions" value={agent.instructions} onChange={(event) => setAgent((current) => ({ ...current, instructions: event.target.value }))} rows={6} /></label>,
    },
    skills: {
      description: "Repeatable ways Chickpea knows how to help.",
      action: () => openManager("skills"),
      actionLabel: "Manage skills",
      body: <div className="tab-item-grid">{skills.slice(0, 4).map((skill) => <button type="button" key={skill.id} onClick={() => openManager("skills")}><Sparkle /><span><strong>{skill.name}</strong><small>{skill.note}</small></span></button>)}<button className="tab-add-card" type="button" onClick={() => openManager("skills")}><Plus /><span><strong>Add or change skills</strong><small>{skills.length} selected now</small></span></button></div>,
    },
    connectors: {
      description: "Apps Chickpea can read from or act in.",
      action: () => openManager("connectors"),
      actionLabel: "Manage connectors",
      body: <div className="tab-item-grid">{connectors.slice(0, 5).map((connector) => <button type="button" key={connector.id} onClick={() => openManager("connectors")}><ConnectorLogo connector={connector} /><span><strong>{connector.name}</strong><small>Connected</small></span></button>)}<button className="tab-add-card" type="button" onClick={() => openManager("connectors")}><Plus /><span><strong>Add connector</strong><small>{connectors.length} connected now</small></span></button></div>,
    },
    repositories: {
      description: "Code and documentation Chickpea can work with.",
      action: () => openManager("repositories"),
      actionLabel: "Manage repositories",
      body: <div className="tab-item-grid">{repositories.map((repository) => <button type="button" key={repository.id} onClick={() => openManager("repositories")}><GithubLogo /><span><strong>{repository.name}</strong><small>{repository.note}</small></span></button>)}<button className="tab-add-card" type="button" onClick={() => openManager("repositories")}><Plus /><span><strong>Add repository</strong><small>Choose from GitHub</small></span></button></div>,
    },
    memory: {
      description: "Durable context this Agent can use wherever it works.",
      body: (
        <div className="agent-memory-layout">
          <aside className="agent-memory-pane" aria-label="Memory files">
            <div className="agent-memory-pane-title"><span>Files</span><small>{agent.memoryFiles.length}</small></div>
            <div className="agent-memory-file-list">
              {agent.memoryFiles.map((file) => (
                <button className={`agent-memory-file ${selectedMemory.id === file.id ? "active" : ""}`} type="button" key={file.id} onClick={() => setSelectedMemoryId(file.id)}>
                  <span className="agent-memory-file-name">{file.name}</span>
                  <span className="agent-memory-file-meta">{file.generated ? "Generated · read-only" : `${file.status} · v${file.version}`}</span>
                </button>
              ))}
            </div>
          </aside>
          <section className="agent-memory-editor">
            <header className="agent-memory-editor-head">
              <div>
                <h3>{selectedMemory.name}</h3>
                <p>{selectedMemory.generated ? "Generated index · changes are made through individual files." : `Version ${selectedMemory.version} · modified ${selectedMemory.modified}`}</p>
              </div>
              <span className={`memory-state ${selectedMemory.generated ? "readonly" : ""}`}>{selectedMemory.generated ? "Read-only" : selectedMemory.status}</span>
            </header>
            {selectedMemory.generated ? (
              <pre className="agent-memory-source">{selectedMemory.content}</pre>
            ) : (
              <div className="agent-memory-form">
                <div className="agent-memory-fields">
                  <label><span>Name</span><input value={selectedMemory.id} readOnly /></label>
                  <label><span>Type</span><select value={memoryDraft.type} onChange={(event) => setMemoryDraft((current) => ({ ...current, type: event.target.value }))}><option value="fact">Fact</option><option value="decision">Decision</option><option value="project">Project</option><option value="feedback">Feedback</option><option value="preference">Preference</option></select></label>
                </div>
                <label><span>Description</span><input value={memoryDraft.description} onChange={(event) => setMemoryDraft((current) => ({ ...current, description: event.target.value }))} /></label>
                <label><span>Markdown body</span><textarea rows="8" value={memoryDraft.body} onChange={(event) => setMemoryDraft((current) => ({ ...current, body: event.target.value }))} /></label>
                <div className="agent-memory-actions">
                  <button className="danger-text-button" type="button" onClick={deleteMemoryFile}>Delete memory</button>
                  <span />
                  <button className="secondary-button" type="button" onClick={discardMemoryChanges}>Discard</button>
                  <button className="primary-button" type="button" onClick={saveMemoryFile}>Save changes</button>
                </div>
                <details className="agent-memory-details"><summary>Revision history <span>{selectedMemory.version}</span></summary><p>Previous versions remain available for review and recovery.</p></details>
              </div>
            )}
          </section>
        </div>
      ),
    },
  };

  return (
    <main className="content profile-page">
      <Header
        kicker="Agent"
        title={agent.name}
        actions={
          <>
            <span className="status-chip"><i /> Active</span>
            <button className="quiet-button" type="button" onClick={() => toast("Agent menu opened")}>•••</button>
          </>
        }
      />
      <p className="page-intro">{agent.tagline}. Configure how it thinks, what it can use, and where it works.</p>

      <section className="profile-tabs-card">
        <div className="profile-tabs" role="tablist" aria-label="Agent setup">
          {[
            ["instructions", "Instructions"],
            ["skills", "Skills"],
            ["connectors", "Connectors"],
            ["repositories", "Repositories"],
            ["memory", "Memory"],
          ].map(([id, label]) => (
            <button key={id} role="tab" aria-selected={activeTab === id} className={activeTab === id ? "active" : ""} type="button" onClick={() => setActiveTab(id)}>{label}</button>
          ))}
        </div>
        <div className="profile-tab-panel" role="tabpanel">
          <div className="profile-tab-head">
            <div><h2>{activeTab[0].toUpperCase() + activeTab.slice(1)}</h2><p>{tabContent[activeTab].description}</p></div>
            {tabContent[activeTab].action ? <button className="secondary-button" type="button" onClick={tabContent[activeTab].action}>{tabContent[activeTab].actionLabel}</button> : null}
          </div>
          {tabContent[activeTab].body}
        </div>
      </section>

      <section className="persistent-placement">
        <div className="persistent-placement-heading">
          <span className="profile-line-icon"><Hash size={19} /></span>
          <div><h2>Where it works</h2><p>Open a channel to tune how this Agent behaves there.</p></div>
        </div>
        <div className="preview-list">
          {channels.map((channel) => <PreviewPill key={channel.id} onClick={() => openChannel(channel.id)} icon={<Hash size={15} />}>{channel.name}</PreviewPill>)}
          {agent.directMessages ? <PreviewPill onClick={() => toast(`Direct messages use ${agent.name}`)} icon={<Robot size={15} />}>Direct messages</PreviewPill> : null}
        </div>
        <button className="row-link" type="button" onClick={openChannels}>Add to channels <CaretRight /></button>
      </section>

      <section className="profile-model-card">
        <div className="persistent-placement-heading">
          <span className="profile-line-icon"><Robot size={19} /></span>
          <div><h2>Model</h2><p>The intelligence this Agent uses for every response.</p></div>
        </div>
        <label className="profile-model-select"><span className="sr-only">Model</span><select defaultValue="glm"><option value="glm">Cloudflare · GLM 5.2</option><option>Claude Sonnet 4</option></select></label>
      </section>

      <section className={`advanced ${advancedOpen ? "open" : ""}`}>
        <button className="advanced-trigger" type="button" onClick={() => setAdvancedOpen((value) => !value)}>
          <span><Gear size={18} /> Advanced</span>
          {advancedOpen ? <CaretDown /> : <CaretRight />}
        </button>
        {advancedOpen ? (
          <div className="advanced-setting-rows">
            <label className="advanced-setting-row">
              <span><strong>Slack identity</strong><small>Who sends this Agent’s replies in Slack.</small></span>
              <select defaultValue="chickpea"><option value="chickpea">@Chickpea</option></select>
            </label>
            <label className="advanced-setting-row">
              <span><strong>Coding sandbox</strong><small>Run code and work with repositories in an isolated environment. Requires a Cloudflare redeploy.</small></span>
              <span className="setting-toggle"><input type="checkbox" /><span /></span>
            </label>
          </div>
        ) : null}
      </section>

      <footer className="sticky-actions">
        <span>Changes apply anywhere this Agent works.</span>
        <button className="secondary-button" type="button" onClick={() => toast("No changes were discarded")}>Discard</button>
        <button className="primary-button" type="button" onClick={() => toast(`${agent.name} saved`)}>Save changes</button>
      </footer>
    </main>
  );
}

function ChannelDetailRow({ icon, title, children, action }) {
  return (
    <section className="channel-detail-row">
      <span className="channel-detail-icon">{icon}</span>
      <div><h2>{title}</h2><div className="channel-detail-copy">{children}</div></div>
      <div className="channel-row-action">{action}</div>
    </section>
  );
}

function ChannelPage({ agent, channel, onBackToAgent, openManager, openBehavior, channelSettings, setChannelSettings, toast }) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const prompt = "@Chickpea give me three useful ways you can help this channel, each with an example prompt I could try next.";
  const connectors = selectedItems(connectorOptions, agent.connectors);
  const skills = selectedItems(skillOptions, agent.skills);
  const repositories = selectedItems(repositoryOptions, agent.repositories);
  async function copyPrompt() {
    try { await navigator.clipboard.writeText(prompt); } catch { /* Browser can block clipboard in local prototypes. */ }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <main className="content channel-page">
      <button className="back-link" type="button" onClick={onBackToAgent}><ArrowLeft /> {agent.name}</button>
      <Header
        title={`#${channel.name}`}
        actions={
          <>
            <span className="ready-chip"><CheckCircle weight="fill" /> Ready in Slack</span>
            <label className="compact-toggle">On <input type="checkbox" defaultChecked /><span /></label>
          </>
        }
      />

      <section className="channel-hero">
        <div>
          <p className="eyebrow">Agent in this channel</p>
          <h2>{agent.name}</h2>
          <p>{clampCopy(agent.instructions, 155)}</p>
        </div>
        <button className="primary-button" type="button" onClick={onBackToAgent}><Robot weight="fill" /> View Agent</button>
      </section>

      <div className="channel-details">
        <section className="channel-profile-bridge">
          <div className="channel-profile-bridge-head">
            <span className="channel-detail-icon"><Lightning /></span>
            <div>
              <h2>What it can use</h2>
              <p>Skills, apps, and repositories come from <strong>{agent.name}</strong>.</p>
            </div>
            <button className="row-link" type="button" onClick={onBackToAgent}>View Agent <CaretRight /></button>
          </div>
          <div className="channel-profile-previews">
            <div className="channel-profile-preview-group">
              <span className="channel-profile-preview-label"><Sparkle /> Skills</span>
              <div className="channel-profile-preview-list">
                {skills.slice(0, 2).map((skill) => <PreviewPill key={skill.id} onClick={() => openManager("skills")} icon={<Sparkle size={14} />}>{skill.name}</PreviewPill>)}
                <MorePill count={skills.length - 2} onClick={() => openManager("skills")} />
              </div>
            </div>
            <div className="channel-profile-preview-group">
              <span className="channel-profile-preview-label"><Stack /> Apps</span>
              <div className="channel-profile-preview-list">
                {connectors.slice(0, 3).map((connector) => <PreviewPill key={connector.id} onClick={() => openManager("connectors")} icon={<ConnectorLogo connector={connector} />}>{connector.name}</PreviewPill>)}
                <MorePill count={connectors.length - 3} onClick={() => openManager("connectors")} />
              </div>
            </div>
            <div className="channel-profile-preview-group">
              <span className="channel-profile-preview-label"><GithubLogo /> Repositories</span>
              <div className="channel-profile-preview-list">
                {repositories.slice(0, 1).map((repository) => <PreviewPill key={repository.id} onClick={() => openManager("repositories")} icon={<GithubLogo />}>{repository.name}</PreviewPill>)}
                <MorePill count={repositories.length - 1} onClick={() => openManager("repositories")} />
              </div>
            </div>
          </div>
        </section>
        <ChannelDetailRow
          icon={<SlackLogo weight="fill" />}
          title="When it speaks"
          action={<button className="row-link" type="button" onClick={openBehavior}>Change <CaretRight /></button>}
        >
          Answers every @mention and may join when it has something useful to add.
        </ChannelDetailRow>
      </div>

      <section className="try-card">
        <div>
          <p className="eyebrow">Try Chickpea here</p>
          <p className="test-prompt">{prompt}</p>
        </div>
        <div className="try-actions">
          <button className="primary-button" type="button" onClick={() => toast(`Slack would open #${channel.name} in a new tab`)}>Open channel in Slack <ArrowSquareOut /></button>
          <button className="secondary-button" type="button" onClick={copyPrompt}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy prompt"}</button>
        </div>
      </section>

      <section className={`advanced ${advancedOpen ? "open" : ""}`}>
        <button className="advanced-trigger" type="button" onClick={() => setAdvancedOpen((value) => !value)}>
          <span><Gear size={18} /> Advanced channel settings</span>
          {advancedOpen ? <CaretDown /> : <CaretRight />}
        </button>
        {advancedOpen ? (
          <div className="channel-overrides">
            <div className="channel-capability-editor">
              <div className="channel-capability-heading"><span className="channel-capability-icon instructions"><Sparkle weight="fill" /></span><span><strong>Additional instructions</strong><small>Always available to {agent.name}. Add only what should be different in #{channel.name}.</small></span></div>
              <textarea aria-label="Channel additional instructions" rows="4" value={channelSettings.instructions} onChange={(event) => setChannelSettings((current) => ({ ...current, instructions: event.target.value }))} placeholder={`For example: Prioritize customer-impacting issues and link every recommendation to source evidence.`} />
            </div>
            <div className="channel-capability-editor">
              <div className="channel-capability-heading"><span className="channel-capability-icon memory"><Brain weight="fill" /></span><span><strong>Channel memory</strong><small>Always available and private to #{channel.name}. The Agent decides what is useful enough to remember.</small></span></div>
              <textarea aria-label="Channel memory" rows="4" value={channelSettings.memory} onChange={(event) => setChannelSettings((current) => ({ ...current, memory: event.target.value }))} placeholder={`Useful facts, decisions, preferences, and context for this channel will appear here.`} />
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function Modal({ title, eyebrow, children, footer, onClose, wide = false }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const prior = document.activeElement;
    dialogRef.current?.focus();
    function onKeyDown(event) { if (event.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); prior?.focus?.(); };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialogRef}>
        <header>
          <div>{eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}<h2>{title}</h2></div>
          <IconButton label="Close" onClick={onClose}><X /></IconButton>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </section>
    </div>
  );
}

function InstructionsModal({ profile, onSave, onClose }) {
  const [value, setValue] = useState(profile.instructions);
  return (
    <Modal
      eyebrow="Default Profile"
      title="Edit instructions"
      onClose={onClose}
      footer={<><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="button" onClick={() => onSave(value)}>Save instructions</button></>}
    >
      <label className="field-label" htmlFor="instructions">What should Chickpea do?</label>
      <textarea id="instructions" rows="7" value={value} onChange={(event) => setValue(event.target.value)} />
      <div className="guidance"><Sparkle weight="fill" /> <span>Good instructions name the role, priorities, and when Chickpea should ask before acting.</span></div>
    </Modal>
  );
}

function ManagerModal({ type, profile, onSave, onClose }) {
  const config = {
    skills: { title: "Manage skills", eyebrow: "Repeatable abilities", options: skillOptions, value: profile.skills },
    connectors: { title: "Manage connectors", eyebrow: "Connected apps", options: connectorOptions, value: profile.connectors },
    repositories: { title: "Manage repositories", eyebrow: "Code and docs", options: repositoryOptions, value: profile.repositories },
  }[type];
  const [selected, setSelected] = useState(config.value);
  const [query, setQuery] = useState("");
  const visible = config.options.filter((item) => `${item.name} ${item.note || ""}`.toLowerCase().includes(query.toLowerCase()));
  function toggle(id) { setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]); }
  return (
    <Modal
      wide
      eyebrow={config.eyebrow}
      title={config.title}
      onClose={onClose}
      footer={<><span className="selection-count">{selected.length} selected</span><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="button" onClick={() => onSave(type, selected)}>Save selection</button></>}
    >
      <label className="search-field"><MagnifyingGlass /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Find ${type}`} /></label>
      <div className="option-grid">
        {visible.map((item) => {
          const active = selected.includes(item.id);
          const ItemIcon = type === "repositories" ? GithubLogo : Sparkle;
          return (
            <button className={`option-card ${active ? "selected" : ""}`} type="button" key={item.id} onClick={() => toggle(item.id)}>
              <span className="option-icon">{type === "connectors" ? <ConnectorLogo connector={item} /> : <ItemIcon />}</span>
              <span><strong>{item.name}</strong><small>{item.note || (active ? "Connected" : "Available")}</small></span>
              <i>{active ? <Check /> : <Plus />}</i>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

function ChannelsModal({ profile, onSave, onClose }) {
  const [selected, setSelected] = useState(profile.channels);
  function toggle(id) { setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]); }
  return (
    <Modal
      eyebrow={profile.name}
      title="Choose where this Agent works"
      onClose={onClose}
      footer={<><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="button" onClick={() => onSave(selected)}>Update channels</button></>}
    >
      <p className="modal-lead">This Agent will be available in the channels you select.</p>
      <div className="channel-checklist">
        {availableChannels.map((channel) => (
          <label key={channel.id}><input type="checkbox" checked={selected.includes(channel.id)} onChange={() => toggle(channel.id)} /><span><Hash /> {channel.name}</span><small>{selected.includes(channel.id) ? `Uses ${profile.name}` : "Not assigned"}</small></label>
        ))}
      </div>
    </Modal>
  );
}

function BehaviorModal({ onClose }) {
  const [value, setValue] = useState("ambient");
  return (
    <Modal
      eyebrow="#all-acme-inc"
      title="When should Chickpea speak?"
      onClose={onClose}
      footer={<><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="button" onClick={onClose}>Save behavior</button></>}
    >
      <div className="radio-stack">
        <label className={value === "ambient" ? "selected" : ""}><input type="radio" name="behavior" value="ambient" checked={value === "ambient"} onChange={(event) => setValue(event.target.value)} /><span><strong>Mentions and useful moments</strong><small>Always answer @mentions. Join when Chickpea has something useful to add.</small></span></label>
        <label className={value === "mentions" ? "selected" : ""}><input type="radio" name="behavior" value="mentions" checked={value === "mentions"} onChange={(event) => setValue(event.target.value)} /><span><strong>Only when mentioned</strong><small>Stay quiet unless someone explicitly asks Chickpea.</small></span></label>
      </div>
    </Modal>
  );
}

function Toast({ message }) {
  return <div className="toast" role="status"><CheckCircle weight="fill" /> {message}</div>;
}

export function App() {
  const [view, setView] = useState(() => window.location.hash === "#channel" ? "channel" : window.location.hash === "#channels" ? "channels" : "agent");
  const [agents, setAgents] = useState(initialAgents);
  const [selectedAgentId, setSelectedAgentId] = useState("default");
  const [selectedChannelId, setSelectedChannelId] = useState("all-acme-inc");
  const [channelSettingsById, setChannelSettingsById] = useState({});
  const [modal, setModal] = useState(null);
  const [toastMessage, setToastMessage] = useState("");
  const agent = agents.find((item) => item.id === selectedAgentId) || agents[0];
  const channel = availableChannels.find((item) => item.id === selectedChannelId) || availableChannels[0];
  const channelSettings = channelSettingsById[selectedChannelId] || { instructions: "", memory: "" };

  function setAgent(updater) {
    setAgents((current) => current.map((item) => item.id === selectedAgentId ? (typeof updater === "function" ? updater(item) : updater) : item));
  }
  function selectAgent(id) { setSelectedAgentId(id); setView("agent"); }
  function openChannel(id, agentId) { if (agentId) setSelectedAgentId(agentId); setSelectedChannelId(id); setView("channel"); }
  function setChannelSettings(updater) {
    setChannelSettingsById((current) => ({ ...current, [selectedChannelId]: typeof updater === "function" ? updater(current[selectedChannelId] || channelSettings) : updater }));
  }

  useEffect(() => {
    window.location.hash = view;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [view]);
  useEffect(() => {
    function goAgent() { setView("agent"); }
    window.addEventListener("go-agent", goAgent);
    return () => window.removeEventListener("go-agent", goAgent);
  }, []);
  useEffect(() => {
    function onHashChange() { setView(window.location.hash === "#channel" ? "channel" : window.location.hash === "#channels" ? "channels" : "agent"); }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function showToast(message) {
    setToastMessage(message);
    window.setTimeout(() => setToastMessage(""), 2200);
  }
  function saveManager(type, ids) {
    setAgent((current) => ({ ...current, [type]: ids }));
    setModal(null);
    showToast(`${type[0].toUpperCase()}${type.slice(1)} updated`);
  }
  function openManager(type) {
    if (view === "channel") {
      setView("agent");
      window.setTimeout(() => setModal({ type: "manager", managerType: type }), 140);
    } else {
      setModal({ type: "manager", managerType: type });
    }
  }

  const modalNode = useMemo(() => {
    if (!modal) return null;
    if (modal.type === "manager") return <ManagerModal type={modal.managerType} profile={agent} onSave={saveManager} onClose={() => setModal(null)} />;
    if (modal.type === "channels") return <ChannelsModal profile={agent} onClose={() => setModal(null)} onSave={(channels) => { setAgent((current) => ({ ...current, channels })); setModal(null); showToast("Agent channels updated"); }} />;
    if (modal.type === "behavior") return <BehaviorModal onClose={() => setModal(null)} />;
    return null;
  }, [modal, agent]);

  return (
    <div className="app-shell">
      <Sidebar view={view} agents={agents} selectedAgentId={selectedAgentId} onSelectAgent={selectAgent} onOpenChannels={() => setView("channels")} />
      {view === "agent" ? (
        <AgentPage
          agent={agent}
          setAgent={setAgent}
          openChannel={openChannel}
          openManager={openManager}
          openChannels={() => setModal({ type: "channels" })}
          toast={showToast}
        />
      ) : view === "channels" ? (
        <ChannelsIndexPage agents={agents} onOpenChannel={openChannel} onOpenAgent={selectAgent} toast={showToast} />
      ) : (
        <ChannelPage
          agent={agent}
          channel={channel}
          onBackToAgent={() => setView("agent")}
          openManager={openManager}
          openBehavior={() => setModal({ type: "behavior" })}
          channelSettings={channelSettings}
          setChannelSettings={setChannelSettings}
          toast={showToast}
        />
      )}
      {modalNode}
      {toastMessage ? <Toast message={toastMessage} /> : null}
    </div>
  );
}
