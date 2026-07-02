import type { BotIdentityConfig } from './types.ts';

export const defaultBotIdentity: BotIdentityConfig = {
  avatarPath: 'assets/bot-avatar.png',
};

export class IdentityStore {
  constructor(private readonly seed: BotIdentityConfig = defaultBotIdentity) {}

  get(): BotIdentityConfig {
    return this.seed;
  }
}
