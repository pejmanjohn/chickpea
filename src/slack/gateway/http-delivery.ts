import { readBoundedText } from '../../http/bounded-body.ts';
import { decryptSlackSecretEnvelope, encryptSlackSecretEnvelope, type CredentialKeyring, type SlackSecretEnvelope } from '../secret-envelope.ts';
import { parseGatewayFrameText, type GatewayInboundDelivery, type GatewayWorkspaceBinding } from './protocol.ts';

export const GATEWAY_HTTP_SETTING = 'slack.gateway.httpDelivery.v1';
export const GATEWAY_HTTP_PATH = '/slack/gateway/delivery';
export const GATEWAY_HTTP_MAX_BYTES = 1_048_576 + 4096;
export interface DeliveryOwner { issuedAt: number; versionId: string }
export interface HttpDeliveryKey {
  operationId: string; endpointUrl: string; routeRevision: number; keyId: string;
  secretEnvelope: SlackSecretEnvelope;
}
export interface HttpDeliveryState {
  version: 1; bindingId: string; deploymentId: string; installedAt: number; mode: 'socket' | 'http'; revision: number;
  owner?: DeliveryOwner;
  active?: HttpDeliveryKey; pending?: HttpDeliveryKey;
  rollback?: {operationId:string; expectedRevision:number};
  registration?: {operationId:string; expectedRevision:number; endpointUrl:string};
}
export interface HttpDeliveryEnvelope {
  protocolVersion: 1; kind: 'gateway.delivery' | 'gateway.challenge';
  bindingId: string; workspaceId: string; appId: string; deploymentId: string;
  routeRevision: number; keyId: string; issuedAt: number;
  delivery?: GatewayInboundDelivery; challengeId?: string; proof?: string;
}
export class HttpDeliveryError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export function deliveryEndpoint(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) ||
      url.username || url.password || url.port || url.search || url.hash ||
      (url.pathname !== '/' && url.pathname !== GATEWAY_HTTP_PATH)) {
    throw new HttpDeliveryError(400, 'delivery_endpoint_invalid');
  }
  url.pathname = GATEWAY_HTTP_PATH;
  return url.href;
}
export function parseHttpDeliveryState(raw: string | undefined | null): HttpDeliveryState | undefined {
  if (!raw) return undefined;
  const value = JSON.parse(raw) as HttpDeliveryState;
  if (value.version !== 1 || typeof value.bindingId !== 'string' ||
      !['socket', 'http'].includes(value.mode) || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new HttpDeliveryError(503, 'delivery_state_invalid');
  }
  return value;
}
function context(binding: GatewayWorkspaceBinding, keyId: string) {
  return { deploymentId: binding.deploymentId, identityId: binding.bindingId,
    identityClass: 'workspace_installation' as const, appId: binding.appId,
    teamId: binding.workspaceId, purpose: 'gateway_delivery_key' as const, revision: keyId };
}
export async function sealDeliveryKey(binding: GatewayWorkspaceBinding, keyring: CredentialKeyring,
  candidate: {operationId: string; endpointUrl: string; routeRevision: number; keyId: string; secret: string}): Promise<HttpDeliveryKey> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(candidate.secret) || !Number.isSafeInteger(candidate.routeRevision) || candidate.routeRevision < 1 ||
      !candidate.keyId || !candidate.operationId || deliveryEndpoint(candidate.endpointUrl) !== candidate.endpointUrl) {
    throw new HttpDeliveryError(502, 'delivery_candidate_invalid');
  }
  const { secret, ...metadata } = candidate;
  return { ...metadata, secretEnvelope: await encryptSlackSecretEnvelope(keyring, context(binding, candidate.keyId), {secret}) };
}
export async function verifyHttpDelivery(input: {
  body: string; signature: string; url: string; binding: GatewayWorkspaceBinding;
  state: HttpDeliveryState; keyring: CredentialKeyring; now?: number;
}): Promise<HttpDeliveryEnvelope> {
  const fail = () => { throw new HttpDeliveryError(401, 'delivery_unauthorized'); };
  if (new TextEncoder().encode(input.body).byteLength > GATEWAY_HTTP_MAX_BYTES) throw new HttpDeliveryError(413, 'delivery_too_large');
  let value: HttpDeliveryEnvelope;
  try { value = JSON.parse(input.body); } catch { throw new HttpDeliveryError(400, 'delivery_invalid'); }
  if (!value || value.protocolVersion !== 1 || !['gateway.delivery', 'gateway.challenge'].includes(value.kind) ||
      !Number.isSafeInteger(value.issuedAt) || Math.abs((input.now ?? Date.now()) - value.issuedAt) > 300_000 ||
      input.state.bindingId !== input.binding.bindingId || input.state.deploymentId !== input.binding.deploymentId || input.state.installedAt !== input.binding.installedAt || value.bindingId !== input.binding.bindingId ||
      value.workspaceId !== input.binding.workspaceId || value.appId !== input.binding.appId || value.deploymentId !== input.binding.deploymentId) fail();
  const key = [input.state.active, input.state.pending].find(k => k && k.keyId === value.keyId && k.routeRevision === value.routeRevision);
  if (!key || key.endpointUrl !== input.url || deliveryEndpoint(input.url) !== input.url) return fail();
  const {secret} = await decryptSlackSecretEnvelope<{secret: string}>(input.keyring, context(input.binding, key.keyId), key.secretEnvelope);
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.signature)) return fail();
  const bytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', bytes(secret), {name:'HMAC',hash:'SHA-256'}, false, ['verify']);
  if (!await crypto.subtle.verify('HMAC', cryptoKey, bytes(input.signature),
    new TextEncoder().encode(`chickpea-gateway-http-v1\nPOST\n${input.url}\n${input.body}`))) return fail();
  if (value.kind === 'gateway.challenge') {
    if (typeof value.challengeId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value.challengeId)) throw new HttpDeliveryError(400, 'delivery_invalid');
    const proofKey = await crypto.subtle.importKey('raw', bytes(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
    const proofBytes = new Uint8Array(await crypto.subtle.sign('HMAC',proofKey,new TextEncoder().encode(`chickpea-gateway-http-challenge-v1\n${input.url}\n${value.challengeId}`)));
    value.proof = btoa(String.fromCharCode(...proofBytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  } else {
    const delivery = parseGatewayFrameText(JSON.stringify(value.delivery));
    if ((delivery.kind !== 'event.deliver' && delivery.kind !== 'interaction.agent_selected') ||
        delivery.bindingId !== value.bindingId || delivery.workspaceId !== value.workspaceId ||
        (delivery.kind === 'event.deliver' && delivery.envelope.workspaceId !== value.workspaceId)) fail();
    value.delivery = delivery as GatewayInboundDelivery;
  }
  return value;
}
export function httpDeliveryReceipt(value: HttpDeliveryEnvelope, outcome: 'accepted'|'duplicate'|'verified') {
  return {protocolVersion:1, bindingId:value.bindingId, workspaceId:value.workspaceId, appId:value.appId,
    deploymentId:value.deploymentId, routeRevision:value.routeRevision,
    ...(value.kind === 'gateway.challenge' ? {challengeId:value.challengeId,proof:value.proof} : {deliveryId:value.delivery!.deliveryId}), outcome};
}
export async function handleHttpDeliveryRequest(request: Request, receive: (input: {body:string;signature:string;url:string}) => Promise<{status:number;body:unknown}>): Promise<Response> {
  try {
    const body = await readBoundedText(new Response(request.body, {headers:request.headers}), {maxBytes:GATEWAY_HTTP_MAX_BYTES, onOversize:()=>new HttpDeliveryError(413,'delivery_too_large'), fatalDecoder:true, signal:AbortSignal.timeout(2000)});
    const result = await receive({body,signature:request.headers.get('x-chickpea-signature') ?? '',url:request.url});
    return Response.json(result.body,{status:result.status,headers:{'cache-control':'no-store'}});
  } catch (error) {
    return Response.json({error:error instanceof HttpDeliveryError ? error.code : 'delivery_unavailable'}, {status:error instanceof HttpDeliveryError ? error.status : 503});
  }
}
