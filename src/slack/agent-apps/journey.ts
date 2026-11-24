/**
 * The web pages an Owner sees on the way to an Agent's own Slack app: the
 * hand-off that makes the press, its failures, the Added page, and the
 * outcomes after Slack's permission screen. Each is the shared journey card
 * with the three steps, the Agent, one way forward and what happens next;
 * nothing on it is a diagnostic.
 */
import { AGENT_SLACK_APP_SURFACE, renderSlackJourneyPage, type SlackJourneyAgent } from '../../admin/page.ts';
import { escapeHtml } from '../../security/html-escape.ts';
import { YOUR_APPS_URL } from './pages.ts';

export type AgentAppPageAgent = Pick<SlackJourneyAgent, 'name' | 'handle' | 'avatarUrl'>;

/** Where a page's buttons lead; each is built by the caller from the host and Admin's origin. */
export interface AgentAppPageLinks {
  /** Admin's home, or its Slack connection section. */
  admin: string;
  tokenPage?: string;
  /** The hand-off page: the press again, which picks the Agent's record up wherever it is. */
  add?: string;
  /** The Agent's own app in Slack. */
  openInSlack?: string;
  /** The Agent's page in Admin, where it is renamed. */
  agentPage?: string;
}

/** Where an Owner is on the three steps: the step under way, 3 once all are done, or -1 for a page about no Agent, which has no bar. */
type Step = -1 | 0 | 1 | 2 | 3;

interface Card {
  status: number;
  step: Step;
  title: string;
  /** Escaped text; `**Allow**` is the one word shown strong. */
  intro: string;
  agent?: AgentAppPageAgent | undefined;
  mark?: SlackJourneyAgent['mark'];
  /** Trusted HTML: the primary action, then at most one quiet link. */
  actions: string;
  next?: string;
  lines?: { done?: string; now: string; todo?: string };
  /** The hand-off's press, submitted by the page itself under this nonce. */
  pressNonce?: string;
}

const STEPS = [{ label: 'Slack token', note: 'Once per workspace' }, { label: 'Create app' }, { label: 'Allow in Slack' }];
/** Slack's authorize address, and the workspace's own address it redirects a signed-in person to. */
const SLACK_ORIGINS = 'https://slack.com https://*.slack.com';

function card(spec: Card): Response {
  const lines = spec.lines
    ? `<ol class="journey-steps" role="list">${spec.lines.done ? `<li class="done">${escapeHtml(spec.lines.done)}</li>` : ''}<li class="now">${escapeHtml(spec.lines.now)}</li>${spec.lines.todo ? `<li class="todo">${escapeHtml(spec.lines.todo)}</li>` : ''}</ol>`
    : '';
  const next = spec.next ? `<p class="journey-next"><span>${strong(spec.next)}</span></p>` : '';
  const press = spec.pressNonce
    ? `<script nonce="${escapeHtml(spec.pressNonce)}">document.forms['agent-app-press'].submit();</script>`
    : '';
  const actions = `${spec.actions ? `<div class="auth-actions">${spec.actions}</div>` : ''}${next}`;
  const html = renderSlackJourneyPage({
    surface: AGENT_SLACK_APP_SURFACE,
    title: spec.title,
    ...(spec.step === -1 ? {} : { progress: { steps: STEPS, current: spec.step } }),
    ...(spec.agent ? { agent: { ...spec.agent, ...(spec.mark ? { mark: spec.mark } : {}) } } : {}),
    // The intro is in the body so its one strong word can be markup; it sits where the shell puts an intro.
    // While the page presses by itself, Continue shows only after a few seconds, so a click cannot cut that press short.
    body: `<p class="auth-intro">${strong(spec.intro)}</p>${lines}${press ? `<div class="journey-later">${actions}</div>` : actions}${press}`,
  });
  return new Response(html, { status: spec.status, headers: pageHeaders(spec.pressNonce) });
}

/** Escapes the text, then shows `**Allow**` as the one strong word. */
function strong(text: string): string {
  return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function pageHeaders(nonce: string | undefined): Headers {
  return new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    // The press answers with a redirect to Slack. Chromium checks every hop of that redirect against form-action.
    'content-security-policy': `default-src 'none'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}; style-src 'unsafe-inline'; ` +
      `font-src 'self'; img-src 'self' https: data:; form-action 'self' ${SLACK_ORIGINS}; base-uri 'none'; frame-ancestors 'none'`,
  });
}

const slackLogo = '<span class="slack-provider-logo slack-logo-image" aria-hidden="true"></span>';

/** The press: a same-origin POST to the page's own address. */
function pressButton(label: string, slack: boolean): string {
  return `<form id="agent-app-press" method="post"><button class="auth-button" type="submit">${slack ? slackLogo : ''}${escapeHtml(label)}</button></form>`;
}

function link(href: string, label: string, options: { slack?: boolean; external?: boolean } = {}): string {
  const external = options.external ? ' rel="noreferrer" target="_blank"' : '';
  return `<a class="auth-link" href="${escapeHtml(href)}"${external}>${options.slack ? slackLogo : ''}${escapeHtml(label)}${options.external ? ' <span aria-hidden="true">&#8599;</span>' : ''}</a>`;
}

function quiet(href: string, label: string): string {
  return `<a class="auth-text-link" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

/** A quiet Try again that presses again. */
function quietPress(label: string): string {
  return `<form method="post"><button class="auth-text-link" type="submit">${escapeHtml(label)}</button></form>`;
}

/**
 * The hand-off: its own POST goes out as soon as the page loads, and Continue
 * sends it again for a browser that did not. `opening` is for an app that
 * already waits for Allow, so the press goes straight to Slack. Without
 * `pressOnOpen` only Continue presses.
 */
export function handoffPage(agent: AgentAppPageAgent, stage: 'creating' | 'opening', pressOnOpen = true): Response {
  const nonce = pressOnOpen ? crypto.randomUUID().replace(/-/g, '') : undefined;
  const { name } = agent;
  return card({
    status: 200,
    step: stage === 'creating' ? 1 : 2,
    title: `Adding ${name} to Slack`,
    intro: stage === 'creating'
      ? "This takes a few seconds. Then Slack's permission screen opens on its own. Choose **Allow** there."
      : "Slack's permission screen is opening. Choose **Allow** there.",
    agent,
    mark: 'wait',
    lines: stage === 'creating'
      ? { now: `Creating ${name}'s Slack app…`, todo: "Opening Slack's permission screen" }
      : { done: `Created ${name}'s Slack app`, now: "Opening Slack's permission screen…" },
    actions: pressButton('Continue to Slack', true),
    next: "Use this if Slack hasn't opened yet.",
    ...(nonce ? { pressNonce: nonce } : {}),
  });
}

/** Why a press stopped short of Slack's permission screen. */
export type AddRefusal =
  | 'token_needed'
  /** Slack refused to create the app. */
  | 'create_refused'
  /** Stopped for any other reason, before or after Slack made the app. */
  | 'not_finished'
  | 'ambiguous_create'
  | 'still_creating'
  | 'cancelling'
  | 'app_limit'
  | 'handle_taken'
  | 'permission_needed';

export function addRefusedPage(refusal: AddRefusal, agent: AgentAppPageAgent, links: AgentAppPageLinks): Response {
  const { name, handle } = agent;
  const tryAgain = pressButton('Try again', false);
  switch (refusal) {
    case 'token_needed':
      return card({
        status: 409, step: 0, agent, title: 'Slack needs one token first',
        intro: `Before Chickpea can create ${name}'s Slack app, it needs one Slack token for this workspace. You only do this once.`,
        actions: link(links.tokenPage ?? links.admin, 'Add the token'),
        next: `After that, choose Add to Slack again. Chickpea creates ${name}'s app and opens Slack's permission screen.`,
      });
    case 'create_refused':
    case 'not_finished':
      return card({
        status: 502, step: 1, agent, mark: 'warn', title: `Adding ${name} to Slack didn't finish`,
        intro: refusal === 'create_refused'
          ? 'Try again in a minute. If it keeps happening, check that your workspace allows new apps.'
          : 'Try again in a minute.',
        actions: tryAgain,
        next: "Slack's permission screen opens. Choose **Allow**.",
      });
    case 'ambiguous_create':
      return card({
        status: 409, step: 1, agent, mark: 'warn', title: `Slack may have created ${name}'s app`,
        intro: `Chickpea didn't hear back from Slack. In Your Apps, delete any ${name} app you don't recognize, then try again.`,
        actions: `${link(YOUR_APPS_URL, 'Open Your Apps in Slack', { external: true })}${quietPress('Try again')}`,
      });
    case 'still_creating':
      return card({
        status: 202, step: 1, agent, mark: 'wait', title: `Slack is still creating ${name}'s app`,
        intro: 'Wait a moment, then try again.',
        actions: tryAgain,
        next: "Slack's permission screen opens. Choose **Allow**.",
      });
    case 'cancelling':
      return card({
        status: 409, step: 1, agent, mark: 'wait', title: `Chickpea is removing ${name}'s earlier app`,
        intro: `An earlier start was cancelled, and Chickpea is still removing the app it made. Try again in a minute to add ${name}.`,
        actions: tryAgain,
      });
    case 'app_limit':
      return card({
        status: 409, step: 1, agent, mark: 'warn', title: "This workspace may have reached Slack's app limit",
        intro: `Slack wouldn't create another app here. Remove an app you no longer use in Slack, then try again.`,
        actions: `${link(YOUR_APPS_URL, 'Open Your Apps in Slack', { external: true })}${quietPress('Try again')}`,
      });
    case 'handle_taken':
      return card({
        status: 409, step: 1, agent, mark: 'warn', title: `Another Agent uses @${handle}`,
        intro: `Another Agent is using @${handle} in Slack, or is being added with it. Rename ${name} in Chickpea Admin, then add it again.`,
        actions: link(links.agentPage ?? links.admin, `Rename ${name}`),
      });
    case 'permission_needed':
      return card({
        status: 409, step: 1, agent, mark: 'warn', title: 'Chickpea needs one more Slack permission',
        intro: `To give @${handle} to ${name}'s own app, Chickpea first needs your permission in Slack. In Chickpea Admin, choose Update in Slack at the top of the page and allow it.`,
        actions: link(links.admin, 'Open Chickpea Admin'),
        next: `Then add ${name} again.`,
      });
  }
}

/** Anyone but a workspace Owner: nothing about the Agent is shown. */
export function ownerNeededPage(): Response {
  return card({
    status: 403, step: -1, title: 'A workspace Owner adds Agents to Slack',
    intro: 'Only an Owner of this Slack workspace can add an Agent to Slack. Ask one of them to open this link.',
    actions: '',
  });
}

/** An Agent that is gone, archived, or otherwise not one an Owner can add. */
export function notAddablePage(links: Pick<AgentAppPageLinks, 'admin'>): Response {
  return card({
    status: 404, step: -1, title: "This Agent can't be added to Slack",
    intro: 'It may have been archived or deleted. Chickpea Admin shows the Agents you can add.',
    actions: link(links.admin, 'Open Chickpea Admin'),
  });
}

/**
 * The Agent is in Slack: just added, or already there. Without its own app
 * (it answers through Chickpea's handle), Admin is the way on.
 */
export function addedPage(
  agent: AgentAppPageAgent,
  links: AgentAppPageLinks,
  variant: 'added' | 'already',
): Response {
  const { name, handle } = agent;
  const open = links.openInSlack ? link(links.openInSlack, `Open ${name} in Slack`, { slack: true }) : link(links.admin, 'Open Chickpea Admin');
  return card({
    status: 200, step: 3, agent, mark: 'ok',
    title: variant === 'added' ? `${name} is in Slack` : `${name} is already in Slack`,
    intro: variant === 'added'
      ? `People can now message @${handle} directly and mention it in channels it's in.`
      : links.openInSlack
        ? `${name} has its own Slack app. People can message @${handle} directly.`
        : `People can already mention @${handle} in Slack.`,
    actions: `${open}${links.openInSlack ? quiet(links.admin, 'Back to Chickpea Admin') : ''}`,
  });
}

export type ConsentOutcome =
  | 'cancelled'
  | 'expired'
  | 'another_person'
  | 'other_workspace'
  | 'missing_permissions'
  | 'slack_down'
  | 'already_active';

const CONSENT_STATUS = {
  cancelled: 200,
  expired: 410,
  another_person: 403,
  other_workspace: 409,
  missing_permissions: 409,
  slack_down: 503,
  already_active: 409,
} satisfies Record<ConsentOutcome, number>;

/** Back from Slack's permission screen without the app added: one headline, one sentence and one way forward. */
export function consentPage(outcome: ConsentOutcome, agent: AgentAppPageAgent, links: AgentAppPageLinks): Response {
  const { name } = agent;
  const status = CONSENT_STATUS[outcome];
  if (outcome === 'already_active') return withStatus(addedPage(agent, links, 'already'), status);
  if (outcome === 'another_person') {
    return card({
      status, step: 2, agent, mark: 'warn', title: 'Another Owner started this',
      intro: `Only the Owner who started adding ${name} can choose Allow. Ask them to finish, or start again yourself in Chickpea Admin.`,
      actions: link(links.admin, 'Open Chickpea Admin'),
    });
  }
  const copy = {
    cancelled: [`${name} wasn't added`, `You didn't choose Allow on Slack's permission screen, so ${name} isn't in Slack yet.`],
    expired: ['That link expired', "Links to Slack's permission screen only work for a short time. Start again; it takes a moment."],
    other_workspace: ['That was a different Slack workspace', `${name} belongs to another workspace. Try again, and check which workspace Slack's permission screen shows before you choose Allow.`],
    missing_permissions: [`${name} needs every permission`, `Slack didn't add ${name} because some permissions weren't allowed. Try again and allow them all.`],
    slack_down: ["Slack didn't answer", `${name} isn't in Slack yet. Wait a minute, then try again.`],
  } satisfies Record<Exclude<ConsentOutcome, 'already_active' | 'another_person'>, [string, string]>;
  const [title, intro] = copy[outcome];
  return card({
    status, step: 2, agent, mark: 'warn', title, intro,
    actions: links.add ? link(links.add, 'Try again', { slack: true }) : link(links.admin, 'Open Chickpea Admin'),
    ...(links.add ? { next: "Slack's permission screen opens. Choose **Allow**." } : {}),
  });
}

/** Back from Slack with a link that names no Agent Chickpea knows. */
export function unnamedExpiredPage(links: Pick<AgentAppPageLinks, 'admin'>): Response {
  return card({
    status: CONSENT_STATUS.expired, step: -1, title: 'That link expired',
    intro: "Links to Slack's permission screen only work for a short time. In Chickpea Admin, add the Agent to Slack again.",
    actions: link(links.admin, 'Open Chickpea Admin'),
  });
}

function withStatus(response: Response, status: number): Response {
  return new Response(response.body, { status, headers: response.headers });
}
