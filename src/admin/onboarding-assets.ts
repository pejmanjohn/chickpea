import { readPublicAsset } from '#chickpea-assets';
import { ONBOARDING_ASSET_FILES } from '../assets/public-assets.ts';

export async function onboardingAssetBytes(name: string): Promise<ArrayBuffer | undefined> {
  if (!(ONBOARDING_ASSET_FILES as readonly string[]).includes(name)) return undefined;
  return (await readPublicAsset(`onboarding/${name}`)).buffer;
}
