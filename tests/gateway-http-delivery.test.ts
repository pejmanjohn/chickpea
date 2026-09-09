import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateCredentialKeyring} from '../src/slack/credential-keyring.ts';
import {deliveryEndpoint, sealDeliveryKey, verifyHttpDelivery, httpDeliveryReceipt, handleHttpDeliveryRequest, type HttpDeliveryState} from '../src/slack/gateway/http-delivery.ts';
import type {GatewayWorkspaceBinding} from '../src/slack/gateway/protocol.ts';

const binding: GatewayWorkspaceBinding = {bindingId:'binding_test',workspaceId:'T_TEST',appId:'A_TEST',deploymentId:'deployment_test',clientId:'client',botUserId:'U_BOT',installerSlackUserId:'U_OWNER',sessionUrl:'wss://gateway.test/session',installedAt:1};
const endpointUrl='https://worker.account.workers.dev/slack/gateway/delivery';
const secret=Buffer.alloc(32,7).toString('base64url');
const keyring=generateCredentialKeyring('test');
const delivery={protocolVersion:1,kind:'event.deliver',deliveryId:'event:Ev_TEST',bindingId:binding.bindingId,workspaceId:binding.workspaceId,envelope:{workspaceId:binding.workspaceId,eventId:'Ev_TEST',eventTime:1,event:{type:'app_mention',channel:'C_TEST',user:'U_TEST',ts:'1.1',event_ts:'1.1',text:'synthetic'}}};
async function fixture(){
 const active=await sealDeliveryKey(binding,keyring,{operationId:'op1',endpointUrl,routeRevision:1,keyId:'key1',secret});
 const state:HttpDeliveryState={version:1,bindingId:binding.bindingId,deploymentId:binding.deploymentId,installedAt:binding.installedAt,mode:'http',revision:1,active};
 return {state,envelope:{protocolVersion:1,kind:'gateway.delivery',bindingId:binding.bindingId,workspaceId:binding.workspaceId,appId:binding.appId,deploymentId:binding.deploymentId,routeRevision:1,keyId:'key1',issuedAt:1000,delivery}};
}
async function sign(body:string,url=endpointUrl){const key=await crypto.subtle.importKey('raw',Buffer.from(secret,'base64url'),{name:'HMAC',hash:'SHA-256'},false,['sign']);return Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`chickpea-gateway-http-v1\nPOST\n${url}\n${body}`))).toString('base64url');}
test('HTTP gateway accepts active and staged keys, including repeated signed attempts',async()=>{
 const {state,envelope}=await fixture();const body=JSON.stringify(envelope);const signature=await sign(body);
 for(const selected of [state,{...state,mode:'socket' as const,active:undefined,pending:state.active}]){
  const value=await verifyHttpDelivery({body,signature,url:endpointUrl,binding,state:selected as HttpDeliveryState,keyring,now:1000});
  assert.equal(value.delivery?.deliveryId,delivery.deliveryId);
 }
 assert.equal((await verifyHttpDelivery({body,signature,url:endpointUrl,binding,state,keyring,now:2000})).kind,'gateway.delivery');
});
test('HTTP gateway rejects tampering, wrong tenant, wrong destination, unknown key and stale revision',async()=>{
 const {state,envelope}=await fixture();const body=JSON.stringify(envelope);const signature=await sign(body);
 await assert.rejects(verifyHttpDelivery({body:body.replace('synthetic','tampered'),signature,url:endpointUrl,binding,state,keyring,now:1000}));
 for(const patch of [{workspaceId:'T_OTHER'},{appId:'A_OTHER'},{deploymentId:'D_OTHER'},{bindingId:'B_OTHER'},{keyId:'missing'},{routeRevision:0},{issuedAt:400001}]){
  const altered=JSON.stringify({...envelope,...patch});await assert.rejects(verifyHttpDelivery({body:altered,signature:await sign(altered),url:endpointUrl,binding,state,keyring,now:1000}));
 }
 await assert.rejects(verifyHttpDelivery({body,signature,url:endpointUrl+'?x=1',binding,state,keyring,now:1000}));
});
test('HTTP gateway rejects nested delivery identity mismatch even with a valid signature',async()=>{
 const {state,envelope}=await fixture();const body=JSON.stringify({...envelope,delivery:{...delivery,workspaceId:'T_OTHER'}});
 await assert.rejects(verifyHttpDelivery({body,signature:await sign(body),url:endpointUrl,binding,state,keyring,now:1000}));
});
test('HTTP endpoint challenge proves possession of the staged key',async()=>{
 const {state,envelope}=await fixture();const body=JSON.stringify({...envelope,kind:'gateway.challenge',challengeId:'challenge1',delivery:undefined});
 const value=await verifyHttpDelivery({body,signature:await sign(body),url:endpointUrl,binding,state,keyring,now:1000});
 const receipt=httpDeliveryReceipt(value,'verified');assert.ok('proof' in receipt);assert.equal(receipt.challengeId,'challenge1');assert.equal(typeof receipt.proof,'string');
 const key=await crypto.subtle.importKey('raw',Buffer.from(secret,'base64url'),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 assert.equal(await crypto.subtle.verify('HMAC',key,Buffer.from(receipt.proof!,'base64url'),new TextEncoder().encode(`chickpea-gateway-http-challenge-v1\n${endpointUrl}\nchallenge1`)),true);
});
test('HTTP receiver caps the body before invoking admission and propagates storage failures',async()=>{
 let invoked=false;
 const large=await handleHttpDeliveryRequest(new Request(endpointUrl,{method:'POST',body:'x'.repeat(1_048_576+4097)}),async()=>{invoked=true;return {status:200,body:{}}});
 assert.equal(large.status,413);assert.equal(invoked,false);
 const failure=await handleHttpDeliveryRequest(new Request(endpointUrl,{method:'POST',body:'{}'}),async()=>{throw Error('private storage details');});
 assert.equal(failure.status,503);assert.doesNotMatch(await failure.text(),/private/);
});
test('endpoint policy rejects arbitrary destinations and normalizes only the fixed path',()=>{
 assert.equal(deliveryEndpoint('https://worker.account.workers.dev'),endpointUrl);
 for(const url of ['http://worker.account.workers.dev','https://127.0.0.1','https://example.com','https://worker.account.workers.dev/other','https://worker.account.workers.dev?x=1','https://user@worker.account.workers.dev','https://worker.account.workers.dev:444'])assert.throws(()=>deliveryEndpoint(url));
});
