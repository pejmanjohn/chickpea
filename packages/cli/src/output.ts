export interface IoOptions {
  json: boolean;
  quiet: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Stdout carries the command's result; stderr carries notes, warnings, and errors. */
export class Io {
  readonly json: boolean;
  readonly quiet: boolean;
  private readonly stdout: (text: string) => void;
  private readonly stderr: (text: string) => void;

  constructor(options: IoOptions) {
    this.json = options.json;
    this.quiet = options.quiet;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
  }

  print(text: string): void {
    this.stdout(text.endsWith('\n') ? text : `${text}\n`);
  }

  printJson(value: unknown): void {
    this.stdout(`${JSON.stringify(value, null, 2)}\n`);
  }

  /** Progress and guidance. Suppressed by --quiet. */
  note(text: string): void {
    if (this.quiet) return;
    this.stderr(text.endsWith('\n') ? text : `${text}\n`);
  }

  /** Security-relevant guidance. Never suppressed. */
  warn(text: string): void {
    this.stderr(text.endsWith('\n') ? text : `${text}\n`);
  }
}
