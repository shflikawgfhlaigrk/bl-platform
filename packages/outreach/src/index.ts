/**
 * @blacklabel/outreach — the cold-email lane (SMTP/IMAP adapters + simulator,
 * fixed templates, campaigns, the append-only send-of-record, warmup capacity,
 * inbound inbox + threads, CAN-SPAM + armed gates). The package holds NO network
 * code: real transports are injected by apps/api; tests drive the simulators.
 *
 * Ships fully COLD. Every send passes ALL gates in order:
 *   not_armed → no_postal → no_provider → no_consent → suppressed
 *   → quiet_hours (defer) → cap_reached (defer)
 *
 * Events emitted:
 *   - outreach.delivery.changed  { v:1, sendId, state }   (canonical; every state change)
 *   - outreach.campaign.paused   { v:1, campaignId, reason, bounceRate, sent, bounced }  (internal)
 * Payloads carry ids + numbers only — NEVER an email address or other PII.
 *
 * Integrator wiring (apps/api):
 *   outreachRouter(deps, {
 *     transport,           // MailTransport  — real SMTP behind admin creds
 *     reader,              // MailboxReader  — real IMAP behind admin creds
 *     suppress,            // (tenantId,email,reason) => void  (customers.suppressions)
 *     isSuppressed,        // (tenantId,email) => boolean       (customers.suppressions)
 *     unsubscribeBaseUrl,  // public URL the unsubscribe link points at
 *   })
 * Provider credentials live in admin, referenced by a credential-id string in
 * outreach_settings.provider_credential_ref (never stored in this package).
 */

export { outreachMigrations } from './migrations';
export { outreachRouter } from './router';

export {
  getOrCreateSettings,
  updateSettings,
  gateReport,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  listTemplates,
  getTemplate,
  createCampaign,
  getCampaign,
  listCampaigns,
  setAudience,
  approveCampaign,
  cancelCampaign,
  pauseCampaign,
  resumeCampaign,
  queueSend,
  queueCampaign,
  sendPending,
  recomputeCampaignCounts,
  evaluateBouncePause,
  checkReplies,
  processUnsubscribe,
  tokenForSend,
  listSends,
  listInbox,
  getThread,
} from './service';
export type {
  SettingsPatch,
  GateReport,
  TemplateInput,
  CampaignInput,
  AudienceEntry,
  QueueSendInput,
  QueueCampaignResult,
  DrainResult,
  CheckRepliesResult,
  UnsubscribeResult,
  ThreadView,
} from './service';

export {
  SimulatorTransport,
  SimulatorReader,
  smtpConfigSchema,
  imapConfigSchema,
} from './adapters';
export type {
  MailTransport,
  MailboxReader,
  SendRequest,
  SendReceipt,
  InboundMessage,
  FetchResult,
  OutreachAdapters,
  SuppressFn,
  IsSuppressedFn,
  SmtpConfig,
  ImapConfig,
  RecordedSend,
} from './adapters';

export {
  warmupCapForAge,
  isQuietHours,
  businessDate,
  ageDaysBetween,
  WARMUP_START,
  WARMUP_STEP_PER_WEEK,
  WARMUP_HARD_CEILING,
  DEFAULT_QUIET_HOURS,
} from './capacity';
export type { QuietHours } from './capacity';

export { classify, normalizeEmail, normalizeSubject, looksLikeBounce, looksLikeAutoReply } from './classify';
export type { Classification, InboundSummary } from './classify';

export { render, unsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl } from './render';

export type {
  OutreachDatabase,
  OutreachSettingsRow,
  OutreachTemplateRow,
  OutreachCampaignRow,
  OutreachSendRow,
  OutreachCapacityRow,
  OutreachInboxRow,
  OutreachReaderStateRow,
  TemplateKind,
  CampaignStatus,
  SendStatus,
  BlockedReason,
  InboxClassification,
} from './schema';
