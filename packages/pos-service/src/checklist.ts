import { stageRank, type MerchantRecord, type MerchantStage } from './lifecycle';

const STEPS: Array<{ stage: MerchantStage; label: string; who: 'customer' | 'stripe' | 'automatic' }> = [
  { stage: 'purchased', label: 'POS purchased', who: 'customer' },
  { stage: 'onboarding', label: 'Verification link sent', who: 'automatic' },
  { stage: 'verified', label: 'Stripe verified the business', who: 'stripe' },
  { stage: 'location_ready', label: 'Store location set up', who: 'automatic' },
  { stage: 'reader_ordered', label: 'Card reader ordered', who: 'automatic' },
  { stage: 'reader_shipped', label: 'Card reader shipped', who: 'stripe' },
  { stage: 'reader_delivered', label: 'Card reader delivered', who: 'stripe' },
  { stage: 'reader_registered', label: 'Card reader registered', who: 'customer' },
  { stage: 'live', label: 'Test sale passed and refunded', who: 'customer' },
];

/** The customer-facing setup checklist for a merchant, derived only from the record. */
export function merchantChecklist(record: MerchantRecord) {
  const rank = stageRank(record.stage);
  const nextIndex = STEPS.findIndex((step) => stageRank(step.stage) > rank);
  return {
    stage: record.stage,
    blocked: record.blocked,
    steps: STEPS.map((step, index) => ({
      label: step.label,
      who: step.who,
      done: stageRank(step.stage) <= rank,
      current: index === nextIndex,
    })),
  };
}
