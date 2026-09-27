// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../web/src/api/client';
import { ExpenseForm, type ExpenseFormProps } from '../../web/src/expense-form/ExpenseForm';
import { registerSplitType, splitType, type SplitBodyProps } from '../../web/src/expense-form/registry';
import { today } from '../../web/src/format';
import { ANA, KAI, LEO, MEMBERS, SAM, expenseView, fakeClient, previewAnswer, written } from './helpers';

afterEach(cleanup);

function setup(over: Partial<ExpenseFormProps> = {}) {
  const client = fakeClient();
  client.previewExpense.mockImplementation(async (body) => previewAnswer(body, over.expense));
  const onSaved = vi.fn();
  const user = userEvent.setup();
  const view = render(<ExpenseForm client={client} members={MEMBERS} meId={SAM.id} tripId={1} homeCurrency="SGD" onSaved={onSaved} {...over} />);
  return { client, onSaved, user, view };
}

const box = (name: string) => screen.getByRole('checkbox', { name: new RegExp(`^${name}`) });
const row = (name: string) => screen.getByText(name, { selector: '.person-name' }).closest('.person') as HTMLElement;

describe('a new expense split evenly', () => {
  it('starts with today, the caller as payer and every active member ticked', () => {
    setup();
    expect(screen.getByLabelText('When')).toHaveValue(today());
    expect(screen.getByLabelText('Paid by')).toHaveValue(String(SAM.id));
    expect(screen.getByRole('option', { name: 'Sam (you)' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Equally' })).toBeChecked();
    expect(box('Ana')).toBeChecked();
    expect(box('Sam')).toBeChecked();
    expect(box('Leo')).toBeChecked();
    // Kai left the chat and is not offered for a new expense.
    expect(screen.queryByText('Kai')).not.toBeInTheDocument();
    // The expense currency starts at the home currency.
    expect(screen.getByText('SGD')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Expense currency' })).toHaveValue('SGD');
    expect(screen.queryByLabelText(/rate/i)).not.toBeInTheDocument();
  });

  it('shows each share while typing and sends the people ticked', async () => {
    const { client, onSaved, user } = setup();
    const saved = written(expenseView());
    client.createExpense.mockResolvedValue(saved);

    await user.type(screen.getByLabelText('What was it for?'), 'Dinner');
    await user.type(screen.getByLabelText('Amount'), '10.00');
    // The cent left over goes to the payer.
    expect(await within(row('Sam')).findByText('3.34 SGD')).toBeInTheDocument();
    expect(within(row('Ana')).getByText('3.33 SGD')).toBeInTheDocument();

    await user.click(box('Leo'));
    expect(await within(row('Ana')).findByText('5.00 SGD')).toBeInTheDocument();
    expect(within(row('Leo')).queryByText(/SGD/)).not.toBeInTheDocument();

    await waitFor(() => expect(client.previewExpense).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(client.createExpense).toHaveBeenCalledTimes(1);
    const [tripId, body] = client.createExpense.mock.calls[0]!;
    expect(tripId).toBe(1);
    expect(body).toMatchObject({
      payerId: SAM.id,
      description: 'Dinner',
      expenseDate: today(),
      total: 1000,
      splitType: 'even',
      status: 'confirmed',
      shares: [{ memberId: ANA.id }, { memberId: SAM.id }],
    });
    // The server decides the currency, the rate and who is acting.
    for (const key of ['currency', 'rateOverride', 'fxRate', 'createdBy', 'version']) expect(body).not.toHaveProperty(key);
    expect(onSaved).toHaveBeenCalledWith(saved);
  });

  it('does not send an expense without an amount or without people', async () => {
    const { client, user } = setup();
    await waitFor(() => expect(client.previewExpense).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the amount.');

    await user.type(screen.getByLabelText('Amount'), '12.345');
    expect(screen.getByRole('alert')).toHaveTextContent('such as 84.50');
    await user.clear(screen.getByLabelText('Amount'));
    await user.type(screen.getByLabelText('Amount'), '12,5');
    expect(screen.getByLabelText('Amount')).toHaveValue('12.5');

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one person.');
    await waitFor(() => expect(client.previewExpense).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(client.createExpense).not.toHaveBeenCalled();

    // A person's own expense is saved or not saved: there is no way to put it aside as a draft.
    expect(screen.queryByRole('button', { name: /draft|approve later/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^More options/ })).not.toBeInTheDocument();
    expect(client.createExpense).not.toHaveBeenCalled();
  });

  it('shows what the server refused and keeps the input', async () => {
    const { client, onSaved, user } = setup({ tripId: 'active' });
    client.createExpense.mockRejectedValue(new ApiError(400, 'trip_ended', 'This trip has ended.'));
    await user.type(screen.getByLabelText('Amount'), '8');
    await waitFor(() => expect(client.previewExpense).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This trip has ended.')).toBeInTheDocument();
    expect(client.createExpense.mock.calls[0]![0]).toBe('active');
    expect(screen.getByLabelText('Amount')).toHaveValue('8');
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('a split by portions', () => {
  it('takes a whole number per person', async () => {
    const { client, user } = setup();
    client.createExpense.mockResolvedValue(written(expenseView()));
    await user.type(screen.getByLabelText('Amount'), '9');
    await user.click(screen.getByRole('radio', { name: 'Portions' }));
    expect(screen.getByRole('radio', { name: 'Portions' })).toBeChecked();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    for (const name of ['Ana', 'Sam', 'Leo']) expect(screen.getByLabelText(`Portions for ${name}`)).toHaveValue('1');

    await user.click(screen.getByRole('button', { name: 'More portions for Ana' }));
    await user.click(screen.getByRole('button', { name: 'Fewer portions for Leo' }));
    expect(screen.getByLabelText('Portions for Ana')).toHaveValue('2');
    expect(screen.getByLabelText('Portions for Leo')).toHaveValue('0');
    expect(await within(row('Ana')).findByText('6.00 SGD')).toBeInTheDocument();
    expect(within(row('Sam')).getByText('3.00 SGD')).toBeInTheDocument();
    expect(within(row('Leo')).queryByText(/SGD/)).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('Portions for Sam'));
    await user.type(screen.getByLabelText('Portions for Sam'), '4');
    expect(await within(row('Sam')).findByText('6.00 SGD')).toBeInTheDocument();

    await waitFor(() => expect(client.previewExpense).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const body = client.createExpense.mock.calls[0]![1];
    expect(body).toMatchObject({ total: 900, splitType: 'portions' });
    expect(body.shares).toEqual([
      { memberId: ANA.id, weight: 2 },
      { memberId: SAM.id, weight: 4 },
    ]);
  });

  it('loads the portions of a saved expense and sends everything back', async () => {
    const expense = expenseView({
      splitType: 'portions',
      payerId: KAI.id,
      tax: 200,
      taxIncluded: true,
      tip: 100,
      items: [{ id: 50, expenseId: 7, label: 'Paella', quantity: 2, amount: 2700, position: 0 }],
      shares: [
        { id: 1, memberId: ANA.id, weight: 3, expenseId: 7, itemId: null },
        { id: 2, memberId: KAI.id, weight: 1, expenseId: 7, itemId: null },
        { id: 3, memberId: ANA.id, weight: 1, expenseId: null, itemId: 50 },
      ],
    });
    const { client, user } = setup({ expense });
    client.saveExpense.mockResolvedValue(written(expense));
    // Kai left the chat but is on this expense, so he is listed.
    expect(screen.getByLabelText('Portions for Kai')).toHaveValue('1');
    expect(screen.getByLabelText('Portions for Ana')).toHaveValue('3');
    expect(screen.getByLabelText('Portions for Sam')).toHaveValue('0');
    expect(screen.getByLabelText('Amount')).toHaveValue('30.00');

    await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(client.saveExpense).toHaveBeenCalledWith(7, {
      version: 3,
      payerId: KAI.id,
      description: 'Dinner',
      merchant: 'Casa Pepe',
      expenseDate: '2026-09-20',
      total: 3000,
      tax: 200,
      taxIncluded: true,
      tip: 100,
      serviceCharge: 0,
      discount: 0,
      splitType: 'portions',
      items: [{ label: 'Paella', quantity: 2, amount: 2700, shares: [{ memberId: ANA.id, weight: 1 }] }],
      shares: [
        { memberId: ANA.id, weight: 3 },
        { memberId: KAI.id, weight: 1 },
      ],
    });
  });
});

describe('the split type registry', () => {
  it('shows a split type without a body on the switch, disabled', async () => {
    const original = splitType('items');
    registerSplitType({ type: 'items', label: 'By item', Body: null, unavailable: 'Splitting by item is coming soon.' });
    try {
      const { user } = setup();
      const option = screen.getByRole('radio', { name: /By item/ });
      expect(option).toBeDisabled();
      await user.click(option);
      expect(screen.getByRole('radio', { name: 'Equally' })).toBeChecked();
    } finally {
      registerSplitType(original);
    }
  });

  it('hands the whole expense to the body registered for a split type', async () => {
    const original = splitType('items');
    const seen: SplitBodyProps[] = [];
    registerSplitType({
      type: 'items',
      label: 'By item',
      Body: (props) => {
        seen.push(props);
        return (
          <button type="button" onClick={() => props.update({ tip: 500, items: [{ label: 'Beer', amount: 450 }] })}>
            items body
          </button>
        );
      },
    });
    try {
      const second = setup();
      second.client.createExpense.mockResolvedValue(written(expenseView()));
      await second.user.type(screen.getByLabelText('Amount'), '9.50');
      await second.user.click(screen.getByRole('radio', { name: 'By item' }));
      await second.user.click(screen.getByRole('button', { name: 'items body' }));
      expect(seen.at(-1)).toMatchObject({ total: 950, currency: 'SGD', state: { splitType: 'items', tip: 500 } });
      await waitFor(() => expect(seen.at(-1)!.amounts).not.toBeNull());
      await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    await second.user.click(screen.getByRole('button', { name: 'Save' }));
      expect(second.client.createExpense.mock.calls[0]![1]).toMatchObject({ splitType: 'items', tip: 500, total: 950, items: [{ label: 'Beer', amount: 450, shares: [] }] });
    } finally {
      registerSplitType(original);
    }
  });
});

describe('a draft', () => {
  it('in a foreign currency shows its own amount, the rate and the converted amount', async () => {
    const expense = expenseView({
      status: 'draft',
      description: '',
      merchant: 'Ichiran',
      currency: 'JPY',
      total: 11240,
      fxRate: '112.4',
      fxRateSource: 'trip',
      homeTotal: 10000,
      amounts: { 1: 3748, 2: 3746, 3: 3746 },
      homeAmounts: { 1: 3334, 2: 3333, 3: 3333 },
    });
    const { client, user } = setup({ expense });
    client.saveExpense.mockResolvedValue(written({ ...expense, status: 'confirmed' }));

    expect(screen.getByLabelText('Amount')).toHaveValue('11240');
    expect(screen.getByText('JPY')).toBeInTheDocument();
    expect(await screen.findByText('1 SGD = 112.4 JPY')).toBeInTheDocument();
    expect(screen.getByText('100.00 SGD')).toBeInTheDocument();
    expect(await within(row('Sam')).findByText('3,746 JPY')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /currency/i })).toHaveValue('JPY');

    await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Approve and save' }));
    const [id, body] = client.saveExpense.mock.calls[0]!;
    expect(id).toBe(7);
    expect(body).toMatchObject({ version: 3, confirm: true, total: 11240, merchant: 'Ichiran' });
    // Left out, so that the expense keeps its currency, its rate and its receipt.
    for (const key of ['currency', 'rateOverride', 'receiptFileId', 'currencyNeedsReview']) expect(body).not.toHaveProperty(key);
  });

  it('with no rate says so, and can still be saved for later', async () => {
    const notice = "Couldn't look up an exchange rate. Enter one to save this.";
    const expense = expenseView({ status: 'draft', currency: 'JPY', total: 11240, fxRate: null, fxRateSource: 'missing', homeTotal: null, homeAmounts: null, notice });
    const { client, user } = setup({ expense });
    client.saveExpense.mockResolvedValue(written(expense));
    expect(screen.getByText(notice)).toBeInTheDocument();
    // The rate row asks for a rate, and approving waits for one.
    expect(await screen.findByText('Exchange rate needed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set exchange rate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve and save' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Set the exchange rate for JPY to save this expense.');
    expect(screen.queryByText('The latest rate will be looked up when saving.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes, approve later' }));
    expect(client.saveExpense.mock.calls[0]![1]).not.toHaveProperty('confirm');
  });

  it('with a guessed currency asks for it to be checked', async () => {
    const expense = expenseView({ status: 'draft', currency: 'THB', currencyNeedsReview: true, fxRate: '26.1', fxRateSource: 'trip' });
    const { client, user } = setup({ expense });
    client.saveExpense.mockResolvedValue(written(expense));
    await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Approve and save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Check the currency first');
    expect(client.saveExpense).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Confirm THB' }));
    await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Approve and save' }));
    expect(client.saveExpense.mock.calls[0]![1]).toMatchObject({ currency: 'THB', confirm: true });
  });
});

describe('when someone else changed the expense', () => {
  async function conflict() {
    const expense = expenseView();
    const current = expenseView({
      version: 4,
      total: 4500,
      payerId: SAM.id,
      shares: [
        { id: 1, memberId: 1, weight: 1, expenseId: 7, itemId: null },
        { id: 2, memberId: 2, weight: 1, expenseId: 7, itemId: null },
      ],
    });
    const result = setup({ expense });
    result.client.saveExpense.mockRejectedValueOnce(new ApiError(409, 'stale', 'This was changed by someone else.', { current }));
    await result.user.clear(screen.getByLabelText('What was it for?'));
    await result.user.type(screen.getByLabelText('What was it for?'), 'Dinner at the pier');
    await result.user.clear(screen.getByLabelText('Amount'));
    await result.user.type(screen.getByLabelText('Amount'), '33.00');
    await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    await result.user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText(/Someone else changed this expense/);
    return { ...result, current };
  }

  it('keeps the unsaved input and shows the latest version next to it', async () => {
    const { client, onSaved } = await conflict();
    expect(client.saveExpense).toHaveBeenCalledTimes(1);
    expect(client.saveExpense.mock.calls[0]![1]).toMatchObject({ version: 3, total: 3300 });
    expect(onSaved).not.toHaveBeenCalled();

    // What was typed is still in the form.
    expect(screen.getByLabelText('What was it for?')).toHaveValue('Dinner at the pier');
    expect(screen.getByLabelText('Amount')).toHaveValue('33.00');
    expect(box('Leo')).toBeChecked();

    const table = screen.getByRole('table');
    const line = (label: string) => within(within(table).getByRole('rowheader', { name: label }).closest('tr') as HTMLElement).getAllByRole('cell').map((c) => c.textContent);
    expect(line('Description')).toEqual(['Dinner at the pier', 'Dinner']);
    expect(line('Amount')).toEqual(['33.00 SGD', '45.00 SGD']);
    expect(line('Paid by')).toEqual(['Ana', 'Sam']);
    expect(line('People')).toEqual(['Ana, Sam, Leo', 'Ana, Sam']);
    // What is the same on both sides is not listed.
    expect(within(table).queryByRole('rowheader', { name: 'Date' })).not.toBeInTheDocument();
  });

  it('saves the member\'s version over the latest when asked to', async () => {
    const { client, onSaved, user } = await conflict();
    const saved = written(expenseView({ version: 5, total: 3300 }));
    client.saveExpense.mockResolvedValueOnce(saved);
    await user.click(screen.getByRole('button', { name: 'Save mine' }));
    expect(client.saveExpense).toHaveBeenCalledTimes(2);
    expect(client.saveExpense.mock.calls[1]![1]).toMatchObject({ version: 4, total: 3300, description: 'Dinner at the pier', payerId: ANA.id });
    expect(client.saveExpense.mock.calls[1]![1].shares).toHaveLength(3);
    expect(onSaved).toHaveBeenCalledWith(saved);
  });

  it('takes the latest version when asked to', async () => {
    const { client, user } = await conflict();
    await user.click(screen.getByRole('button', { name: 'Use the latest' }));
    expect(screen.queryByText(/Someone else changed this expense/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('What was it for?')).toHaveValue('Dinner');
    expect(screen.getByLabelText('Amount')).toHaveValue('45.00');
    expect(screen.getByLabelText('Paid by')).toHaveValue(String(SAM.id));
    expect(box('Leo')).not.toBeChecked();

    client.saveExpense.mockResolvedValueOnce(written(expenseView({ version: 5 })));
    await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(client.saveExpense.mock.calls[1]![1]).toMatchObject({ version: 4, total: 4500, payerId: SAM.id });
  });

  it('does not offer to save over an expense that was deleted', async () => {
    const { user, client } = setup({ expense: expenseView() });
    client.saveExpense.mockRejectedValueOnce(new ApiError(409, 'stale', 'Changed.', { current: expenseView({ version: 4, status: 'deleted' }) }));
    await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/has been deleted in the meantime/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save mine' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toHaveValue('30.00');
  });
});

describe('expense currency and own rate', () => {
  const foreign = () => expenseView({ currency: 'JPY', total: 11240, fxRate: '112.4', fxRateSource: 'trip', homeTotal: 10000 });
  const ready = () => waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());

  it('defaults the picker to the trip home currency', () => {
    setup({ homeCurrency: 'MYR' });
    expect(screen.getByRole('combobox', { name: 'Expense currency' })).toHaveValue('MYR');
  });

  it('saves an untouched trip-sourced expense without rateOverride in either request', async () => {
    const expense = foreign();
    const { client, user } = setup({ expense });
    client.saveExpense.mockResolvedValue(written(expense));
    expect(await screen.findByText('Trip rate')).toBeInTheDocument();
    expect(screen.getByText('100.00 SGD')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(client.saveExpense).toHaveBeenCalledTimes(1);
    expect(client.saveExpense.mock.calls[0]![1]).not.toHaveProperty('rateOverride');
    expect(client.previewExpense.mock.calls[0]![0]).not.toHaveProperty('rateOverride');
  });

  it('sets an own rate as a decimal string from the rate row, then explicitly clears it with null', async () => {
    const expense = foreign();
    const { client, user } = setup({ expense });
    client.saveExpense.mockResolvedValue(written(expense));
    await screen.findByText('Trip rate');
    await user.click(screen.getByRole('button', { name: 'Change exchange rate' }));
    let sheet = screen.getByRole('dialog', { name: 'Exchange rate' });
    // This expense only is the usual choice, and the field starts from the rate in use.
    expect(within(sheet).getByRole('radio', { name: /^This expense only/ })).toBeChecked();
    const input = within(sheet).getByLabelText('How many JPY for 1 SGD');
    expect(input).toHaveValue('112.4');
    await user.clear(input);
    await user.type(input, '100');
    await user.click(within(sheet).getByRole('button', { name: 'Apply' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await screen.findByText("This expense's own rate");
    expect(screen.getByText('112.40 SGD')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(client.saveExpense.mock.calls[0]![1]).toMatchObject({ rateOverride: '100' });
    // The trip's rate was left alone.
    expect(client.request).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Change exchange rate' }));
    sheet = screen.getByRole('dialog', { name: 'Exchange rate' });
    await user.click(within(sheet).getByRole('button', { name: 'Use the trip rate instead' }));
    await screen.findByText('Trip rate');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(client.saveExpense.mock.calls[1]![1]).toMatchObject({ rateOverride: null });
  });

  it('shows the rate row only for a foreign currency', async () => {
    const { user } = setup();
    expect(screen.queryByRole('button', { name: /exchange rate/ })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Amount'), '30');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Expense currency' }), 'JPY');
    expect(screen.getByRole('button', { name: 'Set exchange rate' })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Expense currency' }), 'SGD');
    expect(screen.queryByRole('button', { name: /exchange rate/ })).not.toBeInTheDocument();
  });

  it('preserves a loaded own rate without sending it back as an override', async () => {
    const expense = { ...foreign(), fxRate: '100', fxRateSource: 'expense' as const };
    const { client, user } = setup({ expense });
    client.saveExpense.mockResolvedValue(written(expense));
    await screen.findByText("This expense's own rate");
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(client.saveExpense.mock.calls[0]![1]).not.toHaveProperty('rateOverride');
  });

  it('selects a supported currency, rescales the amount, and uses the API converted total', async () => {
    const { client, user } = setup();
    client.createExpense.mockResolvedValue(written(foreign()));
    await user.type(screen.getByLabelText('Amount'), '84.50');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Expense currency' }), 'JPY');
    expect(screen.getByLabelText('Amount')).toHaveValue('85');
    expect(screen.getByText('JPY has no cents, so 84.50 becomes 85.')).toBeInTheDocument();
    await screen.findByText('The latest rate will be looked up when saving.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(client.createExpense.mock.calls[0]![1]).toMatchObject({ currency: 'JPY', total: 85 });
    expect(client.createExpense.mock.calls[0]![1]).not.toHaveProperty('rateOverride');
    client.previewExpense.mockResolvedValue({ amounts: { 1: 85 }, problems: [], difference: null, fx: { fxRate: '112.4', fxRateSource: 'trip', homeTotal: 12345, homeCurrency: 'SGD' } });
    await user.type(screen.getByLabelText('Amount'), '0');
    expect(await screen.findByText('123.45 SGD')).toBeInTheDocument();
  });

  it('choosing a currency confirms a receipt draft, while saving for later leaves an unchecked draft alone', async () => {
    const expense = expenseView({ status: 'draft', currency: 'THB', currencyNeedsReview: true });
    const { client, user } = setup({ expense });
    client.saveExpense.mockResolvedValue(written(expense));
    await user.click(screen.getByRole('button', { name: 'Save changes, approve later' }));
    expect(client.saveExpense.mock.calls[0]![1]).not.toHaveProperty('currency');
    expect(client.saveExpense.mock.calls[0]![1]).not.toHaveProperty('confirm');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Expense currency' }), 'SGD');
    expect(screen.queryByRole('button', { name: 'Confirm THB' })).not.toBeInTheDocument();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Approve and save' }));
    expect(client.saveExpense.mock.calls[1]![1]).toMatchObject({ currency: 'SGD', confirm: true });
  });
});

describe('a rate that is still being typed', () => {
  it('is never sent: Apply stays off, and a draft is put aside without it', async () => {
    const expense = expenseView({ status: 'draft', currency: 'JPY', total: 11240, fxRate: null, fxRateSource: 'missing', homeTotal: null, homeAmounts: null });
    const { client, user } = setup({ expense });
    client.saveExpense.mockResolvedValue(written(expense));
    await screen.findByText('Exchange rate needed');
    await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    client.previewExpense.mockClear();

    await user.click(screen.getByRole('button', { name: 'Set exchange rate' }));
    let sheet = screen.getByRole('dialog', { name: 'Exchange rate' });
    // The trip has no rate for JPY, so setting one for the trip is offered first.
    expect(within(sheet).getByRole('radio', { name: /^All JPY expenses in this trip/ })).toBeChecked();
    await user.click(within(sheet).getByRole('radio', { name: /^This expense only/ }));
    // The field opens empty, because there is no rate to start from.
    const input = within(sheet).getByLabelText('How many JPY for 1 SGD');
    expect(input).toHaveValue('');
    expect(within(sheet).getByRole('button', { name: 'Apply' })).toBeDisabled();
    await user.type(input, '0');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(within(sheet).getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(within(sheet).getByText('Enter a rate above zero, with up to 6 decimal places.')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.previewExpense).not.toHaveBeenCalled();
    await user.click(within(sheet).getByRole('button', { name: 'Cancel' }));

    // Approving is refused with the reason, and nothing is sent.
    expect(screen.getByRole('button', { name: 'Approve and save' })).toBeDisabled();
    expect(client.saveExpense).not.toHaveBeenCalled();

    // A draft can still be put aside, without a rate.
    await user.click(screen.getByRole('button', { name: 'Save changes, approve later' }));
    expect(client.saveExpense.mock.calls[0]![1]).not.toHaveProperty('rateOverride');

    // Once it can be read it is sent.
    await user.click(screen.getByRole('button', { name: 'Set exchange rate' }));
    sheet = screen.getByRole('dialog', { name: 'Exchange rate' });
    await user.click(within(sheet).getByRole('radio', { name: /^This expense only/ }));
    await user.type(within(sheet).getByLabelText('How many JPY for 1 SGD'), '112.4');
    await user.click(within(sheet).getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('100.00 SGD')).toBeInTheDocument();
    for (const [body] of client.previewExpense.mock.calls) expect((body as { rateOverride?: string }).rateOverride).toBe('112.4');
    await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Approve and save' }));
    expect(client.saveExpense.mock.calls[1]![1]).toMatchObject({ rateOverride: '112.4', confirm: true });
  });
});


/** A preview of a trip rate change, as the rates route answers. */
const ratePreview = (snapshot: string) => ({ currentRate: null, expensesChanged: 1, confirmedExpensesChanged: 0, balancesBefore: {}, balancesAfter: {}, snapshot });

describe('recovering from a failed rate lookup', () => {
  const missing = () => expenseView({ status: 'draft', currency: 'JPY', fxRate: null, fxRateSource: 'missing', notice: "Couldn't look up an exchange rate. Enter one to save this." });

  it('sets the trip rate through preview and apply from the rate sheet, then approves with the updated version', async () => {
    const expense = missing();
    const { client, user, onSaved } = setup({ expense });
    client.request.mockResolvedValueOnce(ratePreview('snapshot')).mockResolvedValueOnce({ tripRate: { currency: 'JPY', rate: '112.4', origin: 'member' }, expensesChanged: 1, updatedExpenses: [{ id: expense.id, version: 4 }] });
    const saved = written({ ...expense, status: 'confirmed', version: 6, fxRate: '112.4', fxRateSource: 'trip' });
    client.saveExpense.mockResolvedValue(saved);
    await user.click(await screen.findByRole('button', { name: 'Set exchange rate' }));
    const sheet = screen.getByRole('dialog', { name: 'Exchange rate' });
    expect(within(sheet).getByRole('radio', { name: /^All JPY expenses in this trip/ })).toBeChecked();
    await user.type(within(sheet).getByLabelText('How many JPY for 1 SGD'), '112.4');
    await user.click(within(sheet).getByRole('button', { name: 'Apply' }));
    // What changes is shown before the trip's rate is set.
    expect(await within(sheet).findByText(/1 saved expense will change/)).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Confirm rate for all JPY expenses' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText('Exchange rate needed')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Approve and save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(client.request.mock.calls).toEqual([
      ['POST', '/api/trips/1/rates/JPY/preview', { rate: '112.4' }],
      ['PUT', '/api/trips/1/rates/JPY', { rate: '112.4', snapshot: 'snapshot' }],
    ]);
    expect(client.saveExpense.mock.calls[0]![1]).toMatchObject({ version: 4, confirm: true });
    expect(client.saveExpense.mock.calls[0]![1]).not.toHaveProperty('rateOverride');
  });

  it('refuses a new expense when no rate can be found: nothing is saved, the input stays, and the rate row asks for one', async () => {
    const message = "Couldn't look up an exchange rate for JPY. Enter the trip rate for JPY to save this expense.";
    const { client, user, onSaved } = setup();
    client.createExpense.mockRejectedValueOnce(new ApiError(400, 'rate_missing', message, { problems: [{ field: 'fxRate', code: 'rate_missing', message }] }));
    await user.type(screen.getByLabelText('What was it for?'), 'Ramen');
    await user.type(screen.getByLabelText('Amount'), '3000');
    await user.selectOptions(screen.getByLabelText('Expense currency'), 'JPY');
    await screen.findByText('The latest rate will be looked up when saving.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByText('Exchange rate needed')).toBeInTheDocument();
    expect(screen.queryByText('The latest rate will be looked up when saving.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('What was it for?')).toHaveValue('Ramen');
    expect(screen.getByLabelText('Amount')).toHaveValue('3000');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(onSaved).not.toHaveBeenCalled();
    // Never a draft.
    expect(screen.queryByRole('button', { name: /draft|approve later/i })).not.toBeInTheDocument();

    // Setting the trip's rate that fails is said in the sheet, and nothing else is sent.
    client.request.mockRejectedValue(new ApiError(400, 'trip_ended', 'This trip has ended.'));
    await user.click(screen.getByRole('button', { name: 'Set exchange rate' }));
    const sheet = screen.getByRole('dialog', { name: 'Exchange rate' });
    expect(within(sheet).getByRole('radio', { name: /^All JPY expenses in this trip/ })).toBeChecked();
    await user.type(within(sheet).getByLabelText('How many JPY for 1 SGD'), '100');
    await user.click(within(sheet).getByRole('button', { name: 'Apply' }));
    expect(await within(sheet).findByText('This trip has ended.')).toBeInTheDocument();
    expect(client.createExpense).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('saves a refused new expense once it has a rate of its own', async () => {
    const { client, user, onSaved } = setup({ tripId: 'active' });
    const saved = written(expenseView({ currency: 'JPY', fxRate: '100', fxRateSource: 'expense' }));
    client.createExpense.mockRejectedValueOnce(new ApiError(400, 'rate_missing', 'A rate is needed.')).mockResolvedValueOnce(saved);
    await user.type(screen.getByLabelText('Amount'), '3000');
    await user.selectOptions(screen.getByLabelText('Expense currency'), 'JPY');
    await screen.findByText('The latest rate will be looked up when saving.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Set exchange rate' }));
    const sheet = screen.getByRole('dialog', { name: 'Exchange rate' });
    // There is no trip yet to set a rate for, so only this expense's own rate is offered.
    expect(within(sheet).getByRole('radio', { name: /^All JPY expenses in this trip/ })).toBeDisabled();
    expect(within(sheet).getByRole('radio', { name: /^This expense only/ })).toBeChecked();
    await user.type(within(sheet).getByLabelText('How many JPY for 1 SGD'), '100');
    await user.click(within(sheet).getByRole('button', { name: 'Apply' }));
    await screen.findByText("This expense's own rate");
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(client.createExpense.mock.calls[1]![1]).toMatchObject({ status: 'confirmed', currency: 'JPY', rateOverride: '100', total: 3000 });
  });

  it('shows a refused approval on the same form', async () => {
    const { client, user, onSaved } = setup({ expense: expenseView({ status: 'draft' }) });
    client.saveExpense.mockRejectedValue(new ApiError(400, 'invalid_status', 'This draft has already been saved.'));
    await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Approve and save' }));
    expect(await screen.findByText('This draft has already been saved.')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('a receipt draft', () => {
  it('is approved with "Approve and save", or saved as it is with "Save changes, approve later", and says where it came from', async () => {
    const expense = expenseView({ status: 'draft', createdBy: ANA.id, receiptFileId: 'file-abc' });
    const { client, user } = setup({ expense });
    client.saveExpense.mockResolvedValue(written(expense));
    expect(screen.getByText('Read from a receipt · added by Ana')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Updating amounts…')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save changes, approve later' }));
    expect(client.saveExpense.mock.calls[0]![1]).not.toHaveProperty('confirm');
    await user.click(screen.getByRole('button', { name: 'Approve and save' }));
    expect(client.saveExpense.mock.calls[1]![1]).toMatchObject({ confirm: true });
  });

  it('has no draft action when the expense is new or already saved', () => {
    setup();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    cleanup();
    setup({ expense: expenseView() });
    expect(screen.queryByRole('button', { name: /approve|draft/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });
});


it('shows a rate snapshot conflict without treating it as an expense conflict', async () => {
  const expense = expenseView({ status: 'draft', currency: 'JPY', fxRate: null, fxRateSource: 'missing' });
  const { client, user, onSaved } = setup({ expense });
  client.request.mockResolvedValueOnce(ratePreview('old')).mockRejectedValueOnce(new ApiError(409, 'stale', 'Changed.', { current: { ...ratePreview('new'), expensesChanged: 2 } }));
  await user.click(await screen.findByRole('button', { name: 'Set exchange rate' }));
  const sheet = screen.getByRole('dialog', { name: 'Exchange rate' });
  await user.type(within(sheet).getByLabelText('How many JPY for 1 SGD'), '100');
  await user.click(within(sheet).getByRole('button', { name: 'Apply' }));
  await user.click(await within(sheet).findByRole('button', { name: 'Confirm rate for all JPY expenses' }));
  expect(await within(sheet).findByText('The trip changed. Check the updated preview below before confirming again.')).toBeInTheDocument();
  expect(within(sheet).getByText(/2 saved expenses will change/)).toBeInTheDocument();
  expect(screen.queryByText(/Someone else changed this expense/)).not.toBeInTheDocument();
  expect(client.saveExpense).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
});

it('saves a second new expense using the trip rate without asking for one', async () => {
  const { client, user, onSaved } = setup();
  const saved = written(expenseView({ currency: 'JPY', fxRate: '100', fxRateSource: 'trip' }));
  client.previewExpense.mockImplementation(async (body) => previewAnswer(body, saved.expense));
  client.createExpense.mockResolvedValue(saved);
  await user.type(screen.getByLabelText('Amount'), '30');
  await user.selectOptions(screen.getByLabelText('Expense currency'), 'JPY');
  await screen.findByText('Trip rate');
  expect(screen.queryByText('Exchange rate needed')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
  expect(client.request).not.toHaveBeenCalled();
  expect(client.createExpense.mock.calls[0]![1]).not.toHaveProperty('rateOverride');
});

describe('the emoji of an expense', () => {
  it('is chosen from a sheet and sent, and left out when untouched', async () => {
    const { client, user } = setup();
    client.createExpense.mockResolvedValue(written(expenseView()));
    await user.type(screen.getByLabelText('Amount'), '12');
    await user.click(screen.getByRole('button', { name: 'Add an emoji' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Choose an emoji' })).getByRole('button', { name: '🍜' }));
    expect(screen.getByRole('button', { name: 'Emoji 🍜, change' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(client.createExpense.mock.calls[0]![1]).toMatchObject({ emoji: '🍜' });
  });

  it('is kept as it was when an expense is saved without touching it', async () => {
    const { client, user } = setup({ expense: expenseView({ emoji: '🍣' }) });
    client.saveExpense.mockResolvedValue(written(expenseView()));
    expect(screen.getByRole('button', { name: 'Emoji 🍣, change' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(client.saveExpense.mock.calls[0]![1]).not.toHaveProperty('emoji');
  });
});
