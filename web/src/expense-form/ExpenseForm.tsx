import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { CURRENCIES, currencyDecimals } from '../../../src/core/currencies';
import { isValidRate } from '../../../src/core/rates';
import { ApiError, messageOf, type ApiClient } from '../api/client';
import { ratesApi } from '../api/rates';
import type { ExpenseView, ExpenseWriteResponse, Member } from '../api/types';
import { Banner } from '../components/ui';
import { ChevronDown } from '../components/icons';
import { amountText, dayLabel, dayText, money, nameOf } from '../format';
import {
  formMembers,
  includedShares,
  newExpenseState,
  parseAmount,
  changeCurrency,
  stateFromExpense,
  toExpenseInput,
  type ExpenseFormState,
  type FormPatch,
} from './formState';
import { splitType, splitTypes } from './registry';
import { useServerPreview } from './useServerPreview';

export interface ExpenseFormProps {
  client: ApiClient;
  members: Member[];
  /** The caller, who is the payer of a new expense. */
  meId: number;
  /** For a new expense: the trip to add it to. "active" starts a trip when the group has none. */
  tripId: number | 'active';
  /** Home currency of the trip. */
  homeCurrency: string;
  /** The expense to edit or the draft to finish. Left out for a new expense. */
  expense?: ExpenseView;
  /** Called with the saved expense. */
  onSaved(result: ExpenseWriteResponse): void;
  onCancel?(): void;
}

const SPLIT_WORDS = { even: 'Equally', portions: 'By portions', items: 'By item' } as const;

function decimalsOf(currency: string): number {
  try {
    return currencyDecimals(currency);
  } catch {
    return 2;
  }
}

function peopleText(members: ReadonlyArray<Member>, shares: Array<{ memberId: number; weight?: number }>, portions: boolean): string {
  if (shares.length === 0) return 'Nobody';
  return shares.map((s) => `${nameOf(members, s.memberId)}${portions ? ` × ${s.weight ?? 1}` : ''}`).join(', ');
}

/** The lines where the latest saved version differs from what the member has typed. */
function differences(members: ReadonlyArray<Member>, mine: ExpenseFormState, latest: ExpenseView): Array<{ label: string; mine: string; latest: string }> {
  const theirs = stateFromExpense(latest);
  const rows: Array<{ label: string; mine: string; latest: string }> = [];
  const add = (label: string, a: string, b: string): void => {
    if (a !== b) rows.push({ label, mine: a || '(empty)', latest: b || '(empty)' });
  };
  add('Description', mine.description.trim(), theirs.description.trim());
  const mineTotal = parseAmount(mine.amountText, mine.currency);
  add('Amount', mineTotal === null ? mine.amountText : money(mineTotal, mine.currency), money(latest.total, latest.currency));
  add('Currency', mine.currency, theirs.currency);
  if (mine.rateOverride !== undefined) add('Rate for this expense', mine.rateOverride ?? 'Trip rate', latest.fxRateSource === 'expense' ? latest.fxRate ?? '' : 'Trip rate');
  add('Date', dayText(mine.expenseDate), dayText(theirs.expenseDate));
  add('Paid by', nameOf(members, mine.payerId), nameOf(members, theirs.payerId));
  add('Split', SPLIT_WORDS[mine.splitType], SPLIT_WORDS[theirs.splitType]);
  const sorted = (state: ExpenseFormState) => includedShares(state).sort((a, b) => a.memberId - b.memberId);
  add('People', peopleText(members, sorted(mine), mine.splitType === 'portions'), peopleText(members, sorted(theirs), theirs.splitType === 'portions'));
  if (mine.splitType === 'items' || theirs.splitType === 'items') {
    const figure = (state: ExpenseFormState, value: number): string => (value === 0 ? '' : money(value, state.currency));
    add('Tax', `${figure(mine, mine.tax)}${mine.tax > 0 && mine.taxIncluded ? ', in the prices' : ''}`, `${figure(theirs, theirs.tax)}${theirs.tax > 0 && theirs.taxIncluded ? ', in the prices' : ''}`);
    add('Tip', figure(mine, mine.tip), figure(theirs, theirs.tip));
    add('Service charge', figure(mine, mine.serviceCharge), figure(theirs, theirs.serviceCharge));
    add('Discount', figure(mine, mine.discount), figure(theirs, theirs.discount));
    const itemText = (state: ExpenseFormState, index: number): string => {
      const item = state.items[index];
      if (!item) return '';
      const who = (item.shares ?? []).filter((s) => state.included.includes(s.memberId)).sort((a, b) => a.memberId - b.memberId);
      return `${item.label}${(item.quantity ?? 1) !== 1 ? ` ×${item.quantity}` : ''}, ${money(item.amount, state.currency)}, ${who.length === 0 ? 'everyone' : peopleText(members, who, false)}`;
    };
    for (let i = 0; i < Math.max(mine.items.length, theirs.items.length); i++) add(`Item ${i + 1}`, itemText(mine, i), itemText(theirs, i));
  }
  return rows;
}

/** Create, edit, and finish a draft. The body under the switch comes from the split type registry. */
export function ExpenseForm(props: ExpenseFormProps) {
  const { client, members } = props;
  const [expense, setExpense] = useState(props.expense);
  const [tripRate, setTripRate] = useState('');
  const [roundingNote, setRoundingNote] = useState('');
  const [state, setState] = useState<ExpenseFormState>(() =>
    expense ? stateFromExpense(expense) : newExpenseState({ members, meId: props.meId, currency: props.homeCurrency }),
  );
  // The version the member is looking at. It moves on only when they choose to after a conflict.
  const [version, setVersion] = useState(expense?.version ?? 0);
  const [latest, setLatest] = useState<ExpenseView | null>(null);
  const [busy, setBusy] = useState<'save' | 'draft' | null>(null);
  const [error, setError] = useState<unknown>(undefined);
  const [touched, setTouched] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);
  // Opened from the start when the expense is not the plain case: a draft, a split by item, its own rate.
  const [moreOpen, setMoreOpen] = useState(() => expense?.status === 'draft' || expense?.splitType === 'items' || expense?.fxRateSource === 'expense');

  const update = (patch: FormPatch): void => setState((current) => ({ ...current, ...patch }));

  const isNew = expense === undefined;
  const isDraft = expense?.status === 'draft';
  const currency = state.currency;
  const foreign = currency !== props.homeCurrency;
  const total = parseAmount(state.amountText, currency);
  // A rate still being typed is not sent anywhere: the server would refuse it.
  const rateProblem = foreign && typeof state.rateOverride === 'string' && !isValidRate(state.rateOverride) ? 'Enter a rate above zero, with up to 6 decimal places.' : null;
  const people = useMemo(() => formMembers(members, state), [members, state]);
  const entry = splitType(state.splitType);
  const Body = entry.Body;
  // All shares and converted figures come from the server.
  const asksServer = Body !== null;
  const asked = useMemo(() => (asksServer && total !== null && rateProblem === null ? {
    ...toExpenseInput(state, total), currency,
    tripId: props.tripId,
    ...(expense ? { expenseId: expense.id } : {}),
  } : null), [asksServer, state, total, rateProblem, currency, props.tripId, expense]);
  const server = useServerPreview(client, asked);
  const fx = server.status === 'ready' ? server.result?.fx : undefined;
  const needsTripRate = foreign && expense?.currency === currency && expense.fxRateSource === 'missing' && state.rateOverride == null && (!fx || fx.fxRateSource === 'missing');
  const shown = { amounts: server.status === 'ready' ? server.result?.amounts ?? null : null, problems: server.status === 'ready' ? server.result?.problems ?? [] : [] };

  const amountProblem =
    total === null
      ? decimalsOf(currency) === 0
        ? `Enter a whole amount in ${currency}, such as 1200.`
        : 'Enter the amount with a dot, such as 84.50.'
      : total === 0
        ? 'Enter the amount.'
        : null;
  const peopleProblem = includedShares(state).length === 0 ? 'Choose at least one person.' : null;
  const typeProblem = Body === null ? 'Choose how to split: evenly or by portions.' : null;
  const currencyProblem = state.currencyNeedsReview && !state.currencyChecked ? `Check the currency first: is this in ${currency}?` : null;
  const unreadable = total === null ? amountProblem : null;
  // With the server's answer: Save is off while the answer is missing or reports a problem.
  const serverProblem = !asksServer
    ? null
    : rateProblem !== null
      ? rateProblem
      : server.status === 'failed'
      ? messageOf(server.error)
      : server.status !== 'ready'
        ? 'Working out what each person pays…'
        : (server.result?.problems[0]?.message ?? null);
  const blocked = entry.serverPreview === true && (unreadable !== null || serverProblem !== null);
  const firstProblem = asksServer
    ? (amountProblem ?? typeProblem ?? peopleProblem ?? currencyProblem ?? serverProblem)
    : (amountProblem ?? typeProblem ?? peopleProblem ?? currencyProblem ?? shown.problems[0]?.message ?? null);

  async function submit(kind: 'save' | 'draft', useVersion = version): Promise<void> {
    setTouched(true);
    setError(undefined);
    // A draft may be incomplete, but what is typed must still be readable.
    if (kind === 'draft' ? total === null : firstProblem !== null) return;
    if (kind === 'save' && needsTripRate && !isValidRate(tripRate)) {
      setError(new ApiError(400, 'rate_missing', 'Enter the trip rate above zero, with up to 6 decimal places.'));
      return;
    }
    const input = toExpenseInput(state, total ?? 0);
    // A draft may be incomplete: a rate that cannot be read yet is left out, not sent.
    if (rateProblem !== null) delete input.rateOverride;
    setBusy(kind);
    try {
      if (kind === 'save' && needsTripRate && expense) {
        const api = ratesApi(client);
        const preview = await api.preview(expense.tripId, currency, tripRate);
        const applied = await api.apply(expense.tripId, currency, tripRate, preview.snapshot).catch((problem: unknown) => {
          if (problem instanceof ApiError && problem.stale) throw new ApiError(400, 'invalid_input', 'The trip changed. Check the rate and try saving again.');
          throw problem;
        });
        const changed = applied.updatedExpenses.find((item) => item.id === expense.id);
        // Advance only over our own rate change, never over someone else's edit.
        if (changed && changed.version === useVersion + 1) {
          useVersion = changed.version;
          setVersion(useVersion);
        }
        setExpense({ ...expense, fxRate: tripRate, fxRateSource: 'trip', notice: null });
        server.retry();
      }
      let result: ExpenseWriteResponse;
      if (expense === undefined) {
        result = await client.createExpense(props.tripId, { ...input, status: kind === 'draft' ? 'draft' : 'confirmed' });
      } else {
        result = await client.saveExpense(expense.id, { ...input, version: useVersion, ...(isDraft && kind === 'save' ? { confirm: true } : {}) });
      }
      if (kind === 'save' && (result.keptAsDraft || result.expense.status !== 'confirmed')) {
        setExpense(result.expense);
        setVersion(result.expense.version);
        setError(new ApiError(400, 'invalid_input', result.expense.notice ?? 'This expense is still a draft. Check the details and try again.'));
        server.retry();
        return;
      }
      props.onSaved(result);
    } catch (problem) {
      if (problem instanceof ApiError && problem.stale && problem.current) {
        setLatest(problem.current as ExpenseView);
      } else {
        setError(problem);
      }
    } finally {
      setBusy(null);
    }
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    void submit('save');
  }

  const rate = fx?.fxRate ? `1 ${fx.homeCurrency} = ${fx.fxRate} ${currency}` : null;
  const rows = latest ? differences(members, state, latest) : [];
  const gone = latest !== null && latest.status !== 'draft' && latest.status !== 'confirmed';

  // More options: what is needed less often. Shown only when there is something in it.
  const Extras = entry.Extras ?? null;
  const ownRate = state.rateOverride !== undefined && state.rateOverride !== null;
  const canDraft = isNew || isDraft;
  const hasMore = Extras !== null || foreign || canDraft;
  const moreParts = [
    ...(Extras !== null ? ['Tax, tip, service charge, discount'] : []),
    ...(foreign ? ['exchange rate for this expense only'] : []),
    ...(canDraft ? ['save as draft'] : []),
  ];
  const moreSummary = moreParts.join(', ').replace(/^./, (c) => c.toUpperCase());
  const showMore = hasMore && moreOpen;

  // Why Save is off. A problem the split already shows next to its field is only pointed to here.
  const bodyShowsProblems = state.splitType === 'items' && entry.serverPreview === true;
  const saveReason = busy !== null
    ? null
    : firstProblem === null
      ? null
      : firstProblem === serverProblem && server.status === 'loading'
        ? null
        : bodyShowsProblems && firstProblem === serverProblem && rateProblem === null
          ? 'Fix what is marked above to save.'
          : firstProblem;

  const dateFace = state.expenseDate ? dayLabel(state.expenseDate) : 'Choose a date';
  const moveToAmount = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    amountRef.current?.focus();
  };

  return (
    <form className="form expense-form" onSubmit={onSubmit} noValidate>
      {latest ? (
        <Banner kind="warn">
          <strong>Someone else changed this expense while you were editing.</strong>
          <p>Nothing you typed is lost. It is still in the form below.</p>
          {gone ? (
            <p>The expense has been {latest.status} in the meantime, so it cannot be saved.</p>
          ) : rows.length === 0 ? (
            <p>The latest saved version is the same as what you typed.</p>
          ) : (
            <table className="compare">
              <thead>
                <tr>
                  <th scope="col"></th>
                  <th scope="col">Yours</th>
                  <th scope="col">Latest saved</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    <td>{row.mine}</td>
                    <td>{row.latest}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="banner-actions">
            {gone ? null : (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy !== null}
                onClick={() => {
                  const next = latest.version;
                  setVersion(next);
                  setLatest(null);
                  void submit('save', next);
                }}
              >
                Save mine
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy !== null}
              onClick={() => {
                setState(stateFromExpense(latest));
                setVersion(latest.version);
                setLatest(null);
                setTouched(false);
              }}
            >
              Use the latest
            </button>
          </div>
        </Banner>
      ) : null}

      {error !== undefined ? (
        <Banner kind="error" onClose={() => setError(undefined)}>
          <p>{messageOf(error)}</p>
          {error instanceof ApiError && error.problems.length > 1 ? (
            <ul>
              {error.problems.slice(1).map((problem) => (
                <li key={`${problem.field}-${problem.code}`}>{problem.message}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      ) : null}

      {expense?.notice && (error === undefined || messageOf(error) !== expense.notice) ? <Banner kind="warn">{expense.notice}</Banner> : null}

      <div className="field">
        <label className="field-label" htmlFor="expense-title">What was it for?</label>
        <input
          id="expense-title"
          className="title-input"
          type="text"
          value={state.description}
          maxLength={500}
          autoComplete="off"
          enterKeyHint="next"
          // A new expense starts here, with the keyboard up.
          autoFocus={isNew}
          placeholder={state.merchant ?? 'Dinner, taxi, tickets…'}
          onKeyDown={moveToAmount}
          onChange={(event) => update({ description: event.target.value })}
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="expense-amount">Amount</label>
        <div className="amount-box" data-invalid={touched && amountProblem !== null}>
          <select aria-label="Expense currency" className="currency-select" value={currency} disabled={busy !== null}
            onChange={(event) => {
              try {
                const next = changeCurrency(state, event.target.value);
                const before = [state.amountText, ...state.items.map((item) => amountText(item.amount, currency)), ...[state.tax, state.tip, state.serviceCharge, state.discount].map((value) => amountText(value, currency))];
                const after = [next.amountText, ...next.items.map((item) => amountText(item.amount, next.currency)), ...[next.tax, next.tip, next.serviceCharge, next.discount].map((value) => amountText(value, next.currency))];
                const rounded = decimalsOf(next.currency) === 0 ? before.findIndex((value) => /\.\d*[1-9]/.test(value)) : -1;
                setRoundingNote(rounded < 0 ? '' : `${next.currency} has no cents, so ${before[rounded]} becomes ${after[rounded]}.`);
                setState(next); setTripRate(''); setError(undefined);
              }
              catch (problem) { setError(new ApiError(400, 'invalid_input', problem instanceof Error ? problem.message : 'Check the amounts before changing currency.')); }
            }}>
            {CURRENCIES.map((option) => <option key={option.code} value={option.code}>{option.code}</option>)}
          </select>
          <input
            ref={amountRef}
            id="expense-amount"
            className="amount-input"
            type="text"
            inputMode={decimalsOf(currency) === 0 ? 'numeric' : 'decimal'}
            enterKeyHint="done"
            autoComplete="off"
            value={state.amountText}
            placeholder={amountText(0, currency)}
            aria-invalid={touched && amountProblem !== null}
            onChange={(event) => update({ amountText: event.target.value.replace(',', '.') })}
          />
        </div>
      </div>

      {roundingNote ? <p className="field-hint" role="status">{roundingNote}</p> : null}

      {state.currencyNeedsReview ? (
        <div className="banner banner-warn">
          <div className="banner-body">
            <p>Check the currency read from the receipt. Choose a currency above or confirm {currency}.</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => update({ currencyChecked: true, currencyNeedsReview: false })}>
              Confirm {currency}
            </button>
          </div>
        </div>
      ) : null}

      {foreign ? (
        <div className="fx" aria-label="Exchange rate">
          {fx?.homeTotal !== null && fx?.homeTotal !== undefined ? <p className="fx-converted"><span>Converted amount</span> <strong>{money(fx.homeTotal, fx.homeCurrency)}</strong></p> : null}
          {rate ? <p className="fx-lines"><span>Rate: {rate}</span><span>{fx?.fxRateSource === 'expense' ? "This expense's own rate" : 'Trip rate'}</span></p>
            : <p>{server.status === 'loading' ? 'Checking the rate…' : needsTripRate ? 'Enter a trip rate to save this expense.' : fx?.fxRateSource === 'missing' ? 'The latest rate will be looked up when saving.' : 'Enter valid figures to see the rate and converted amount.'}</p>}
          {needsTripRate ? <label className="field">
            <span id="trip-rate-label">Trip rate: 1 {props.homeCurrency} = ___ {currency}</span>
            <input aria-labelledby="trip-rate-label" type="text" inputMode="decimal" value={tripRate} disabled={busy !== null} onChange={(event) => setTripRate(event.target.value.replace(',', '.'))} />
            <span className="field-hint">Used for this and future expenses in {currency}. Use up to 6 decimal places.</span>
          </label> : null}
        </div>
      ) : null}

      <div className="pickers">
        <div className="field">
          <label className="field-label" htmlFor="expense-payer">Paid by</label>
          <span className="picker">
            <select id="expense-payer" value={state.payerId} onChange={(event) => update({ payerId: Number(event.target.value) })}>
              {people.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.displayName}
                  {member.id === props.meId ? ' (you)' : ''}
                </option>
              ))}
            </select>
          </span>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="expense-date">When</label>
          <span className="picker">
            <span className="picker-face" aria-hidden="true">{dateFace}</span>
            <input id="expense-date" className="picker-overlay" type="date" value={state.expenseDate} onChange={(event) => update({ expenseDate: event.target.value })} />
          </span>
        </div>
      </div>

      <div className="section split">
        <div className="split-head">
          <span id="split-label" className="section-label">Split</span>
          <div className="segmented segmented-sm" role="radiogroup" aria-labelledby="split-label">
            {splitTypes().map((option) => (
              <button
                key={option.type}
                type="button"
                role="radio"
                aria-checked={state.splitType === option.type}
                disabled={option.Body === null}
                title={option.Body === null ? option.unavailable : undefined}
                className={state.splitType === option.type ? 'on' : ''}
                onClick={() => {
                  update({ splitType: option.type });
                  // A split by item uses tax, tip and discount, which live under More options.
                  if (option.Extras) setMoreOpen(true);
                }}
              >
                {option.label}
                {option.Body === null ? <small> soon</small> : null}
              </button>
            ))}
          </div>
        </div>
        {Body === null ? <p className="field-hint">{entry.unavailable} Choose another way to split.</p> : null}

        {Body !== null ? (
          <Body
            state={state}
            update={update}
            members={people}
            total={total}
            currency={currency}
            corrections={server.status === 'ready' ? server.result?.corrections : undefined}
            amounts={shown.amounts}
            problems={shown.problems}
            disabled={busy !== null}
            client={client}
            meId={props.meId}
            {...(asksServer
              ? { pending: server.status === 'loading', previewError: server.status === 'failed' ? server.error : undefined, retryPreview: server.retry }
              : {})}
          />
        ) : null}
        {server.status === 'failed' && state.splitType !== 'items' ? <button type="button" className="link-btn small" onClick={server.retry}>Try preview again</button> : null}
      </div>

      {hasMore ? (
        <div className="disclosure">
          <button type="button" className="disclosure-btn" aria-expanded={showMore} aria-controls="more-options" onClick={() => setMoreOpen((open) => !open)}>
            <span className="row-main">
              <span className="row-title">More options</span>
              <span className="row-sub wrap">{moreSummary}</span>
            </span>
            <span className="disclosure-chevron" aria-hidden="true"><ChevronDown size={18} /></span>
          </button>
          {showMore ? (
            <div className="disclosure-panel" id="more-options">
              {Extras !== null && Body !== null ? (
                <Extras
                  state={state}
                  update={update}
                  members={people}
                  total={total}
                  currency={currency}
                  amounts={shown.amounts}
                  problems={shown.problems}
                  disabled={busy !== null}
                  client={client}
                />
              ) : null}
              {foreign ? (
                <div className="field">
                  <span className="sub-head">Exchange rate for this expense</span>
                  {ownRate ? (
                    <div className="field">
                      <label htmlFor="expense-rate">This expense's rate: 1 {props.homeCurrency} = ___ {currency}</label>
                      <input id="expense-rate" aria-describedby="expense-rate-hint" aria-invalid={rateProblem !== null && state.rateOverride !== ''} type="text" inputMode="decimal" value={state.rateOverride ?? ''} onChange={(event) => update({ rateOverride: event.target.value.replace(',', '.') })} />
                      <span id="expense-rate-hint" className={rateProblem !== null && state.rateOverride !== '' ? 'problem' : 'field-hint'}>Enter a rate above zero, with up to 6 decimal places.</span>
                    </div>
                  ) : (
                    <button type="button" className="btn btn-secondary btn-block" onClick={() => update({ rateOverride: fx?.fxRate ?? '' })}>
                      {fx?.fxRateSource === 'expense' ? "Change this expense's rate" : 'Use a different rate for this expense'}
                    </button>
                  )}
                  {state.rateOverride != null || fx?.fxRateSource === 'expense' ? (
                    <button type="button" className="btn btn-ghost" onClick={() => update({ rateOverride: null })}>Use the trip rate instead</button>
                  ) : null}
                </div>
              ) : null}
              {canDraft ? (
                <div className="field">
                  <span className="sub-head">Not finished?</span>
                  <button type="button" className="btn btn-secondary btn-block" disabled={busy !== null} onClick={() => void submit('draft')}>
                    {busy === 'draft' ? 'Saving…' : isNew ? 'Save as draft' : 'Save draft for later'}
                  </button>
                  <span className="field-hint">A draft does not count toward balances until it is finished.</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {server.status === 'loading' ? <p role="status" className="visually-hidden">Updating amounts…</p> : null}
      <div className="action-bar">
        {saveReason !== null ? <p className="save-reason" role="alert">{saveReason}</p> : null}
        <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={busy !== null || saveReason !== null || blocked || firstProblem !== null}>
          {busy === 'save' ? 'Saving…' : isNew ? 'Save' : isDraft ? 'Finish and save' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
