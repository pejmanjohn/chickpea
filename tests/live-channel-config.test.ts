import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liveChannelConfigurationEnabled } from '../src/config/live-channel-config.ts';

test('live Channel configuration is default-on with an explicit snapshot rollback', () => {
  assert.equal(liveChannelConfigurationEnabled(undefined, {}), true);
  assert.equal(liveChannelConfigurationEnabled({ CHICKPEA_LIVE_CHANNEL_CONFIG: 'true' }, {}), true);
  assert.equal(liveChannelConfigurationEnabled({ CHICKPEA_LIVE_CHANNEL_CONFIG: 'false' }, {}), false);
  assert.equal(liveChannelConfigurationEnabled({ CHICKPEA_LIVE_CHANNEL_CONFIG: '0' }, {}), false);
  assert.equal(liveChannelConfigurationEnabled(undefined, {
    CHICKPEA_LIVE_CHANNEL_CONFIG: 'off',
  }), false);
  assert.equal(liveChannelConfigurationEnabled({ CHICKPEA_LIVE_CHANNEL_CONFIG: '1' }, {
    CHICKPEA_LIVE_CHANNEL_CONFIG: 'false',
  }), true);
});
