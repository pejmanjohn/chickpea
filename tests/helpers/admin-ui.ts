import { readFileSync } from 'node:fs';

import { renderAdminPage } from '../../src/admin/page.ts';
import {
  ADMIN_UI_SCRIPT_PATH,
  ADMIN_UI_STYLESHEET_PATH,
} from '../../src/admin/ui-assets.ts';

export function adminUiScript(): string {
  return readFileSync(new URL(`../../assets/${ADMIN_UI_SCRIPT_PATH}`, import.meta.url), 'utf8');
}

export function adminUiStylesheet(): string {
  return readFileSync(new URL(`../../assets/${ADMIN_UI_STYLESHEET_PATH}`, import.meta.url), 'utf8');
}

/**
 * The production shell references its script and stylesheet as static assets.
 * Tests that inspect or execute the application read the same bytes inlined,
 * with the config island pre-assigned the way the script accepts from a host.
 */
export function renderAdminPageWithInlineAssets(
  options: Parameters<typeof renderAdminPage>[0] = {},
): string {
  const html = renderAdminPage(options);
  const config = html.match(
    /<script id="chickpea-admin-config" type="application\/json">([\s\S]*?)<\/script>/,
  )?.[1];
  if (!config) throw new Error('Admin shell is missing its config island.');
  return html
    .replace(
      /<link rel="stylesheet" href="\/admin-ui\/admin\.css\?v=[^"]*">/,
      () => `<style>\n${adminUiStylesheet()}</style>`,
    )
    .replace(
      /<script src="\/admin-ui\/admin\.js\?v=[^"]*"><\/script>/,
      () => `<script>\nwindow.__chickpeaAdminConfig = ${config};\n${adminUiScript()}</script>`,
    );
}
