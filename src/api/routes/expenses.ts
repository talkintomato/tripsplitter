import type { Hono } from 'hono';
import { amountsToRecord, computeShares, DEFAULT_HOME_CURRENCY, isValidRate, validateExpense } from '../../core/index.js';
import {
  confirmExpense,
  createExpense,
  deleteExpense,
  discardExpense,
  getExpense,
  getOrCreateActiveTrip,
  getTrip,
  inTransaction,
  listExpenses,
  listTrips,
  restoreExpense,
  saveExpense,
  setTripRate,
  ValidationError,
  type ExpenseDetail,
  type ExpenseInput,
  type ExpenseStatus,
  type SetTripRateResult,
  type Trip,
} from '../../db/index.js';
import { idParam, type ApiContext, type ApiEnv, type Caller, type Services } from '../context.js';
import { describeChanges, expenseNotice, notify } from '../notices.js';
import { createExpenseBody, previewExpenseBody, readBody, saveExpenseBody, versionBody } from '../schemas.js';
import type { ExpensePreviewResponse, ExpenseResponse, ExpensesResponse, ExpenseWriteResponse } from '../types.js';
import { toExpenseView } from '../views.js';

const STATUSES: readonly ExpenseStatus[] = ['draft', 'confirmed', 'discarded', 'deleted'];

/** Thrown inside the transaction of a preview, so that everything it wrote is rolled back. */
class PreviewDone extends Error {
  readonly response: ExpensePreviewResponse;

  constructor(response: ExpensePreviewResponse) {
    super('preview');
    this.response = response;
  }
}

/** Refuses an expense that needs a rate nobody has given and none could be looked up. */
function rateNeeded(currency: string): ValidationError {
  const message = `Couldn't look up an exchange rate for ${currency}. Enter the trip rate for ${currency} to save this expense.`;
  return new ValidationError('rate_missing', message, { problems: [{ field: 'fxRate', code: 'rate_missing', message }] });
}

/** Asked for when a person tries to create a draft. Drafts come only from receipt photos, through the bot. */
export const NO_MANUAL_DRAFTS = 'Expenses are saved straight away. Drafts come from receipt photos.';

/** One create or save, described so that it can be run again once a rate has been found. */
interface ExpenseWrite {
  /** The trip to write to. May create it. Runs inside the transaction. */
  trip(): Trip;
  /** Home and expense currency, asked for only after `run` was refused for want of a rate. */
  currencies(): { home: string; currency: string };
  run(trip: Trip): ExpenseDetail;
  /** The same write without confirming. Missing when the expense cannot be kept as a draft. */
  runAsDraft?: (trip: Trip) => ExpenseDetail;
}

interface WriteResult {
  trip: Trip;
  expense: ExpenseDetail;
  rate: SetTripRateResult | null;
  keptAsDraft: boolean;
}

export function registerExpenseRoutes(app: Hono<ApiEnv>, { db, deps }: Services): void {
  /** The latest rate, or null when none could be found. Never throws. */
  async function lookUpRate(home: string, currency: string): Promise<string | null> {
    try {
      const rate = await deps.suggestRate(home, currency);
      return isValidRate(rate) ? rate : null;
    } catch (error) {
      console.error('Could not look up a rate:', error instanceof Error ? error.message : error);
      return null;
    }
  }

  /**
   * Runs a create or save. When the expense has no rate, the latest one is looked up and becomes the trip's
   * rate. When the lookup finds nothing, a new expense is refused, and a receipt draft being approved stays a draft.
   */
  async function writeExpense(caller: Caller, write: ExpenseWrite): Promise<WriteResult> {
    const { scope } = caller;
    const attempt = (options: { rate?: { currency: string; value: string }; asDraft?: boolean } = {}) =>
      inTransaction(db, () => {
        const trip = write.trip();
        const rate = options.rate ? setTripRate(db, scope, trip.id, options.rate.currency, options.rate.value, 'suggested') : null;
        const expense = options.asDraft && write.runAsDraft ? write.runAsDraft(trip) : write.run(trip);
        return { trip, expense, rate };
      });

    let first: ReturnType<typeof attempt>;
    try {
      first = attempt();
    } catch (error) {
      if (!(error instanceof ValidationError) || error.code !== 'rate_missing') throw error;
      const { home, currency } = write.currencies();
      const value = await lookUpRate(home, currency);
      if (value === null) {
        // A receipt draft being approved stays a draft, with the changes saved. Anything else is refused,
        // and nothing was written: the attempt above ran in a transaction that was rolled back.
        if (!write.runAsDraft) throw rateNeeded(currency);
        return { ...attempt({ asDraft: true }), keptAsDraft: true };
      }
      return { ...attempt({ rate: { currency, value } }), keptAsDraft: false };
    }

    if (first.expense.fxRateSource !== 'missing') return { ...first, keptAsDraft: false };
    const value = await lookUpRate(first.trip.homeCurrency, first.expense.currency);
    if (value === null) return { ...first, keptAsDraft: false };
    try {
      const rate = setTripRate(db, scope, first.trip.id, first.expense.currency, value, 'suggested');
      return { trip: first.trip, expense: getExpense(db, scope, first.expense.id), rate, keptAsDraft: false };
    } catch (error) {
      if (error instanceof ValidationError) return { ...first, keptAsDraft: false };
      throw error;
    }
  }

  async function announceRate(caller: Caller, result: WriteResult): Promise<void> {
    const rate = result.rate;
    if (!rate || !rate.changed) return;
    await notify('tripRateChanged', () =>
      deps.notifier.tripRateChanged({
        chatId: caller.group.chatId,
        actorName: caller.member.displayName,
        homeCurrency: result.trip.homeCurrency,
        currency: rate.tripRate.currency,
        rate: rate.tripRate.rate,
        origin: rate.tripRate.origin,
        expensesChanged: rate.changedExpenses.length,
      }),
    );
  }

  function writeResponse(caller: Caller, result: WriteResult): ExpenseWriteResponse {
    // The trip is read again: a first confirmed expense locks its home currency.
    return {
      expense: toExpenseView(db, caller.scope, result.expense),
      rateSet: result.rate
        ? { currency: result.rate.tripRate.currency, rate: result.rate.tripRate.rate, origin: result.rate.tripRate.origin }
        : null,
      keptAsDraft: result.keptAsDraft,
    };
  }

  app.get('/api/trips/:tripId/expenses', (c) => {
    const { scope } = c.get('caller');
    const trip = getTrip(db, scope, idParam(c, 'tripId', 'trip'));
    const raw = (c.req.query('status') ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
    for (const status of raw) {
      if (!STATUSES.includes(status as ExpenseStatus)) {
        throw new ValidationError('invalid_input', `"${status}" is not a status. Use draft, confirmed, discarded or deleted.`);
      }
    }
    const expenses = listExpenses(db, scope, trip.id, raw.length > 0 ? { status: raw as ExpenseStatus[] } : {});
    const response: ExpensesResponse = { expenses: expenses.map((e) => toExpenseView(db, scope, e, trip)) };
    return c.json(response);
  });

  // `:tripId` is a trip's ID, or the word "active": the group's active trip, started first when there is none.
  app.post('/api/trips/:tripId/expenses', async (c) => {
    const caller = c.get('caller');
    const { scope } = caller;
    const useActive = c.req.param('tripId') === 'active';
    const tripId = useActive ? 0 : idParam(c, 'tripId', 'trip');
    if (!useActive) getTrip(db, scope, tripId);
    const { status, ...input } = await readBody(c, createExpenseBody);
    // A person's expense is saved or not saved. Drafts are made by the receipt reader, not through this route.
    if (status === 'draft') throw new ValidationError('invalid_input', NO_MANUAL_DRAFTS);

    const result = await writeExpense(caller, {
      trip: () => (useActive ? getOrCreateActiveTrip(db, scope).trip : getTrip(db, scope, tripId)),
      currencies: () => {
        const home = useActive
          ? (listTrips(db, scope, { status: 'active' })[0]?.homeCurrency ?? listTrips(db, scope)[0]?.homeCurrency ?? DEFAULT_HOME_CURRENCY)
          : getTrip(db, scope, tripId).homeCurrency;
        return { home, currency: input.currency ?? home };
      },
      run: (trip) => createExpense(db, scope, { ...input, tripId: trip.id, status: 'confirmed' }),
    });

    await announceRate(caller, result);
    if (result.expense.status === 'confirmed') {
      await notify('expenseSaved', () => deps.notifier.expenseSaved(expenseNotice(db, caller, result.expense)));
    }
    return c.json(writeResponse(caller, result), 201);
  });

  // What each person would pay for an expense that is not saved. The expense goes through the very
  // operation that a save uses, as a draft in a transaction that is always rolled back, so members, items
  // and figures are checked exactly as a save checks them, and nothing is written.
  app.post('/api/expenses/preview', async (c) => {
    const { scope } = c.get('caller');
    const { status: _status, tripId, expenseId, ...input } = await readBody(c, previewExpenseBody);
    try {
      inTransaction(db, () => {
        const existing = expenseId === undefined ? undefined : getExpense(db, scope, expenseId);
        const trip = existing ? getTrip(db, scope, existing.tripId) : tripId === undefined || tripId === 'active' ? getOrCreateActiveTrip(db, scope).trip : getTrip(db, scope, tripId);
        const keptRate = existing?.fxRateSource === 'expense' && existing.currency === (input.currency ?? existing.currency) && input.rateOverride === undefined
          ? { rateOverride: existing.fxRate } : {};
        const draft = createExpense(db, scope, { ...(existing ? { currency: existing.currency } : {}), ...keptRate, ...input, tripId: trip.id, status: 'draft' });
        const view = toExpenseView(db, scope, draft, trip);
        const problems = validateExpense(draft, draft.items, draft.shares);
        const mismatch = problems.find((p) => p.code === 'total_mismatch');
        const safe = (value: bigint): number | null => value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
        const corrections = {
          total: mismatch?.difference === undefined ? null : safe(BigInt(draft.total) - BigInt(mismatch.difference)),
          discount: mismatch?.difference === undefined || mismatch.difference >= 0 ? null : safe(BigInt(draft.discount) - BigInt(mismatch.difference)),
        };
        throw new PreviewDone({
          ...(tripId !== undefined || expenseId !== undefined ? { corrections, fx: { fxRate: view.fxRate, fxRateSource: view.fxRateSource, homeTotal: view.homeTotal, homeCurrency: view.homeCurrency } } : {}),
          amounts: problems.length === 0 ? amountsToRecord(computeShares(draft, draft.items, draft.shares)) : null,
          problems,
          difference: mismatch?.difference ?? null,
        });
      });
    } catch (error) {
      if (error instanceof PreviewDone) return c.json(error.response);
      throw error;
    }
    throw new Error('A preview must end by rolling back.');
  });

  app.get('/api/expenses/:id', (c) => {
    const { scope } = c.get('caller');
    const response: ExpenseResponse = { expense: toExpenseView(db, scope, getExpense(db, scope, idParam(c, 'id', 'expense'))) };
    return c.json(response);
  });

  app.put('/api/expenses/:id', async (c) => {
    const caller = c.get('caller');
    const { scope } = caller;
    const id = idParam(c, 'id', 'expense');
    const before = getExpense(db, scope, id);
    const { version, confirm, ...fields } = await readBody(c, saveExpenseBody);
    const input: ExpenseInput = fields;
    const confirming = confirm === true && before.status === 'draft';

    const save = (): ExpenseDetail => saveExpense(db, scope, id, version, input);
    const result = await writeExpense(caller, {
      trip: () => getTrip(db, scope, before.tripId),
      currencies: () => ({ home: getTrip(db, scope, before.tripId).homeCurrency, currency: input.currency ?? before.currency }),
      run: () => {
        const saved = save();
        return confirming ? confirmExpense(db, scope, id, saved.version) : saved;
      },
      ...(confirming ? { runAsDraft: save } : {}),
    });

    await announceRate(caller, result);
    const after = result.expense;
    if (before.status === 'draft' && after.status === 'confirmed') {
      await notify('expenseSaved', () => deps.notifier.expenseSaved(expenseNotice(db, caller, after)));
    } else if (before.status === 'confirmed' && after.status === 'confirmed') {
      const changes = describeChanges(db, scope, before, after);
      if (changes.length > 0) {
        await notify('expenseEdited', () => deps.notifier.expenseEdited({ ...expenseNotice(db, caller, after), changes }));
      }
    }
    return c.json(writeResponse(caller, result));
  });

  /** The four status changes share everything but the operation and the notice. */
  function statusRoute(
    path: string,
    change: (caller: Caller, id: number, version: number) => ExpenseDetail,
    announce: (caller: Caller, before: ExpenseDetail, after: ExpenseDetail) => Promise<void>,
  ): void {
    app.post(path, async (c: ApiContext) => {
      const caller = c.get('caller');
      const id = idParam(c, 'id', 'expense');
      const before = getExpense(db, caller.scope, id);
      const { version } = await readBody(c, versionBody);
      const after = change(caller, id, version);
      await announce(caller, before, after);
      const response: ExpenseResponse = { expense: toExpenseView(db, caller.scope, after) };
      return c.json(response);
    });
  }

  statusRoute(
    '/api/expenses/:id/confirm',
    (caller, id, version) => confirmExpense(db, caller.scope, id, version),
    (caller, _before, after) => notify('expenseSaved', () => deps.notifier.expenseSaved(expenseNotice(db, caller, after))),
  );
  statusRoute(
    '/api/expenses/:id/discard',
    (caller, id, version) => discardExpense(db, caller.scope, id, version),
    async () => {},
  );
  statusRoute(
    '/api/expenses/:id/delete',
    (caller, id, version) => deleteExpense(db, caller.scope, id, version),
    (caller, _before, after) => notify('expenseDeleted', () => deps.notifier.expenseDeleted(expenseNotice(db, caller, after))),
  );
  statusRoute(
    '/api/expenses/:id/restore',
    (caller, id, version) => restoreExpense(db, caller.scope, id, version),
    async (caller, _before, after) => {
      // Only a deleted expense coming back is announced. A discarded draft coming back is not.
      if (after.status !== 'confirmed') return;
      await notify('expenseRestored', () => deps.notifier.expenseRestored(expenseNotice(db, caller, after)));
    },
  );
}
