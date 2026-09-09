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
  await provisionDeploymentRecovery(settings,'version1',capability.digest,1);
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
 try{const cap=await mintDeploymentActivation();await provisionDeploymentRecovery(settings,'version',cap.digest,1);
 assert.equal(((await authorizeDeploymentRecovery(settings,'version',`Bearer ${cap.capability}`)) as {binding:null}).binding,null);
 await settings.setSetting(GATEWAY_BINDING_SETTING,'installed');
 assert.equal(await authorizeDeploymentRecovery(settings,'version',`Bearer ${cap.capability}`),false);
 }finally{settings.close();}
});
test('recovery provisioning fails when the binding changes before its durable write',async()=>{
 const settings=new SqliteSettingsStore(':memory:');
 try{const cap=await mintDeploymentActivation();
 const racing={...settings,getSetting:settings.getSetting.bind(settings),getSettings:settings.getSettings.bind(settings),applySettingsPatch:async(patch:any)=>{await settings.setSetting(GATEWAY_BINDING_SETTING,'replacement');return settings.applySettingsPatch(patch);}};
 await assert.rejects(provisionDeploymentRecovery(racing as any,'version',cap.digest,1),/installation changed/);
 assert.equal(await authorizeDeploymentRecovery(settings,'version',`Bearer ${cap.capability}`),false);
 }finally{settings.close();}
});

test('new receipt resumes HTTP intent while recovery repairs and stale readiness preserve recovery',async()=>{
 const settings=new SqliteSettingsStore(':memory:');
 try{
  const cap=await mintDeploymentActivation();
  const original=await provisionDeploymentRecovery(settings,'version1',cap.digest,1);
  assert.equal(await deploymentUpgradeAllowed(settings,original),true);
  assert.equal(((await beginDeploymentRecovery(settings,'version1',`Bearer ${cap.capability}`)) as {intent:string}).intent,'recover');
  assert.equal(await deploymentUpgradeAllowed(settings,original),false);
  assert.equal((await provisionDeploymentRecovery(settings,'version1',cap.digest,1)).intent,'recover');
  const repaired=await provisionDeploymentRecovery(settings,'version2',cap.digest,2);
  assert.equal(repaired.intent,'recover');
  assert.equal(await deploymentUpgradeAllowed(settings,repaired),false);
  const next=await provisionDeploymentRecovery(settings,'version3',(await mintDeploymentActivation()).digest,3);
  assert.equal(next.intent,'upgrade');
  assert.equal(await deploymentUpgradeAllowed(settings,next),true);
 }finally{settings.close();}
});
test('readiness CAS retry cannot overwrite a concurrently persisted recovery intent',async()=>{
 const settings=new SqliteSettingsStore(':memory:');
 try{
  const cap=await mintDeploymentActivation();await provisionDeploymentRecovery(settings,'version',cap.digest,1);
  let raced=false;
  const racing={getSetting:settings.getSetting.bind(settings),getSettings:settings.getSettings.bind(settings),applySettingsPatch:async(patch:any)=>{
    if(!raced){raced=true;await beginDeploymentRecovery(settings,'version',`Bearer ${cap.capability}`);}
    return settings.applySettingsPatch(patch);
  }};
  assert.equal((await provisionDeploymentRecovery(racing as any,'version',cap.digest,1)).intent,'recover');
 }finally{settings.close();}
});

test('stale readiness and equal conflicting deployment ownership cannot overwrite the current receipt',async()=>{
 const settings=new SqliteSettingsStore(':memory:');
 try{const old=await mintDeploymentActivation();const current=await mintDeploymentActivation();
 await provisionDeploymentRecovery(settings,'old',old.digest,1);
 const latest=await provisionDeploymentRecovery(settings,'new',current.digest,2);
 await assert.rejects(provisionDeploymentRecovery(settings,'old',old.digest,1),/newer deployment/);
 await assert.rejects(provisionDeploymentRecovery(settings,'other',old.digest,2),/newer deployment/);
 await assert.rejects(provisionDeploymentRecovery(settings,'new',old.digest,2),/newer deployment/);
 assert.equal(await deploymentUpgradeAllowed(settings,latest),true);
 }finally{settings.close();}
});
test('old readiness CAS retry cannot replace a newly claimed deployment',async()=>{
 const settings=new SqliteSettingsStore(':memory:');
 try{const old=await mintDeploymentActivation();const current=await mintDeploymentActivation();
 await provisionDeploymentRecovery(settings,'old',old.digest,1);let raced=false;
 const racing={getSetting:settings.getSetting.bind(settings),getSettings:settings.getSettings.bind(settings),applySettingsPatch:async(patch:any)=>{
  if(!raced){raced=true;await provisionDeploymentRecovery(settings,'new',current.digest,2);}
  return settings.applySettingsPatch(patch);
 }};
 await assert.rejects(provisionDeploymentRecovery(racing as any,'old',old.digest,1),/newer deployment/);
 assert.equal(await authorizeDeploymentRecovery(settings,'old',`Bearer ${old.capability}`),false);
 assert.ok(await authorizeDeploymentRecovery(settings,'new',`Bearer ${current.capability}`));
 }finally{settings.close();}
});
