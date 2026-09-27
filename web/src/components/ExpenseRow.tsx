import { Link } from 'react-router-dom';
import type { ExpenseView, Settlement } from '../api/types';
import { groupByDay } from '../dayGroups';
import { expenseTitle, money, nameOf, splitEmoji, stakeText } from '../format';
import { useApp } from '../state';
import { Bed, Car, Coffee, Food, Glass, Plane, Receipt, Ticket, Train, Transfer, Cart, type IconComponent } from './icons';

// A tile for the row, from words in the title. Order matters: "Airport taxi" is a taxi.
const TILES: Array<[RegExp, IconComponent]> = [
  [/\b(taxi|uber|grab|lyft|car|fuel|petrol|gas|parking|toll|rental)\b/i, Car],
  [/\b(train|trains|metro|subway|bus|rail|ferry|shinkansen|pass|passes|jr)\b/i, Train],
  [/\b(flight|flights|airport|plane|airline)\b/i, Plane],
  [/\b(hotel|hostel|airbnb|villa|room|nights?|ryokan|accommodation|stay|resort)\b/i, Bed],
  [/\b(coffee|cafe|café|tea|latte|bakery)\b/i, Coffee],
  [/\b(bar|beer|beers|drinks?|wine|sake|cocktails?|pub|highball)\b/i, Glass],
  [/\b(dinner|lunch|breakfast|brunch|supper|restaurant|izakaya|ramen|sushi|food|meal|bbq|pizza|burger|noodles?|snacks?|yakiniku|market|dessert)\b/i, Food],
  [/\b(tickets?|museum|entry|tour|show|concert|temple|admission|park|zoo|onsen)\b/i, Ticket],
  [/\b(groceries|grocery|supermarket|konbini|shop|shopping|store|mart|souvenirs?)\b/i, Cart],
];

export function expenseIcon(title: string): IconComponent {
  return TILES.find(([pattern]) => pattern.test(title))?.[1] ?? Receipt;
}

/** The tile of an expense: the emoji its title starts with, or an icon picked from its words. */
export function ExpenseTile(props: { title: string; emoji?: string | null; className?: string }) {
  const fromTitle = splitEmoji(props.title);
  const emoji = props.emoji ?? fromTitle.emoji;
  const rest = fromTitle.rest;
  if (emoji) return <span className={`tile tile-emoji ${props.className ?? ''}`} aria-hidden="true">{emoji}</span>;
  const Icon = expenseIcon(rest);
  return <span className={`tile ${props.className ?? ''}`} aria-hidden="true"><Icon /></span>;
}

/** The title to show next to its tile: without the leading emoji, which the tile shows. */
export function titleWithoutEmoji(title: string): string {
  return splitEmoji(title).rest || title;
}

/** One expense in the trip's list: what, who paid, the total, and what it means for the person looking. */
export function ExpenseRow(props: { expense: ExpenseView }) {
  const { group } = useApp();
  const { expense } = props;
  const title = expenseTitle(expense);
  const payer = expense.payerId === group.me.id ? 'you' : nameOf(group.members, expense.payerId);
  const stake = stakeText(expense.myStake);
  const noRate = expense.currency !== expense.homeCurrency && expense.homeTotal === null;
  return (
    <Link className="card-row" to={`/expenses/${expense.id}`}>
      <ExpenseTile title={title} emoji={expense.emoji} />
      <span className="row-main">
        <span className="row-title">{titleWithoutEmoji(title)}</span>
        <span className="row-sub">Paid by {payer}</span>
      </span>
      <span className="row-end">
        <span className="row-amount">{money(expense.total, expense.currency)}</span>
        {stake ? <span className={`stake stake-${expense.myStake.kind}`}>{stake}</span> : noRate ? <span className="row-sub">no rate yet</span> : null}
      </span>
    </Link>
  );
}

/** A payment between two people, in the same list as the expenses. */
export function SettlementRow(props: { settlement: Settlement; currency: string; onOpen?: (settlement: Settlement) => void }) {
  const { group } = useApp();
  const { settlement } = props;
  const who = (id: number, start: boolean): string => (id === group.me.id ? (start ? 'You' : 'you') : nameOf(group.members, id));
  const Tag = props.onOpen ? 'button' : 'div';
  return (
    <Tag className={`card-row ${props.onOpen ? '' : 'card-row-static'}`} {...(props.onOpen ? { type: 'button' as const, onClick: () => props.onOpen!(settlement) } : {})}>
      <span className="tile tile-transfer" aria-hidden="true"><Transfer /></span>
      <span className="row-main">
        <span className="row-title">Payment</span>
        <span className="row-sub">{who(settlement.fromMemberId, true)} paid {who(settlement.toMemberId, false)}</span>
      </span>
      <span className="row-end">
        <span className="row-amount">{money(settlement.amount, props.currency)}</span>
      </span>
    </Tag>
  );
}

/** Expenses and payments under a heading for each day, newest first. */
export function ExpenseList(props: { expenses: ExpenseView[]; settlements: Settlement[]; currency: string; now?: Date; empty: string; onSettlement?: (settlement: Settlement) => void }) {
  const days = groupByDay(props.expenses, props.settlements, props.now);
  if (days.length === 0) return <p className="list-empty">{props.empty}</p>;
  return (
    <div className="days">
      {days.map((day) => (
        <section key={day.day} className="day" aria-label={day.label}>
          <h3 className="day-head">
            <span>{day.label}</span>
            {day.total !== null ? <span className="day-total">{money(day.total, props.currency)}</span> : null}
          </h3>
          <ul className="cards">
            {day.entries.map((entry) => (
              <li key={entry.kind === 'expense' ? `e${entry.expense.id}` : `s${entry.settlement.id}`}>
                {entry.kind === 'expense' ? <ExpenseRow expense={entry.expense} /> : <SettlementRow settlement={entry.settlement} currency={props.currency} {...(props.onSettlement ? { onOpen: props.onSettlement } : {})} />}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
