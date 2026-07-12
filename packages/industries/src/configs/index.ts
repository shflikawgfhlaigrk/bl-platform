import { constructionConfig } from './construction';
import { hvacConfig } from './hvac';
import { lawFirmConfig } from './law-firm';
import { medicalDentalConfig } from './medical-dental';
import { musicAudioConfig } from './music-audio';
import { realEstateConfig } from './real-estate';
import { restaurantConfig } from './restaurant';
import { spaWellnessConfig } from './spa-wellness';
import { smartHomeSecurityConfig } from './smart-home-security';
import { tackRetailConfig } from './tack-retail';
import { windowCleaningConfig } from './window-cleaning';

/**
 * All shipped industry configs. Adding an industry = add ONE file here and
 * list it below — no other code changes anywhere in the platform.
 *
 * Entries are `unknown` on purpose: every config goes through the Zod loader
 * (`parseIndustryConfig`) before it is served, so a broken config fails fast
 * with a full violation list instead of silently shipping.
 */
export const shippedIndustryConfigs: ReadonlyArray<{ source: string; raw: unknown }> = [
  { source: 'configs/construction.ts', raw: constructionConfig },
  { source: 'configs/hvac.ts', raw: hvacConfig },
  { source: 'configs/law-firm.ts', raw: lawFirmConfig },
  { source: 'configs/medical-dental.ts', raw: medicalDentalConfig },
  { source: 'configs/music-audio.ts', raw: musicAudioConfig },
  { source: 'configs/real-estate.ts', raw: realEstateConfig },
  { source: 'configs/restaurant.ts', raw: restaurantConfig },
  { source: 'configs/smart-home-security.ts', raw: smartHomeSecurityConfig },
  { source: 'configs/spa-wellness.ts', raw: spaWellnessConfig },
  { source: 'configs/tack-retail.ts', raw: tackRetailConfig },
  { source: 'configs/window-cleaning.ts', raw: windowCleaningConfig },
];
