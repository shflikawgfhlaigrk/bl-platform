/**
 * @blacklabel/messaging — unified messaging inbox (one inbox across
 * channels: email, sms, website, social, internal).
 *
 * Events emitted (all after the DB write succeeds):
 * - `messaging.message.received`      { messageId, channel, from }        (catalog event)
 * - `messaging.message.sent`          { messageId, channel, to }          (module event)
 * - `messaging.conversation.closed`   { conversationId }                  (module event)
 * - `messaging.conversation.assigned` { conversationId, userId }          (module event)
 *
 * Cross-module contracts:
 * - IMPLEMENTS core's SendMessageContract via `createMessagingSendContract`
 *   (apps/api wires it into other modules' `deps.contracts.sendMessage`).
 * - CONSUMES the documented `TimelineWriter` contract (optional): when a
 *   conversation is linked to a CRM customer/contact by id, message-received
 *   and conversation-closed timeline entries are written through it.
 */
export const MODULE_KEY = 'messaging' as const;
export { ResendEmailProvider } from './resend';
export type { ResendConnection, ResendOptions } from './resend';

// Schema / row types
export type {
  MessagingDatabase,
  MessagingChannelRow,
  MessagingConversationRow,
  MessagingMessageRow,
  MessagingTemplateRow,
  MessagingParticipantRow,
  MessagingAssignmentRow,
  MessagingInboundReceiptRow,
  ChannelType,
  ConversationStatus,
  MessageDirection,
  MessageStatus,
  ParticipantKind,
} from './schema';
export {
  CHANNEL_TYPES,
  CONVERSATION_STATUSES,
  MESSAGE_DIRECTIONS,
  MESSAGE_STATUSES,
  PARTICIPANT_KINDS,
} from './schema';

// Migrations
export { messagingMigrations } from './migrations';

// Router factory
export { messagingRouter } from './router';
export type { MessagingRouterOptions } from './router';

// Service + channel-provider interface + stubs + contracts
export {
  MessagingService,
  renderTemplate,
  defaultProviders,
  LogOnlyEmailProvider,
  LogOnlySmsProvider,
  createMessagingSendContract,
} from './service';
export type {
  MessagingServiceOptions,
  ChannelProvider,
  ChannelProviders,
  ChannelSendResult,
  ChannelDeliveryResult,
  DurableSendMessageInput,
  DurableSendMessageContract,
  OutboundPayload,
  LoggedSend,
  TimelineWriter,
  TimelineEventInput,
  ChannelDto,
  ConversationDetail,
  CreateConversationInput,
  InboundMessageInput,
  SendOutboundInput,
  ConversationFilters,
  SearchResult,
} from './service';

// Seed helper
export { seedMessaging } from './seed';
export type { MessagingSeedResult } from './seed';
