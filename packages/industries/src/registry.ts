import { parseIndustryConfig, type IndustryConfig } from './config';
import { shippedIndustryConfigs } from './configs';

/**
 * In-memory registry of validated industry configs. Built lazily on first
 * use; every shipped config is run through the Zod loader, so a bad config
 * throws an IndustryConfigError with the full violation list at startup
 * rather than corrupting a tenant at apply time.
 */

let cache: Map<string, IndustryConfig> | undefined;

function registry(): Map<string, IndustryConfig> {
  if (!cache) {
    const map = new Map<string, IndustryConfig>();
    for (const entry of shippedIndustryConfigs) {
      const config = parseIndustryConfig(entry.raw, entry.source);
      if (map.has(config.key)) {
        throw new Error(`duplicate industry config key "${config.key}" (${entry.source})`);
      }
      map.set(config.key, config);
    }
    cache = map;
  }
  return cache;
}

/** Compact listing entry for the industries catalog. */
export interface IndustrySummary {
  key: string;
  label: string;
  description: string;
  counts: {
    leadStages: number;
    quoteTemplates: number;
    appointmentTypes: number;
    dashboardWidgets: number;
    workflows: number;
  };
}

/** All available industries, sorted by key (deterministic). */
export function listIndustries(): IndustrySummary[] {
  return [...registry().values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((config) => ({
      key: config.key,
      label: config.label,
      description: config.description,
      counts: {
        leadStages: config.leadStages.length,
        quoteTemplates: config.quoteTemplates.length,
        appointmentTypes: config.appointmentTypes.length,
        dashboardWidgets: config.dashboardWidgets.length,
        workflows: config.workflows.length,
      },
    }));
}

/** Full validated config for one industry, or undefined if unknown. */
export function getIndustryConfig(key: string): IndustryConfig | undefined {
  return registry().get(key);
}
