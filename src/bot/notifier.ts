import { InlineKeyboard, type Api } from 'grammy';
import type { Config } from '../config.js';
import {
  formatAmount,
  fromMinorUnits,
  launchUrl,
  type ExpenseNotice,
  type Notifier,
  type RateNotice,
  type SettlementNotice,
  type SplitType,
} from '../core/index.js';
import { getGroup, systemScope, type Db } from '../db/index.js';
import { postIntro } from './intro.js';
import { describeError, type BotLogger } from './support.js';

const SPLIT_LABEL: Record<SplitType, string> = {
  even: 'split evenly',
  portions: 'split by portions',
  items: 'split by item',
};

export function expenseSavedText(n: ExpenseNotice): string {
  const head = `${n.actorName} added ${n.description}, ${formatAmount(n.total, n.currency)}, ${SPLIT_LABEL[n.splitType]}.`;
  if (n.shares.length === 0) return head;
  const shares = n.shares.map((share) => `${share.name} ${fromMinorUnits(share.amount, n.currency)}`).join(' · ');
  return `${head} ${shares}`;
}

export function expenseEditedText(n: ExpenseNotice & { changes: string[] }): string {
  const head = `${n.actorName} edited ${n.description}`;
  return n.changes.length === 0 ? head : `${head}: ${n.changes.join(', ')}`;
}

export function expenseRemovedText(n: ExpenseNotice, verb: 'deleted' | 'restored'): string {
  return `${n.actorName} ${verb} ${n.description} (${formatAmount(n.total, n.currency)})`;
}

function paymentText(n: SettlementNotice): string {
  return `${n.fromName} paid ${n.toName} ${formatAmount(n.amount, n.currency)}`;
}

export function settlementText(n: SettlementNotice, kind: 'recorded' | 'undone' | 'restored'): string {
  if (kind === 'recorded') return `${paymentText(n)}, recorded by ${n.actorName}`;
  const verb = kind === 'undone' ? 'undid' : 'restored';
  return `${n.actorName} ${verb} the payment: ${paymentText(n)}`;
}

export function tripRateText(n: RateNotice): string {
  const rate = `1 ${n.homeCurrency} = ${n.rate} ${n.currency}`;
  if (n.origin === 'suggested') return `Trip rate for ${n.currency} set to ${rate}. Change it in trip settings.`;
  const count = n.expensesChanged === 1 ? '1 expense updated.' : `${n.expensesChanged} expenses updated.`;
  return `${n.actorName} changed the trip rate: ${rate}. ${count}`;
}

export function createNotifier(api: Api, config: Config, db: Db, logger: BotLogger): Notifier {
  /** Runs one notice. Whatever goes wrong is logged, so that a notice never throws. */
  async function safely(name: string, chatId: number, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      logger.error(`Could not post the notice ${name}`, { chatId, error: describeError(error) });
    }
  }

  function post(name: string, chatId: number, text: () => string, keyboard?: () => InlineKeyboard): Promise<void> {
    return safely(name, chatId, async () => {
      const markup = keyboard?.();
      await api.sendMessage(chatId, text(), {
        link_preview_options: { is_disabled: true },
        ...(markup !== undefined ? { reply_markup: markup } : {}),
      });
    });
  }

  function viewButton(n: ExpenseNotice): InlineKeyboard {
    const group = getGroup(db, systemScope(n.groupId));
    const url = launchUrl(config, { groupId: group.id, linkVersion: group.linkVersion, view: 'expense', expenseId: n.expenseId });
    return new InlineKeyboard().url('View', url);
  }

  return {
    expenseSaved: (n) => post('expenseSaved', n.chatId, () => expenseSavedText(n), () => viewButton(n)),
    expenseEdited: (n) => post('expenseEdited', n.chatId, () => expenseEditedText(n), () => viewButton(n)),
    expenseDeleted: (n) => post('expenseDeleted', n.chatId, () => expenseRemovedText(n, 'deleted')),
    expenseRestored: (n) => post('expenseRestored', n.chatId, () => expenseRemovedText(n, 'restored')),
    settlementRecorded: (n) => post('settlementRecorded', n.chatId, () => settlementText(n, 'recorded')),
    settlementUndone: (n) => post('settlementUndone', n.chatId, () => settlementText(n, 'undone')),
    settlementRestored: (n) => post('settlementRestored', n.chatId, () => settlementText(n, 'restored')),
    tripRateChanged: (n) => post('tripRateChanged', n.chatId, () => tripRateText(n)),
    tripEnded: (n) => post('tripEnded', n.chatId, () => `${n.actorName} ended the trip. Balances can still be settled.`),
    tripReopened: (n) => post('tripReopened', n.chatId, () => `${n.actorName} reopened the trip.`),
    memberJoinedByLink: (n) => post('memberJoinedByLink', n.chatId, () => `${n.memberName} joined the trip through the link.`),
    async linkReset(n) {
      await post('linkReset', n.chatId, () => `${n.actorName} reset the group's link. Old links no longer work.`);
      await safely('linkReset', n.chatId, async () => {
        // Read after the reset, so the buttons carry the new link version.
        const group = getGroup(db, systemScope(n.groupId));
        const previousIntro = group.introMessageId;
        const posted = await postIntro(api, config, db, group, logger);
        if (posted && previousIntro !== null) {
          // The old intro's buttons no longer work, so it should not stay pinned.
          await api.unpinChatMessage(group.chatId, previousIntro);
        }
      });
    },
  };
}
