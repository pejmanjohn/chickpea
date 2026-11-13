import { getGuide, guideText, GUIDE_RESULT_MAX_CHARACTERS } from '../src/management/mcp-v5/guide.ts';
import { PLAYBOOK_TOPICS } from '../src/management/playbook/index.ts';
for (const reader of ['any', 'chat-app'] as const) for (const topic of PLAYBOOK_TOPICS) {
  const out = getGuide({ topic }, reader);
  const size = guideText(out).length + JSON.stringify(out).length;
  if (size > 25_000) console.log(reader, topic, size, GUIDE_RESULT_MAX_CHARACTERS - size);
}
