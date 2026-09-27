import { Link } from 'react-router-dom';
import type { ExpenseView } from '../api/types';
import { dayText, expenseTitle, money, nameOf } from '../format';
import { useApp } from '../state';

/** One expense in a list. Shows the amount in its own currency, and in home currency when that differs. */
export function ExpenseRow(props: { expense: ExpenseView }) {
  const { group } = useApp();
  const { expense } = props;
  const foreign = expense.currency !== expense.homeCurrency;
  const mine = expense.homeAmounts?.[group.me.id];
  return (
    <Link className="row" to={`/expenses/${expense.id}`}>
      <span className="row-main">
        <span className="row-title">{expenseTitle(expense)}</span>
        <span className="hint small">
          {dayText(expense.expenseDate)} · {nameOf(group.members, expense.payerId)} paid
          {mine !== undefined && mine > 0 ? ` · your share ${money(mine, expense.homeCurrency)}` : ''}
        </span>
      </span>
      <span className="row-side">
        <span className="row-amount">{money(expense.total, expense.currency)}</span>
        {foreign && expense.homeTotal !== null ? <span className="hint small">{money(expense.homeTotal, expense.homeCurrency)}</span> : null}
        {foreign && expense.homeTotal === null ? <span className="hint small">no rate yet</span> : null}
      </span>
    </Link>
  );
}
