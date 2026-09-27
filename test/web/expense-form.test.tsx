// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../web/src/api/client';
import { ExpenseForm, type ExpenseFormProps } from '../../web/src/expense-form/ExpenseForm';
import { registerSplitType, splitType, type SplitBodyProps } from '../../web/src/expense-form/registry';
import { today } from '../../web/src/format';
import { ANA, KAI, LEO, MEMBERS, SAM, expenseView, fakeClient, written } from './helpers';

afterEach(cleanup);

function setup(over: Partial<ExpenseFormProps> = {}) {
  const client = fakeClient();
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
    expect(screen.getByLabelText('Date')).toHaveValue(today());
    expect(screen.getByLabelText('Paid by')).toHaveValue(String(SAM.id));
    expect(screen.getByRole('option', { name: 'Sam (you)' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Evenly' })).toBeChecked();
    expect(box('Ana')).toBeChecked();
    expect(box('Sam')).toBeChecked();
    expect(box('Leo')).toBeChecked();
    // Kai left the chat and is not offered for a new expense.
    expect(screen.queryByText('Kai')).not.toBeInTheDocument();
    // No currency to choose and no rate to enter in this build.
    expect(screen.getByText('SGD')).toBeInTheDocument();
    expect(screen.queryByLabelText(/currency/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/rate/i)).not.toBeInTheDocument();
  });

  it('shows each share while typing and sends the people ticked', async () => {
    const { client, onSaved, user } = setup();
    const saved = written(expenseView());
    client.createExpense.mockResolvedValue(saved);

    await user.type(screen.getByLabelText('What was it for?'), 'Dinner');
    await user.type(screen.getByLabelText('Amount'), '10.00');
    // The cent left over goes to the payer.
    expect(within(row('Sam')).getByText('3.34 SGD')).toBeInTheDocument();
    expect(within(row('Ana')).getByText('3.33 SGD')).toBeInTheDocument();

    await user.click(box('Leo'));
    expect(within(row('Ana')).getByText('5.00 SGD')).toBeInTheDocument();
    expect(within(row('Leo')).queryByText(/SGD/)).not.toBeInTheDocument();

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
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the amount.');

    await user.type(screen.getByLabelText('Amount'), '12.345');
    expect(screen.getByRole('alert')).toHaveTextContent('such as 84.50');
    await user.clear(screen.getByLabelText('Amount'));
    await user.type(screen.getByLabelText('Amount'), '12,5');
    expect(screen.getByLabelText('Amount')).toHaveValue('12.5');

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one person.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(client.createExpense).not.toHaveBeenCalled();

    // A draft may be incomplete.
    client.createExpense.mockResolvedValue(written(expenseView({ status: 'draft' })));
    await user.click(screen.getByRole('button', { name: 'Save as draft' }));
    expect(client.createExpense.mock.calls[0]![1]).toMatchObject({ status: 'draft', total: 1250, shares: [] });
  });

  it('shows what the server refused and keeps the input', async () => {
    const { client, onSaved, user } = setup({ tripId: 'active' });
    client.createExpense.mockRejectedValue(new ApiError(400, 'trip_ended', 'This trip has ended.'));
    await user.type(screen.getByLabelText('Amount'), '8');
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
    expect(within(row('Ana')).getByText('6.00 SGD')).toBeInTheDocument();
    expect(within(row('Sam')).getByText('3.00 SGD')).toBeInTheDocument();
    expect(within(row('Leo')).queryByText(/SGD/)).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('Portions for Sam'));
    await user.type(screen.getByLabelText('Portions for Sam'), '4');
    expect(within(row('Sam')).getByText('6.00 SGD')).toBeInTheDocument();

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
  it('shows the items split, disabled, until a body is registered for it', async () => {
    const original = splitType('items');
    const { user, view } = setup();
    const option = screen.getByRole('radio', { name: /By item/ });
    expect(option).toBeDisabled();
    await user.click(option);
    expect(screen.getByRole('radio', { name: 'Evenly' })).toBeChecked();
    view.unmount();

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
      expect(seen.at(-1)!.amounts).not.toBeNull();
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
    expect(screen.getByText('Rate: 1 SGD = 112.4 JPY')).toBeInTheDocument();
    expect(screen.getByText('100.00 SGD')).toBeInTheDocument();
    expect(within(row('Sam')).getByText('3746 JPY')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /currency/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Finish and save' }));
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
    expect(screen.getByText('No exchange rate yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save draft for later' }));
    expect(client.saveExpense.mock.calls[0]![1]).not.toHaveProperty('confirm');
  });

  it('with a guessed currency asks for it to be checked', async () => {
    const expense = expenseView({ status: 'draft', currency: 'THB', currencyNeedsReview: true, fxRate: '26.1', fxRateSource: 'trip' });
    const { client, user } = setup({ expense });
    client.saveExpense.mockResolvedValue(written(expense));
    await user.click(screen.getByRole('button', { name: 'Finish and save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Check the currency first');
    expect(client.saveExpense).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox', { name: /Yes, this is in THB/ }));
    await user.click(screen.getByRole('button', { name: 'Finish and save' }));
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
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(client.saveExpense.mock.calls[1]![1]).toMatchObject({ version: 4, total: 4500, payerId: SAM.id });
  });

  it('does not offer to save over an expense that was deleted', async () => {
    const { user, client } = setup({ expense: expenseView() });
    client.saveExpense.mockRejectedValueOnce(new ApiError(409, 'stale', 'Changed.', { current: expenseView({ version: 4, status: 'deleted' }) }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/has been deleted in the meantime/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save mine' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toHaveValue('30.00');
  });
});
