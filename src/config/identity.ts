import type { BotIdentityConfig } from './types.ts';

export const defaultBotIdentity: BotIdentityConfig = {
  avatarPath: 'assets/bot-avatar.png',
};

export class IdentityStore {
  private readonly seed: BotIdentityConfig;

  constructor(seed: BotIdentityConfig = defaultBotIdentity) {
    this.seed = seed;
  }

  get(): BotIdentityConfig {
    return this.seed;
  }
}
