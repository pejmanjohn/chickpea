import type { WebAPICallResult, WebClient } from '@slack/web-api';

import type { GatewayOperationClient } from './client.ts';
import {
  gatewayOperationAllowed,
  type GatewaySlackOperation,
} from './protocol.ts';

type ApiMethod = (input?: Record<string, unknown>) => Promise<WebAPICallResult>;

const NAMESPACED_OPERATIONS = new Set<GatewaySlackOperation>([
  'auth.test',
  'users.info',
  'users.list',
  'conversations.info',
  'conversations.list',
  'conversations.members',
  'conversations.open',
  'conversations.join',
  'conversations.history',
  'conversations.replies',
  'usergroups.list',
  'usergroups.create',
  'usergroups.update',
  'usergroups.disable',
  'usergroups.enable',
  'views.publish',
  'chat.postMessage',
  'chat.postEphemeral',
  'chat.update',
  'chat.delete',
  'chat.startStream',
  'chat.appendStream',
  'chat.stopStream',
  'files.uploadV2',
  'reactions.get',
  'reactions.add',
  'reactions.remove',
]);

const ASSISTANT_THREAD_OPERATIONS = new Set<GatewaySlackOperation>([
  'assistant.threads.setStatus',
  'assistant.threads.setSuggestedPrompts',
  'assistant.threads.setTitle',
]);

/**
 * WebClient-shaped facade over the private Chickpea gateway. It intentionally
 * has no fallback client or token: an unlisted-app deployment can invoke only
 * the reviewed protocol allowlist, and an accidental new SDK call fails
 * locally before any request leaves the deployment.
 */
export function createGatewaySlackWebClient(client: GatewayOperationClient): WebClient {
  const namespace = (name: string): Record<string, ApiMethod> => new Proxy({}, {
    get(_target, method): ApiMethod {
      if (typeof method !== 'string') throw unsupported(name);
      return apiMethod(client, `${name}.${method}`);
    },
  });
  const assistantThreads = new Proxy({}, {
    get(_target, method): ApiMethod {
      if (typeof method !== 'string') throw unsupported('assistant.threads');
      const operation = `assistant.threads.${method}`;
      if (!ASSISTANT_THREAD_OPERATIONS.has(operation as GatewaySlackOperation)) {
        throw unsupported(operation);
      }
      return apiMethod(client, operation);
    },
  });
  const assistant = new Proxy({}, {
    get(_target, child): unknown {
      if (child === 'threads') return assistantThreads;
      throw unsupported(`assistant.${String(child)}`);
    },
  });

  return new Proxy({}, {
    get(_target, property): unknown {
      if (property === 'assistant') return assistant;
      if (typeof property !== 'string') throw unsupported(String(property));
      if (['auth', 'users', 'conversations', 'usergroups', 'views', 'chat', 'files', 'reactions']
        .includes(property)) {
        return namespace(property);
      }
      throw unsupported(property);
    },
  }) as unknown as WebClient;
}

function apiMethod(client: GatewayOperationClient, operationName: string): ApiMethod {
  if (!gatewayOperationAllowed(operationName)) throw unsupported(operationName);
  const operation = operationName as GatewaySlackOperation;
  if (!NAMESPACED_OPERATIONS.has(operation) && !ASSISTANT_THREAD_OPERATIONS.has(operation)) {
    throw unsupported(operationName);
  }
  return async (input = {}) => {
    const result = await client.call(operation, input);
    return { ok: true, ...result } as WebAPICallResult;
  };
}

function unsupported(operation: string): Error {
  return new Error(`Slack operation is unavailable through the Chickpea gateway (${operation}).`);
}
