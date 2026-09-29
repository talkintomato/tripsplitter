import { InlineKeyboard, type Api } from 'grammy';
import type { Config } from '../config.js';
import { launchUrl } from '../core/index.js';
import { getGroup, listMembers, personalRecipients, systemScope, type Db, type PersonalNoticeType } from '../db/index.js';
import type { BotLogger } from './support.js';

/** Telegram error descriptions can contain request text. Log only a fixed category and numeric code. */
export function noticeFailure(error: unknown): { reason: string; code?: number } {
  const code = typeof error === 'object' && error !== null && 'error_code' in error && typeof error.error_code === 'number' ? error.error_code : undefined;
  return { reason: code === 403 ? 'private_chat_unavailable' : code === 400 ? 'request_refused' : code === 429 ? 'rate_limited' : 'delivery_failed', ...(code === undefined ? {} : { code }) };
}

export function createPersonalDelivery(api: Api, config: Config, db: Db, logger: BotLogger) {
  return async (type: PersonalNoticeType, groupId: number, actorId: number, memberIds: number[], text: (memberId: number) => string, expenseId?: number): Promise<void> => {
    try {
      const group = getGroup(db, systemScope(groupId));
      const url = launchUrl(config, { groupId, linkVersion: group.linkVersion, ...(expenseId ? { view: 'expense' as const, expenseId } : { view: 'home' as const }) });
      const keyboard = new InlineKeyboard();
      if (config.webhookUrl) {
        const appUrl = new URL(config.webhookUrl);
        appUrl.searchParams.set('startapp', new URL(url).searchParams.get('startapp')!);
        keyboard.webApp('Open', appUrl.toString());
      } else keyboard.url('Open', url);
      // Missing actor context must never result in accidentally notifying the actor.
      if (!actorId) return;
      for (const member of personalRecipients(db, groupId, type, memberIds.filter(id => id !== actorId))) {
        try {
          await api.sendMessage(member.telegramUserId!, text(member.id).replace(/[\r\n]+/g, ' ').slice(0, 3500), {
            reply_markup: keyboard, link_preview_options: { is_disabled: true },
          });
        } catch (error) {
          logger.error('Could not send personal notice', { type, ...noticeFailure(error) });
        }
      }
    } catch (error) {
      logger.error('Could not prepare personal notice', { type, ...noticeFailure(error) });
    }
  };
}

/** Drafts have no group notice. This separate delivery path preserves the Notifier method contract. */
export async function sendDraftWaiting(api: Api, config: Config, db: Db, logger: BotLogger, n: {
  groupId: number; actorMemberId: number; actorName: string; tripName: string; expenseId: number;
}): Promise<void> {
  try {
    const ids = listMembers(db, systemScope(n.groupId)).map(m => m.id);
    await createPersonalDelivery(api, config, db, logger)('draft_waiting', n.groupId, n.actorMemberId, ids,
      () => `🧾 A receipt from ${n.actorName} is waiting for approval in ${n.tripName}`, n.expenseId);
  } catch (error) {
    logger.error('Could not prepare draft notice', noticeFailure(error));
  }
}
