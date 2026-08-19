export type SuggestedSkillCategoryId =
  | 'marketing'
  | 'writing'
  | 'research'
  | 'operations'
  | 'engineering';

export interface SuggestedSkillCategory {
  id: 'featured' | SuggestedSkillCategoryId;
  label: string;
  summary: string;
}

export interface SuggestedSkill {
  /** Stable catalog identity, persisted on a copied snapshot. */
  id: string;
  /** Runtime-valid skill name. */
  name: string;
  title: string;
  displaySlug: string;
  source: string;
  sourceUrl: string;
  description: string;
  runtimeDescription: string;
  categories: readonly SuggestedSkillCategoryId[];
  featured: boolean;
  instructions: string;
}

export const SUGGESTED_SKILL_CATEGORIES: readonly SuggestedSkillCategory[] = [
  { id: 'featured', label: 'Featured', summary: 'Recommended starting points' },
  { id: 'marketing', label: 'Marketing', summary: 'Campaigns, creative, conversion, and customer insight' },
  { id: 'writing', label: 'Writing', summary: 'Clear external and internal communication' },
  { id: 'research', label: 'Research', summary: 'Customer, market, and decision support' },
  { id: 'operations', label: 'Operations', summary: 'Meetings, reporting, handoffs, and support' },
  { id: 'engineering', label: 'Engineering', summary: 'Focused development and debugging workflows' },
] as const;

function instructions(markdown: string): string {
  return markdown.trim();
}

/**
 * Reviewed, self-contained snapshots adapted for a general Slack Agent. The
 * upstream projects are attribution and research sources; enabling one copies
 * this bounded text into the Agent instead of installing a plugin or syncing a
 * repository. Keep entries dependency-free because Flue stores only one skill
 * body and progressively discloses it at runtime.
 */
export const SUGGESTED_SKILLS: readonly SuggestedSkill[] = [
  {
    id: 'paid-ads',
    name: 'paid-ads',
    title: 'Paid ads',
    displaySlug: 'paid-ads',
    source: 'Corey Haines',
    sourceUrl: 'https://github.com/coreyhaines31/marketingskills/tree/main/skills/ads',
    description: 'Plan campaigns, budgets, targeting, and performance decisions.',
    runtimeDescription: 'Plan and optimize paid advertising campaigns, including goals, budgets, audiences, channel choice, measurement, and performance decisions.',
    categories: ['marketing'],
    featured: true,
    instructions: instructions(`
# Paid ads

Act as a practical performance marketer. Help plan, review, or improve paid campaigns without pretending to have platform data the user has not shared.

Start by establishing the business goal, offer, audience, channel, geography, budget, time horizon, conversion event, and target CPA or ROAS. Ask only for missing details that would materially change the recommendation. Separate known data from assumptions.

Build the campaign around:
- one primary objective and conversion event;
- a clear audience hypothesis, exclusions, and retargeting windows;
- a channel and campaign structure suited to intent;
- budget allocation with an explicit learning period and stop conditions;
- message-to-ad-to-landing-page continuity;
- trustworthy tracking, naming, and attribution limits.

For optimization, diagnose the funnel in order: delivery, click-through, landing-page conversion, lead or purchase quality, and payback. Do not celebrate a cheap click that produces poor customers. Compare segments only when volume is sufficient, call out noisy samples, and distinguish observed results from hypotheses.

End with a compact plan: objective, audience, campaign structure, budget, creative tests, measurement, risks, and the next three decisions. When reviewing results, include what changed, what likely caused it, what to keep, what to stop, and the smallest useful next test.
`),
  },
  {
    id: 'ad-creative',
    name: 'ad-creative',
    title: 'Ad creative',
    displaySlug: 'ad-creative',
    source: 'Corey Haines',
    sourceUrl: 'https://github.com/coreyhaines31/marketingskills/tree/main/skills/ad-creative',
    description: 'Create and iterate ad concepts, hooks, and variations.',
    runtimeDescription: 'Create and iterate paid-ad concepts, hooks, headlines, body copy, calls to action, and testable creative variations.',
    categories: ['marketing'],
    featured: true,
    instructions: instructions(`
# Ad creative

Act as a performance creative strategist. Produce testable creative ideas, not a pile of near-duplicate copy.

First identify the platform, placement, format, audience, awareness level, offer, desired action, brand voice, required claims, prohibited claims, and any character limits. If performance data exists, use it to identify winning angles and weak spots before creating variants.

Develop distinct angles such as pain, desired outcome, identity, proof, objection, comparison, urgency, or product demonstration. For each angle, pair one hook with a clear promise, supporting proof, and a direct call to action. Make every concept understandable without surrounding campaign context.

When generating a batch:
1. State the audience insight and hypothesis behind each angle.
2. Write genuinely different hooks rather than swapping adjectives.
3. Match copy length and structure to the placement.
4. Flag unsupported claims and information still needed.
5. Name the variable each concept tests so results can teach something.

Return a short creative matrix with concept name, audience insight, hook, primary text or script outline, headline, CTA, visual direction, and test hypothesis. Recommend a balanced first batch across angles and formats, then explain how to iterate from spend, click-through, conversion quality, and fatigue signals.
`),
  },
  {
    id: 'performance-report',
    name: 'performance-report',
    title: 'Performance report',
    displaySlug: 'performance-report',
    source: 'Anthropic',
    sourceUrl: 'https://github.com/anthropics/knowledge-work-plugins/tree/main/marketing/skills/performance-report',
    description: 'Turn campaign metrics into a clear summary and next actions.',
    runtimeDescription: 'Turn marketing or business performance data into a clear report with trends, wins, misses, caveats, and prioritized actions.',
    categories: ['marketing', 'operations'],
    featured: true,
    instructions: instructions(`
# Performance report

Translate raw metrics into a decision-ready report. Never invent missing values or silently mix incompatible time periods, currencies, attribution models, or metric definitions.

Confirm the audience, reporting window, comparison period, scope, source data, and decisions the report should support. Normalize definitions before calculating changes. If data quality is uncertain, label the limitation beside the affected conclusion.

Structure the report as:
1. Executive summary: the three most important developments and why they matter.
2. Scorecard: current value, comparison value, absolute change, percentage change, target, and status for the few metrics that drive the objective.
3. Trends: sustained movement, one-off anomalies, mix shifts, and meaningful segment differences.
4. What worked and what missed: evidence first, then interpretation.
5. Recommended actions: owner-ready, prioritized by likely impact, confidence, and effort.
6. Next-period focus: what to monitor and what would change the plan.

For paid marketing, connect spend to downstream outcomes such as qualified leads, revenue, contribution margin, CAC, or payback when available. Treat platform-reported attribution as one view, not ground truth. Distinguish correlation from causation and do not over-read small samples.

Use clear tables and short prose. Lead with the conclusion, keep diagnostic detail below it, and finish with open questions or missing data that block a stronger decision.
`),
  },
  {
    id: 'copywriting',
    name: 'copywriting',
    title: 'Copywriting',
    displaySlug: 'copywriting',
    source: 'Corey Haines',
    sourceUrl: 'https://github.com/coreyhaines31/marketingskills/tree/main/skills/copywriting',
    description: 'Write landing pages, headlines, CTAs, and campaign copy.',
    runtimeDescription: 'Write or improve persuasive marketing copy for landing pages, product pages, campaigns, headlines, value propositions, and calls to action.',
    categories: ['marketing', 'writing'],
    featured: true,
    instructions: instructions(`
# Copywriting

Write clear, specific marketing copy that helps the right reader understand the value and take the next step. Prefer customer language over company jargon and evidence over hype.

Before drafting, identify the page or asset, audience, awareness level, primary problem, desired outcome, offer, differentiators, proof, objections, voice, and single primary action. Ask for only the missing inputs that affect the message.

Use these principles:
- clarity before cleverness;
- benefits grounded in concrete product capabilities;
- one main idea per section;
- specific claims that can be supported;
- active language and natural rhythm;
- a visible, low-ambiguity next step.

For a page, usually cover: headline, explanatory subhead, primary CTA, problem context, value or outcomes, how it works, proof, objections, and a final CTA. Change the order to match the reader's awareness and the strength of the proof. Do not force every section into every page.

Return finished copy first. Follow with brief annotations for important choices, two or three materially different headline options, and any claims that need validation. When revising existing copy, preserve accurate facts and intentional voice, explain the biggest weaknesses, and avoid making the text longer unless the added detail earns its place.
`),
  },
  {
    id: 'internal-comms',
    name: 'internal-comms',
    title: 'Internal comms',
    displaySlug: 'internal-comms',
    source: 'Anthropic',
    sourceUrl: 'https://github.com/anthropics/skills/tree/main/skills/internal-comms',
    description: 'Draft company updates, leadership reports, FAQs, and announcements.',
    runtimeDescription: 'Draft concise internal company communications such as updates, leadership reports, announcements, FAQs, and change notices.',
    categories: ['writing', 'operations'],
    featured: true,
    instructions: instructions(`
# Internal communications

Write internal updates that help people understand what changed, why it matters, and what they need to do. Match the company's voice and the formality of the audience.

Establish the audience, sender, channel, purpose, timing, sensitivity, known facts, decisions, owners, and required action. Do not turn uncertainty into certainty. If details are confidential or unsettled, use explicit placeholders or state what is not yet decided.

Choose the format that fits the job:
- brief Slack announcement: headline, context, action, owner, deadline, link;
- project update: status, progress, risks, decisions, next steps;
- leadership update: outcome, evidence, implications, asks;
- change communication: what is changing, why, who is affected, when, support path;
- FAQ: direct questions in the language employees will actually use.

Lead with the news. Keep background subordinate to the decision or action. Use concrete dates, names, and ownership. Avoid corporate filler, inflated celebration, and vague phrases such as “moving forward.”

Before finishing, check that the message answers: What happened? Why? Who is affected? What happens next? What do I need to do? Where do questions go? Return send-ready copy, then list any unresolved facts that should be confirmed before posting.
`),
  },
  {
    id: 'customer-research',
    name: 'customer-research',
    title: 'Customer research',
    displaySlug: 'customer-research',
    source: 'Corey Haines',
    sourceUrl: 'https://github.com/coreyhaines31/marketingskills/tree/main/skills/customer-research',
    description: 'Synthesize interviews, support threads, reviews, and sales calls.',
    runtimeDescription: 'Analyze interviews, surveys, reviews, support conversations, and sales calls to identify customer language, patterns, segments, and opportunities.',
    categories: ['marketing', 'research'],
    featured: true,
    instructions: instructions(`
# Customer research

Turn customer evidence into useful patterns without flattening differences or manufacturing consensus.

Clarify the research question, decision, audience, source set, collection period, sample, and known biases. Work from the material provided or clearly identify what additional evidence is needed. Keep direct observations separate from interpretation.

For each source, extract customer language about triggers, jobs, pains, desired outcomes, alternatives, objections, anxieties, decision criteria, moments of value, and reasons to stay or leave. Preserve short representative quotes when available and attach each claim to its evidence.

Synthesize in stages:
1. Normalize notes without erasing meaning.
2. Cluster related observations into themes.
3. Note frequency, intensity, affected segment, and contradictory evidence.
4. Distinguish a broad pattern from a vivid outlier.
5. Translate the strongest patterns into messaging, product, sales, or service opportunities.

Return the research question, source and sample caveats, ranked themes, evidence, segment differences, insights, opportunities, and unanswered questions. Avoid fake precision from small qualitative samples. If the user asks for personas, ground each one in distinct behaviors and needs rather than invented demographics.
`),
  },
  {
    id: 'meeting-notes-and-actions',
    name: 'meeting-notes-and-actions',
    title: 'Meeting notes & actions',
    displaySlug: 'meeting-notes-and-actions',
    source: 'Composio Community',
    sourceUrl: 'https://github.com/composio-community/awesome-codex-skills/tree/master/meeting-notes-and-actions',
    description: 'Extract decisions, open questions, owners, and follow-ups.',
    runtimeDescription: 'Turn a meeting transcript or rough notes into a concise summary with decisions, risks, open questions, and owner-tagged actions.',
    categories: ['writing', 'operations'],
    featured: true,
    instructions: instructions(`
# Meeting notes and actions

Turn rough notes or a transcript into a reliable record people can act on. Preserve important nuance while removing repetition and filler.

Use the meeting title, date, attendees, and preferred level of detail when known. Do not invent attendance, decisions, owners, or deadlines. Mark uncertain speaker attribution and unresolved details explicitly.

Produce:
- Summary: the purpose, outcome, and main developments in a few bullets.
- Decisions: what was decided, by whom if clear, and any conditions.
- Discussion: only the context needed to understand the decisions.
- Risks and open questions: unresolved issues and what would answer them.
- Action items: one concrete action per line with owner, due date, and dependencies when stated.

Convert vague follow-ups into clear tasks only when the transcript supports the interpretation. Otherwise preserve the ambiguity and ask for an owner or deadline. Separate proposals from decisions and disagreement from final alignment.

Finish with a short “Needs confirmation” section when facts are missing. Keep the output easy to paste into Slack, a project tracker, or a shared document.
`),
  },
  {
    id: 'unslop',
    name: 'unslop',
    title: 'Unslop',
    displaySlug: 'unslop',
    source: 'PStack',
    sourceUrl: 'https://github.com/cursor/plugins/tree/main/pstack/skills/unslop',
    description: 'Cut AI tells and restore a specific human voice.',
    runtimeDescription: 'Edit writing to remove generic AI patterns, preserve meaning, and restore a specific, natural human voice.',
    categories: ['writing'],
    featured: true,
    instructions: instructions(`
# Unslop

Edit text to remove obvious AI patterns and give it a specific human voice. Preserve the author's meaning, factual claims, audience, and intended level of formality.

First identify what makes the draft feel generated: generic framing, repetitive structure, padded transitions, canned enthusiasm, fake quotations, over-explaining, symmetrical lists, unnecessary headings, abstract nouns, or a conclusion that merely repeats the opening.

Then rewrite:
- choose plain, concrete words over inflated language;
- vary sentence length and paragraph rhythm;
- keep useful opinions, tension, humor, and uncertainty;
- replace vague judgments with specific observations;
- remove throat-clearing, recap, and filler;
- use first person when it fits the speaker;
- avoid turning every thought into a tidy framework;
- preserve intentional quirks instead of sanding them away.

Watch for stock phrases such as “delve,” “landscape,” “in today's world,” “it's worth noting,” “unlock,” “elevate,” “game-changer,” “robust,” and “seamless.” Remove them when they are doing no real work, but do not perform blind word substitution.

Return the revised text without a long preamble. If the voice is underspecified, make the smallest defensible edit and briefly name the one or two choices that most changed the feel. Self-audit once more: what still sounds like it could have been written for anyone? Fix that.
`),
  },
  {
    id: 'page-cro',
    name: 'page-cro',
    title: 'Page CRO',
    displaySlug: 'page-cro',
    source: 'Corey Haines',
    sourceUrl: 'https://github.com/coreyhaines31/marketingskills/tree/main/skills/cro',
    description: 'Review marketing pages and recommend conversion improvements.',
    runtimeDescription: 'Review a marketing page or form and recommend prioritized conversion improvements, copy changes, and test ideas.',
    categories: ['marketing'],
    featured: false,
    instructions: instructions(`
# Page conversion review

Review a marketing page as a conversion system, not a collection of cosmetic preferences.

Identify the page type, primary audience, traffic source, awareness level, main conversion action, baseline performance, and important constraints. If only a URL or pasted copy is available, state what can and cannot be judged from that evidence.

Evaluate in order:
1. Is the value proposition clear within the first screen?
2. Does the message match the visitor's source and intent?
3. Is the primary CTA obvious, specific, and appropriately repeated?
4. Does the page provide credible proof for its claims?
5. Are objections answered before the relevant decision point?
6. Is the visual and copy hierarchy easy to scan?
7. Where does the flow create avoidable effort, anxiety, or distraction?
8. Are forms asking only for information needed at this stage?

Rank findings by expected impact, confidence, and effort. Separate definite usability problems from hypotheses that need testing. For each high-priority issue, provide the evidence, why it matters, a concrete change, and a metric or behavior that would show improvement.

Return quick wins, larger changes, copy alternatives, and a small experiment backlog. Avoid generic advice like “add social proof” without saying which proof, where, and what doubt it resolves.
`),
  },
  {
    id: 'marketing-psychology',
    name: 'marketing-psychology',
    title: 'Marketing psychology',
    displaySlug: 'marketing-psychology',
    source: 'Corey Haines',
    sourceUrl: 'https://github.com/coreyhaines31/marketingskills/tree/main/skills/marketing-psychology',
    description: 'Apply behavioral principles to messaging, offers, and campaigns.',
    runtimeDescription: 'Apply relevant behavioral science and ethical persuasion principles to marketing messages, offers, journeys, and experiments.',
    categories: ['marketing', 'research'],
    featured: false,
    instructions: instructions(`
# Marketing psychology

Use behavioral principles to explain and improve a real marketing decision. Do not dump a catalog of biases or use psychology to disguise a weak offer.

Clarify the audience, desired behavior, current behavior, decision context, friction, perceived risk, alternatives, evidence, and ethical constraints. Identify the smallest set of principles that actually explains the situation.

Useful lenses include: social proof, authority, loss aversion, default effects, choice overload, anchoring, framing, present bias, goal gradient, commitment, reciprocity, familiarity, uncertainty reduction, and the gap between stated preference and observed behavior.

For each recommended principle:
- explain the behavior it addresses in ordinary language;
- connect it to evidence or a stated hypothesis;
- show the exact message, offer, sequence, or interface change;
- identify the risk of misuse or an unintended effect;
- propose a way to test whether it helped.

Prefer honest clarity, useful defaults, credible proof, and reduced effort. Reject dark patterns, fabricated scarcity, hidden costs, coerced consent, and manipulative personalization.

Return the behavioral diagnosis, two or three relevant principles, concrete applications, copy or experiment examples, and the measure of success. Name alternative explanations when the evidence does not isolate one cause.
`),
  },
  {
    id: 'research-synthesis',
    name: 'research-synthesis',
    title: 'Research synthesis',
    displaySlug: 'research-synthesis',
    source: 'Anthropic',
    sourceUrl: 'https://github.com/anthropics/knowledge-work-plugins/tree/main/design/skills/research-synthesis',
    description: 'Turn scattered research into themes, evidence, and decisions.',
    runtimeDescription: 'Synthesize interviews, surveys, usability notes, feedback, or other research into themes, evidence, insights, and prioritized recommendations.',
    categories: ['research'],
    featured: false,
    instructions: instructions(`
# Research synthesis

Synthesize a body of research into a defensible decision aid. Keep observations, themes, insights, and recommendations as separate layers so readers can trace each conclusion back to evidence.

Begin with the study question, source types, participant or response count, collection period, audience, and decision to be made. Note sampling gaps, leading questions, incomplete records, and other limitations.

Process the evidence by tagging meaningful observations, grouping related tags, comparing segments, and looking for contradictions as actively as patterns. A theme is not just a repeated topic; it should describe a meaningful behavior, need, or barrier. Weight frequency alongside intensity and strategic importance.

For each theme include:
- a clear statement;
- supporting observations or short quotes;
- affected segments and exceptions;
- confidence and limitations;
- the implication for the decision.

Then translate themes into insights and opportunities. Prioritize recommendations by user impact, evidence strength, business relevance, and reversibility. Do not imply statistical significance from qualitative data or merge conflicting groups into a fictional average user.

Return an executive summary, methodology and caveats, ranked themes, evidence, segment differences, insights, recommendations, and questions for further research.
`),
  },
  {
    id: 'competitor-analysis',
    name: 'competitor-analysis',
    title: 'Competitor analysis',
    displaySlug: 'competitor-analysis',
    source: 'Pawel Huryn',
    sourceUrl: 'https://github.com/phuryn/pm-skills/tree/main/pm-market-research/skills/competitor-analysis',
    description: 'Compare competitors and identify differentiation opportunities.',
    runtimeDescription: 'Compare direct and indirect competitors across positioning, customers, product, pricing, go-to-market, strengths, weaknesses, and differentiation opportunities.',
    categories: ['research'],
    featured: false,
    instructions: instructions(`
# Competitor analysis

Build a decision-oriented view of the competitive landscape. The goal is not to create the longest feature table; it is to understand alternatives, customer choices, and credible ways to differentiate.

Define the market, target customer, job to be done, geography, and decision this analysis should support. Separate direct competitors, indirect alternatives, and doing nothing. Prefer current primary evidence such as product pages, pricing, documentation, customer reviews, and public company material. Date time-sensitive claims.

For each relevant competitor assess:
- target customer and positioning;
- core promise and proof;
- product strengths and important gaps;
- pricing and packaging when public;
- acquisition or distribution model;
- customer praise, complaints, and switching triggers;
- areas where the evidence is weak or contradictory.

Compare companies on the few dimensions customers actually use to choose. Avoid false precision, unverified market-share claims, and treating marketing copy as demonstrated capability.

Return the market frame, competitor set, concise profiles, comparison matrix, whitespace, threats, differentiation options, and recommended next research. Make each strategic implication explicit: what should the team do differently because of this evidence?
`),
  },
  {
    id: 'support-ticket-triage',
    name: 'support-ticket-triage',
    title: 'Support ticket triage',
    displaySlug: 'support-ticket-triage',
    source: 'Composio Community',
    sourceUrl: 'https://github.com/composio-community/awesome-codex-skills/tree/master/support-ticket-triage',
    description: 'Categorize customer issues, set priority, and draft responses.',
    runtimeDescription: 'Triage support conversations into category, impact, priority, next action, internal notes, reproduction details, and a concise customer response.',
    categories: ['operations'],
    featured: false,
    instructions: instructions(`
# Support ticket triage

Turn an incoming support conversation into a clear next action while treating severity, urgency, and customer emotion as separate signals.

Extract the product area, issue type, affected user or account, environment, timeline, business impact, scope, reproduction steps, observed behavior, expected behavior, attempted fixes, and missing evidence. Mask sensitive personal or credential data before repeating it.

Assign a category and priority using the team's taxonomy when provided. Explain the priority in one sentence based on impact, breadth, workaround, and time sensitivity. Do not promise an ETA or root cause that has not been confirmed.

Produce:
- concise issue summary;
- category and priority with rationale;
- reproduction information and missing diagnostics;
- immediate customer-safe next step;
- internal routing, suspected area, and evidence to collect;
- a reply draft in the requested voice.

The reply should acknowledge the concrete problem, restate the understood impact, say what happens next, and ask only for information that is truly needed. If evidence supports multiple interpretations, list the leading possibilities and what would distinguish them. Escalate security, data loss, broad outage, billing lockout, or safety concerns according to the user's policy rather than burying them in normal triage.
`),
  },
  {
    id: 'grill-me',
    name: 'grill-me',
    title: 'Grill me',
    displaySlug: '/grill-me',
    source: 'Matt Pocock',
    sourceUrl: 'https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md',
    description: 'A relentless interview to sharpen a plan or design.',
    runtimeDescription: 'Relentlessly interview the user to expose assumptions and sharpen a plan, decision, product, or design before action.',
    categories: ['research'],
    featured: false,
    instructions: instructions(`
# Grill me

Interview the user rigorously until the important branches of a plan, decision, or idea are explicit. Do not execute the plan during the interview.

Build a decision tree: each settled choice may reveal dependent choices. In each round, ask only questions whose prerequisites are already settled. Gather facts from the available conversation and tools yourself; ask the user for judgments, priorities, risk tolerance, and product choices.

Ask a focused batch per round. Number every question, give it a short title, explain why it matters when that is not obvious, offer concrete options when useful, and include your recommended answer with reasoning. Do not ask a question whose answer depends on another open question in the same round.

After each response:
- restate decisions that are now settled;
- update assumptions and contradictions;
- identify which branches are newly unblocked;
- ask the next frontier of questions.

Push on goals, users, success measures, constraints, failure modes, reversibility, ownership, sequencing, edge cases, and what is explicitly out of scope. Challenge vague language and premature solutions without becoming performatively adversarial.

Finish only when no material branch remains silently assumed. Summarize the shared understanding, open risks, and decisions made, then ask the user to confirm that the interview is complete before any implementation begins.
`),
  },
  {
    id: 'to-questionnaire',
    name: 'to-questionnaire',
    title: 'Questionnaire',
    displaySlug: 'to-questionnaire',
    source: 'Matt Pocock',
    sourceUrl: 'https://github.com/mattpocock/skills/tree/main/skills/productivity/to-questionnaire',
    description: 'Interview for missing context and create a focused questionnaire.',
    runtimeDescription: 'Turn a decision that depends on someone else’s knowledge into a focused discovery questionnaire for that person.',
    categories: ['research'],
    featured: false,
    instructions: instructions(`
# Questionnaire

Turn a knowledge gap into a questionnaire the user can send to one person or use in a meeting. Interview the user about the handoff, not about facts they do not know.

First establish who will answer: their role, expertise, relationship to the user, and what context they already have. Then establish what the user needs back: the decisions, facts, constraints, examples, or commitments required after the response.

Draft questions that close the gap between what the recipient knows and what the user needs. Put the highest-value questions first because the user may get only one response. Group longer questionnaires by theme and keep each question focused on one answerable issue.

The questionnaire should include:
- title and purpose;
- brief context the recipient needs;
- how to answer and any deadline;
- prioritized questions with enough framing to avoid ambiguity;
- a final prompt for missing concerns or evidence.

Use open questions for discovery and constrained choices for decisions. Ask for examples, thresholds, owners, dates, and tradeoffs where they matter. Avoid leading questions and do not embed the user's preferred answer as fact.

Return send-ready Markdown in the conversation. Check that every required output the user named is covered by at least one question and that the recipient can answer without a separate briefing.
`),
  },
  {
    id: 'handoff',
    name: 'handoff',
    title: 'Handoff',
    displaySlug: 'handoff',
    source: 'Matt Pocock',
    sourceUrl: 'https://github.com/mattpocock/skills/tree/main/skills/productivity/handoff',
    description: 'Turn the conversation into a concise handoff for the next agent.',
    runtimeDescription: 'Compact the current work into a concise, evidence-based handoff another person or agent can continue without replaying the conversation.',
    categories: ['writing', 'operations'],
    featured: false,
    instructions: instructions(`
# Handoff

Create a compact continuation brief from the current conversation. The next reader should be able to resume the work without replaying the full history.

Include:
- objective and current status;
- decisions already made and who made them;
- important context and constraints;
- work completed, with links or paths when available;
- verification performed and its result;
- unresolved questions, risks, and blockers;
- exact next actions in priority order;
- commands, artifacts, or source locations needed to continue.

Separate verified facts from inference and proposed next steps. Preserve exact identifiers, error messages, filenames, and acceptance criteria when they matter. Redact secrets, personal data, and credentials.

Do not duplicate long material already captured in a document, issue, change set, or shared link; point to it and explain why it matters. Remove stale exploration and dead ends unless they prevent the next person from repeating an expensive mistake.

Return the handoff directly in the conversation unless the user asks for another destination. Keep it concise, but never omit a decision or blocker that could cause the next person to take the wrong action.
`),
  },
  {
    id: 'tdd',
    name: 'tdd',
    title: 'TDD bug fix',
    displaySlug: 'tdd',
    source: 'PStack',
    sourceUrl: 'https://github.com/cursor/plugins/tree/main/pstack/skills/tdd',
    description: 'Write a focused failing test before fixing a bug.',
    runtimeDescription: 'Fix a bug with a focused regression test that fails for the observed behavior before the production change and passes afterward.',
    categories: ['engineering'],
    featured: false,
    instructions: instructions(`
# TDD bug fix

Use a proof-first loop when the bug has a clear, affordable executable seam. The purpose is a focused regression test that fails before the fix and passes afterward.

1. State intended behavior, observed behavior, affected path, and the smallest reproducible case.
2. Find the narrowest existing test surface that reaches the real behavior. Prefer strengthening the right nearby test over adding a duplicate.
3. Write or update the regression test before changing production code.
4. Run it and confirm it fails for the expected reason. A test that passes or fails from setup is not valid red evidence.
5. Make the smallest production change that restores the intended contract.
6. Rerun the regression test, then the relevant adjacent checks.
7. Review the diff for unrelated cleanup and remove it.

Do not force a new test when it would require broad infrastructure, brittle mocks, production-only state, or disproportionate fixture churn. In that case, say why before fixing and choose the closest executable proof, such as an existing integration scenario or controlled reproduction.

Report the red failure, the root cause, the fix, the green verification, and any broader checks. Never claim a red-before-green sequence you did not actually observe.
`),
  },
  {
    id: 'principle-fix-root-causes',
    name: 'principle-fix-root-causes',
    title: 'Fix root causes',
    displaySlug: 'principle-fix-root-causes',
    source: 'PStack',
    sourceUrl: 'https://github.com/cursor/plugins/tree/main/pstack/skills/principle-fix-root-causes',
    description: 'Reproduce the problem, trace it to the cause, and fix it there.',
    runtimeDescription: 'Diagnose failures by reproducing them, tracing symptoms to the underlying cause, and fixing the causal layer instead of adding guards.',
    categories: ['engineering'],
    featured: false,
    instructions: instructions(`
# Fix root causes

When debugging, trace each symptom to the causal layer and fix it there. Do not silence a crash, retry blindly, or add a defensive check that leaves the broken state intact.

Start with a reliable reproduction and a clear expected result. Follow the data and control flow backward. Ask why each incorrect value or transition exists until you reach the earliest violated invariant that explains the observed behavior.

Use evidence:
- inspect the actual error and state;
- instrument uncertain boundaries rather than guessing;
- compare a working case with the failing case;
- check for the same pattern elsewhere;
- verify lifecycle, persistence, cache, and configuration state for restart-only failures.

Choose the repair at the layer that owns the invariant. Keep boundary validation at the boundary, state repair in the state owner, and business rules in the domain logic. A long comment justifying a workaround is a signal to revisit the design.

After the fix, rerun the original reproduction, add or strengthen regression coverage when practical, and inspect related paths for the same cause. Explain the causal chain clearly: symptom, evidence, violated invariant, root cause, repair, and verification.
`),
  },
  {
    id: 'diagnosing-bugs',
    name: 'diagnosing-bugs',
    title: 'Diagnosing bugs',
    displaySlug: 'diagnosing-bugs',
    source: 'Matt Pocock',
    sourceUrl: 'https://github.com/mattpocock/skills/tree/main/skills/engineering/diagnosing-bugs',
    description: 'Minimize the repro, test hypotheses, fix, and verify.',
    runtimeDescription: 'Diagnose hard bugs and performance regressions with a tight feedback loop, minimized reproduction, competing hypotheses, instrumentation, and verification.',
    categories: ['engineering'],
    featured: false,
    instructions: instructions(`
# Diagnosing bugs

Treat diagnosis as an evidence loop. Do not start with a fix; first create a signal that reliably distinguishes broken from working behavior.

1. Build the tightest pass/fail reproduction available. Record exact inputs, environment, observed output, expected output, and variability.
2. Minimize it while keeping it red. Remove unrelated data, services, timing, and code paths one at a time.
3. List competing hypotheses that could explain all observed evidence. For each, name the quickest discriminating check.
4. Run the highest-information checks first. Instrument boundaries when state or control flow is uncertain.
5. Update or discard hypotheses based on results; do not reinterpret a failed prediction as support.
6. Once the cause is proven, fix the violated invariant with the smallest complete change.
7. Verify the original reproduction, nearby behavior, and a regression check. Remove temporary instrumentation and dead experiments.

Redact secrets and personal data from logs, commands, and artifacts. For intermittent bugs, capture frequency and control one variable at a time. For performance regressions, measure before optimizing and preserve the benchmark conditions.

Report what was reproduced, how the case was minimized, hypotheses tested, decisive evidence, root cause, fix, and final verification. Clearly label anything that remains an inference.
`),
  },
  {
    id: 'principle-boundary-discipline',
    name: 'principle-boundary-discipline',
    title: 'Boundary discipline',
    displaySlug: 'principle-boundary-discipline',
    source: 'PStack',
    sourceUrl: 'https://github.com/cursor/plugins/tree/main/pstack/skills/principle-boundary-discipline',
    description: 'Keep validation at system boundaries and business logic pure.',
    runtimeDescription: 'Concentrate validation and error handling at system boundaries while keeping internal business logic typed, pure, and framework-independent.',
    categories: ['engineering'],
    featured: false,
    instructions: instructions(`
# Boundary discipline

Place parsing, validation, normalization, authentication, and defensive error handling where untrusted data enters or leaves the system. Inside that boundary, use explicit domain types and trust the invariant.

At boundaries such as HTTP, Slack events, configuration, storage, command input, and third-party APIs:
- validate structure and semantic constraints once;
- normalize into domain concepts;
- reject invalid data with safe, useful errors;
- translate transport failures into stable application errors;
- keep credentials and wire-only details from leaking inward.

Inside the system:
- keep business logic in small deterministic functions;
- pass typed values rather than raw request or storage objects;
- propagate errors instead of repeatedly catching and rewrapping them;
- avoid redundant null checks that hide a broken invariant;
- do not make domain code depend on framework lifecycle or serialization details.

Across public seams, expose domain concepts rather than a provider's private representation. Keep general mechanism reusable and special policy near the owning edge.

When reviewing code, identify each trust transition, who owns validation, and whether the same rule is scattered across layers. Recommend the smallest move that makes the boundary explicit, then verify both rejected input and clean internal behavior.
`),
  },
] as const;
