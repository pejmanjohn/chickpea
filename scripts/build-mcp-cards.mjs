import { assetPath, publishAgentCard, saveAgentCard } from './lib/mcp-cards.mjs';

const card = await publishAgentCard();
saveAgentCard(card);
console.log(`Agent card v${card.version}: assets/${assetPath(card.version)} (${card.html.length} bytes)`);
