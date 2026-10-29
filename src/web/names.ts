export const READ_WEB_PAGE_TOOL_NAME = 'read_web_page';
export const WEB_SEARCH_TOOL_NAME = 'web_search';
export const WEB_TOOL_NAMES = [READ_WEB_PAGE_TOOL_NAME, WEB_SEARCH_TOOL_NAME] as const;
export type WebToolName = (typeof WEB_TOOL_NAMES)[number];
