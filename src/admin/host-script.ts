/**
 * One same-origin script a host adds to the head of every page Core renders
 * from its shells (Admin and the Slack journey pages). Standalone Chickpea
 * installs none, so its pages carry no script but their own.
 */
let scriptPath: string | null = null;

/** Install the host's script path, once at module scope; undefined removes it. */
export function configureHostPageScript(path: string | undefined): void {
  if (path === undefined) {
    scriptPath = null;
    return;
  }
  if (typeof path !== 'string' || !/^\/(?![/\\])[A-Za-z0-9/_.~-]{0,255}$/.test(path)) {
    throw new Error('The host page script must be a same-origin path.');
  }
  scriptPath = path;
}

/** Whether a host installed a page script, for a host's own page policy. */
export function hostPageScriptConfigured(): boolean {
  return scriptPath !== null;
}

/** The host script's tag for a page's head, or nothing. The path's characters need no escaping. */
export function hostPageScriptTag(): string {
  return scriptPath === null ? '' : `<script src="${scriptPath}" defer></script>`;
}
