/**
 * The fixed text the browser tools return to the model, and the Slack status
 * shown while a step waits for approval.
 */

export const BROWSER_NOT_CONNECTED_MESSAGE =
  'The browser is not connected. Ask an Admin to connect it in Settings › Browser.';
export const BROWSER_DATA_CHANGE_REFUSAL =
  'Public websites are read-only: changing data needs a website login that allows actions. Tell the person what they can do themselves.';
/** The refusal for a data-changing step on a login granted checking only. */
export function browserCheckOnlyRefusal(host: string): string {
  return `This login allows checking only. Ask an Admin to allow actions on ${host} if this step should be taken.`;
}
export const BROWSER_NO_APPROVER_MESSAGE =
  'There is no person in this conversation to approve this step, so it cannot be taken. Tell the person what you would do, and that they can ask again in Slack.';
export const BROWSER_APPROVAL_INSTRUCTION =
  'Ask the person to reply exactly "approve" in this thread to let you take this step, or "stop". End your reply after asking.';
export const BROWSER_PAGE_CHANGED_MESSAGE =
  'The page changed since approval; take a new snapshot and ask again if the step is still right.';
/** Slack status while a data-changing step waits for the person. */
export const BROWSER_APPROVAL_ACTIVITY = ['checking', 'Waiting for approval on', 'a website'] as const;
export const BROWSER_NO_PAGE_MESSAGE = 'No page is open in the browser. Call browser_open first.';
export const BROWSER_VISION_UNAVAILABLE_MESSAGE =
  "This Agent's model cannot look at images. Use browser_snapshot instead.";
export const BROWSER_NO_LOGINS_MESSAGE =
  "This Agent has no website logins. An Admin can grant one on the Agent's Websites tab.";
export const BROWSER_UNKNOWN_LOGIN_MESSAGE =
  'This Agent has no website login with that id. Use a loginId from the Signing in section of the browser skill.';
export const BROWSER_LOGIN_REVOKED_MESSAGE =
  "This Agent's access to that website login was removed. Answer without signing in, and tell the person.";
export const BROWSER_HANDED_OFF_MESSAGE =
  'You already sent the person a private sign-in link for this site. End your reply now; continue when they answer.';
export const BROWSER_HANDOFF_NEEDS_PAID_PLAN_MESSAGE =
  "Handing a sign-in to a person needs a paid Browserbase plan, because the browser has to stay open while they sign in. Tell the person, and that an Admin can upgrade the Browserbase plan.";
export const BROWSER_HANDOFF_NO_REQUESTER_MESSAGE =
  'There is no person in this conversation to send a private sign-in link to. Tell the person the site needs them to sign in, and to ask again in a Slack conversation.';
export const BROWSER_HANDOFF_NOTE =
  'Tell the person you have sent them a private sign-in link and that you will continue when they reply. End your reply now.';
export const BROWSER_SIGN_IN_NOTE =
  'Judge from the page whether you are signed in. If it asks for a code this login cannot supply, or shows a challenge you cannot pass, call browser_handoff.';
