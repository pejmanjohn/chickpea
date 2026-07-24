import type { TurnPullRequestProgress } from '../config/state-rpc.ts';

export function pullRequestProgressFromGithubResponse(input: {
  requestUrl: string;
  requestMethod: string;
  responseStatus: number;
  responseBody: unknown;
}): TurnPullRequestProgress | undefined {
  const match = githubPullRequestCreateMatch(
    input.requestUrl,
    input.requestMethod,
    input.responseStatus,
  );
  if (!match || !isRecord(input.responseBody)) return undefined;
  const number = input.responseBody.number;
  if (!Number.isSafeInteger(number) || (number as number) <= 0) return undefined;

  const [owner, repositoryName] = match.slice(1).map(decodeURIComponent);
  if (!owner || !repositoryName) return undefined;
  const repository = `${owner}/${repositoryName}`;
  const htmlUrl = input.responseBody.html_url;
  const head = input.responseBody.head;
  const branch = isRecord(head) && typeof head.ref === 'string' ? head.ref : undefined;
  const url =
    typeof htmlUrl === 'string' &&
    htmlUrl.startsWith(`https://github.com/${repository}/pull/`)
      ? htmlUrl
      : `https://github.com/${repository}/pull/${number as number}`;
  return {
    number: number as number,
    url,
    repository,
    ...(branch === undefined ? {} : { branch }),
  };
}

export function isGithubPullRequestCreateResponse(
  requestUrl: string,
  requestMethod: string,
  responseStatus: number,
): boolean {
  return githubPullRequestCreateMatch(requestUrl, requestMethod, responseStatus) !== undefined;
}

function githubPullRequestCreateMatch(
  requestUrl: string,
  requestMethod: string,
  responseStatus: number,
): RegExpMatchArray | undefined {
  if (
    requestMethod.toUpperCase() !== 'POST' ||
    responseStatus < 200 ||
    responseStatus >= 300
  ) {
    return undefined;
  }
  return (
    new URL(requestUrl).pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/?$/) ??
    undefined
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
