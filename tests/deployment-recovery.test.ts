import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SqliteSettingsStore} from '../src/config/settings-store.ts';
import {authorizeDeploymentRecovery, provisionDeploymentRecovery, DEPLOYMENT_RECOVERY_SETTING} from '../src/auth/deployment-recovery.ts';
import {mintDeploymentActivation} from '../src/auth/deployment-activation.mjs';
import {GATEWAY_BINDING_SETTING} from '../src/slack/gateway/client.ts';

test('deployment recovery authority binds capability, serving version and installation', async()=>{
 const settings=new SqliteSettingsStore(':memory:');
 try{
  const capability=await mintDeploymentActivation();
  await settings.setSetting(GATEWAY_BINDING_SETTING,'original');
  await provisionDeploymentRecovery(settings,'version1',capability.digest);
  assert.deepEqual(await authorizeDeploymentRecovery(settings,'version1',`Bearer ${capability.capability}`),{binding:'original'});
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
 assert.deepEqual(await authorizeDeploymentRecovery(settings,'version',`Bearer ${cap.capability}`),{binding:null});
 await settings.setSetting(GATEWAY_BINDING_SETTING,'installed');
 assert.equal(await authorizeDeploymentRecovery(settings,'version',`Bearer ${cap.capability}`),false);
 }finally{settings.close();}
});
test('recovery provisioning fails when the binding changes before its durable write',async()=>{
 const settings=new SqliteSettingsStore(':memory:');
 try{const cap=await mintDeploymentActivation();
 const racing={...settings,getSetting:settings.getSetting.bind(settings),applySettingsPatch:async(patch:any)=>{await settings.setSetting(GATEWAY_BINDING_SETTING,'replacement');return settings.applySettingsPatch(patch);}};
 await assert.rejects(provisionDeploymentRecovery(racing as any,'version',cap.digest),/installation changed/);
 assert.equal(await settings.getSetting(DEPLOYMENT_RECOVERY_SETTING),undefined);
 }finally{settings.close();}
});
