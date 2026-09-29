import { connectChatgpt } from './chatgpt.ts';
import { openBrowserDetached } from './browser.ts';
import { normalizeDeploymentOrigin } from './origin.ts';

try {
  if (!process.argv[2]) throw new Error('Pass your Chickpea deployment URL.');
  await connectChatgpt(normalizeDeploymentOrigin(process.argv[2]), {
    fetch, openBrowser: openBrowserDetached, note: text => process.stderr.write(`${text}\n`),
  });
} catch {
  process.stderr.write('ChatGPT connection did not finish. Return to Chickpea Model providers, cancel sign-in, and run the helper again.\n');
  process.exitCode = 1;
}
