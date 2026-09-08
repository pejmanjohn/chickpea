import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SqliteSettingsStore} from '../src/config/settings-store.ts';
import {authorizeDeploymentRecovery, provisionDeploymentRecovery, beginDeploymentRecovery, deploymentUpgradeAllowed} from '../src/auth/deployment-recovery.ts';
import {mintDeploymentActivation} from '../src/auth/deployment-activation.mjs';
import {GATEWAY_BINDING_SETTING} from '../src/slack/gateway/client.ts';

test('deployment recovery authority binds capability, serving version and installation', async()=>{
 const settings=new SqliteSettingsStore(':memory:');
 try{
  const capability=await mintDeploymentActivation();
  await settings.setSetting(GATEWAY_BINDING_SETTING,'original');
  await provisionDeploymentRecovery(settings,'version1',capability.digest);
  assert.equal(((await authorizeDeploymentRecovery(settings,'version1',`Bearer ${capability.capability}`)) as {binding:string}).binding,'original');
  assert.equal(await authorizeDeploymentRecovery(settings,'version2',`Bearer ${capability.capability}`),false);
  assert.equal(await authorizeDeploymentRecovery(settings,'version1',`Bearer ${(await mintDeploymentActivation()).capability}`),false);
  assert.equal(await authorizeDeploymentRecovery(settings,'version1',''),false);
  await settings.setSetting(GATEWAY_BINDING_SETTING,'replacement');
  assert.equal(await authorizeDeploymentRecovery(settings,'version1',`Bearer ${capability.capability}`),false);
 }finally{settings.close();}
});
test('recovery capability before setup cannot authorize a later installation',async()=>{
 const settings=new SqliteSettingsStore(':memory:');
 try{const cap=await mintDeploymentActivation();await provisionDeploymentRecovery(settings,'version',cap.digest);
 assert.equal(((await authorizeDeploymentRecovery(settings,'version',`Bearer ${cap.capability}`)) as {binding:null}).binding,null);
 await settings.setSetting(GATEWAY_BINDING_SETTING,'installed');
 assert.equal(await authorizeDeploymentRecovery(settings,'version',`Bearer ${cap.capability}`),false);
 }finally{settings.close();}
});
test('recovery provisioning fails when the binding changes before its durable write',async()=>{
 const settings=new SqliteSettingsStore(':memory:');
 try{const cap=await mintDeploymentActivation();
 const racing={...settings,getSetting:settings.getSetting.bind(settings),getSettings:settings.getSettings.bind(settings),applySettingsPatch:async(patch:any)=>{await settings.setSetting(GATEWAY_BINDING_SETTING,'replacement');return settings.applySettingsPatch(patch);}};
 await assert.rejects(provisionDeploymentRecovery(racing as any,'version',cap.digest),/installation changed/);
 assert.equal(await authorizeDeploymentRecovery(settings,'version',`Bearer ${cap.capability}`),false);
 }finally{settings.close();}
});

test('new receipt resumes HTTP intent while recovery repairs and stale readiness preserve recovery',async()=>{
 const settings=new SqliteSettingsStore(':memory:');
 try{
  const cap=await mintDeploymentActivation();
  const original=await provisionDeploymentRecovery(settings,'version1',cap.digest);
  assert.equal(await deploymentUpgradeAllowed(settings,original),true);
  assert.equal(((await beginDeploymentRecovery(settings,'version1',`Bearer ${cap.capability}`)) as {intent:string}).intent,'recover');
  assert.equal(await deploymentUpgradeAllowed(settings,original),false);
  assert.equal((await provisionDeploymentRecovery(settings,'version1',cap.digest)).intent,'recover');
  const repaired=await provisionDeploymentRecovery(settings,'version2',cap.digest);
  assert.equal(repaired.intent,'recover');
  assert.equal(await deploymentUpgradeAllowed(settings,repaired),false);
  const next=await provisionDeploymentRecovery(settings,'version3',(await mintDeploymentActivation()).digest);
  assert.equal(next.intent,'upgrade');
  assert.equal(await deploymentUpgradeAllowed(settings,next),true);
 }finally{settings.close();}
});
test('readiness CAS retry cannot overwrite a concurrently persisted recovery intent',async()=>{
 const settings=new SqliteSettingsStore(':memory:');
 try{
  const cap=await mintDeploymentActivation();await provisionDeploymentRecovery(settings,'version',cap.digest);
  let raced=false;
  const racing={getSetting:settings.getSetting.bind(settings),getSettings:settings.getSettings.bind(settings),applySettingsPatch:async(patch:any)=>{
    if(!raced){raced=true;await beginDeploymentRecovery(settings,'version',`Bearer ${cap.capability}`);}
    return settings.applySettingsPatch(patch);
  }};
  assert.equal((await provisionDeploymentRecovery(racing as any,'version',cap.digest)).intent,'recover');
 }finally{settings.close();}
});
