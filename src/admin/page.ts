export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>slack-flue /admin</title>
<style>
:root {
  --bg: #ffffff;
  --well: #f7f5f2;
  --raise: rgba(28, 25, 23, 0.04);
  --line: rgba(28, 25, 23, 0.08);
  --line-strong: rgba(28, 25, 23, 0.14);
  --text: #201d1a;
  --text-2: #57534c;
  --text-3: #8a857d;
  --ember: #e8833a;
  --ember-deep: #b05415;
  --ember-bright: #f09a55;
  --ember-tint: rgba(232, 131, 58, 0.13);
  --ok: #1f7a44;
  --ok-tint: rgba(31, 122, 68, 0.1);
  --danger: #c03538;
  --danger-tint: rgba(192, 53, 56, 0.08);
  --font: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --radius: 8px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { color-scheme: light; }
body {
  background: var(--bg);
  color: var(--text-2);
  font-family: var(--font);
  font-feature-settings: "cv02", "cv03", "cv04", "cv11";
  font-size: 0.875rem;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
button, input, textarea, select { font: inherit; }
::selection { background: var(--ember-tint); }
.page-title { color: var(--text); font-size: 1.0625rem; font-weight: 600; letter-spacing: 0; }
.page-title.mono-title { font-family: var(--mono); font-size: 1rem; }
.section-eyebrow {
  color: var(--text-3);
  font-family: var(--mono);
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.field-label { color: var(--text); display: block; font-size: 0.8125rem; font-weight: 500; }
.hint { color: var(--text-3); font-size: 0.8125rem; }
.mono { font-family: var(--mono); font-size: 0.78125rem; }
.btn {
  align-items: center;
  border: 0;
  border-radius: var(--radius);
  cursor: pointer;
  display: inline-flex;
  font-size: 0.8125rem;
  font-weight: 500;
  gap: 6px;
  justify-content: center;
  min-height: 32px;
  padding: 7px 12px;
  text-decoration: none;
}
.btn:disabled { cursor: not-allowed; opacity: 0.5; }
.btn:focus-visible, .tab:focus-visible, .x-btn:focus-visible, .rail-add:focus-visible, .chan-item:focus-visible {
  outline: 2px solid var(--ember-deep);
  outline-offset: 2px;
}
.btn-primary { background: var(--ember); color: #22130a; }
.btn-primary:hover:not(:disabled) { background: var(--ember-bright); }
.btn-soft { background: rgba(28, 25, 23, 0.06); color: var(--text); }
.btn-soft:hover:not(:disabled) { background: rgba(28, 25, 23, 0.09); }
.btn-ghost { background: transparent; color: var(--text-2); }
.btn-ghost:hover:not(:disabled) { background: rgba(28, 25, 23, 0.05); color: var(--text); }
.btn-danger { background: var(--danger-tint); color: #a92c30; }
.btn-danger:hover:not(:disabled) { background: rgba(192, 53, 56, 0.13); }
.btn-sm { border-radius: 6px; font-size: 0.75rem; min-height: 26px; padding: 4px 9px; }
.input, .textarea {
  background: #fff;
  border: 0;
  border-radius: var(--radius);
  box-shadow: inset 0 0 0 1px rgba(28, 25, 23, 0.15);
  color: var(--text);
  font-size: 0.875rem;
  padding: 8px 11px;
  width: 100%;
}
.input::placeholder, .textarea::placeholder { color: var(--text-3); }
.input:focus-visible, .textarea:focus-visible {
  outline: 2px solid var(--ember-deep);
  outline-offset: -1px;
}
.textarea { line-height: 1.55; min-height: 96px; resize: vertical; }
.input.mono, .textarea.mono { font-size: 0.8125rem; }
.toggle {
  background: rgba(28, 25, 23, 0.12);
  border-radius: 999px;
  display: inline-flex;
  flex-shrink: 0;
  padding: 2px;
  position: relative;
  transition: background 0.2s ease-in-out;
  width: 36px;
}
.toggle:has(:checked) { background: var(--ember); }
.toggle .thumb {
  aspect-ratio: 1;
  background: #fff;
  border-radius: 999px;
  box-shadow: 0 1px 2px rgba(28, 25, 23, 0.2);
  transition: transform 0.2s ease-in-out;
  width: 50%;
}
.toggle:has(:checked) .thumb { transform: translateX(100%); }
.toggle input { appearance: none; cursor: pointer; inset: 0; position: absolute; }
.toggle:has(:focus-visible) { outline: 2px solid var(--ember-deep); outline-offset: 2px; }
.badge {
  align-items: center;
  border-radius: 999px;
  display: inline-flex;
  font-size: 0.75rem;
  font-weight: 500;
  gap: 5px;
  padding: 2px 9px;
}
.badge .dot { background: currentColor; border-radius: 999px; height: 5px; width: 5px; }
.badge-on { background: var(--ok-tint); color: var(--ok); }
.badge-off { background: rgba(28, 25, 23, 0.06); color: var(--text-3); }
.chip {
  background: rgba(28, 25, 23, 0.06);
  border-radius: 5px;
  color: var(--text-2);
  display: inline-flex;
  font-family: var(--mono);
  font-size: 0.71875rem;
  max-width: 100%;
  overflow-wrap: anywhere;
  padding: 2px 7px;
}
.frame { display: flex; flex-direction: column; min-height: 100dvh; }
.topbar {
  align-items: center;
  border-bottom: 1px solid var(--line);
  display: flex;
  gap: 12px;
  height: 54px;
  padding: 0 20px;
}
.brand { align-items: center; display: flex; flex: 1; gap: 10px; min-width: 0; }
.avatar {
  align-items: center;
  background: var(--ember-tint);
  border-radius: 7px;
  color: var(--ember-deep);
  display: flex;
  flex-shrink: 0;
  font-size: 0.8125rem;
  font-weight: 600;
  height: 26px;
  justify-content: center;
  width: 26px;
}
.brand-name { color: var(--text); font-size: 0.875rem; font-weight: 600; }
.topbar .actions { align-items: center; display: flex; gap: 8px; }
.body { display: flex; flex: 1; min-height: 0; }
.rail {
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 10px;
  width: 248px;
}
.rail-head { align-items: center; display: flex; justify-content: space-between; padding: 0 10px 10px; }
.ws-row {
  align-items: center;
  color: var(--text);
  display: flex;
  gap: 7px;
  font-size: 0.8125rem;
  font-weight: 500;
  padding: 6px 10px;
}
.chan-item {
  background: transparent;
  border: 0;
  border-radius: var(--radius);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-left: 12px;
  padding: 8px 10px;
  text-align: left;
  text-decoration: none;
}
.chan-item:hover { background: var(--raise); }
.chan-item.active { background: rgba(28, 25, 23, 0.07); }
.chan-name { color: var(--text); font-family: var(--mono); font-size: 0.8125rem; font-weight: 500; overflow-wrap: anywhere; }
.chan-meta { color: var(--text-3); font-size: 0.71875rem; overflow-wrap: anywhere; }
.rail-add {
  background: none;
  border: 0;
  border-radius: var(--radius);
  color: var(--text-3);
  cursor: pointer;
  font-size: 0.8125rem;
  margin-left: 12px;
  padding: 7px 10px;
  text-align: left;
}
.rail-add:hover { background: var(--raise); color: var(--text-2); }
.rail-form {
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 8px 0 0 12px;
  padding-top: 10px;
}
.main { flex: 1; min-width: 0; overflow-y: auto; padding: 26px 32px 48px; }
.main-inner { display: flex; flex-direction: column; gap: 28px; margin: 0 auto; max-width: 760px; }
.main-head { align-items: flex-start; display: flex; gap: 12px; justify-content: space-between; }
.section { border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 14px; padding-top: 20px; }
.section:first-child { border-top: 0; padding-top: 0; }
.section-head { align-items: baseline; display: flex; gap: 10px; justify-content: space-between; }
.section-title { color: var(--text); font-size: 0.875rem; font-weight: 600; }
.field { display: flex; flex-direction: column; gap: 6px; }
.form-grid { display: grid; gap: 16px 18px; grid-template-columns: 1fr 1fr; }
.form-grid .full { grid-column: 1 / -1; }
.bundle-row {
  align-items: center;
  border-radius: var(--radius);
  box-shadow: inset 0 0 0 1px var(--line-strong);
  display: flex;
  gap: 10px;
  min-height: 44px;
  padding: 9px 12px;
}
.bundle-row .b-name { color: var(--text); font-size: 0.8125rem; font-weight: 500; overflow-wrap: anywhere; }
.bundle-row .b-meta { color: var(--text-3); font-family: var(--mono); font-size: 0.71875rem; overflow-wrap: anywhere; }
.bundle-row .spacer, .modal-foot .spacer { flex: 1; }
.x-btn {
  background: none;
  border: 0;
  border-radius: 5px;
  color: var(--text-3);
  cursor: pointer;
  font-size: 0.875rem;
  line-height: 1;
  padding: 4px 7px;
}
.x-btn:hover { background: rgba(28, 25, 23, 0.06); color: var(--text); }
.well {
  background: var(--well);
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px var(--line);
  padding: 4px 18px;
}
.well dl { display: flex; flex-direction: column; }
.well .kv, .adv-rows .kv {
  border-top: 1px solid var(--line);
  display: grid;
  gap: 16px;
  grid-template-columns: 148px 1fr;
  padding: 11px 0;
}
.well .kv:first-child, .adv-rows .kv:first-child { border-top: 0; }
.well dt, .adv-rows dt { color: var(--text); font-size: 0.8125rem; font-weight: 500; }
.well dd, .adv-rows dd { color: var(--text-2); font-size: 0.8125rem; min-width: 0; }
.well dd.mono, .adv-rows dd.mono { font-size: 0.78125rem; overflow-wrap: anywhere; }
.instructions-preview {
  background: #fff;
  border-left: 2px solid var(--line-strong);
  color: var(--text-2);
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 0.8125rem;
  margin-top: 2px;
  padding: 10px 14px;
}
.layer-tag {
  color: var(--text-3);
  font-family: var(--mono);
  font-size: 0.65625rem;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}
.layer-tag.ember { color: var(--ember-deep); }
.from-addendum { border-left: 2px solid var(--ember); margin-left: -16px; padding-left: 14px; }
details.advanced { border-top: 1px solid var(--line); padding-top: 4px; }
details.advanced summary {
  align-items: center;
  color: var(--text-2);
  cursor: pointer;
  display: flex;
  font-size: 0.875rem;
  font-weight: 600;
  gap: 7px;
  list-style: none;
  padding: 14px 0;
}
details.advanced summary::-webkit-details-marker { display: none; }
details.advanced summary::before { color: var(--text-3); content: "▸"; font-size: 0.75rem; }
details[open].advanced summary::before { content: "▾"; }
.adv-rows { display: flex; flex-direction: column; padding-bottom: 14px; }
.save-bar { align-items: center; display: flex; gap: 10px; justify-content: flex-end; }
.save-note { color: var(--text-3); font-size: 0.75rem; margin-right: auto; }
.error, .field-error { color: var(--danger); font-size: 0.8125rem; }
.empty {
  align-items: flex-start;
  background: var(--well);
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px var(--line);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px;
}
.scrim {
  align-items: flex-start;
  background: rgba(28, 25, 23, 0.42);
  display: none;
  inset: 0;
  justify-content: center;
  min-height: 100dvh;
  overflow-y: auto;
  padding: 44px 20px;
  position: fixed;
  z-index: 20;
}
.scrim.open { display: flex; }
.modal {
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 20px 50px rgba(28, 25, 23, 0.3);
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 720px;
  padding: 22px 26px;
  width: 100%;
}
.modal-head { align-items: center; display: flex; gap: 10px; }
.modal-title { color: var(--text); flex: 1; font-size: 1.0625rem; font-weight: 600; }
.profile-list { display: flex; flex-wrap: wrap; gap: 8px; }
.tabs { border-bottom: 1px solid var(--line); display: flex; gap: 22px; }
.tab {
  background: none;
  border: 0;
  color: var(--text-3);
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 500;
  margin-bottom: -1px;
  padding: 8px 2px 10px;
}
.tab:hover { color: var(--text-2); }
.tab.active { border-bottom: 2px solid var(--text); color: var(--text); }
.modal-foot { align-items: center; border-top: 1px solid var(--line); display: flex; gap: 10px; padding-top: 16px; }
.layer-legend { display: flex; flex-direction: column; gap: 6px; }
.layer-legend .step { align-items: baseline; display: flex; gap: 9px; font-size: 0.8125rem; }
.layer-legend .step .n { color: var(--text-3); font-family: var(--mono); font-size: 0.6875rem; }
.combo-list {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(28, 25, 23, 0.14), inset 0 0 0 1px var(--line);
  display: flex;
  flex-direction: column;
  margin-top: 6px;
  overflow: hidden;
  padding: 5px;
}
.combo-group {
  align-items: baseline;
  color: var(--text-3);
  display: flex;
  gap: 8px;
  font-family: var(--mono);
  font-size: 0.65625rem;
  letter-spacing: 0.07em;
  padding: 8px 9px 4px;
  text-transform: uppercase;
}
.combo-group .src { letter-spacing: 0; text-transform: none; }
.combo-opt {
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--text);
  cursor: pointer;
  font-family: var(--mono);
  font-size: 0.8125rem;
  padding: 6px 9px;
  text-align: left;
}
.combo-opt.plain { font-family: var(--font); }
.combo-opt:hover { background: var(--raise); }
.combo-opt.active { background: var(--ember-tint); color: var(--ember-deep); }
.combo-foot { border-top: 1px solid var(--line); color: var(--text-3); font-size: 0.75rem; margin-top: 4px; padding: 8px 9px 4px; }
@media (max-width: 720px) {
  .body { flex-direction: column; }
  .rail { border-bottom: 1px solid var(--line); border-right: 0; width: 100%; }
  .main { padding: 20px; }
  .form-grid { grid-template-columns: 1fr; }
  .well .kv, .adv-rows .kv { grid-template-columns: 1fr; gap: 3px; }
  .btn { font-size: 0.875rem; padding: 9px 14px; }
  .btn-sm { font-size: 0.8125rem; padding: 6px 11px; }
  .main-head, .section-head, .bundle-row, .save-bar { align-items: stretch; flex-direction: column; }
  .save-note { margin-right: 0; }
}
</style>
</head>
<body>
<div id="app" class="frame">
  <header class="topbar">
    <div class="brand">
      <span class="avatar">F</span>
      <span class="brand-name">Flue Assistant</span>
      <span class="chip">local · node</span>
    </div>
    <div class="actions">
      <a class="btn btn-ghost" href="https://api.slack.com/apps" rel="noreferrer">Open Slack console &nearr;</a>
      <button type="button" class="btn btn-soft" disabled>Profiles</button>
    </div>
  </header>
  <div class="body">
    <nav class="rail" aria-label="Channels">
      <div class="rail-head"><span class="section-eyebrow">Slack channels</span><span class="hint">...</span></div>
      <div class="ws-row">▾ Workspace</div>
    </nav>
    <main class="main"><div class="main-inner"><div class="empty"><h1 class="page-title">Loading admin...</h1><p class="hint">Reading local configuration.</p></div></div></main>
  </div>
</div>
<div id="modal-root"></div>
<script>
(function () {
  // Fallback only for the very first paint before /admin/api/models resolves;
  // defaultModels() prefers the server-supplied pair (single source of truth in
  // src/config/seed.ts) so a bumped seed default never goes stale here.
  var DEFAULT_MODELS_FALLBACK = { claude: "anthropic/claude-sonnet-4-6", "workers-ai": "@cf/zai-org/glm-5.2" };
  var state = {
    agents: [],
    assignments: [],
    models: { automatic: { label: "Automatic (provider default)", value: null }, providers: [] },
    active: null,
    effective: null,
    effectiveError: "",
    addChannelOpen: false,
    channelFormDraft: { workspaceId: "", channelId: "", channelLabel: "" },
    addChannelError: "",
    swapOpen: false,
    channelDraft: { enabled: true, channelPromptAddendum: "" },
    dirty: false,
    saveError: "",
    modalOpen: false,
    modalTab: "details",
    editingAgentId: null,
    profileDraft: null,
    profileError: ""
  };

  // One source for the Workspace/Channel/Name form fields used by both the
  // rail add-channel form and the profile modal's Channels tab.
  function channelFieldsHtml(idPrefix) {
    var draft = state.channelFormDraft;
    return '<div class="field"><label class="field-label" for="' + idPrefix + '-workspace">Workspace ID</label><input class="input mono" id="' + idPrefix + '-workspace" name="workspaceId" value="' + esc(draft.workspaceId) + '" placeholder="T0123ABC"></div>' +
      '<div class="field"><label class="field-label" for="' + idPrefix + '-channel">Channel ID</label><input class="input mono" id="' + idPrefix + '-channel" name="channelId" value="' + esc(draft.channelId) + '" placeholder="C0123ABC"></div>' +
      '<div class="field full"><label class="field-label" for="' + idPrefix + '-channel-label">Channel name</label><input class="input" id="' + idPrefix + '-channel-label" name="channelLabel" value="' + esc(draft.channelLabel || "") + '" placeholder="eng-releases"></div>';
  }

  function defaultModels() {
    return (state.models && state.models.defaultModels) || DEFAULT_MODELS_FALLBACK;
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function api(path, options) {
    return fetch(path, Object.assign({ credentials: "same-origin" }, options || {})).then(function (response) {
      return response.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
        if (!response.ok) {
          var message = body && body.error ? body.error : "HTTP " + response.status;
          throw new Error(message);
        }
        return body;
      });
    });
  }

  function postJson(path, method, body) {
    return api(path, {
      method: method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  function concreteAssignments() {
    return state.assignments.filter(function (assignment) {
      return assignment.workspaceId !== "*" && assignment.channelId !== "*";
    });
  }

  function activeAssignment() {
    if (!state.active) return null;
    return state.assignments.find(function (assignment) {
      return assignment.workspaceId === state.active.workspaceId && assignment.channelId === state.active.channelId;
    }) || null;
  }

  function firstWorkspaceAssignment() {
    return state.assignments.find(function (assignment) {
      return assignment.workspaceId !== "*";
    }) || null;
  }

  function defaultChannelFormWorkspaceId() {
    if (state.active && state.active.workspaceId) return state.active.workspaceId;
    var assignment = firstWorkspaceAssignment();
    return assignment ? assignment.workspaceId : "";
  }

  function syncChannelFormWorkspacePrefill() {
    if (!state.channelFormDraft.workspaceId) {
      state.channelFormDraft.workspaceId = defaultChannelFormWorkspaceId();
    }
  }

  function agentById(id) {
    return state.agents.find(function (agent) { return agent.id === id; }) || null;
  }

  function normalizeChannelLabel(label) {
    return String(label || "").trim().replace(/^#+/, "");
  }

  function channelLabel(assignment) {
    var label = normalizeChannelLabel(assignment && assignment.channelLabel);
    return "#" + (label || String((assignment && assignment.channelId) || "channel"));
  }

  function channelCountLabel(count) {
    return count + " " + (count === 1 ? "channel" : "channels");
  }

  // Every assignment for the agent, wildcards included — matches the server's
  // delete guard so the modal's "Used in N" count is honest and each blocking
  // row (including the seeded '*'/'*' catch-all) has a Remove affordance.
  function allAssignmentsForAgent(agentId) {
    return state.assignments.filter(function (assignment) { return assignment.agentId === agentId; });
  }

  function assignmentByKey(workspaceId, channelId) {
    return state.assignments.find(function (assignment) {
      return assignment.workspaceId === workspaceId && assignment.channelId === channelId;
    }) || null;
  }

  function isWildcardAssignment(assignment) {
    return assignment.workspaceId === "*" || assignment.channelId === "*";
  }

  function defaultAgent() {
    return state.agents[0] || null;
  }

  function render() {
    var app = document.getElementById("app");
    app.innerHTML = topbarHtml() + '<div class="body">' + railHtml() + mainHtml() + "</div>";
    renderModal();
  }

  function topbarHtml() {
    return '<header class="topbar">' +
      '<div class="brand"><span class="avatar">F</span><span class="brand-name">Flue Assistant</span><span class="chip">local · node</span></div>' +
      '<div class="actions"><a class="btn btn-ghost" href="https://api.slack.com/apps" rel="noreferrer">Open Slack console &nearr;</a>' +
      '<button type="button" class="btn btn-soft" data-action="open-profiles">Profiles</button></div>' +
      "</header>";
  }

  function railHtml() {
    var channels = concreteAssignments();
    var groups = [];
    channels.forEach(function (assignment) {
      var group = groups.find(function (candidate) { return candidate.workspaceId === assignment.workspaceId; });
      if (!group) {
        group = { workspaceId: assignment.workspaceId, assignments: [] };
        groups.push(group);
      }
      group.assignments.push(assignment);
    });
    var html = '<nav class="rail" aria-label="Channels">' +
      '<div class="rail-head"><span class="section-eyebrow">Slack channels</span><span class="hint" style="font-size:0.6875rem;">' + channels.length + '</span></div>' +
      (channels.length === 0 ? '<div class="ws-row">▾ Workspace</div>' : "");
    if (channels.length === 0) {
      html += '<div class="empty" style="margin:8px 0 8px 12px; padding:12px;"><p class="field-label">No channels yet &mdash; add one</p><p class="hint">Attach a profile by Slack channel ID.</p></div>';
    } else {
      groups.forEach(function (group) {
        html += '<div class="ws-row">▾ ' + esc(group.workspaceId || "Workspace") + '</div>';
        group.assignments.forEach(function (assignment) {
          var active = state.active && state.active.workspaceId === assignment.workspaceId && state.active.channelId === assignment.channelId;
          var railAgent = agentById(assignment.agentId);
          html += '<button type="button" class="chan-item' + (active ? " active" : "") + '" data-action="select-channel" data-workspace="' + esc(assignment.workspaceId) + '" data-channel="' + esc(assignment.channelId) + '">' +
            '<span class="chan-name">' + esc(channelLabel(assignment)) + '</span>' +
            '<span class="chan-meta">' + esc(railAgent ? railAgent.name : assignment.agentId) + '</span></button>';
        });
      });
    }
    html += '<button type="button" class="rail-add" data-action="toggle-add-channel">+ Add channel</button>';
    if (state.addChannelOpen) {
      html += '<form class="rail-form" data-action="add-channel-form">' +
        channelFieldsHtml("rail") +
        (state.addChannelError ? '<p class="field-error">' + esc(state.addChannelError) + '</p>' : "") +
        '<div style="display:flex; gap:8px;"><button type="submit" class="btn btn-primary btn-sm">Add</button><button type="button" class="btn btn-ghost btn-sm" data-action="cancel-add-channel">Cancel</button></div>' +
        '</form>';
    }
    return html + '</nav>';
  }

  function mainHtml() {
    var assignment = activeAssignment();
    if (!assignment) {
      return '<main class="main"><div class="main-inner"><div class="empty">' +
        '<h1 class="page-title">No channels yet &mdash; add one</h1>' +
        '<p class="hint">Create the first channel scope, then attach a reusable profile and channel instructions.</p>' +
        '<button type="button" class="btn btn-soft" data-action="toggle-add-channel">Add channel</button>' +
        '</div></div></main>';
    }
    var agent = agentById(assignment.agentId);
    var enabled = state.channelDraft.enabled;
    return '<main class="main"><div class="main-inner">' +
      '<div class="main-head"><div style="display:flex; flex-direction:column; gap:2px;">' +
      '<h1 class="page-title mono-title">' + esc(channelLabel(assignment)) + '</h1>' +
      '<p class="hint">What Flue Assistant can do in this channel. It answers mentions here, always as @Flue Assistant.</p>' +
      '</div><label style="display:flex; align-items:center; gap:10px;"><span class="hint">' + (enabled ? "Enabled" : "Disabled") + '</span>' +
      '<span class="toggle"><span class="thumb"></span><input type="checkbox" data-action="channel-enabled" ' + (enabled ? "checked" : "") + ' aria-label="Channel enabled"></span></label></div>' +
      profileSectionHtml(agent, assignment) +
      channelInstructionsHtml() +
      accessSummaryHtml() +
      advancedHtml(assignment) +
      saveBarHtml() +
      '</div></main>';
  }

  function profileSectionHtml(agent, assignment) {
    var meta = agent ? modelLabel(agent) + " · " + toolsLabel(agent.allowedTools) + " · used in " + channelCountLabel(allAssignmentsForAgent(agent.id).length) : "Unknown profile";
    var row = agent
      ? '<div class="bundle-row"><span class="b-name">' + esc(agent.name) + '</span><span class="b-meta">' + esc(meta) + '</span><span class="spacer"></span><button type="button" class="btn btn-soft btn-sm" data-action="toggle-swap">Change</button><button type="button" class="x-btn" data-action="detach-profile" aria-label="Detach profile">&times;</button></div>'
      : '<div class="empty"><p class="field-label">No profile attached</p><p class="hint">Attach a profile before the channel can answer.</p></div>';
    if (state.swapOpen) {
      row += '<div class="bundle-row"><select class="input" data-role="swap-profile">' + state.agents.map(function (profile) {
        return '<option value="' + esc(profile.id) + '"' + (profile.id === assignment.agentId ? " selected" : "") + '>' + esc(profile.name) + '</option>';
      }).join("") + '</select><button type="button" class="btn btn-primary btn-sm" data-action="attach-selected-profile">Attach</button></div>';
    }
    return '<section class="section"><div class="section-head"><div><h2 class="section-title">Profile</h2><p class="hint">The reusable behavior attached to this channel &mdash; instructions, model, and tools.</p></div><button type="button" class="btn btn-ghost btn-sm" data-action="open-profiles">Manage profiles</button></div>' + row + '</section>';
  }

  function channelInstructionsHtml() {
    return '<section class="section"><div class="section-head"><div><h2 class="section-title">Channel instructions</h2><p class="hint">Appended to the profile\\'s instructions in this channel only.</p></div></div>' +
      '<div class="field"><label class="field-label" for="addendum" style="position:absolute; clip: rect(0 0 0 0);">Channel instructions</label>' +
      '<textarea class="textarea" id="addendum" data-action="channel-addendum">' + esc(state.channelDraft.channelPromptAddendum || "") + '</textarea></div></section>';
  }

  function accessSummaryHtml() {
    var body = "";
    if (state.effectiveError) {
      body = '<div class="empty"><p class="field-label">No enabled profile</p><p class="hint">' + esc(state.effectiveError) + '</p></div>';
    } else if (!state.effective) {
      body = '<div class="well"><dl><div class="kv"><dt>Status</dt><dd>Resolving...</dd></div></dl></div>';
    } else {
      var profile = state.effective.profile;
      body = '<div class="well"><dl>' +
        '<div class="kv"><dt>Profile</dt><dd>' + esc(profile.name) + ' ' + enabledBadge(profile.enabled) + '</dd></div>' +
        '<div class="kv"><dt>Replies as</dt><dd>Flue Assistant &mdash; the install-wide Slack identity shared by every channel</dd></div>' +
        '<div class="kv"><dt>Model</dt><dd class="mono">' + esc(state.effective.model) + '</dd></div>' +
        '<div class="kv"><dt>Provider</dt><dd class="mono">' + esc(state.effective.provider) + '</dd></div>' +
        '<div class="kv"><dt>Allowed tools</dt><dd>' + toolsChips(state.effective.allowedTools) + '</dd></div>' +
        '<div class="kv"><dt>Instructions</dt><dd><div class="instructions-preview">' + instructionLayersHtml(state.effective.instructionLayers) + '</div></dd></div>' +
        '<div class="kv"><dt>Snapshot</dt><dd class="mono">sha256:' + esc(shortHash(state.effective.snapshotHash)) + ' · new threads only</dd></div>' +
        '</dl></div>';
    }
    return '<section class="section"><div class="section-head"><div><h2 class="section-title">Access summary</h2><p class="hint">Resolved from the attached profile and this channel\\'s instructions. New threads pick this up; existing threads keep the snapshot they started with.</p></div></div>' + body + '</section>';
  }

  function advancedHtml(assignment) {
    return '<details class="advanced"><summary>Advanced</summary><div class="adv-rows"><dl style="display:contents;">' +
      '<div class="kv"><dt>Channel ID</dt><dd class="mono">' + esc(assignment.channelId) + '</dd></div>' +
      '<div class="kv"><dt>Workspace ID</dt><dd class="mono">' + esc(assignment.workspaceId) + '</dd></div>' +
      '<div class="kv"><dt>Providers</dt><dd style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">' + providerBadges() + '<span class="hint" style="font-size:0.75rem;">Read-only &mdash; configured via .env (built-ins) or src/app.ts (custom).</span></dd></div>' +
      '<div class="kv"><dt>Coming later</dt><dd>Inherited defaults, guest policy, and channel-member edits arrive with scope inheritance &mdash; see the roadmap.</dd></div>' +
      '</dl></div></details>';
  }

  function saveBarHtml() {
    return '<div class="save-bar">' +
      '<p class="save-note">Changes apply to new threads without a restart.</p>' +
      (state.saveError ? '<p class="field-error">' + esc(state.saveError) + '</p>' : "") +
      '<button type="button" class="btn btn-ghost" data-action="discard-channel" ' + (!state.dirty ? "disabled" : "") + '>Discard</button>' +
      '<button type="button" class="btn btn-primary" data-action="save-channel" ' + (!state.dirty ? "disabled" : "") + '>Save changes</button>' +
      '</div>';
  }

  function renderModal() {
    var root = document.getElementById("modal-root");
    if (!state.modalOpen) {
      root.innerHTML = '<div class="scrim"></div>';
      return;
    }
    var draft = state.profileDraft || newProfileDraft();
    root.innerHTML = '<div class="scrim open"><div class="modal" role="dialog" aria-labelledby="pm-title">' +
      '<div class="modal-head"><h1 class="modal-title" id="pm-title">' + esc(draft.name || "New profile") + '</h1><button type="button" class="x-btn" data-action="close-profiles" aria-label="Close">&times;</button></div>' +
      profileListHtml() +
      '<div class="tabs"><button type="button" class="tab ' + tabClass("details") + '" data-action="profile-tab" data-tab="details">Details</button><button type="button" class="tab ' + tabClass("instructions") + '" data-action="profile-tab" data-tab="instructions">Instructions</button><button type="button" class="tab ' + tabClass("channels") + '" data-action="profile-tab" data-tab="channels">Channels</button></div>' +
      profileTabHtml(draft) +
      '<div class="modal-foot"><button type="button" class="btn btn-danger btn-sm" data-action="delete-profile" ' + (!draft.id ? "disabled" : "") + '>Delete profile</button><button type="button" class="btn btn-soft btn-sm" data-action="profile-tab" data-tab="channels">Add to channels</button><span class="hint" style="font-size:0.75rem;">Used in ' + channelCountLabel(allAssignmentsForAgent(draft.id).length) + '</span><span class="spacer"></span>' + (state.profileError ? '<span class="field-error">' + esc(state.profileError) + '</span>' : "") + '<button type="button" class="btn btn-primary" data-action="save-profile">Done</button></div>' +
      '</div></div>';
  }

  function profileListHtml() {
    var buttons = state.agents.map(function (agent) {
      var active = state.editingAgentId === agent.id;
      return '<button type="button" class="btn ' + (active ? "btn-primary" : "btn-soft") + ' btn-sm" data-action="select-profile" data-agent="' + esc(agent.id) + '">' + esc(agent.name) + '</button>';
    }).join("");
    return '<div class="profile-list">' + buttons + '<button type="button" class="btn btn-ghost btn-sm" data-action="new-profile">+ New profile</button></div>';
  }

  function profileTabHtml(draft) {
    if (state.modalTab === "instructions") return profileInstructionsHtml(draft);
    if (state.modalTab === "channels") return profileChannelsHtml(draft);
    return profileDetailsHtml(draft);
  }

  function profileDetailsHtml(draft) {
    var warning = modelWarning(draft.model || "");
    return '<form class="form-grid" data-action="profile-form">' +
      '<div class="field"><label class="field-label" for="p-name">Name</label><input class="input" id="p-name" name="name" type="text" value="' + esc(draft.name) + '"><p class="hint">Internal label. Replies in Slack always post as Flue Assistant.</p></div>' +
      '<div class="field"><label class="field-label" for="p-model">Model</label><input class="input mono" id="p-model" name="model" type="text" value="' + esc(draft.model || "") + '" role="combobox" aria-expanded="true" placeholder="Automatic (provider default)"><p class="hint">Automatic by default. Suggestions come from this install\\'s providers; any provider/model specifier works.</p>' + (warning ? '<p class="field-error">' + esc(warning) + '</p>' : "") + modelPickerHtml(draft.model || "") + '</div>' +
      '<div class="field full"><label class="field-label" for="p-desc">Description</label><input class="input" id="p-desc" name="description" type="text" value="' + esc(draft.description) + '"></div>' +
      '<div class="field full" style="flex-direction:row; align-items:center; gap:10px;"><span class="toggle"><span class="thumb"></span><input type="checkbox" name="enabled" ' + (draft.enabled ? "checked" : "") + ' aria-label="Profile enabled"></span><span class="field-label" style="display:inline;">Enabled</span><span class="hint">Disabled profiles stop answering in every channel they are attached to.</span></div>' +
      '</form>';
  }

  function profileInstructionsHtml(draft) {
    return '<div style="display:flex; flex-direction:column; gap:14px;"><div class="field"><label class="field-label" for="p-instr">Profile instructions</label><textarea class="textarea" id="p-instr" name="instructions" style="min-height:130px;">' + esc(draft.instructions) + '</textarea><p class="hint">Travel with the profile to every channel it is attached to.</p></div>' +
      '<div class="layer-legend"><p class="field-label">How instructions layer at runtime</p><div class="step"><span class="n">1</span><span><b style="font-weight:500; color:var(--text);">Profile instructions</b> &mdash; this tab, shared across channels.</span></div><div class="step"><span class="n">2</span><span><b style="font-weight:500; color:var(--text);">Channel instructions</b> &mdash; appended per channel, set on each channel page.</span></div><div class="step"><span class="n">3</span><span><b style="font-weight:500; color:var(--text);">Guardrail</b> &mdash; always appended by the runtime.</span></div><p class="hint">Each channel\\'s Access summary shows the exact resolved stack.</p></div></div>';
  }

  function profileChannelsHtml(draft) {
    var attached = allAssignmentsForAgent(draft.id);
    var rows = attached.length === 0
      ? '<div class="empty"><p class="field-label">No channels yet &mdash; add one</p><p class="hint">Channels added here can append their own instructions on the channel page.</p></div>'
      : attached.map(function (assignment) {
          var wild = isWildcardAssignment(assignment);
          var name = wild ? "All channels" : channelLabel(assignment);
          var meta = wild
            ? esc(assignment.workspaceId) + "/" + esc(assignment.channelId) + " · catch-all fallback"
            : esc(assignment.channelId) + ' · ' + (assignment.channelPromptAddendum ? "has channel instructions" : "no channel instructions");
          return '<div class="bundle-row"><span class="b-name mono" style="font-weight:500;">' + esc(name) + '</span><span class="b-meta">' + meta + '</span><span class="spacer"></span><button type="button" class="btn btn-danger btn-sm" data-action="remove-profile-channel" data-workspace="' + esc(assignment.workspaceId) + '" data-channel="' + esc(assignment.channelId) + '">Remove</button></div>';
        }).join("");
    var form = draft.id
      ? '<form class="rail-form" style="margin-left:0;" data-action="profile-add-channel"><div class="form-grid">' + channelFieldsHtml("profile") + '</div><button type="submit" class="btn btn-soft btn-sm">Add to channels</button></form>'
      : '<p class="hint">Save this profile before adding it to channels.</p>';
    return '<div style="display:flex; flex-direction:column; gap:10px;"><p class="hint">Channels this profile answers in. Each channel can append its own instructions on its channel page.</p>' + rows + form + '</div>';
  }

  function modelPickerHtml(current) {
    var html = '<div class="combo-list" role="listbox"><button type="button" class="combo-opt plain ' + (!current ? "active" : "") + '" data-action="pick-model" data-model="">Automatic (provider default)</button>';
    state.models.providers.forEach(function (provider) {
      if (!provider.configured) return;
      html += '<div class="combo-group">' + esc(provider.id) + '<span class="src">· ' + esc(provider.source) + '</span></div>';
      provider.suggestions.forEach(function (model) {
        html += '<button type="button" class="combo-opt ' + (current === model ? "active" : "") + '" data-action="pick-model" data-model="' + esc(model) + '">' + esc(model) + '</button>';
      });
    });
    return html + '<div class="combo-foot">Suggestions come from this install\\'s configured providers. Type any provider/model specifier.</div></div>';
  }

  function enabledBadge(enabled) {
    return '<span class="badge ' + (enabled ? "badge-on" : "badge-off") + '" style="margin-left:6px;"><span class="dot"></span>' + (enabled ? "Enabled" : "Disabled") + '</span>';
  }

  function toolsChips(tools) {
    if (!tools || tools.length === 0) return '<span class="hint">No tools allowed</span>';
    return tools.map(function (tool) { return '<span class="chip">' + esc(tool) + '</span>'; }).join(" ");
  }

  function toolsLabel(tools) {
    return tools && tools.length ? tools.join(" · ") : "no tools";
  }

  function modelLabel(agent) {
    return agent.model || "Automatic";
  }

  function instructionLayersHtml(layers) {
    return layers.map(function (layer) {
      var ember = layer.source === "channel";
      return '<span class="layer-tag ' + (ember ? "ember" : "") + '">' + esc(layer.label) + '</span><span class="' + (ember ? "from-addendum" : "") + '">' + esc(layer.text) + '</span>';
    }).join("");
  }

  function providerBadges() {
    return state.models.providers.map(function (provider) {
      return '<span class="badge ' + (provider.configured ? "badge-on" : "badge-off") + '"><span class="dot"></span>' + esc(provider.id) + '</span>';
    }).join("");
  }

  function shortHash(hash) {
    return hash ? hash.slice(0, 6) + "..." + hash.slice(-4) : "pending";
  }

  function tabClass(tab) {
    return state.modalTab === tab ? "active" : "";
  }

  function newProfileDraft() {
    var base = defaultAgent();
    return {
      id: "",
      name: "New profile",
      description: "",
      instructions: "Answer with concise, factual Slack context.",
      enabled: true,
      model: "",
      defaultModels: base ? base.defaultModels : defaultModels(),
      allowedTools: base ? base.allowedTools : []
    };
  }

  function cloneAgent(agent) {
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      instructions: agent.instructions,
      enabled: agent.enabled,
      model: agent.model || "",
      defaultModels: agent.defaultModels || defaultModels(),
      allowedTools: agent.allowedTools || []
    };
  }

  function modelWarning(model) {
    if (!model || model.indexOf("/") < 1) return "";
    var provider = model.slice(0, model.indexOf("/"));
    var known = state.models.providers.some(function (item) { return item.configured && item.id === provider; });
    return known ? "" : "Free text accepted; provider not detected in this install.";
  }

  function slugId(name) {
    var slug = String(name || "profile").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!slug) slug = "profile";
    var id = "agent_" + slug;
    if (!agentById(id)) return id;
    return id + "_" + Date.now().toString(36);
  }

  function collectProfileDraft() {
    var draft = state.profileDraft || newProfileDraft();
    var nameInput = document.getElementById("p-name");
    var modelInput = document.getElementById("p-model");
    var descInput = document.getElementById("p-desc");
    var enabledInput = document.querySelector('input[name="enabled"]');
    var instructionsInput = document.getElementById("p-instr");
    if (nameInput) draft.name = nameInput.value.trim();
    if (modelInput) draft.model = modelInput.value.trim();
    if (descInput) draft.description = descInput.value;
    if (enabledInput) draft.enabled = enabledInput.checked;
    if (instructionsInput) draft.instructions = instructionsInput.value.trim();
    state.profileDraft = draft;
    return draft;
  }

  // The dirty -> enabled rule for the save bar lives in saveBarHtml; this
  // mirrors it for the keystroke path, which skips a full render to preserve
  // textarea focus.
  function syncSaveBar() {
    var discard = document.querySelector('[data-action="discard-channel"]');
    var save = document.querySelector('[data-action="save-channel"]');
    if (discard) discard.disabled = !state.dirty;
    if (save) save.disabled = !state.dirty;
  }

  function channelDraftFrom(assignment) {
    return {
      enabled: assignment ? assignment.enabled : true,
      channelPromptAddendum: (assignment && assignment.channelPromptAddendum) || ""
    };
  }

  function selectActive(workspaceId, channelId) {
    state.active = { workspaceId: workspaceId, channelId: channelId };
    var assignment = activeAssignment();
    state.channelDraft = channelDraftFrom(assignment);
    state.channelFormDraft.workspaceId = workspaceId || state.channelFormDraft.workspaceId;
    state.dirty = false;
    state.saveError = "";
    // Re-render when the resolution lands — the click handler's synchronous
    // render() only paints the "Resolving..." placeholder.
    loadEffective().then(render);
  }

  function refreshData() {
    return Promise.all([
      api("/admin/api/agents"),
      api("/admin/api/assignments"),
      api("/admin/api/models")
    ]).then(function (parts) {
      state.agents = parts[0].agents || [];
      state.assignments = parts[1].assignments || [];
      state.models = parts[2];
      var channels = concreteAssignments();
      if (!state.active && channels[0]) {
        state.active = { workspaceId: channels[0].workspaceId, channelId: channels[0].channelId };
      }
      if (state.active) {
        var assignment = activeAssignment();
        if (assignment) {
          state.channelDraft = channelDraftFrom(assignment);
        }
      }
      syncChannelFormWorkspacePrefill();
      return loadEffective();
    }).then(render).catch(function (error) {
      document.querySelector(".main-inner").innerHTML = '<div class="empty"><p class="field-label">Admin failed to load</p><p class="error">' + esc(error.message) + '</p></div>';
    });
  }

  function loadEffective() {
    state.effective = null;
    state.effectiveError = "";
    if (!state.active) return Promise.resolve();
    return api("/admin/api/effective-config?workspaceId=" + encodeURIComponent(state.active.workspaceId) + "&channelId=" + encodeURIComponent(state.active.channelId))
      .then(function (body) { state.effective = body.config; })
      .catch(function (error) { state.effectiveError = error.message; });
  }

  function putAssignment(workspaceId, channelId, agentId, enabled, addendum, label) {
    var body = { workspaceId: workspaceId, channelId: channelId, agentId: agentId, enabled: enabled };
    var normalizedLabel = normalizeChannelLabel(label);
    if (normalizedLabel) body.channelLabel = normalizedLabel;
    if (addendum !== undefined) body.channelPromptAddendum = addendum;
    return postJson("/admin/api/assignments", "PUT", body);
  }

  document.addEventListener("click", function (event) {
    var target = event.target.closest("[data-action]");
    if (!target) return;
    var action = target.getAttribute("data-action");
    if (action === "open-profiles") {
      var agent = activeAssignment() ? agentById(activeAssignment().agentId) : defaultAgent();
      state.editingAgentId = agent ? agent.id : null;
      state.profileDraft = agent ? cloneAgent(agent) : newProfileDraft();
      state.modalOpen = true;
      state.modalTab = "details";
      state.profileError = "";
      render();
    }
    if (action === "close-profiles") { state.modalOpen = false; render(); }
    if (action === "select-channel") { selectActive(target.getAttribute("data-workspace"), target.getAttribute("data-channel")); render(); }
    if (action === "toggle-add-channel") { state.addChannelOpen = true; state.addChannelError = ""; syncChannelFormWorkspacePrefill(); render(); }
    if (action === "cancel-add-channel") { state.addChannelOpen = false; state.addChannelError = ""; render(); }
    if (action === "toggle-swap") { state.swapOpen = !state.swapOpen; render(); }
    if (action === "attach-selected-profile") { attachSelectedProfile(); }
    if (action === "detach-profile") { detachProfile(); }
    if (action === "discard-channel") { var a = activeAssignment(); if (a) selectActive(a.workspaceId, a.channelId); render(); }
    if (action === "save-channel") { saveChannel(); }
    if (action === "profile-tab") { collectProfileDraft(); state.modalTab = target.getAttribute("data-tab"); if (state.modalTab === "channels") syncChannelFormWorkspacePrefill(); renderModal(); }
    if (action === "select-profile") { var selected = agentById(target.getAttribute("data-agent")); if (selected) { state.editingAgentId = selected.id; state.profileDraft = cloneAgent(selected); state.profileError = ""; renderModal(); } }
    if (action === "new-profile") { state.editingAgentId = null; state.profileDraft = newProfileDraft(); state.modalTab = "details"; state.profileError = ""; renderModal(); }
    if (action === "pick-model") { var modelInput = document.getElementById("p-model"); if (modelInput) modelInput.value = target.getAttribute("data-model") || ""; collectProfileDraft(); renderModal(); }
    if (action === "save-profile") { saveProfile(); }
    if (action === "delete-profile") { deleteProfile(); }
    if (action === "remove-profile-channel") { removeProfileChannel(target.getAttribute("data-workspace"), target.getAttribute("data-channel")); }
  });

  document.addEventListener("input", function (event) {
    var target = event.target;
    var action = target.getAttribute && target.getAttribute("data-action");
    if (action === "channel-addendum") {
      state.channelDraft.channelPromptAddendum = target.value;
      state.dirty = true;
      state.saveError = "";
      syncSaveBar();
    }
  });

  document.addEventListener("change", function (event) {
    var target = event.target;
    var action = target.getAttribute && target.getAttribute("data-action");
    if (action === "channel-enabled") {
      state.channelDraft.enabled = target.checked;
      state.dirty = true;
      render();
    }
  });

  document.addEventListener("submit", function (event) {
    var form = event.target;
    var action = form.getAttribute("data-action");
    if (!action) return;
    event.preventDefault();
    if (action === "add-channel-form") addChannel(new FormData(form));
    if (action === "profile-add-channel") addProfileChannel(new FormData(form));
  });

  // Label persist rule shared by both add-channel forms: an explicitly typed
  // name wins, else keep an existing assignment's label, else empty.
  function resolveChannelLabelToPersist(workspaceId, channelId, rawLabel) {
    var existing = assignmentByKey(workspaceId, channelId);
    return normalizeChannelLabel(rawLabel) || (existing && existing.channelLabel) || "";
  }

  // One submit flow for the rail form and the profile modal's Channels tab;
  // callers differ only in agent source and error sink. Returns null when
  // validation failed (the fail sink has already rendered the message).
  function submitChannelForm(formData, agentId, missingAgentMessage, fail, blockExisting) {
    var workspaceId = String(formData.get("workspaceId") || "").trim();
    var channelId = String(formData.get("channelId") || "").trim();
    var channelLabel = resolveChannelLabelToPersist(workspaceId, channelId, formData.get("channelLabel"));
    state.channelFormDraft = { workspaceId: workspaceId, channelId: channelId, channelLabel: channelLabel };
    if (!agentId) { fail(missingAgentMessage); return null; }
    if (!workspaceId) { fail("Workspace ID is required."); return null; }
    if (!channelId) { fail("Channel ID is required."); return null; }
    var existing = assignmentByKey(workspaceId, channelId);
    // The rail's "+ Add channel" is for creating a NEW channel — refuse to
    // silently steal one already assigned to another profile.
    if (blockExisting && existing) {
      fail("Channel " + channelId + " is already assigned. Select it from the list to edit.");
      return null;
    }
    // Preserve a re-added channel's enabled flag and channel instructions: the
    // add form sets the profile and label only, never wiping saved config or
    // re-enabling a deliberately disabled channel.
    var enabled = existing ? existing.enabled : true;
    var addendum = existing ? existing.channelPromptAddendum : undefined;
    return putAssignment(workspaceId, channelId, agentId, enabled, addendum, channelLabel).then(function () {
      state.active = { workspaceId: workspaceId, channelId: channelId };
    });
  }

  function addChannel(formData) {
    var agent = defaultAgent();
    var fail = function (message) { state.addChannelError = message; render(); };
    var submitted = submitChannelForm(formData, agent && agent.id, "Create a profile before adding a channel.", fail, true);
    if (!submitted) return;
    submitted.then(function () {
      state.addChannelOpen = false;
      state.addChannelError = "";
      return refreshData();
    }).catch(function (error) { fail(error.message); });
  }

  function attachSelectedProfile() {
    var assignment = activeAssignment();
    var select = document.querySelector('[data-role="swap-profile"]');
    if (!assignment || !select) return;
    // Swap only the profile; keep the channel's persisted enabled/instructions
    // so an unsaved textarea edit is not committed as a side effect.
    putAssignment(assignment.workspaceId, assignment.channelId, select.value, assignment.enabled, assignment.channelPromptAddendum, assignment.channelLabel).then(function () {
      state.swapOpen = false;
      return refreshData();
    }).catch(function (error) { state.saveError = error.message; render(); });
  }

  function detachProfile() {
    var assignment = activeAssignment();
    if (!assignment) return;
    api("/admin/api/assignments?workspaceId=" + encodeURIComponent(assignment.workspaceId) + "&channelId=" + encodeURIComponent(assignment.channelId), { method: "DELETE" }).then(function () {
      state.active = null;
      return refreshData();
    }).catch(function (error) { state.saveError = error.message; render(); });
  }

  function saveChannel() {
    var assignment = activeAssignment();
    if (!assignment) return;
    putAssignment(assignment.workspaceId, assignment.channelId, assignment.agentId, state.channelDraft.enabled, state.channelDraft.channelPromptAddendum, assignment.channelLabel).then(function () {
      state.dirty = false;
      state.saveError = "";
      return refreshData();
    }).catch(function (error) { state.saveError = error.message; render(); });
  }

  function saveProfile() {
    var draft = collectProfileDraft();
    if (!draft.name) { state.profileError = "Name is required."; renderModal(); return; }
    if (!draft.instructions) { state.profileError = "Profile instructions are required."; renderModal(); return; }
    var body = {
      name: draft.name,
      description: draft.description,
      instructions: draft.instructions,
      enabled: draft.enabled,
      defaultModels: draft.defaultModels || defaultModels(),
      allowedTools: draft.allowedTools || []
    };
    if (draft.model) body.model = draft.model;
    var request;
    if (draft.id) {
      body.model = draft.model || null;
      request = postJson("/admin/api/agents/" + encodeURIComponent(draft.id), "PATCH", body);
    } else {
      body.id = slugId(draft.name);
      request = postJson("/admin/api/agents", "POST", body);
    }
    request.then(function (result) {
      state.modalOpen = false;
      state.profileError = "";
      if (!state.active && result.agent) state.editingAgentId = result.agent.id;
      return refreshData();
    }).catch(function (error) { state.profileError = error.message; renderModal(); });
  }

  function deleteProfile() {
    var draft = state.profileDraft;
    if (!draft || !draft.id) return;
    api("/admin/api/agents/" + encodeURIComponent(draft.id), { method: "DELETE" }).then(function () {
      state.modalOpen = false;
      if (state.active && activeAssignment() && activeAssignment().agentId === draft.id) state.active = null;
      return refreshData();
    }).catch(function (error) { state.profileError = error.message; renderModal(); });
  }

  function addProfileChannel(formData) {
    var draft = collectProfileDraft();
    var fail = function (message) { state.profileError = message; renderModal(); };
    var submitted = submitChannelForm(formData, draft.id, "Save profile before adding channels.", fail);
    if (!submitted) return;
    submitted.then(function () {
      state.channelFormDraft.channelId = "";
      state.channelFormDraft.channelLabel = "";
      return refreshData();
    }).catch(function (error) { fail(error.message); });
  }

  function removeProfileChannel(workspaceId, channelId) {
    api("/admin/api/assignments?workspaceId=" + encodeURIComponent(workspaceId) + "&channelId=" + encodeURIComponent(channelId), { method: "DELETE" })
      .then(refreshData)
      .catch(function (error) { state.profileError = error.message; renderModal(); });
  }

  refreshData();
})();
</script>
</body>
</html>`;
}
