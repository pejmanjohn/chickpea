import { createAssistantMessageEventStream, type AssistantMessage, type Model, type ProviderStreams } from '@earendil-works/pi-ai';
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createChickpeaPiProvider } from '../config/pi-provider.ts';
import { registerPiProvider } from '../config/pi-provider-registry.ts';
import { OpenAiSubscriptionError } from '../openai-subscription/errors.ts';
import { resolveOpenAiAuthMethod } from '../config/openai-auth.ts';
import { resolvePlanSession, type PlanDependencies } from './connection.ts';
import { CHATGPT_PLAN_API } from './protocol.ts';

export const CHATGPT_PLAN_PROVIDER = 'chatgpt-plan';
const MARKER = 'chickpea-managed-chatgpt-session';
const models = new Map<string, Model<'openai-responses'>>();
let binding: PlanDependencies | undefined;

export async function bindChatgptPlanProvider(d: PlanDependencies, modelId: string) {
  const bundle = await resolvePlanSession(d);
  const found = bundle.models.find(model => model.id === modelId);
  if (!found) throw new OpenAiSubscriptionError('unsupported_model');
  binding = d;
  registerChatgptPlanModel(modelId, found.name);
}

/** Only public model metadata is registered in Flue; credentials stay at fetch. */
export function registerChatgptPlanModel(id: string, name = id) {
  if (!/^[a-z0-9][a-z0-9._-]{0,199}$/i.test(id)) throw new OpenAiSubscriptionError('unsupported_model');
  const baseline = openaiProvider().getModels().find(model => model.id === id);
  models.set(id, {
    ...baseline, id, name, provider: CHATGPT_PLAN_PROVIDER, api: 'openai-responses', baseUrl: CHATGPT_PLAN_API,
    reasoning: baseline?.reasoning ?? true, input: baseline?.input ?? ['text', 'image'],
    contextWindow: baseline?.contextWindow ?? 128_000, maxTokens: baseline?.maxTokens ?? 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  registerPiProvider(createChickpeaPiProvider({ id: CHATGPT_PLAN_PROVIDER, name: 'ChatGPT', apiKey: MARKER,
    models: [...models.values()], api: planStreams() }));
}

export function normalizePlanPayload(input: Record<string, unknown>): Record<string, unknown> {
  const allowed = ['model', 'instructions', 'input', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'text', 'include', 'prompt_cache_key'];
  const payload = Object.fromEntries(allowed.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  payload.stream = true;
  payload.store = false;
  if (!Array.isArray(payload.input)) throw new OpenAiSubscriptionError('protocol_drift');
  payload.input = payload.input.map(item => {
    if (!item || typeof item !== 'object') throw new OpenAiSubscriptionError('protocol_drift');
    if (item.type === 'function_call') return { ...item, namespace: 'chickpea' };
    return item.role === 'system' ? { ...item, role: 'developer' } : item;
  });
  if (Array.isArray(payload.tools) && payload.tools.length) {
    if (payload.tools.some(tool => tool.type !== 'function')) throw new OpenAiSubscriptionError('protocol_drift');
    payload.tools = [{ type: 'namespace', name: 'chickpea', description: 'Chickpea Agent tools', tools: payload.tools }];
  }
  if (payload.tool_choice && typeof payload.tool_choice === 'object' && 'type' in payload.tool_choice && payload.tool_choice.type === 'function') {
    payload.tool_choice = { ...payload.tool_choice, namespace: 'chickpea' };
  }
  return payload;
}

/** Reject redirects, credential overrides, and any request outside Responses. */
export function planFetch(d: PlanDependencies): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== `${CHATGPT_PLAN_API}/responses` || request.method !== 'POST') throw new OpenAiSubscriptionError('protocol_drift');
    if (await resolveOpenAiAuthMethod(d.settings) !== 'subscription') throw new OpenAiSubscriptionError('auth_reconnect_required');
    const payload = normalizePlanPayload(await request.json() as Record<string, unknown>);
    const { session, models: available } = await resolvePlanSession(d);
    if (!available.some(model => model.id === payload.model)) throw new OpenAiSubscriptionError('unsupported_model');
    const response = await (d.fetch ?? fetch)(`${CHATGPT_PLAN_API}/responses`, {
      method: 'POST', redirect: 'manual', signal: request.signal,
      headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(payload),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new OpenAiSubscriptionError(response.status === 401 ? 'auth_reconnect_required' : response.status === 429 ? 'subscription_quota_exhausted' : response.status === 403 ? 'entitlement_denied' : 'provider_unavailable');
    }
    return completedResponse(response);
  };
}

/** A truncated stream or a late error must never become a successful reply. */
export function completedResponse(response: Response): Response {
  let buffer = '';
  let completed = false;
  const decoder = new TextDecoder();
  const inspect = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let event: { type?: string };
    try { event = JSON.parse(data); } catch { throw new OpenAiSubscriptionError('invalid_response'); }
    if (event.type === 'response.completed') completed = true;
    if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') throw new OpenAiSubscriptionError('provider_unavailable');
  };
  return new Response(response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) { inspect(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
      if (buffer.length > 4_194_304) throw new OpenAiSubscriptionError('invalid_response');
      controller.enqueue(chunk);
    },
    flush() { buffer += decoder.decode(); inspect(buffer); if (!completed) throw new OpenAiSubscriptionError('invalid_response'); },
  })), { status: response.status, headers: { 'content-type': 'text/event-stream' } });
}

function planStreams(): ProviderStreams {
  const wrap = (simple: boolean): ProviderStreams['streamSimple'] => (model, context, options) => {
    const d = binding;
    if (!d) throw new OpenAiSubscriptionError('auth_reconnect_required');
    const mapped = { ...context, messages: context.messages.map(message => message.role === 'assistant' && message.provider === CHATGPT_PLAN_PROVIDER ? { ...message, provider: 'openai' } : message) };
    const source = (simple ? streamSimple : stream)({ ...model, api: 'openai-responses', provider: 'openai', baseUrl: CHATGPT_PLAN_API }, mapped, {
      apiKey: MARKER, fetch: planFetch(d), maxRetries: 0,
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.reasoning ? { reasoning: options.reasoning } : {}),
    });
    const target = createAssistantMessageEventStream();
    const safe = (message: AssistantMessage, error = false): AssistantMessage => {
      const { diagnostics: _diagnostics, errorMessage: _errorMessage, ...rest } = message;
      return { ...rest, provider: CHATGPT_PLAN_PROVIDER, ...(error ? { errorMessage: 'ChatGPT request failed. Check the connection and plan limits in Settings.' } : {}) };
    };
    void (async () => {
      let last: AssistantMessage = {
        role: 'assistant', content: [], api: 'openai-responses', provider: CHATGPT_PLAN_PROVIDER, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'error', timestamp: Date.now(),
      };
      try {
        for await (const event of source) {
          last = event.type === 'done' ? event.message : event.type === 'error' ? event.error : event.partial;
          target.push(event.type === 'done' ? { ...event, message: safe(event.message) } : event.type === 'error' ? { ...event, error: safe(event.error, true) } : { ...event, partial: safe(event.partial) });
        }
      } catch {
        target.push({ type: 'error', reason: 'error', error: safe({ ...last, stopReason: 'error' }, true) });
      } finally { target.end(); }
    })();
    return target;
  };
  return { stream: wrap(false), streamSimple: wrap(true) };
}
