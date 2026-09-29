import { spawn } from 'node:child_process';

export async function openBrowserDetached(url: string): Promise<void> {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]]
      : ['xdg-open', [url]];
  await new Promise<void>((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.once('error', () => resolve());
      child.once('spawn', () => { child.unref(); resolve(); });
    } catch {
      resolve();
    }
  });
}

