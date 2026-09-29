import { useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import type { ExpenseView } from '../api/types';
import { ActionError, Avatar, Badge, Banner, Confirm, Empty, ErrorState, IconButton, Loading, Screen, Section } from '../components/ui';
import { ExpenseTile, titleWithoutEmoji } from '../components/ExpenseRow';
import { ChevronRight, Pencil, Receipt, Trash } from '../components/icons';
import { History } from '../components/History';
import { ExpenseForm } from '../expense-form/ExpenseForm';
import { dayText, expenseTitle, localDay, longDayText, money, nameOf, rateText } from '../format';
import { useApp } from '../state';
import { useLoad } from '../useLoad';

const STATUS_TEXT = { draft: 'Draft', confirmed: '', discarded: 'Discarded draft', deleted: 'Deleted' } as const;
const SPLIT_TEXT = { even: 'Split equally', portions: 'Split by portions', items: 'Split by item' } as const;

function useExpense(id: number) {
  const { client } = useApp();
  return useLoad(async () => {
    const { expense } = await client.getExpense(id);
    const { trip } = await client.getTrip(expense.tripId);
    return { expense, trip };
  }, `expense-${id}`);
}

export function AddExpense() {
  const { client, group, refresh } = useApp();
  const navigate = useNavigate();
  const raw = useParams().tripId ?? 'active';
  const tripId = raw === 'active' ? ('active' as const) : Number(raw);
  const trip = useLoad(async () => (tripId === 'active' ? null : (await client.getTrip(tripId)).trip), `add-${raw}`);

  if (trip.error !== undefined) {
    return (
      <Screen title="Add expense">
        <ErrorState error={trip.error} onRetry={() => void trip.reload()} />
      </Screen>
    );
  }
  if (trip.data === undefined) {
    return (
      <Screen title="Add expense">
        <Loading shape="detail" />
      </Screen>
    );
  }
  if (trip.data !== null && trip.data.status === 'ended') {
    return (
      <Screen title="Add expense">
        <Empty>This trip has ended, so nothing can be added to it.</Empty>
      </Screen>
    );
  }
  return (
    <Screen title="Add expense" subtitle={trip.data?.name ?? 'This starts a new trip.'} swipeBack={false}>
      <ExpenseForm
        client={client}
        members={group.members}
        meId={group.me.id}
        tripId={tripId}
        homeCurrency={trip.data?.homeCurrency ?? group.newTripCurrency}
        onSaved={(result) => {
          void refresh().catch(() => undefined);
          navigate(`/expenses/${result.expense.id}`, { replace: true });
        }}
        onCancel={() => navigate(-1)}
      />
    </Screen>
  );
}

export function EditExpense() {
  const { client, group, refresh } = useApp();
  const navigate = useNavigate();
  const id = Number(useParams().id);
  const openRate = (useLocation().state as { openRate?: boolean } | null)?.openRate === true;
  const loaded = useExpense(id);
  const [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  if (loaded.error !== undefined) {
    return (
      <Screen title="Edit expense">
        <ErrorState error={loaded.error} onRetry={() => void loaded.reload()} />
      </Screen>
    );
  }
  if (loaded.data === undefined) {
    return (
      <Screen title="Edit expense">
        <Loading shape="detail" />
      </Screen>
    );
  }
  const { expense, trip } = loaded.data;
  const editable = trip.status === 'active' && (expense.status === 'draft' || expense.status === 'confirmed');
  // A draft opens straight here, so this is also where it can be thrown away.
  const discardButton = editable && expense.status === 'draft'
    ? <IconButton label="Discard" icon={Trash} tone="danger" disabled={busy} onClick={() => setDiscarding(true)} />
    : undefined;
  async function discard(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await client.discardExpense(expense.id, expense.version);
      await refresh();
      navigate(-1);
    } catch (problem) {
      setError(problem);
      await loaded.reload();
    } finally {
      setBusy(false);
      setDiscarding(false);
    }
  }
  return (
    <Screen title={expense.status === 'draft' ? 'Approve draft' : 'Edit expense'} subtitle={trip.name} actions={discardButton} swipeBack={!editable}>
      <ActionError error={error} onClose={() => setError(undefined)} />
      {discarding ? (
        <Confirm title="Discard this draft?" confirmLabel="Discard" danger busy={busy} onCancel={() => setDiscarding(false)} onConfirm={() => void discard()}>
          <p>It won't count toward balances. You can restore it from Activity.</p>
        </Confirm>
      ) : null}
      {editable ? (
        <ExpenseForm
          key={expense.id}
          client={client}
          members={group.members}
          meId={group.me.id}
          tripId={trip.id}
          homeCurrency={trip.homeCurrency}
          expense={expense}
          openRateSheet={openRate}
          // Back to the expense this was opened from, which loads the saved version.
          onSaved={() => navigate(-1)}
          onCancel={() => navigate(-1)}
        />
      ) : (
        <Empty>{trip.status === 'ended' ? 'This trip has ended, so its expenses cannot be changed.' : 'This expense was removed. Restore it first to change it.'}</Empty>
      )}
    </Screen>
  );
}

/** The rate of a foreign expense: the rate, where it comes from, and the converted amount. */
function RateRowText(props: { expense: ExpenseView }) {
  const { expense } = props;
  const rate = rateText(expense);
  return (
    <span className="row-main">
      <span className={`rate-main ${rate ? '' : 'warn-text'}`}>{rate ?? 'Exchange rate needed'}</span>
      <span className="rate-sub">
        {rate ? <span>{expense.fxRateSource === 'expense' ? "This expense's own rate" : 'Trip rate'}</span> : `No rate for ${expense.currency} yet.`}
      </span>
    </span>
  );
}

export function ExpenseDetail() {
  const { client, group } = useApp();
  const navigate = useNavigate();
  const id = Number(useParams().id);
  const loaded = useExpense(id);
  const [asking, setAsking] = useState<'delete' | 'discard' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  if (loaded.error !== undefined && loaded.data === undefined) {
    return (
      <Screen title="Expense">
        <ErrorState error={loaded.error} onRetry={() => void loaded.reload()} />
      </Screen>
    );
  }
  if (loaded.data === undefined) {
    return (
      <Screen title="Expense">
        <Loading shape="detail" />
      </Screen>
    );
  }
  const { expense, trip } = loaded.data;
  // A draft has nothing to review before it is finished, so it always opens straight in the form.
  // (Compared as a string so the draft branches below stay typed; they remain as a fallback.)
  if ((expense.status as string) === 'draft') return <Navigate to={`/expenses/${expense.id}/edit`} replace />;
  const open = trip.status === 'active';
  const foreign = expense.currency !== expense.homeCurrency;
  const included = expense.shares.filter((s) => s.itemId === null);
  const title = expenseTitle(expense);
  const name = (memberId: number): string => (memberId === group.me.id ? 'You' : nameOf(group.members, memberId));
  const needsRate = expense.problems.some((p) => p.code === 'rate_missing');
  const editable = open && (expense.status === 'confirmed' || expense.status === 'draft');

  async function change(run: (version: number) => Promise<{ expense: ExpenseView }>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const result = await run(expense.version);
      loaded.set({ expense: result.expense, trip });
    } catch (problem) {
      setError(problem);
      if (problem instanceof ApiError && problem.stale && problem.current) loaded.set({ expense: problem.current as ExpenseView, trip });
    } finally {
      setBusy(false);
      setAsking(null);
    }
  }

  const actions = open ? (
    expense.status === 'confirmed' ? (
      <>
        <IconButton label="Edit" icon={Pencil} disabled={busy} onClick={() => navigate(`/expenses/${expense.id}/edit`)} />
        <IconButton label="Delete" icon={Trash} tone="danger" disabled={busy} onClick={() => setAsking('delete')} />
      </>
    ) : expense.status === 'draft' ? (
      <IconButton label="Discard" icon={Trash} tone="danger" disabled={busy} onClick={() => setAsking('discard')} />
    ) : null
  ) : null;

  const figures = (
    [
      ['Tax', expense.tax, expense.taxIncluded ? ' (already in the prices)' : ''],
      ['Tip', expense.tip, ''],
      ['Service charge', expense.serviceCharge, ''],
      ['Discount', expense.discount, ''],
    ] as const
  ).filter(([, amount]) => amount > 0);

  return (
    <Screen title="Expense" subtitle={trip.name} actions={actions}>
      <ActionError error={error} onClose={() => setError(undefined)} />
      {STATUS_TEXT[expense.status] ? <Banner kind={expense.status === 'draft' ? 'info' : 'warn'}>{STATUS_TEXT[expense.status]}. It does not count toward balances.</Banner> : null}
      {expense.notice ? <Banner kind="warn">{expense.notice}</Banner> : null}

      <div className="detail-head">
        {expense.status !== 'confirmed' || needsRate ? (
          <div className="badges">
            {expense.status === 'draft' ? <Badge tone="draft">Draft</Badge> : null}
            {expense.status === 'deleted' ? <Badge tone="neg">Deleted</Badge> : null}
            {expense.status === 'discarded' ? <Badge tone="neutral">Discarded</Badge> : null}
            {needsRate ? <Badge tone="warn">Needs rate</Badge> : null}
            
          </div>
        ) : null}
        {expense.status === 'draft' ? (
          <p className="origin-line">{expense.receiptFileId ? 'Read from a receipt' : 'Waiting for approval'} · added by {expense.createdBy === group.me.id ? 'you' : nameOf(group.members, expense.createdBy)}</p>
        ) : null}
        <div className="detail-title">
          <ExpenseTile title={title} emoji={expense.emoji} />
          <h2>{titleWithoutEmoji(title)}</h2>
        </div>
        <p className={`detail-amount ${money(expense.total, expense.currency).length > 13 ? 'is-long' : ''}`}>{money(expense.total, expense.currency)}</p>
        {foreign && expense.homeTotal !== null ? <p className="detail-converted">= {money(expense.homeTotal, expense.homeCurrency)}</p> : null}
        <p className="detail-meta">
          Added by {expense.createdBy === group.me.id ? 'you' : nameOf(group.members, expense.createdBy)} on {dayText(localDay(expense.createdAt))}
        </p>
      </div>

      {foreign ? (
        editable ? (
          <button type="button" className="card rate-row rate-row-card" aria-label={`${expense.fxRate ? 'Change' : 'Set'} exchange rate`} onClick={() => navigate(`/expenses/${expense.id}/edit`, { state: { openRate: true } })}>
            <RateRowText expense={expense} />
            <span className="rate-action" aria-hidden="true">{expense.fxRate ? 'Change' : 'Set'}<ChevronRight size={14} /></span>
          </button>
        ) : (
          <div className="card rate-row rate-row-card rate-row-static">
            <RateRowText expense={expense} />
          </div>
        )
      ) : null}

      <section className="card tree" aria-label="Who paid and who owes">
        <p className="tree-root">
          <Avatar name={nameOf(group.members, expense.payerId)} id={expense.payerId} />
          <span>
            <strong>{name(expense.payerId)}</strong> paid {money(expense.total, expense.currency)}
          </span>
        </p>
        <p className="tree-caption">
          {SPLIT_TEXT[expense.splitType]}
          {included.length > 0 ? ` between ${included.length} ${included.length === 1 ? 'person' : 'people'}` : ''}
        </p>
        {included.length === 0 ? (
          <p className="field-hint">Nobody is included yet.</p>
        ) : (
          <ul className="tree-branches">
            {included.map((share) => {
              const amount = expense.amounts?.[share.memberId];
              const home = expense.homeAmounts?.[share.memberId];
              const payer = share.memberId === expense.payerId;
              const portions = expense.splitType === 'portions' ? `${share.weight} ${share.weight === 1 ? 'portion' : 'portions'}` : null;
              return (
                <li key={share.memberId}>
                  <Avatar name={nameOf(group.members, share.memberId)} id={share.memberId} size="sm" />
                  <span className="row-main">
                    <span className="row-title">{name(share.memberId)}</span>
                    <span className="row-sub">{[portions, payer ? 'own share' : share.memberId === group.me.id ? 'owe' : 'owes'].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="tree-amount">
                    <span>{amount !== undefined ? money(amount, expense.currency) : '—'}</span>
                    {foreign && home !== undefined ? <span className="row-sub">{money(home, expense.homeCurrency)}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {expense.amounts === null && expense.problems.length > 0 ? <p className="problem">{expense.problems.find((p) => p.field !== 'fxRate' && p.field !== 'currency')?.message}</p> : null}
      </section>

      {expense.items.length > 0 ? (
        <Section title="Items on the receipt">
          <ul className="list-card">
            {expense.items.map((item) => (
              <li key={item.id} className="item">
                <span className="row-main">
                  <span className="row-title wrap">
                    {item.label}
                    {item.quantity !== 1 ? ` ×${item.quantity}` : ''}
                  </span>
                  <span className="row-sub wrap">{(() => {
                    const assigned = expense.shares.filter((share) => share.itemId === item.id);
                    return (assigned.length > 0 ? assigned : included).map((share) => `${nameOf(group.members, share.memberId)}${assigned.length > 0 && share.weight > 1 ? ` ×${share.weight}` : ''}`).join(', ') || 'Nobody yet';
                  })()}</span>
                </span>
                <span className="row-amount">{money(item.amount, expense.currency)}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <dl className="card facts">
        <div>
          <dt>Date</dt>
          <dd>{longDayText(expense.expenseDate)}</dd>
        </div>
        {expense.merchant ? (
          <div>
            <dt>Place</dt>
            <dd>{expense.merchant}</dd>
          </div>
        ) : null}
        {figures.map(([label, amount, note]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {money(amount, expense.currency)}
              {note}
            </dd>
          </div>
        ))}
      </dl>

      <History type="expense" id={expense.id} version={expense.version} />

      {open ? (
        expense.status === 'draft' ? (
          <div className="action-bar">
            <button type="button" className="btn btn-primary btn-block btn-lg" disabled={busy} onClick={() => navigate(`/expenses/${expense.id}/edit`)}>
              Review and approve
            </button>
          </div>
        ) : expense.status === 'deleted' || expense.status === 'discarded' ? (
          <div className="action-bar">
            <button type="button" className="btn btn-primary btn-block btn-lg" disabled={busy} onClick={() => void change((version) => client.restoreExpense(expense.id, version))}>
              {busy ? 'Restoring…' : 'Restore'}
            </button>
          </div>
        ) : null
      ) : (
        <p className="hint small center">This trip has ended, so its expenses cannot be changed.</p>
      )}

      {asking === 'delete' ? (
        <Confirm title="Delete this expense?" confirmLabel="Delete" danger busy={busy} onCancel={() => setAsking(null)} onConfirm={() => void change((version) => client.deleteExpense(expense.id, version))}>
          <p>It stops counting toward balances. Anyone can restore it from Activity.</p>
        </Confirm>
      ) : null}
      {asking === 'discard' ? (
        <Confirm title="Discard this draft?" confirmLabel="Discard" danger busy={busy} onCancel={() => setAsking(null)} onConfirm={() => void change((version) => client.discardExpense(expense.id, version))}>
          <p>Anyone can restore it from Activity.</p>
        </Confirm>
      ) : null}
    </Screen>
  );
}

export function Drafts() {
  const { client, group } = useApp();
  const navigate = useNavigate();
  const tripId = Number(useParams().tripId);
  const loaded = useLoad(() => client.listExpenses(tripId, ['draft']), `drafts-${tripId}`);
  // The bot's name, for the empty list. Only asked for then, and "the bot" when it cannot be had.
  const empty = loaded.data?.expenses.length === 0;
  const bot = useLoad(async () => (empty ? (await client.getMyGroups()).botUsername : null), `bot-${empty ? 'ask' : 'no'}`);
  const [asking, setAsking] = useState<ExpenseView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  async function discard(expense: ExpenseView): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await client.discardExpense(expense.id, expense.version);
    } catch (problem) {
      setError(problem);
    } finally {
      await loaded.reload();
      setBusy(false);
      setAsking(null);
    }
  }

  return (
    <Screen title="Drafts" subtitle="Drafts do not count until they are approved.">
      <ActionError error={error} onClose={() => setError(undefined)} />
      {loaded.error !== undefined && loaded.data === undefined ? (
        <ErrorState error={loaded.error} onRetry={() => void loaded.reload()} />
      ) : loaded.data === undefined ? (
        <Loading what="drafts" />
      ) : loaded.data.expenses.length === 0 ? (
        <Empty icon={Receipt}>No drafts. Tag a receipt photo with {bot.data ? `@${bot.data}` : 'the bot'} in the group and it will appear here to approve.</Empty>
      ) : (
        <ul className="cards">
          {loaded.data.expenses.map((expense) => {
            const needsRate = expense.problems.some((p) => p.code === 'rate_missing');
            return (
              <li key={expense.id} className="card draft-card">
                <button type="button" className="item" onClick={() => navigate(`/expenses/${expense.id}`)}>
                  <ExpenseTile title={expenseTitle(expense)} emoji={expense.emoji} />
                  <span className="row-main">
                    <span className="row-title">{titleWithoutEmoji(expenseTitle(expense))}</span>
                    <span className="row-sub"><Badge tone="draft">Draft</Badge> {longDayText(expense.expenseDate)}</span>
                  </span>
                  <span className="row-end">
                    <span className="row-amount">{money(expense.total, expense.currency)}</span>
                    {expense.currency !== expense.homeCurrency ? (
                      <span className="row-sub">{expense.homeTotal !== null ? money(expense.homeTotal, expense.homeCurrency) : 'no rate yet'}</span>
                    ) : null}
                  </span>
                </button>
                <p className="draft-origin">
                  {expense.receiptFileId ? 'Read from a receipt' : 'Waiting for approval'} · added by {expense.createdBy === group.me.id ? 'you' : nameOf(group.members, expense.createdBy)}
                </p>
                {needsRate || expense.notice ? (
                  <div className="draft-notes">
                    <span className="badges">
                      {needsRate ? <Badge tone="warn">Needs rate</Badge> : null}
                      
                    </span>
                    {expense.notice ? <p className="field-hint">{expense.notice}</p> : null}
                  </div>
                ) : null}
                <div className="draft-actions">
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => navigate(`/expenses/${expense.id}/edit`)}>
                    Review and approve
                  </button>
                  <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => setAsking(expense)}>
                    Discard
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {asking ? (
        <Confirm title={`Discard ${expenseTitle(asking)}?`} confirmLabel="Discard" danger busy={busy} onCancel={() => setAsking(null)} onConfirm={() => void discard(asking)}>
          <p>Anyone can restore it from Activity.</p>
        </Confirm>
      ) : null}
    </Screen>
  );
}
