import { CARD_TITLES, assetPath, publishCard, readPublished, saveCard } from './lib/mcp-cards.mjs';

let published = readPublished();
for (const card of Object.keys(CARD_TITLES)) {
  const built = await publishCard(card, { published });
  saveCard(built);
  published = built.published;
  console.log(`${card} v${built.version}: assets/${assetPath(card, built.version)} (${built.html.length} bytes)`);
}
