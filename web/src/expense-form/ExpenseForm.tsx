import { LocationField } from './LocationField';
import { PhotoField, usePhotoField } from '../photos/PhotoField';
import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { CURRENCIES, currencyDecimals } from '../../../src/core/currencies';
import { isValidRate } from '../../../src/core/rates';
import { ApiError, messageOf, type ApiClient } from '../api/client';
import type { ExpenseView, ExpenseWriteResponse, Member } from '../api/types';
import { Badge, Banner } from '../components/ui';
import { ChevronDown, ChevronRight, Smile } from '../components/icons';
import { RateSheet } from './RateSheet';
import type { TripRateApplied } from '../api/useTripRateChange';
import { amountText, dayLabel, money, nameOf } from '../format';
import { EmojiPicker } from './EmojiPicker';
import { expenseChanges } from '../expenseChanges';
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
  onSaved(result: ExpenseWriteResponse, failedPhotos?: Blob[]): void;
  onCancel?(): void;
  /** Opens the exchange rate sheet straight away, as "Change" on the expense's detail does. */
  openRateSheet?: boolean;
}

function decimalsOf(currency: string): number {
  try {
    return currencyDecimals(currency);
  } catch {
    return 2;
  }
}

/** The lines where the latest saved version differs from what the member has typed. */
function differences(members: ReadonlyArray<Member>, mine: ExpenseFormState, latest: ExpenseView): Array<{ label: string; mine: string; latest: string }> {
  // Only when the member set or cleared the expense's own rate in this session.
  const rate: [string, string] | undefined = mine.rateOverride !== undefined
    ? [mine.rateOverride ?? 'Trip rate', latest.fxRateSource === 'expense' ? latest.fxRate ?? '' : 'Trip rate']
    : undefined;
  return expenseChanges(members, mine, stateFromExpense(latest), { rate, rateLabel: 'Rate for this expense' }).map((row) => ({ label: row.label, mine: row.before, latest: row.after }));
}

/** Create, edit, and finish a draft. The body under the switch comes from the split type registry. */
export function ExpenseForm(props: ExpenseFormProps) {
  const { client, members } = props;
  const [expense, setExpense] = useState(props.expense);

  // The currency a new expense was refused in for want of a rate. The rate row then asks for one.
  const [refusedCurrency, setRefusedCurrency] = useState<string | null>(null);
  const [roundingNote, setRoundingNote] = useState('');
  const [state, setState] = useState<ExpenseFormState>(() =>
    expense ? stateFromExpense(expense) : newExpenseState({ members, meId: props.meId, currency: props.homeCurrency }),
  );
  // The version the member is looking at. It moves on only when they choose to after a conflict.
  const [version, setVersion] = useState(expense?.version ?? 0);
  const [latest, setLatest] = useState<ExpenseView | null>(null);
  const [locationBusy, setLocationBusy] = useState(false);
  const [busy, setBusy] = useState<'save' | 'draft' | null>(null);
  const [error, setError] = useState<unknown>(undefined);
  const [touched, setTouched] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);
  const [emojiSheet, setEmojiSheet] = useState(false);
  const [rateSheet, setRateSheet] = useState(props.openRateSheet === true && props.expense !== undefined && props.expense.currency !== props.homeCurrency);
  // Opened from the start when the expense is not the plain case: a draft, a split by item, its own rate.
  const [moreOpen, setMoreOpen] = useState(() => expense?.status === 'draft' || expense?.splitType === 'items' || expense?.fxRateSource === 'expense');

  const update = (patch: FormPatch): void => setState((current) => ({ ...current, ...patch }));

  const photoField = usePhotoField(client, props.expense, state.location != null, location => { update({ location }); setMoreOpen(true); });

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
  // No rate for this currency, and none could be looked up: the trip needs one before this can be saved.
  const rateNeeded = foreign && state.rateOverride == null && (!fx || fx.fxRateSource === 'missing')
    && ((expense?.currency === currency && expense.fxRateSource === 'missing') || refusedCurrency === currency);
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
  const rateNeededProblem = rateNeeded ? `Set the exchange rate for ${currency} to save this expense.` : null;
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
    ? (amountProblem ?? typeProblem ?? peopleProblem ?? rateNeededProblem ?? serverProblem)
    : (amountProblem ?? typeProblem ?? peopleProblem ?? rateNeededProblem ?? shown.problems[0]?.message ?? null);

  /**
   * `save`: saves a new expense or an edit, and approves a receipt draft. `draft`: only for a receipt draft being
   * edited, "Save changes, approve later". A person's own expense is never kept as a draft.
   */
  async function submit(kind: 'save' | 'draft', useVersion = version): Promise<void> {
    if (photoField.working || photoField.tagging || locationBusy || busy !== null) return;
    setTouched(true);
    setError(undefined);
    if (kind === 'draft' && !isDraft) return;
    // A draft put aside may be incomplete, but what is typed must still be readable.
    if (kind === 'draft' ? total === null : firstProblem !== null) return;
    const input = toExpenseInput(state, total ?? 0);
    // A rate that cannot be read yet is left out, not sent.
    if (rateProblem !== null) delete input.rateOverride;
    setBusy(kind);
    try {
      let result: ExpenseWriteResponse;
      if (expense === undefined) {
        result = await client.createExpense(props.tripId, { ...input, status: 'confirmed' });
      } else {
        result = await client.saveExpense(expense.id, { ...input, version: useVersion, ...(isDraft && kind === 'save' ? { confirm: true } : {}) });
      }
      // Approving a receipt draft can leave it a draft, with its changes saved, when no rate could be found.
      if (kind === 'save' && (result.keptAsDraft || result.expense.status !== 'confirmed')) {
        setExpense(result.expense);
        setVersion(result.expense.version);
        setError(new ApiError(400, 'invalid_input', result.expense.notice ?? 'This expense is still a draft. Check the details and try again.'));
        server.retry();
        return;
      }
      const failedPhotos = expense === undefined ? await photoField.uploadAfterSave(result.expense.id) : [];
      if (failedPhotos.length) props.onSaved(result, failedPhotos);
      else props.onSaved(result);
    } catch (problem) {
      if (problem instanceof ApiError && problem.stale && problem.current) {
        setLatest(problem.current as ExpenseView);
      } else {
        // Nothing was saved. When a rate is what is missing, the rate row asks for one.
        if (problem instanceof ApiError && problem.code === 'rate_missing') setRefusedCurrency(currency);
        setError(problem);
      }
    } finally {
      setBusy(null);
    }
  }

  /** The trip's rate was changed from the sheet: this expense now uses it. */
  function tripRateApplied(result: TripRateApplied, rate: string): void {
    if (expense) {
      const changed = result.updatedExpenses.find((item) => item.id === expense.id);
      // Advance only over our own rate change, never over someone else's edit.
      if (changed && changed.version === version + 1) setVersion(changed.version);
      setExpense({ ...expense, fxRate: rate, fxRateSource: 'trip', notice: null });
    }
    setRefusedCurrency(null);
    if (state.rateOverride != null || fx?.fxRateSource === 'expense') update({ rateOverride: null });
    setError(undefined);
    server.retry();
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    void submit('save');
  }

  const rate = fx?.fxRate ? `1 ${fx.homeCurrency} = ${fx.fxRate} ${currency}` : null;
  const rows = latest ? differences(members, state, latest) : [];
  const gone = latest !== null && latest.status !== 'draft' && latest.status !== 'confirmed';

  // More options always includes location, plus any extras for this split type.
  const Extras = entry.Extras ?? null;
  const ownRate = (state.rateOverride !== undefined && state.rateOverride !== null) || (state.rateOverride === undefined && fx?.fxRateSource === 'expense');
  const moreSummary = Extras ? 'Tax, tip, service charge, discount, location' : 'Location';

  const showMore = moreOpen;
  const rateTripId = typeof props.tripId === 'number' ? props.tripId : (expense?.tripId ?? null);
  const rateSource = fx?.fxRateSource === 'expense'
    ? "This expense's own rate"
    : fx?.fxRateSource === 'suggested'
      ? 'Live rate · saved as the trip rate'
      : 'Trip rate';
  const rateAction = rateNeeded || !rate ? 'Set' : 'Change';

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

  const titleEmoji = state.emoji;
  const dateFace = state.expenseDate ? dayLabel(state.expenseDate) : 'Choose a date';
  const moveToAmount = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    amountRef.current?.focus();
  };

  const moreOptions = (
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
              <LocationField onBusy={setLocationBusy} client={client} location={state.location ?? null} onChange={location => update({ location })} disabled={busy !== null || photoField.tagging || locationBusy} />
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
            </div>
          ) : null}
        </div>
      );
  const moreInsideSplit = state.splitType === 'items' && Body !== null;

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

      {isDraft && expense ? (
        <p className="origin-line">
          <Badge tone="draft">Draft</Badge>
          <span>{expense.receiptFileId ? 'Read from a receipt' : 'Waiting for approval'} · added by {expense.createdBy === props.meId ? 'you' : nameOf(members, expense.createdBy)}</span>
        </p>
      ) : null}

      <div className="field">
        <label className="field-label" htmlFor="expense-title">What was it for?</label>
        <div className="title-row">
        <button type="button" className="emoji-btn" aria-label={titleEmoji ? `Emoji ${titleEmoji}, change` : 'Add an emoji'} onClick={() => setEmojiSheet(true)}>
          {titleEmoji ?? <span className="emoji-empty" aria-hidden="true"><Smile /></span>}
        </button>
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
      </div>
      {emojiSheet ? (
        <EmojiPicker
          current={titleEmoji}
          onPick={(emoji) => update({ emoji, emojiChanged: true })}
          onClose={() => setEmojiSheet(false)}
        />
      ) : null}

      <div className="field">
        <label className="field-label" htmlFor="expense-amount">Amount</label>
        <div className="amount-card">
        <div className="amount-box" data-invalid={touched && amountProblem !== null}>
          <select aria-label="Expense currency" className="currency-select" value={currency} disabled={busy !== null}
            onChange={(event) => {
              try {
                const next = changeCurrency(state, event.target.value);
                const before = [state.amountText, ...state.items.map((item) => amountText(item.amount, currency)), ...[state.tax, state.tip, state.serviceCharge, state.discount].map((value) => amountText(value, currency))];
                const after = [next.amountText, ...next.items.map((item) => amountText(item.amount, next.currency)), ...[next.tax, next.tip, next.serviceCharge, next.discount].map((value) => amountText(value, next.currency))];
                const rounded = decimalsOf(next.currency) === 0 ? before.findIndex((value) => /\.\d*[1-9]/.test(value)) : -1;
                setRoundingNote(rounded < 0 ? '' : `${next.currency} has no cents, so ${before[rounded]} becomes ${after[rounded]}.`);
                setState(next); setRefusedCurrency(null); setError(undefined);
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
        {foreign ? (
          <button type="button" className={`rate-row ${rateNeeded ? 'rate-row-needed' : ''}`} aria-label={`${rateAction} exchange rate`} onClick={() => setRateSheet(true)}>
            <span className="row-main">
              <span className="rate-main">{rateNeeded ? 'Exchange rate needed' : rate ?? (server.status === 'loading' ? 'Checking the rate…' : 'Exchange rate')}</span>
              <span className="rate-sub">
                {rateNeeded ? (
                  `No rate for ${currency} could be looked up. Set one to save this expense.`
                ) : rate ? (
                  <>
                    <span>{rateSource}</span>
                    {fx?.homeTotal !== null && fx?.homeTotal !== undefined ? <> · ≈ <span className="num">{money(fx.homeTotal, fx.homeCurrency)}</span></> : null}
                  </>
                ) : fx?.fxRateSource === 'missing' ? (
                  'The latest rate will be looked up when saving.'
                ) : server.status === 'loading' ? null : (
                  'Enter the amount to see the rate and converted amount.'
                )}
              </span>
            </span>
            <span className="rate-action" aria-hidden="true">{rateAction}<ChevronRight size={14} /></span>
          </button>
        ) : null}
        </div>
      </div>

      {roundingNote ? <p className="field-hint" role="status">{roundingNote}</p> : null}

      {state.currencyNeedsReview ? (
        <p className="field-hint">The currency was read from the receipt. Change it above if it's wrong.</p>
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
            {...(moreInsideSplit ? { beforeShares: moreOptions } : {})}
            {...(asksServer
              ? { pending: server.status === 'loading', previewError: server.status === 'failed' ? server.error : undefined, retryPreview: server.retry }
              : {})}
          />
        ) : null}
        {server.status === 'failed' && state.splitType !== 'items' ? <button type="button" className="link-btn small" onClick={server.retry}>Try preview again</button> : null}
      </div>

      <PhotoField client={client} field={photoField} expense={expense} disabled={busy !== null || locationBusy} />

      {/* By item: More options sits above what each person pays, since tax, tip and discount change it. */}
      {moreInsideSplit ? null : moreOptions}

      {server.status === 'loading' ? <p role="status" className="visually-hidden">Updating amounts…</p> : null}
      <div className="action-bar">
        {saveReason !== null ? <p className="save-reason" role="alert">{saveReason}</p> : null}
        <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={photoField.working || photoField.tagging || locationBusy || busy !== null || saveReason !== null || blocked || firstProblem !== null}>
          {busy === 'save' ? 'Saving…' : isNew ? 'Save' : isDraft ? 'Approve and save' : 'Save changes'}
        </button>
        {isDraft ? (
          // Kept for a receipt draft only, so that half-assigned work is not lost. It stays a draft.
          <button type="button" className="btn btn-ghost btn-block" disabled={busy !== null} onClick={() => void submit('draft')}>
            {busy === 'draft' ? 'Saving…' : 'Save changes, approve later'}
          </button>
        ) : null}
      </div>

      {rateSheet && foreign ? (
        <RateSheet
          client={client}
          home={props.homeCurrency}
          currency={currency}
          members={members}
          current={state.rateOverride ?? fx?.fxRate ?? (expense?.currency === currency ? expense.fxRate : null) ?? null}
          ownRate={ownRate}
          tripId={rateTripId}
          initialScope={rateNeeded || fx?.fxRateSource === 'missing' ? 'trip' : 'expense'}
          onOwnRate={(value) => update({ rateOverride: value })}
          onTripRateInstead={() => update({ rateOverride: null })}
          onTripRateApplied={tripRateApplied}
          onClose={() => setRateSheet(false)}
        />
      ) : null}
    </form>
  );
}
