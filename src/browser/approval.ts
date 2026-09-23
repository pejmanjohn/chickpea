/**
 * Data-changing browser steps on a login granted `act`: held as a pending
 * action until the person replies "approve" in the Slack thread, then taken
 * once by the turn that reply starts. Form-filling steps before the held one
 * are kept so the approved turn, which runs in a new browser session, can
 * replay them first.
 */
import type { FlueLogger } from '@flue/runtime';

import { artifactFilename } from '../sandbox/artifact-tool.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  BrowserActionError,
  claimApprovedBrowserAction,
  createBrowserAction,
  MAX_BROWSER_FORM_STEPS,
  sweepBrowserActions,
  type BrowserActionRecord,
  type BrowserActionScope,
  type BrowserFormStep,
} from './actions.ts';
import {
  classifyGrantedLogin,
  requireOpenPage,
  websiteLoginMatchesUrl,
  type BrowserLoginBinder,
  type BrowserWebsiteLogin,
} from './binding.ts';
import {
  BROWSER_APPROVAL_INSTRUCTION,
  BROWSER_DATA_CHANGE_REFUSAL,
  BROWSER_HANDED_OFF_MESSAGE,
  BROWSER_NO_APPROVER_MESSAGE,
  BROWSER_NO_PAGE_MESSAGE,
  BROWSER_PAGE_CHANGED_MESSAGE,
  browserCheckOnlyRefusal,
} from './messages.ts';
import type { BrowserAction, BrowserPage, ElementRef, PageInfo } from './page.ts';
import type { BrowserTurnSession } from './turn-session.ts';

/**
 * Approval for data-changing steps on logins that allow actions: the Slack
 * conversation, Agent, and person this turn answers, and where pending
 * actions are stored. Absent (a scheduled run), such steps are refused.
 */
export interface BrowserApprovalOptions {
  scope: BrowserActionScope;
  /** The Slack message this turn answers; an approval is bound to it. */
  messageTs: string;
  settings: () => Promise<SettingsStore>;
  /** Called once a step is waiting for the person's reply. */
  onAwaitingApproval?: () => void;
}

/** The step the model asked for, as browser_act received it. */
export interface BrowserStepInput {
  ref: string;
  action: BrowserAction;
  text?: string | undefined;
  key?: string | undefined;
  submit?: boolean | undefined;
}

/** The page as the tools report it: redacted and capped. */
export interface BrowserPageReport {
  url: string;
  title: string;
  snapshot: string;
  truncated: boolean;
}

/** Pending records are swept only once the index holds more than this many. */
const SWEEP_MIN_INDEX = 8;
const FORM_STEP_ROLES = new Set(['checkbox', 'radio', 'switch', 'option', 'tab', 'combobox', 'menuitemcheckbox', 'menuitemradio']);

function quoted(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return `"${clean.length > max ? `${clean.slice(0, max)}…` : clean}"`;
}

/** Plain words for a step, such as `click "Confirm change"` or `press Enter`. */
export function describeBrowserAction(
  target: Pick<ElementRef, 'role' | 'name'>,
  action: BrowserAction,
  options: { text?: string | undefined; key?: string | undefined; submit?: boolean | undefined } = {},
): string {
  const element = target.name ? quoted(target.name, 80) : `the ${target.role || 'element'}`;
  switch (action) {
    case 'click': return `click ${element}`;
    case 'type': {
      const typed = options.text ? `type ${quoted(options.text, 60)} into ${element}` : `type into ${element}`;
      return options.submit ? `${typed} and press Enter` : typed;
    }
    case 'press': return `press ${options.key ?? 'a key'}`;
    case 'select': return options.text ? `choose ${quoted(options.text, 60)} in ${element}` : `choose an option in ${element}`;
    case 'clear': return `clear ${element}`;
    default: return `${action} ${element}`;
  }
}

/** Which of the refs sharing `target`'s role and name it is, in snapshot order. */
export function occurrenceOf(page: BrowserPage, ref: string, target: ElementRef): number {
  let count = 0;
  for (const [id, candidate] of page.refs) {
    if (id === ref) return count;
    if (candidate.role === target.role && candidate.name === target.name) count += 1;
  }
  return count;
}

/** Find an element again by role, name, and occurrence in the latest snapshot. */
export function findRef(page: BrowserPage, step: Pick<BrowserFormStep, 'role' | 'name' | 'occurrence'>): string | undefined {
  const matches = [...page.refs].filter(([, target]) => target.role === step.role && target.name === step.name);
  return (matches[step.occurrence] ?? (matches.length === 1 ? matches[0] : undefined))?.[0];
}

/** The replayable form step a non-data-changing action is, if any. */
export function formStepFor(page: BrowserPage, data: BrowserStepInput): BrowserFormStep | undefined {
  const target = page.refs.get(data.ref);
  if (!target) return undefined;
  const fills = data.action === 'type' || data.action === 'select' || data.action === 'clear' ||
    (data.action === 'click' && FORM_STEP_ROLES.has(target.role));
  if (!fills) return undefined;
  return {
    role: target.role,
    name: target.name,
    occurrence: occurrenceOf(page, data.ref, target),
    action: data.action,
    ...(data.text === undefined ? {} : { text: data.text }),
  };
}

/**
 * Form-filling steps taken on the current page, replayed before an approved
 * action because approval continues in a new browser session.
 */
export class BrowserFormSteps {
  #steps: BrowserFormStep[] = [];
  #url = '';

  /** Start over on `url`: a page was opened, navigated, submitted, or an approved step was taken. */
  reset(url: string): void {
    this.#steps = [];
    this.#url = url;
  }

  /**
   * Note a step's outcome: a field filled without leaving the page is kept;
   * a navigation or a submit starts over.
   */
  track(input: { step: BrowserFormStep | undefined; before: string; after: string; submitted: boolean }): void {
    if (input.step && input.after === input.before && !input.submitted) {
      if (input.before !== this.#url) this.reset(input.before);
      this.#steps = [...this.#steps, input.step].slice(-MAX_BROWSER_FORM_STEPS);
    } else if (input.after !== this.#url || input.submitted) {
      this.reset(input.after);
    }
  }

  /** The steps to replay before a step on `url`, if any were taken there. */
  preludeFor(url: string): BrowserFormStep[] | undefined {
    return this.#url === url && this.#steps.length ? this.#steps : undefined;
  }
}

function approvalErrorMessage(error: BrowserActionError): string {
  switch (error.code) {
    case 'consumed': return 'That approval was already used. Take a new snapshot and ask again if another step is needed.';
    case 'expired': return 'That approval expired. Take a new snapshot and ask again if the step is still right.';
    case 'not_approved': return 'The person has not approved that step with their latest reply. Ask them to reply exactly "approve" in this thread, and end your reply.';
    default: return 'That approval is not for this conversation. Ask the person again if the step is still right.';
  }
}

export interface BrowserApprovalContext {
  session: BrowserTurnSession;
  logins: BrowserLoginBinder;
  approvals: BrowserApprovalOptions | undefined;
  formSteps: BrowserFormSteps;
  readPage: (pageInfo?: PageInfo) => Promise<BrowserPageReport>;
  stageArtifact: (artifact: { bytes: Uint8Array; filename: string; title: string; kind: 'image' }) => Promise<unknown>;
  redact: (text: string) => string;
  errorMessage: (error: unknown) => string;
  now: () => Date;
  navigationTimeoutMs: number;
  log?: Pick<FlueLogger, 'warn'> | undefined;
}

/** The held-step half of browser_act: asking for approval and taking an approved step. */
export function createBrowserApprovalSteps(context: BrowserApprovalContext) {
  const { session, logins, formSteps, readPage } = context;
  const refuse = (error: string) => ({ output: { error } });
  let swept = false;

  /** The mounted grant for the open session's login, when it still allows actions. */
  const actionLogin = async (): Promise<BrowserWebsiteLogin | string> => {
    const bound = session.binding;
    if (!bound || session.policy.readOnly) {
      return bound ? browserCheckOnlyRefusal(bound.host) : BROWSER_DATA_CHANGE_REFUSAL;
    }
    const login = classifyGrantedLogin(logins.granted, await logins.mounted(), bound.loginId);
    if (typeof login === 'string') return logins.revoked(bound.loginId);
    return login.level === 'act' ? login : browserCheckOnlyRefusal(login.host);
  };

  /** Hold a data-changing step until the person approves it in Slack. */
  const askApproval = async (data: BrowserStepInput) => {
    if (!session.active) return refuse(BROWSER_NO_PAGE_MESSAGE);
    const login = await actionLogin();
    if (typeof login === 'string') return { output: { refused: true, reason: login } };
    const approvals = context.approvals;
    if (!approvals) return refuse(BROWSER_NO_APPROVER_MESSAGE);
    const { page } = await requireOpenPage(session);
    const target = page.refs.get(data.ref);
    if (!target) {
      return { output: { error: `Unknown element reference ${data.ref}; take a new snapshot`, ...(await readPage()) } };
    }
    const info = await page.pageInfo();
    if (!websiteLoginMatchesUrl(login.host, new URL(info.url))) {
      return refuse(`The page is no longer on ${login.host}. Open it with browser_open first.`);
    }
    const description = context.redact(describeBrowserAction(target, data.action, data));
    const settings = await approvals.settings();
    const at = context.now().getTime();
    // Cleanup of old records runs at most once a turn, and only once there is something to clear.
    if (!swept) {
      swept = true;
      await sweepBrowserActions({ settings, now: at, minIndexSize: SWEEP_MIN_INDEX }).catch(() => undefined);
    }
    const prelude = formSteps.preludeFor(info.url);
    const [record, picture] = await Promise.all([
      createBrowserAction(settings, {
        ...approvals.scope,
        loginId: login.id,
        host: login.host,
        url: info.url,
        title: info.title,
        ref: data.ref,
        role: target.role,
        name: target.name,
        occurrence: occurrenceOf(page, data.ref, target),
        action: data.action,
        ...(data.text === undefined ? {} : { text: data.text }),
        ...(data.key === undefined ? {} : { key: data.key }),
        ...(data.submit === undefined ? {} : { submit: data.submit }),
        ...(prelude ? { prelude } : {}),
        description,
        now: at,
      }),
      page.screenshot({ format: 'jpeg', quality: 70 }).then(
        (bytes) => ({ bytes }),
        (error: unknown) => ({ error }),
      ),
    ]);
    // The picture of the page rides with the question; the step waits either way.
    try {
      if ('error' in picture) throw picture.error;
      await context.stageArtifact({
        bytes: picture.bytes,
        filename: artifactFilename(undefined, 'about-to', 'jpg'),
        title: `About to: ${description}`.slice(0, 200),
        kind: 'image',
      });
    } catch (error) {
      context.log?.warn('browser_act could not attach the approval screenshot', { error: context.errorMessage(error) });
    }
    approvals.onAwaitingApproval?.();
    return {
      output: { awaitingApproval: true, actionId: record.id, description, instruction: BROWSER_APPROVAL_INSTRUCTION },
    };
  };

  /** Take a step the person approved: reopen its page, find the element again, act once. */
  const runApproved = async (actionId: string) => {
    const approvals = context.approvals;
    if (!approvals) return refuse(BROWSER_NO_APPROVER_MESSAGE);
    let record: BrowserActionRecord;
    try {
      record = await claimApprovedBrowserAction({
        settings: await approvals.settings(),
        id: actionId,
        scope: approvals.scope,
        messageTs: approvals.messageTs,
        now: context.now().getTime(),
      });
    } catch (error) {
      if (error instanceof BrowserActionError) return refuse(approvalErrorMessage(error));
      throw error;
    }
    const live = logins.liveReader();
    const login = classifyGrantedLogin(logins.granted, await live(), record.loginId);
    if (typeof login === 'string' || login.host !== record.host) return refuse(await logins.revoked(record.loginId));
    if (login.level !== 'act') return refuse(browserCheckOnlyRefusal(login.host));
    if (session.handedOff.has(login.id)) return refuse(BROWSER_HANDED_OFF_MESSAGE);
    const recordedHost = new URL(record.url).host;
    const timeoutMs = context.navigationTimeoutMs;
    let page: BrowserPage;
    let info: PageInfo;
    if (session.active && session.binding?.loginId === login.id) {
      page = (await requireOpenPage(session)).page;
      info = await page.pageInfo();
      if (info.url !== record.url) info = await page.navigate(record.url, { timeoutMs });
    } else {
      page = (await session.ensureFor(await logins.bindingFor(login, live))).page;
      info = await page.navigate(record.url, { timeoutMs });
    }
    const onRecordedHost = () => {
      try {
        return new URL(info.url).host === recordedHost;
      } catch {
        return false;
      }
    };
    if (!onRecordedHost()) return { output: { error: BROWSER_PAGE_CHANGED_MESSAGE, ...(await readPage(info)) } };
    // Restore what was filled in before the step, then find its element.
    for (const step of record.prelude ?? []) {
      await readPage(info);
      const ref = findRef(page, step);
      if (!ref) return { output: { error: BROWSER_PAGE_CHANGED_MESSAGE, ...(await readPage()) } };
      info = await page.act(ref, step.action, {
        ...(step.text === undefined ? {} : { text: step.text }),
        ...(step.key === undefined ? {} : { key: step.key }),
      });
      if (!onRecordedHost()) return { output: { error: BROWSER_PAGE_CHANGED_MESSAGE, ...(await readPage(info)) } };
    }
    await readPage(info);
    const ref = findRef(page, record);
    if (!ref) return { output: { error: BROWSER_PAGE_CHANGED_MESSAGE, ...(await readPage()) } };
    const done = await page.act(ref, record.action, {
      ...(record.text === undefined ? {} : { text: record.text }),
      ...(record.key === undefined ? {} : { key: record.key }),
      ...(record.submit === undefined ? {} : { submit: record.submit }),
    });
    formSteps.reset(done.url);
    return { output: { approvedStepTaken: record.description, ...(await readPage(done)) } };
  };

  return { askApproval, runApproved };
}
