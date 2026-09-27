import type { ActivityEntry, ExpenseView, Member, Settlement, Trip } from './api/types';
import { expenseTitle, money, nameOf } from './format';

type Loose = Record<string, unknown> | null;

const record = (value: unknown): Loose => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null);

function expenseText(value: unknown): string {
  const expense = record(value) as unknown as ExpenseView | null;
  if (!expense) return 'an expense';
  return `${expenseTitle(expense)} (${money(expense.total, expense.currency)})`;
}

function settlementText(value: unknown, members: ReadonlyArray<Member>, trips: ReadonlyArray<Trip>): string {
  const settlement = record(value) as unknown as Settlement | null;
  if (!settlement) return 'a payment';
  const currency = trips.find((t) => t.id === settlement.tripId)?.homeCurrency;
  const amount = currency ? money(settlement.amount, currency) : '';
  return `${nameOf(members, settlement.fromMemberId)} paid ${nameOf(members, settlement.toMemberId)} ${amount}`.trim();
}

const text = (value: Loose, key: string): string => (value && typeof value[key] === 'string' ? (value[key] as string) : '');

const isReceiptDraft = (after: Loose): boolean => text(after, 'status') === 'draft' && typeof after?.receiptFileId === 'string' && after.receiptFileId !== '';

/**
 * What happened to one expense or payment, in a few words, for the history on its own detail, where its name
 * would only repeat the title. The Activity screen says the same with the name: see `activityText`.
 */
export function historyText(entry: ActivityEntry): string {
  const after = record(entry.after);
  switch (entry.action) {
    case 'expense.create':
      return isReceiptDraft(after) ? 'Read from a receipt' : text(after, 'status') === 'draft' ? 'Started as a draft' : 'Added';
    case 'expense.save':
      return 'Edited';
    case 'expense.confirm':
      return 'Approved';
    case 'expense.discard':
      return 'Discarded';
    case 'expense.delete':
      return 'Deleted';
    case 'expense.restore':
      return 'Restored';
    case 'expense.rate_change':
      return 'Exchange rate changed with the trip rate';
    case 'expense.member_merged':
      return 'Updated after two people were joined into one';
    case 'settlement.create':
      return 'Recorded';
    case 'settlement.undo':
      return 'Undone';
    case 'settlement.restore':
      return 'Restored';
    case 'settlement.member_merged':
      return 'Updated after two people were joined into one';
    default:
      return String(entry.action);
  }
}

/** One line for an activity entry, without the name of who did it. */
export function activityText(entry: ActivityEntry, members: ReadonlyArray<Member>, trips: ReadonlyArray<Trip>): string {
  const before = record(entry.before);
  const after = record(entry.after);
  const latest = after ?? before;
  switch (entry.action) {
    case 'expense.create':
      return isReceiptDraft(after) ? `read a receipt: ${expenseText(after)}` : text(after, 'status') === 'draft' ? `started a draft: ${expenseText(after)}` : `added ${expenseText(after)}`;
    case 'expense.save':
      return `edited ${expenseText(after)}`;
    case 'expense.confirm':
      return `approved the draft ${expenseText(after)}`;
    case 'expense.discard':
      return `discarded the draft ${expenseText(after)}`;
    case 'expense.delete':
      return `deleted ${expenseText(after)}`;
    case 'expense.restore':
      return `restored ${expenseText(after)}`;
    case 'expense.rate_change':
      return `changed the exchange rate of ${expenseText(after)}`;
    case 'expense.member_merged':
      return `updated ${expenseText(after)} after two people were joined into one`;
    case 'settlement.create':
      return `recorded a payment: ${settlementText(after, members, trips)}`;
    case 'settlement.undo':
      return `undid a payment: ${settlementText(after, members, trips)}`;
    case 'settlement.restore':
      return `restored a payment: ${settlementText(after, members, trips)}`;
    case 'settlement.member_merged':
      return `updated a payment after two people were joined into one`;
    case 'trip.create':
      return `started the trip ${text(after, 'name')}`;
    case 'trip.rename':
      return `renamed the trip from ${text(before, 'name')} to ${text(after, 'name')}`;
    case 'trip.home_currency':
      return `changed the home currency from ${text(before, 'homeCurrency')} to ${text(after, 'homeCurrency')}`;
    case 'trip.setup_done':
      return 'finished setting up the trip';
    case 'trip.end':
      return `ended the trip ${text(after, 'name')}`;
    case 'trip.reopen':
      return `reopened the trip ${text(after, 'name')}`;
    case 'trip_rate.set':
    case 'trip_rate.change': {
      const home = trips.find((t) => t.id === entry.tripId)?.homeCurrency ?? '';
      return `set the rate: 1 ${home} = ${text(after, 'rate')} ${text(after, 'currency')}`;
    }
    case 'trip_rate.remove':
      return `removed the rate for ${text(before, 'currency')}`;
    case 'trip_rate.member_merged':
      return 'updated a rate after two people were joined into one';
    case 'member.add': {
      const via = text(after, 'joinedVia');
      const name = text(after, 'displayName');
      if (via === 'link') return `${name} joined through the link`;
      if (via === 'manual') return `added ${name}`;
      return `${name} joined from the chat`;
    }
    case 'member.update':
      return `${text(before, 'displayName')} is now shown as ${text(after, 'displayName')}`;
    case 'member.activate':
      return `${text(latest, 'displayName')} is back in the chat`;
    case 'member.deactivate':
      return `${text(latest, 'displayName')} left the chat`;
    case 'member.claim': {
      const absorbed = record(after?.absorbed ?? before?.absorbed);
      return `said "that's me" for ${text(absorbed, 'displayName')}`;
    }
    case 'group.create':
      return 'set up the group';
    case 'group.rename':
      return `the group is now called ${text(after, 'title')}`;
    case 'group.migrate':
      return 'the chat was upgraded by Telegram';
    case 'group.intro_message':
      return 'posted the pinned message';
    case 'group.link_reset':
      return "reset the group's link";
    default:
      return String(entry.action);
  }
}
