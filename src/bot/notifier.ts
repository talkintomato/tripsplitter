import { createPersonalDelivery, noticeFailure } from './personal-notices.js';
import { displayAmount as formatAmount, displayDate, escapeHtml } from '../tools/summary.js';
import { InlineKeyboard, type Api } from 'grammy';
import type { Config } from '../config.js';
import {
  launchUrl,
  type ExpenseNotice,
  type Notifier,
  type RateNotice,
  type SettlementNotice,
  type SplitType,
} from '../core/index.js';
import { getGroup, findGroupByChatId, isGroupNoticeEnabled, systemScope, type Db, type GroupNoticeType } from '../db/index.js';
import { postIntro } from './intro.js';
import type { BotLogger } from './support.js';

const SPLIT_LABEL: Record<SplitType, string> = {
  even: 'split evenly',
  portions: 'split by portions',
  items: 'split by item',
};

const singleLine = (value:string) => value.replace(/[\r\n]+/g,' ');
const shortNotice = (head:string,lines:string[]):string => [head,...(lines.length>5?[...lines.slice(0,4),`and ${lines.length-4} more changes`]:lines)].map(singleLine).join('\n');
export function expenseSavedText(n: ExpenseNotice): string {
  return shortNotice(`➕ ${n.actorName} added ${n.description}`, [
    `Total: ${formatAmount(n.total,n.currency)}`,
    n.splitType==='even'?`Split equally between ${n.shares.length}`:SPLIT_LABEL[n.splitType].replace(/^s/,'S'),
    ...n.shares.map(s=>`• ${s.name}: ${formatAmount(s.amount,n.currency)}`),
  ]);
}
/** The Mini App's existing notice contract contains short plain phrases. */
function readableChange(change:string):string {
  if(change.includes(' → '))return change;
  const match=/^(total|name|place|date|paid by|payer|split|tax|tip|service charge|discount) (.+) to (.+)$/.exec(change);
  if(!match)return change==='who is included'?'People changed':change==='items'?'Items changed':change==='exchange rate'?'Exchange rate changed':change;
  const labels:Record<string,string>={name:'Description',place:'Merchant',payer:'Paid by','paid by':'Paid by'};
  const value=(v:string)=>match[1]==='date'?displayDate(v,new Date()):v.replace(/^"|"$/g,'').replace(/\B(?=(\d{3})+(?!\d))/g,',');
  return `${labels[match[1]!]??match[1]![0]!.toUpperCase()+match[1]!.slice(1)}: ${value(match[2]!)} → ${value(match[3]!)}`;
}
export function expenseEditedText(n: ExpenseNotice & { changes: string[] }): string {
  return shortNotice(`✏️ ${n.actorName} changed ${n.description}`,n.changes.map(readableChange));
}
export function expenseRemovedText(n: ExpenseNotice, verb: 'deleted' | 'restored'): string {
  return `${verb==='deleted'?'🗑️':'♻️'} ${n.actorName} ${verb} ${n.description} · ${formatAmount(n.total,n.currency)}`;
}
export function settlementText(n: SettlementNotice, kind: 'recorded' | 'undone' | 'restored'): string {
  const payment=`${n.fromName} → ${n.toName} · ${formatAmount(n.amount,n.currency)}`;
  return `${kind==='recorded'?'💸':kind==='undone'?'↩️':'♻️'} ${n.actorName} ${kind==='recorded'?'recorded':kind==='undone'?'undid':'restored'} payment\n${payment}`;
}
export function tripRateText(n: RateNotice): string {
  return `💱 ${n.actorName} changed the exchange rate\nRate: 1 ${n.homeCurrency} = ${n.rate} ${n.currency} · ${n.origin==='suggested'?'looked up today':'trip rate'}\n${n.expensesChanged} ${n.expensesChanged===1?'expense':'expenses'} updated`;
}

/** Bound even unusually long item-change notices after HTML escaping. */
function noticeLine(text:string):string {
  let result='';
  for(const char of singleLine(text)) {
    const escaped=escapeHtml(char);
    if(result.length+escaped.length>600)return `${result}…`;
    result+=escaped;
  }
  return result;
}

export function createNotifier(api: Api, config: Config, db: Db, logger: BotLogger): Notifier {
  /** Runs one notice. Whatever goes wrong is logged, so that a notice never throws. */
  async function safely(name: string, chatId: number, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      logger.error(`Could not post the notice ${name}`, { chatId, ...noticeFailure(error) });
    }
  }

  function post(name: string, chatId: number, text: () => string, keyboard?: () => InlineKeyboard): Promise<void> {
    return safely(name, chatId, async () => {
      const markup = keyboard?.();
      const plain = text();
      const [title,...lines] = plain.split('\n');
      const html = /^[➕✏🗑♻💸↩💱🏁🔓]/u.test(plain)
        ? [`<b>${noticeLine(title!)}</b>`,...lines.map(noticeLine)].join('\n')
        : escapeHtml(plain);
      await api.sendMessage(chatId, html, {
        parse_mode: 'HTML',
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

  const personal = createPersonalDelivery(api, config, db, logger);
  async function groupPost(type: GroupNoticeType, name: string, n: { chatId: number; groupId?: number }, text: () => string, keyboard?: () => InlineKeyboard): Promise<void> {
    await safely(name, n.chatId, async () => {
      const groupId = n.groupId ?? findGroupByChatId(db, n.chatId)?.id;
      if (groupId === undefined || !isGroupNoticeEnabled(db, groupId, type)) return;
      await post(name, n.chatId, text, keyboard);
    });
  }
  async function expensePersonal(n: ExpenseNotice, verb: 'added' | 'changed' | 'deleted' | 'restored'): Promise<void> {
    const p = n.personal;
    if (!p) return;
    const ids = verb === 'added' ? p.memberIds : [...p.memberIds, p.payerId, ...(n.beforePersonal?.memberIds ?? []), ...(n.beforePersonal ? [n.beforePersonal.payerId] : [])];
    const stake = (amount: number, currency: string, now: boolean) => amount > 0
      ? `you are ${now ? 'now ' : ''}owed ${formatAmount(amount, currency)}`
      : `you ${now ? 'now ' : ''}owe ${formatAmount(Math.abs(amount), currency)}`;
    await personal(verb === 'added' ? 'added_me' : 'changed_mine', n.groupId, p.actorMemberId, ids, id => {
      let suffix = '';
      if (verb === 'added' || verb === 'changed') {
        suffix = ` · ${stake(p.balances[id] ?? 0, p.homeCurrency, verb === 'changed')}`;
        if (verb === 'changed' && n.beforePersonal) suffix += ` (was: ${stake(n.beforePersonal.balances[id] ?? 0, n.beforePersonal.homeCurrency, false)})`;
      }
      const icon = { added: '➕', changed: '✏️', deleted: '🗑️', restored: '♻️' }[verb];
      return `${icon} ${n.actorName} ${verb} ${n.description} in ${p.tripName}${suffix}`;
    }, n.expenseId);
  }
  async function paymentPersonal(n: SettlementNotice, kind: 'recorded' | 'undid' | 'restored'): Promise<void> {
    if (!n.groupId || !n.actorMemberId || !n.fromMemberId || !n.toMemberId) return;
    await personal('payments_me', n.groupId, n.actorMemberId, [n.fromMemberId, n.toMemberId], id => {
      const payment = `${id === n.fromMemberId ? 'you' : n.fromName} paid ${id === n.toMemberId ? 'you' : n.toName} ${formatAmount(n.amount, n.currency)}`;
      return `💸 ${n.actorName} ${kind === 'recorded' ? 'recorded that' : `${kind} the payment where`} ${payment} in ${n.tripName}`;
    });
  }
  return {
    async expenseSaved(n) {
      await groupPost('expense_added', 'expenseSaved', n, () => expenseSavedText(n), () => viewButton(n));
      await expensePersonal(n, 'added');
    },
    async expenseEdited(n) {
      await groupPost('expense_changed', 'expenseEdited', n, () => expenseEditedText(n), () => viewButton(n));
      await expensePersonal(n, 'changed');
    },
    async expenseDeleted(n) {
      await groupPost('expense_removed', 'expenseDeleted', n, () => expenseRemovedText(n, 'deleted'));
      await expensePersonal(n, 'deleted');
    },
    async expenseRestored(n) {
      await groupPost('expense_removed', 'expenseRestored', n, () => expenseRemovedText(n, 'restored'));
      await expensePersonal(n, 'restored');
    },
    async settlementRecorded(n) {
      await groupPost('payment', 'settlementRecorded', n, () => settlementText(n, 'recorded'));
      await paymentPersonal(n, 'recorded');
    },
    async settlementUndone(n) {
      await groupPost('payment', 'settlementUndone', n, () => settlementText(n, 'undone'));
      await paymentPersonal(n, 'undid');
    },
    async settlementRestored(n) {
      await groupPost('payment', 'settlementRestored', n, () => settlementText(n, 'restored'));
      await paymentPersonal(n, 'restored');
    },
    async tripRateChanged(n) {
      await groupPost('exchange_rate', 'tripRateChanged', n, () => tripRateText(n));
      if (n.groupId && n.actorMemberId) await personal('exchange_rate', n.groupId, n.actorMemberId, n.affectedMemberIds ?? [],
        () => `💱 ${n.actorName} changed the ${n.currency} rate in ${n.tripName} and your balance changed`);
    },
    tripEnded: (n) => groupPost('trip', 'tripEnded', n, () => `🏁 ${n.actorName} ended ${n.tripName}\nBalances can still be settled.`),
    tripReopened: (n) => groupPost('trip', 'tripReopened', n, () => `🔓 ${n.actorName} reopened ${n.tripName}`),
    memberJoinedByLink: (n) => groupPost('member_joined', 'memberJoinedByLink', n, () => `${n.memberName} joined the trip through the link.`),
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
