import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SqliteSettingsStore} from '../src/config/settings-store.ts';
import {SqliteConfigStore} from '../src/config/store.ts';
import {generateCredentialKeyring} from '../src/slack/credential-keyring.ts';
import {GatewayDeploymentClient,GATEWAY_BINDING_SETTING} from '../src/slack/gateway/client.ts';
import {GATEWAY_HTTP_SETTING,parseHttpDeliveryState} from '../src/slack/gateway/http-delivery.ts';
import {loadOrCreateGatewayDeploymentIdentity,verifyGatewayRequestSignature} from '../src/slack/gateway/identity.ts';

const origin='https://worker.account.workers.dev';
async function fixture(loss?:'prepare'|'activate'|'rollback'){
 const settings=new SqliteSettingsStore(':memory:');const config=new SqliteConfigStore(':memory:');const keyring=generateCredentialKeyring('test');
 const identity=await loadOrCreateGatewayDeploymentIdentity({settings,keyring});
 const binding={bindingId:'binding',workspaceId:'T_TEST',appId:'A_TEST',deploymentId:identity.deploymentId,clientId:'client',botUserId:'U_BOT',installerSlackUserId:'U_OWNER',sessionUrl:'wss://gateway.test/session',installedAt:1};
 await settings.setSetting(GATEWAY_BINDING_SETTING,JSON.stringify(binding));
 let remote:any={protocolVersion:1,...binding,mode:'socket',revision:0};let lost=false;let prepares=0;let activations=0;let blockActivation=false;
 const fetcher:typeof fetch=async(_url,init)=>{
  const request=JSON.parse(String(init?.body));assert.equal(await verifyGatewayRequestSignature({publicKey:identity.publicKey,request}),true);
  const action=request.kind.split('.')[1];
  if(action==='prepare'){
   if(!remote.candidate&&remote.active?.operationId!==request.operationId){prepares++;remote.candidate={operationId:request.operationId,endpointUrl:request.endpointUrl,routeRevision:remote.revision+1,keyId:'key'+prepares,secret:Buffer.alloc(32,8).toString('base64url'),expiresAt:Date.now()+900000};}
  }
  if(action==='activate'){
   if(blockActivation)return Response.json({error:'delivery_endpoint_unverified'},{status:409});
   const staged=parseHttpDeliveryState(await settings.getSetting(GATEWAY_HTTP_SETTING));assert.equal(staged?.pending?.keyId,remote.candidate?.keyId);
   activations++;remote={...remote,mode:'http',revision:remote.candidate.routeRevision,active:remote.candidate,candidate:undefined};
  }
  if(action==='rollback'){if(remote.mode==='http')remote={...remote,mode:'socket',revision:remote.revision+1,active:undefined,candidate:undefined};}
  if(action===loss&&!lost){lost=true;throw Error('synthetic response loss');}
  return Response.json(remote);
 };
 const client=()=>new GatewayDeploymentClient({settings,config,keyring,gatewayBaseUrl:'https://gateway.test',fetch:fetcher});
 return {settings,config,client,counts:()=>({prepares,activations}),block(value:boolean){blockActivation=value;},expire(){remote.candidate=undefined;},cleanup(){settings.close();config.close();}};
}
for(const loss of ['prepare','activate'] as const)test(`HTTP registration recovers lost ${loss} response using the same operation`,async()=>{
 const f=await fixture(loss);try{
  await assert.rejects(f.client().ensureHttpDelivery(origin));
  assert.equal(await f.client().ensureHttpDelivery(origin),true);
  const state=parseHttpDeliveryState(await f.settings.getSetting(GATEWAY_HTTP_SETTING));assert.equal(state?.mode,'http');assert.equal(state?.revision,1);assert.ok(state?.active);assert.equal(state?.pending,undefined);
  assert.equal(f.counts().prepares,1);assert.equal(f.counts().activations,1);
  assert.equal(await f.client().ensureHttpDelivery(origin),true);
 }finally{f.cleanup();}
});
test('explicit HTTP rollback stays on socket during maintenance',async()=>{
 const f=await fixture();try{await f.client().ensureHttpDelivery(origin);await f.client().rollbackHttpDelivery();assert.equal(await f.client().ensureHttpDelivery(origin),false);assert.equal(parseHttpDeliveryState(await f.settings.getSetting(GATEWAY_HTTP_SETTING))?.revision,2);}finally{f.cleanup();}
});
test('concurrent HTTP registration does not overwrite another local operation',async()=>{
 const f=await fixture();try{const results=await Promise.allSettled([f.client().ensureHttpDelivery(origin),f.client().ensureHttpDelivery(origin)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(await f.client().ensureHttpDelivery(origin),true);assert.equal(f.counts().prepares,1);}finally{f.cleanup();}
});

test('rollback reconciles an activation whose response was lost before any delivery',async()=>{
 const f=await fixture('activate');try{await assert.rejects(f.client().ensureHttpDelivery(origin));await f.client().rollbackHttpDelivery();assert.equal(await f.client().ensureHttpDelivery(origin),false);assert.equal(parseHttpDeliveryState(await f.settings.getSetting(GATEWAY_HTTP_SETTING))?.revision,2);}finally{f.cleanup();}
});
test('maintenance recovers a lost rollback response',async()=>{
 const f=await fixture('rollback');try{await f.client().ensureHttpDelivery(origin);await assert.rejects(f.client().rollbackHttpDelivery());assert.equal(await f.client().ensureHttpDelivery(origin),false);assert.equal(parseHttpDeliveryState(await f.settings.getSetting(GATEWAY_HTTP_SETTING))?.rollback,undefined);}finally{f.cleanup();}
});
test('expired key rotation restarts preparation without stranding the active HTTP route',async()=>{
 const f=await fixture();try{await f.client().ensureHttpDelivery(origin);f.block(true);await assert.rejects(f.client().ensureHttpDelivery(origin,{rotate:true}));f.expire();f.block(false);assert.equal(await f.client().ensureHttpDelivery(origin),true);assert.equal(parseHttpDeliveryState(await f.settings.getSetting(GATEWAY_HTTP_SETTING))?.revision,2);}finally{f.cleanup();}
});
