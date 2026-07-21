import type { SkillConfig } from './types.ts';

interface ConnectorSkillScope {
  allowedHosts: string[];
  pathPrefixes: string[];
  allowedMethods: string[];
}

type ConnectorSkillKind = 'github-api' | 'asana-api' | 'zendesk-api';

interface ConnectorSkillDefinition {
  name: ConnectorSkillKind;
  description: string;
  instructions: string;
  matchesHost: (host: string) => boolean;
}

const AUTOMATIC_AUTH =
  "Authentication is handled automatically by the workspace's connection. Never add authentication or authorization headers, and never ask the user for a token.";

const ERROR_AND_RESTRICTION_GUIDANCE = [
  '## Errors and connection restrictions',
  '',
  "- API errors arrive as JSON in the response body, not through curl exit codes. Check the body's error message. A `401` or `403` object means the connection's credential is invalid or expired; tell the user to update it in the admin under **Profiles → Connections**, and never ask them to paste a token into chat.",
  '- `MethodNotAllowedError` or another blocked-method error: the operator limited this connection\'s methods. Explain the restriction and do not retry the blocked method.',
  '- A non-allowlisted-URL error means the requested path is outside the connection\'s scope. Explain that scope restriction; do not work around it with another host or URL.',
  '- Before choosing a recipe, check **Your connection** for the methods and paths actually allowed. A recipe does not override those restrictions.',
].join('\n');

const GITHUB_INSTRUCTIONS = [
  '# GitHub REST API',
  '',
  'Base URL: `https://api.github.com` (GitHub REST API v3).',
  '',
  AUTOMATIC_AUTH,
  '',
  '## Response shape',
  '',
  'Successful responses are JSON objects or arrays. Issue-list responses also include pull requests; entries with a `pull_request` field are PRs. File-content responses return base64 in `content` (remove line breaks before decoding). Keep the recommended media type and API-version headers shown below.',
  '',
  '## Recipes',
  '',
  'URL-encode spaces in query values as `%20`.',
  '',
  'Get a repository:',
  githubCurl(['  "https://api.github.com/repos/{owner}/{repo}"']),
  '',
  'List a repository\'s open issues and pull requests:',
  githubCurl(['  "https://api.github.com/repos/{owner}/{repo}/issues?state=open&per_page=100&page=1"']),
  '',
  'Search issues and pull requests (add `is:issue` or `is:pr` to narrow the query):',
  githubCurl([
    '  "https://api.github.com/search/issues?q=repo:{owner}/{repo}%20is:open%20label:bug&per_page=100"',
  ]),
  '',
  'Read an issue or pull request:',
  githubCurl(['  "https://api.github.com/repos/{owner}/{repo}/issues/{issue_number}"']),
  '',
  'Read its comments:',
  githubCurl(['  "https://api.github.com/repos/{owner}/{repo}/issues/{issue_number}/comments?per_page=100&page=1"']),
  '',
  'Create an issue comment:',
  githubCurl([
    '  --request POST \\',
    "  -H 'Content-Type: application/json' \\",
    "  --data '{\"body\":\"Comment text\"}' \\",
    '  "https://api.github.com/repos/{owner}/{repo}/issues/{issue_number}/comments"',
  ]),
  '',
  'Create an issue:',
  githubCurl([
    '  --request POST \\',
    "  -H 'Content-Type: application/json' \\",
    "  --data '{\"title\":\"Issue title\",\"body\":\"Issue details\",\"labels\":[\"bug\"]}' \\",
    '  "https://api.github.com/repos/{owner}/{repo}/issues"',
  ]),
  '',
  'Get file contents at a ref (decode the response `content` from base64):',
  githubCurl([
    '  "https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={branch-or-sha}"',
  ]),
  '',
  'Search code:',
  githubCurl([
    '  "https://api.github.com/search/code?q={search%20term}%20repo:{owner}/{repo}&per_page=100"',
  ]),
  '',
  'List recent Actions workflow runs:',
  githubCurl(['  "https://api.github.com/repos/{owner}/{repo}/actions/runs?per_page=100&page=1"']),
  '',
  '## Pagination',
  '',
  'Use `per_page` (up to 100) and `page`. Follow the HTTP `Link` response header, especially the `rel="next"` URL, instead of guessing whether another page exists.',
  '',
  ERROR_AND_RESTRICTION_GUIDANCE,
].join('\n');

const ASANA_INSTRUCTIONS = [
  '# Asana API',
  '',
  'Base URL: `https://app.asana.com/api/1.0`.',
  '',
  AUTOMATIC_AUTH,
  '',
  '## Response shape',
  '',
  'Asana wraps successful payloads under `{"data": ...}`. Default payloads are intentionally compact, so request the fields you need with `opt_fields` (for example `name,completed,assignee.name,due_on,permalink_url`). IDs are string GIDs.',
  '',
  '## Recipes',
  '',
  'URL-encode spaces in query values as `%20`.',
  '',
  'Get the current user:',
  apiCurl(['  "https://app.asana.com/api/1.0/users/me?opt_fields=name,email"']),
  '',
  'List workspaces:',
  apiCurl(['  "https://app.asana.com/api/1.0/workspaces?limit=100&opt_fields=name"']),
  '',
  'List projects in a workspace:',
  apiCurl([
    '  "https://app.asana.com/api/1.0/workspaces/{workspace_gid}/projects?archived=false&limit=100&opt_fields=name,archived,permalink_url"',
  ]),
  '',
  'List tasks in a project:',
  apiCurl([
    '  "https://app.asana.com/api/1.0/projects/{project_gid}/tasks?limit=100&opt_fields=name,completed,assignee.name,due_on,permalink_url"',
  ]),
  '',
  'Get one task:',
  apiCurl([
    '  "https://app.asana.com/api/1.0/tasks/{task_gid}?opt_fields=name,notes,completed,assignee.name,due_on,projects.name,permalink_url"',
  ]),
  '',
  'Create a task:',
  apiCurl([
    '  --request POST \\',
    "  -H 'Content-Type: application/json' \\",
    "  --data '{\"data\":{\"name\":\"Task title\",\"notes\":\"Task details\",\"projects\":[\"{project_gid}\"]}}' \\",
    '  "https://app.asana.com/api/1.0/tasks"',
  ]),
  '',
  'Update a task:',
  apiCurl([
    '  --request PUT \\',
    "  -H 'Content-Type: application/json' \\",
    "  --data '{\"data\":{\"completed\":true}}' \\",
    '  "https://app.asana.com/api/1.0/tasks/{task_gid}"',
  ]),
  '',
  'Add a comment:',
  apiCurl([
    '  --request POST \\',
    "  -H 'Content-Type: application/json' \\",
    "  --data '{\"data\":{\"text\":\"Comment text\"}}' \\",
    '  "https://app.asana.com/api/1.0/tasks/{task_gid}/stories"',
  ]),
  '',
  'Search tasks in a workspace:',
  apiCurl([
    '  "https://app.asana.com/api/1.0/workspaces/{workspace_gid}/tasks/search?text={search%20terms}&resource_subtype=default_task&opt_fields=name,completed,assignee.name,due_on,permalink_url"',
  ]),
  '',
  '## Pagination',
  '',
  'Set `limit` (up to 100). When the response includes `next_page.offset`, pass that opaque value as the next request\'s `offset`; stop when `next_page` is absent. The task search endpoint is unpaginated — narrow the query or use sort parameters instead of expecting `next_page`.',
  '',
  ERROR_AND_RESTRICTION_GUIDANCE,
].join('\n');

const ZENDESK_INSTRUCTIONS = [
  '# Zendesk API',
  '',
  'Base URL: `https://<your-subdomain>.zendesk.com/api/v2`. Use the exact tenant host shown in **Your connection** below. REST paths end in `.json`.',
  '',
  AUTOMATIC_AUTH,
  '',
  '## Response shape',
  '',
  'Zendesk returns JSON objects keyed by resource name, such as `ticket`, `tickets`, `users`, or `results`. Ticket comments are separate from the ticket object. For updates, a comment with `public: false` is an internal note; `public: true` is a public reply.',
  '',
  '## Recipes',
  '',
  'URL-encode spaces in query values as `%20`.',
  '',
  'Get the current user:',
  apiCurl(['  "https://{your-subdomain}.zendesk.com/api/v2/users/me.json"']),
  '',
  'List tickets:',
  apiCurl(['  "https://{your-subdomain}.zendesk.com/api/v2/tickets.json?page%5Bsize%5D=100"']),
  '',
  'Search tickets:',
  apiCurl([
    '  "https://{your-subdomain}.zendesk.com/api/v2/search.json?query=type:ticket%20status%3Csolved%20{search%20terms}"',
  ]),
  '',
  'Get a ticket:',
  apiCurl(['  "https://{your-subdomain}.zendesk.com/api/v2/tickets/{ticket_id}.json"']),
  '',
  'Get a ticket\'s comments:',
  apiCurl([
    '  "https://{your-subdomain}.zendesk.com/api/v2/tickets/{ticket_id}/comments.json?page%5Bsize%5D=100"',
  ]),
  '',
  'Create a ticket:',
  apiCurl([
    '  --request POST \\',
    "  -H 'Content-Type: application/json' \\",
    "  --data '{\"ticket\":{\"subject\":\"Ticket subject\",\"comment\":{\"body\":\"Ticket details\",\"public\":true},\"priority\":\"normal\"}}' \\",
    '  "https://{your-subdomain}.zendesk.com/api/v2/tickets.json"',
  ]),
  '',
  'Update a ticket with an internal note:',
  apiCurl([
    '  --request PUT \\',
    "  -H 'Content-Type: application/json' \\",
    "  --data '{\"ticket\":{\"comment\":{\"body\":\"Internal note text\",\"public\":false}}}' \\",
    '  "https://{your-subdomain}.zendesk.com/api/v2/tickets/{ticket_id}.json"',
  ]),
  '',
  'Update a ticket with a public reply:',
  apiCurl([
    '  --request PUT \\',
    "  -H 'Content-Type: application/json' \\",
    "  --data '{\"ticket\":{\"comment\":{\"html_body\":\"Public reply text\",\"public\":true}}}' \\",
    '  "https://{your-subdomain}.zendesk.com/api/v2/tickets/{ticket_id}.json"',
  ]),
  '',
  'List users:',
  apiCurl(['  "https://{your-subdomain}.zendesk.com/api/v2/users.json?page%5Bsize%5D=100"']),
  '',
  '## Pagination',
  '',
  'Prefer cursor pagination: set `page[size]` (up to 100), then request the URL in `links.next` until it is null. Do not construct or alter the cursor. Use offset pagination only for endpoints that do not support cursors.',
  '',
  ERROR_AND_RESTRICTION_GUIDANCE,
].join('\n');

const CONNECTOR_SKILLS: ConnectorSkillDefinition[] = [
  {
    name: 'github-api',
    description: 'Work with repositories, issues, pull requests, code, and Actions through GitHub REST.',
    instructions: GITHUB_INSTRUCTIONS,
    matchesHost: (host) => host === 'api.github.com',
  },
  {
    name: 'asana-api',
    description: 'Read and update Asana workspaces, projects, tasks, and comments.',
    instructions: ASANA_INSTRUCTIONS,
    matchesHost: (host) => host === 'app.asana.com',
  },
  {
    name: 'zendesk-api',
    description: 'Search and update Zendesk tickets, comments, and users.',
    instructions: ZENDESK_INSTRUCTIONS,
    matchesHost: (host) => host.endsWith('.zendesk.com'),
  },
];

/**
 * Build skills only from credential-free connection scope. The narrow input is
 * a security boundary: credential-bearing ResolvedApiConnection rows must be
 * explicitly projected before they can reach instruction text.
 */
export function connectorSkillsForConnections(scopes: ConnectorSkillScope[]): SkillConfig[] {
  const skills: SkillConfig[] = [];
  const attached = new Set<ConnectorSkillKind>();

  for (const scope of scopes) {
    const hosts = scope.allowedHosts.map((host) => host.toLowerCase());
    for (const definition of CONNECTOR_SKILLS) {
      if (attached.has(definition.name) || !hosts.some(definition.matchesHost)) {
        continue;
      }
      attached.add(definition.name);
      skills.push({
        name: definition.name,
        description: definition.description,
        instructions: `${definition.instructions}\n\n${connectionContext(scope, definition.matchesHost)}`,
        enabled: true,
      });
    }
  }

  return skills;
}

function githubCurl(lines: string[]): string {
  return [
    '```bash',
    'curl -sS \\',
    "  -H 'Accept: application/vnd.github+json' \\",
    "  -H 'X-GitHub-Api-Version: 2022-11-28' \\",
    ...lines,
    '```',
  ].join('\n');
}

function apiCurl(lines: string[]): string {
  return ['```bash', 'curl -sS \\', ...lines, '```'].join('\n');
}

function connectionContext(
  scope: ConnectorSkillScope,
  matchesHost: ConnectorSkillDefinition['matchesHost'],
): string {
  const matchingHosts = scope.allowedHosts.filter((host) => matchesHost(host.toLowerCase()));
  return [
    '## Your connection',
    '',
    `- Allowed hosts: ${inlineValues(matchingHosts)}`,
    `- Path scope: ${scope.pathPrefixes.length > 0 ? inlineValues(scope.pathPrefixes) : 'whole host'}`,
    `- Allowed methods: ${scope.allowedMethods.join(', ')}`,
  ].join('\n');
}

function inlineValues(values: string[]): string {
  return values.map((value) => `\`${value}\``).join(', ');
}
