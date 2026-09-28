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
import { getGroup, systemScope, type Db } from '../db/index.js';
import { postIntro } from './intro.js';
import { describeError, type BotLogger } from './support.js';

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
      logger.error(`Could not post the notice ${name}`, { chatId, error: describeError(error) });
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

  return {
    expenseSaved: (n) => post('expenseSaved', n.chatId, () => expenseSavedText(n), () => viewButton(n)),
    expenseEdited: (n) => post('expenseEdited', n.chatId, () => expenseEditedText(n), () => viewButton(n)),
    expenseDeleted: (n) => post('expenseDeleted', n.chatId, () => expenseRemovedText(n, 'deleted')),
    expenseRestored: (n) => post('expenseRestored', n.chatId, () => expenseRemovedText(n, 'restored')),
    settlementRecorded: (n) => post('settlementRecorded', n.chatId, () => settlementText(n, 'recorded')),
    settlementUndone: (n) => post('settlementUndone', n.chatId, () => settlementText(n, 'undone')),
    settlementRestored: (n) => post('settlementRestored', n.chatId, () => settlementText(n, 'restored')),
    tripRateChanged: (n) => post('tripRateChanged', n.chatId, () => tripRateText(n)),
    tripEnded: (n) => post('tripEnded', n.chatId, () => `🏁 ${n.actorName} ended ${n.tripName}\nBalances can still be settled.`),
    tripReopened: (n) => post('tripReopened', n.chatId, () => `🔓 ${n.actorName} reopened ${n.tripName}`),
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
