import { describe, expect, it } from 'vitest';
import { computeTotals } from '@blacklabel/core';
import {
  CORE_TERMS,
  IndustryConfigError,
  getIndustryConfig,
  listIndustries,
  parseIndustryConfig,
  termFor,
  validateIndustryConfig,
} from '@blacklabel/industries';

const EXPECTED_KEYS = [
  'construction',
  'hvac',
  'law-firm',
  'medical-dental',
  'music-audio',
  'real-estate',
  'restaurant',
  'service-delivery',
  'smart-home-security',
  'spa-wellness',
  'tack-retail',
  'window-cleaning',
];

/** A minimal, fully valid config used as a base for invalid variants. */
function validConfig() {
  return {
    key: 'test-industry',
    label: 'Test Industry',
    description: 'A config used in tests.',
    terminology: {
      lead: 'Lead',
      customer: 'Customer',
      quote: 'Quote',
      job: 'Job',
      appointment: 'Appointment',
      invoice: 'Invoice',
      team_member: 'Team Member',
    },
    leadStages: [
      { key: 'new', label: 'New' },
      { key: 'won', label: 'Won' },
    ],
    quoteTemplates: [
      {
        key: 'basic',
        name: 'Basic Package',
        lines: [{ description: 'Service', quantity: 1, unitPriceCents: 10000 }],
      },
    ],
    appointmentTypes: [{ key: 'visit', label: 'Visit', durationMinutes: 60 }],
    dashboardWidgets: [{ key: 'revenue', title: 'Revenue', type: 'metric' }],
    workflows: [
      {
        key: 'followup',
        name: 'Follow up',
        trigger: 'crm.lead.created',
        actions: [{ type: 'create_task', params: { title: 'Call' } }],
      },
    ],
  };
}

describe('shipped industry configs', () => {
  it('ships all 12 industries', () => {
    expect(listIndustries().map((i) => i.key)).toEqual(EXPECTED_KEYS);
  });

  it.each(EXPECTED_KEYS)('config "%s" is complete and validates', (key) => {
    const config = getIndustryConfig(key);
    expect(config).toBeDefined();
    // Re-validating the registry output proves the raw file passes the loader.
    const result = validateIndustryConfig(config);
    expect(result.ok).toBe(true);
    for (const term of CORE_TERMS) {
      expect(config!.terminology[term]).toBeTruthy();
    }
    expect(config!.leadStages.length).toBeGreaterThanOrEqual(2);
    expect(config!.quoteTemplates.length).toBeGreaterThanOrEqual(1);
    expect(config!.appointmentTypes.length).toBeGreaterThanOrEqual(1);
    expect(config!.dashboardWidgets.length).toBeGreaterThanOrEqual(1);
    expect(config!.workflows.length).toBeGreaterThanOrEqual(1);
  });

  it('every template line uses integer cents that core money math accepts', () => {
    for (const summary of listIndustries()) {
      const config = getIndustryConfig(summary.key)!;
      for (const template of config.quoteTemplates) {
        // computeTotals throws on non-integer cents — this asserts to the cent.
        const totals = computeTotals(template.lines);
        expect(Number.isInteger(totals.totalCents)).toBe(true);
        expect(totals.totalCents).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('window-cleaning residential template totals to the cent via computeTotals', () => {
    const config = getIndustryConfig('window-cleaning')!;
    const template = config.quoteTemplates.find((t) => t.key === 'residential_standard')!;
    const totals = computeTotals(template.lines);
    // 20*450 + 20*350 + 10*200 = 9000 + 7000 + 2000
    expect(totals.subtotalCents).toBe(18000);
    expect(totals.totalCents).toBe(18000);
  });
});

describe('config loader validation', () => {
  it('accepts a valid config', () => {
    const result = validateIndustryConfig(validConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.key).toBe('test-industry');
    }
  });

  it('rejects an invalid config with EVERY violation listed', () => {
    const bad = validConfig() as any;
    delete bad.label; // missing required field
    delete bad.terminology.job; // missing core term
    delete bad.terminology.invoice; // missing core term
    bad.leadStages[1].key = 'new'; // duplicate stage key
    bad.quoteTemplates[0].lines[0].unitPriceCents = 99.5; // float money
    bad.workflows[0].trigger = 'NotAnEvent'; // bad event name
    bad.bogusField = true; // unknown key

    const result = validateIndustryConfig(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.violations.map((v) => v.path);
    expect(paths).toContain('label');
    expect(paths).toContain('terminology.job');
    expect(paths).toContain('terminology.invoice');
    expect(paths).toContain('leadStages.1.key');
    expect(paths).toContain('quoteTemplates.0.lines.0.unitPriceCents');
    expect(paths).toContain('workflows.0.trigger');
    expect(result.violations.length).toBeGreaterThanOrEqual(7);
  });

  it('parseIndustryConfig throws a typed IndustryConfigError with violations', () => {
    const bad = validConfig() as any;
    bad.key = 'Not Kebab';
    bad.appointmentTypes[0].durationMinutes = -5;
    try {
      parseIndustryConfig(bad, 'test.ts');
      expect.fail('expected IndustryConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(IndustryConfigError);
      const cfgErr = err as IndustryConfigError;
      expect(cfgErr.source).toBe('test.ts');
      expect(cfgErr.violations.length).toBeGreaterThanOrEqual(2);
      expect(cfgErr.violations.map((v) => v.path)).toContain('key');
      expect(cfgErr.violations.map((v) => v.path)).toContain(
        'appointmentTypes.0.durationMinutes',
      );
      expect(cfgErr.message).toContain('test.ts');
    }
  });

  it('rejects a workflow with no actions', () => {
    const bad = validConfig() as any;
    bad.workflows[0].actions = [];
    const result = validateIndustryConfig(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((v) => v.path)).toContain('workflows.0.actions');
    }
  });

  it('rejects non-object input entirely', () => {
    expect(validateIndustryConfig(null).ok).toBe(false);
    expect(validateIndustryConfig('nope').ok).toBe(false);
    expect(validateIndustryConfig(42).ok).toBe(false);
  });
});

describe('terminology lookup', () => {
  it('termFor returns the mapped display term', () => {
    const config = getIndustryConfig('law-firm')!;
    expect(termFor(config.terminology, 'job')).toBe('Matter');
    expect(termFor(config.terminology, 'team_member')).toBe('Attorney');
  });

  it('termFor falls back to the core term when unmapped', () => {
    expect(termFor({}, 'job')).toBe('job');
    expect(termFor({ job: 'Session' }, 'quote')).toBe('quote');
  });

  it('maps the same core term differently across industries', () => {
    const spa = getIndustryConfig('spa-wellness')!;
    const construction = getIndustryConfig('construction')!;
    expect(termFor(spa.terminology, 'job')).toBe('Session');
    expect(termFor(construction.terminology, 'job')).toBe('Project');
  });
});
