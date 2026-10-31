/** A synthetic skill: an intro line, then numbered sections of distinct lines. Fourteen sections run past 11,000 characters. */
export function syntheticSkill(sections = 14): string {
  return [
    'Use this skill to prepare the weekly operations review for the leadership meeting.',
    '',
    ...Array.from({ length: sections }, (_, index) => syntheticSection(index + 1)),
  ].join('\n');
}

export function syntheticSection(step: number, title = `Review area ${step}`): string {
  return [
    `## Step ${step}: ${title}`,
    '',
    syntheticParagraph(step),
    '',
    ...Array.from({ length: 6 }, (_, index) => syntheticItem(step, index + 1)),
    '',
  ].join('\n');
}

export function syntheticParagraph(step: number): string {
  return `Area ${step} covers the work that moved since the last review. Read the tracker export for area ${step}, ` +
    `compare it with last week's notes, and write down every owner, date, and status that changed, with a ` +
    `one-line reason for each change you find.`;
}

export function syntheticItem(step: number, item: number): string {
  return `- Check item ${step}.${item} against the tracker and note any owner, date, or status that differs.`;
}

/** The words a reworded item gains, unique to its step. */
export function rewordMarker(step: number): string {
  return `escalate blocked owners in area ${step}`;
}

/** The skill with item 3 of each listed step reworded. */
export function rewordItems(skill: string, steps: readonly number[]): string {
  return steps.reduce((text, step) => {
    const item = syntheticItem(step, 3);
    if (!text.includes(item)) throw new Error(`step ${step} has no item 3`);
    return text.replace(item, `- Check item ${step}.3 against the tracker and ${rewordMarker(step)} to the on-call lead.`);
  }, skill);
}

interface SkillRecord {
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
}

/**
 * Long skills, each edited in three places. They widen nothing, and their
 * previews together run past one Slack message.
 */
export function longSkillEdits(count = 24): { before: SkillRecord[]; after: SkillRecord[] } {
  const before = Array.from({ length: count }, (_, index) => ({
    name: `review-${index + 1}`,
    description: 'Prepare the weekly operations review.',
    instructions: syntheticSkill(),
    enabled: true,
  }));
  return {
    before,
    after: before.map((skill) => ({ ...skill, instructions: rewordItems(skill.instructions, [2, 7, 12]) })),
  };
}
