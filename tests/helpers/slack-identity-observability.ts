export interface CapturedSlackIdentityOperationalEvents<T> {
  events: Array<Record<string, unknown>>;
  result: T;
  serialized: string;
}

export async function captureSlackIdentityOperationalEvents<T>(
  run: () => T | Promise<T>,
): Promise<CapturedSlackIdentityOperationalEvents<T>> {
  const lines: string[] = [];
  const previousInfo = console.info;
  console.info = (...args: unknown[]) => {
    if (args[0] === '[chickpea] slack_installation_operational') {
      lines.push(String(args[1]));
    }
  };
  try {
    const result = await run();
    return {
      events: lines.map((line) => JSON.parse(line) as Record<string, unknown>),
      result,
      serialized: lines.join('\n'),
    };
  } finally {
    console.info = previousInfo;
  }
}
