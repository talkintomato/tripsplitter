/**
 * Chat agent integration contract:
 *
 * AgentModel.respond(input: AgentModelInput): Promise<AgentModelOutput>
 *   receives fixed instruction, trip data, <=8 stored turns, definitions, message,
 *   and this turn's ordered calls/results. All tool data is an untrusted_data envelope.
 * runAgentTurn(db, config, deps: AgentDeps, input: AgentTurnInput): Promise<AgentTurnResult>
 *   input = {groupId, memberId, chatId, text, now: Date}; authenticate the Telegram
 *   sender first. Never let a model supply these IDs. Caps count one message, including failures.
 * confirmProposal(db, deps: ConfirmationDeps, input: ProposalDecision): ConfirmationResult
 * cancelProposal(db, deps: ConfirmationDeps, input: ProposalDecision): ConfirmationResult
 *   input = {proposalId, memberId, now: Date}; deps is currently {}.
 *   memberId is the authenticated sender's foundation membership, not Telegram user ID.
 *   done returns typed notices, ONLY on the first successful commit. Dispatch each via
 *   Notifier[notice.method](notice.payload) after commit. Cancel returns no notices.
 *   Notices are at-most-once handoffs, not a durable delivery outbox.
 * applyProposal is an alias of confirmProposal. All actions/activity/status commit together.
 * A replacement proposal cancels previous pending offers for this person/chat.
 * Stale checks conservatively refuse on ANY intervening group activity, including member
 * changes, since names, everyone splits, rates and trip state are preview dependencies.
 * Expired turns are purged opportunistically at the start of turns.
 * No manual drafts, secret access or conversation logging.
 */
export * from './model.js';
export * from './types.js';
export * from './loop.js';
export * from '../tools/index.js';
export { AGENT_INSTRUCTION } from './prompt.js';

export * from './openai.js';
export * from './handlers.js';
