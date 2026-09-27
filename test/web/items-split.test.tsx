// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../web/src/api/client';
import type { CreateExpenseBody, ExpenseItem, ExpenseView, Share } from '../../web/src/api/types';
import { ExpenseForm, type ExpenseFormProps } from '../../web/src/expense-form/ExpenseForm';
import { ANA, LEO, MEMBERS, SAM, expenseView, fakeClient, previewAnswer, written } from './helpers';

afterEach(cleanup);

const item = (id: number, label: string, amount: number, quantity = 1): ExpenseItem => ({ id, expenseId: 7, label, quantity, amount, position: id });
const on = (id: number, memberId: number, itemId: number): Share => ({ id, memberId, weight: 1, expenseId: null, itemId });

/**
 * A draft as the receipt reader leaves it: Paella x2 32.00, Beer 4.50, Bread 3.00, tax 3.95 on top, tip 5.00,
 * total 48.45, paid by Ana, nobody assigned to anything.
 */
function receipt(over: Partial<ExpenseView> = {}): ExpenseView {
  return expenseView({
    status: 'draft',
    description: '',
    total: 4845,
    tax: 395,
    tip: 500,
    splitType: 'even',
    items: [item(50, 'Paella', 3200, 2), item(51, 'Beer', 450), item(52, 'Bread', 300)],
    ...over,
  });
}

function setup(over: Partial<ExpenseFormProps> = {}) {
  const client = fakeClient();
  client.previewExpense.mockImplementation(async (body: CreateExpenseBody) => previewAnswer(body));
  const onSaved = vi.fn();
  const user = userEvent.setup();
  render(<ExpenseForm client={client} members={MEMBERS} meId={SAM.id} tripId={1} homeCurrency="SGD" onSaved={onSaved} {...over} />);
  return { client, onSaved, user };
}

/** Opens the receipt and chooses the split by item. */
async function openReceipt(over: Partial<ExpenseView> = {}) {
  const result = setup({ expense: receipt(over) });
  await result.user.click(screen.getByRole('radio', { name: 'By item' }));
  return result;
}

const save = () => screen.getByRole('button', { name: 'Finish and save' });
const person = (name: string) => within(screen.getByRole('group', { name: 'Pick a person' })).getByRole('button', { name: new RegExp(`^${name}`) });
const line = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}`) });
const pays = () => within(screen.getByRole('list', { name: 'Each person pays' })).getAllByRole('listitem').map((li) => li.textContent);
const lastPreview = (client: ReturnType<typeof fakeClient>): CreateExpenseBody => client.previewExpense.mock.calls.at(-1)![0] as CreateExpenseBody;
const settled = () => waitFor(() => expect(screen.queryByText('Working it out…')).not.toBeInTheDocument());

describe('paint mode', () => {
  it('assigns the items of the person picked, and shows and saves what the server answered', async () => {
    const { client, onSaved, user } = await openReceipt();
    expect(screen.getByText('Tap a name, then tap everything that person had.')).toBeInTheDocument();
    for (const label of ['Paella', 'Beer', 'Bread']) expect(within(line(label)).getByText('Everyone')).toBeInTheDocument();

    await user.click(person('Sam'));
    expect(person('Sam')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Now tap everything Sam had.')).toBeInTheDocument();
    await user.click(line('Paella'));
    await user.click(line('Beer'));
    expect(line('Beer')).toHaveAttribute('aria-pressed', 'true');
    expect(line('Bread')).toHaveAttribute('aria-pressed', 'false');
    // No list of people opened: one tap per item.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(person('Ana'));
    expect(person('Sam')).toHaveAttribute('aria-pressed', 'false');
    await user.click(line('Paella'));
    expect(within(line('Paella')).getByText('Ana, Sam')).toBeInTheDocument();
    expect(within(line('Beer')).getByText('Sam')).toBeInTheDocument();
    expect(within(line('Bread')).getByText('Everyone')).toBeInTheDocument();

    // Worked out by hand: items 17.00, 21.50 and 1.00; tax and tip 8.95 in proportion; the cent left to Ana, who paid.
    await waitFor(() => expect(pays()).toEqual(['Ana20.86 SGD', 'Leo1.22 SGD', 'Sam26.37 SGD']));
    expect(person('Sam')).toHaveTextContent('26.37 SGD');

    // A second tap takes the person off the item again.
    await user.click(line('Paella'));
    expect(within(line('Paella')).getByText('Sam')).toBeInTheDocument();
    await user.click(line('Paella'));
    await user.click(screen.getByRole('button', { name: 'Finished' }));
    expect(screen.getByText('Tap a name, then tap everything that person had.')).toBeInTheDocument();
    await waitFor(() => expect(pays()).toEqual(['Ana20.86 SGD', 'Leo1.22 SGD', 'Sam26.37 SGD']));
    await settled();

    const saved = written(receipt({ status: 'confirmed', splitType: 'items' }));
    client.saveExpense.mockResolvedValue(saved);
    await user.click(save());
    expect(client.saveExpense).toHaveBeenCalledTimes(1);
    const [id, body] = client.saveExpense.mock.calls[0]!;
    expect(id).toBe(7);
    expect(body).toMatchObject({
      version: 3,
      confirm: true,
      splitType: 'items',
      total: 4845,
      tax: 395,
      taxIncluded: false,
      tip: 500,
      shares: [{ memberId: ANA.id }, { memberId: SAM.id }, { memberId: LEO.id }],
      items: [
        { label: 'Paella', quantity: 2, amount: 3200, shares: [{ memberId: SAM.id }, { memberId: ANA.id }] },
        { label: 'Beer', quantity: 1, amount: 450, shares: [{ memberId: SAM.id }] },
        { label: 'Bread', quantity: 1, amount: 300, shares: [] },
      ],
    });
    // What was saved is what the amounts on the screen were worked out from.
    const { version: _version, confirm: _confirm, ...sent } = body as Record<string, unknown>;
    expect(sent).toEqual(lastPreview(client));
    expect(onSaved).toHaveBeenCalledWith(saved);
  });

  it('works out nothing by itself: the amounts are the ones the server gave', async () => {
    const client = fakeClient();
    client.previewExpense.mockResolvedValue({ amounts: { [ANA.id]: 4000, [SAM.id]: 800, [LEO.id]: 45 }, problems: [], difference: null });
    render(<ExpenseForm client={client} members={MEMBERS} meId={SAM.id} tripId={1} homeCurrency="SGD" onSaved={vi.fn()} expense={receipt({ splitType: 'items' })} />);
    await waitFor(() => expect(pays()).toEqual(['Ana40.00 SGD', 'Leo0.45 SGD', 'Sam8.00 SGD']));
    expect(person('Leo')).toHaveTextContent('0.45 SGD');
  });

  it('shows who is on each item of a saved expense', async () => {
    setup({ expense: receipt({ status: 'confirmed', splitType: 'items', shares: [...expenseView().shares, on(10, ANA.id, 50), on(11, SAM.id, 50), on(12, SAM.id, 51)] }) });
    expect(within(line('Paella ×2')).getByText('Ana, Sam')).toBeInTheDocument();
    expect(within(line('Beer')).getByText('Sam')).toBeInTheDocument();
    await waitFor(() => expect(pays()).toEqual(['Ana20.86 SGD', 'Leo1.22 SGD', 'Sam26.37 SGD']));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });
});

describe('an item', () => {
  it('opens a list of the people included when tapped, and can be shared by several', async () => {
    const { client, user } = await openReceipt();
    await user.click(line('Bread'));
    const sheet = screen.getByRole('dialog', { name: 'Change this item' });
    expect(within(sheet).getAllByRole('checkbox').map((box) => (box.closest('label') as HTMLElement).textContent)).toEqual(['Ana', 'Leo', 'Sam']);
    expect(within(sheet).getByText('Nobody ticked: everyone shares it.')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('checkbox', { name: 'Ana' }));
    await user.click(within(sheet).getByRole('checkbox', { name: 'Leo' }));
    expect(within(sheet).getByText('2 people share it equally.')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(line('Bread')).getByText('Ana, Leo')).toBeInTheDocument();
    await waitFor(() => expect(lastPreview(client).items![2]!.shares).toEqual([{ memberId: ANA.id }, { memberId: LEO.id }]));
  });

  it('keeps its line total when the quantity changes', async () => {
    const { client, user } = await openReceipt();
    await user.click(line('Beer'));
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByLabelText('Line total')).toHaveValue('4.50');
    await user.clear(within(sheet).getByLabelText('How many'));
    await user.type(within(sheet).getByLabelText('How many'), '3');
    expect(within(sheet).getByLabelText('Line total')).toHaveValue('4.50');
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(within(line('Beer ×3')).getByText('4.50 SGD')).toBeInTheDocument();
    await settled();
    expect(save()).toBeEnabled();
    client.saveExpense.mockResolvedValue(written(receipt()));
    await user.click(save());
    expect(client.saveExpense.mock.calls[0]![1].items[1]).toEqual({ label: 'Beer', quantity: 3, amount: 450, shares: [] });
  });

  it('can be added, changed and removed', async () => {
    const { client, user } = await openReceipt();
    await user.click(screen.getByRole('button', { name: 'Add an item' }));
    let sheet = screen.getByRole('dialog', { name: 'Add an item' });
    await user.type(within(sheet).getByLabelText('What was it?'), 'Flan');
    await user.type(within(sheet).getByLabelText('Line total'), '6,5');
    await user.click(within(sheet).getByRole('checkbox', { name: 'Leo' }));
    await user.click(within(sheet).getByRole('button', { name: 'Add and enter another' }));
    // The sheet stays open, empty, for the next line.
    sheet = screen.getByRole('dialog', { name: 'Add an item' });
    expect(within(sheet).getByLabelText('What was it?')).toHaveValue('');
    expect(within(sheet).getByLabelText('Line total')).toHaveValue('');
    expect(within(sheet).getByRole('checkbox', { name: 'Leo' })).not.toBeChecked();
    await user.type(within(sheet).getByLabelText('What was it?'), 'Coffee');
    await user.type(within(sheet).getByLabelText('Line total'), '3');
    await user.click(within(sheet).getByRole('button', { name: 'Add item' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(line('Flan')).getByText('6.50 SGD')).toBeInTheDocument();
    expect(within(line('Flan')).getByText('Leo')).toBeInTheDocument();
    expect(within(line('Coffee')).getByText('3.00 SGD')).toBeInTheDocument();

    await user.click(line('Coffee'));
    sheet = screen.getByRole('dialog', { name: 'Change this item' });
    await user.clear(within(sheet).getByLabelText('What was it?'));
    await user.type(within(sheet).getByLabelText('What was it?'), 'Espresso');
    await user.clear(within(sheet).getByLabelText('Line total'));
    await user.type(within(sheet).getByLabelText('Line total'), '2.80');
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(within(line('Espresso')).getByText('2.80 SGD')).toBeInTheDocument();

    await user.click(line('Beer'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove this item' }));
    expect(screen.queryByRole('button', { name: /^Beer/ })).not.toBeInTheDocument();

    // Changes that are given up change nothing.
    await user.click(line('Bread'));
    await user.type(within(screen.getByRole('dialog')).getByLabelText('Line total'), '9');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(within(line('Bread')).getByText('3.00 SGD')).toBeInTheDocument();

    await waitFor(() =>
      expect(lastPreview(client).items).toEqual([
        { label: 'Paella', quantity: 2, amount: 3200, shares: [] },
        { label: 'Bread', quantity: 1, amount: 300, shares: [] },
        { label: 'Flan', quantity: 1, amount: 650, shares: [{ memberId: LEO.id }] },
        { label: 'Espresso', quantity: 1, amount: 280, shares: [] },
      ]),
    );
  });

  it('loses a person who is taken out of the expense', async () => {
    const { client, user } = await openReceipt();
    await user.click(person('Leo'));
    await user.click(line('Beer'));
    await user.click(person('Sam'));
    await user.click(line('Beer'));
    expect(within(line('Beer')).getByText('Leo, Sam')).toBeInTheDocument();

    expect(screen.getByText('Ana, Leo, Sam')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.click(screen.getByRole('checkbox', { name: 'Leo' }));
    expect(within(line('Beer')).getByText('Sam')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Pick a person' })).queryByRole('button', { name: /^Leo/ })).not.toBeInTheDocument();
    await waitFor(() => expect(pays()).toEqual(['Ana21.47 SGD', 'Sam26.98 SGD']));
    expect(lastPreview(client)).toMatchObject({ shares: [{ memberId: ANA.id }, { memberId: SAM.id }] });
    expect(lastPreview(client).items![1]!.shares).toEqual([{ memberId: SAM.id }]);
  });
});

describe('tax, tip, service charge and discount', () => {
  it('are figures that can be changed, and tax can be marked as already in the prices', async () => {
    const { client, user } = await openReceipt();
    expect(screen.getByLabelText('Tax')).toHaveValue('3.95');
    expect(screen.getByLabelText('Tip')).toHaveValue('5.00');
    expect(screen.getByLabelText('Service charge')).toHaveValue('');
    expect(screen.getByLabelText('Discount')).toHaveValue('');
    await settled();
    expect(save()).toBeEnabled();

    await user.click(screen.getByRole('checkbox', { name: 'Tax is already in the prices' }));
    await waitFor(() => expect(lastPreview(client)).toMatchObject({ tax: 395, taxIncluded: true }));
    // The tax no longer counts, so the amount is 3.95 more than the rest explains.
    expect(await screen.findByText('The amount is 3.95 SGD more than the items add up to.')).toBeInTheDocument();
    expect(save()).toBeDisabled();

    await user.type(screen.getByLabelText('Service charge'), '3.95');
    await waitFor(() => expect(screen.queryByText(/more than the items add up to/)).not.toBeInTheDocument());
    await settled();
    expect(lastPreview(client)).toMatchObject({ tax: 395, taxIncluded: true, serviceCharge: 395, tip: 500, discount: 0 });
    expect(save()).toBeEnabled();

    // Only amounts can be typed.
    await user.clear(screen.getByLabelText('Tip'));
    await user.type(screen.getByLabelText('Tip'), '-4,256x');
    expect(screen.getByLabelText('Tip')).toHaveValue('4.25');
    await waitFor(() => expect(lastPreview(client).tip).toBe(425));
  });
});

describe('when the amount is more than the items explain', () => {
  async function tooMuch() {
    const result = await openReceipt({ total: 5000 });
    const box = (await screen.findByText('The amount is 1.55 SGD more than the items add up to.')).closest('.difference') as HTMLElement;
    expect(save()).toBeDisabled();
    expect(within(box).getAllByRole('button').map((b) => b.textContent)).toEqual(['Change the amount to 48.45 SGD', 'Add 1.55 SGD as “Other”, shared by everyone']);
    return { ...result, box };
  }

  it('changes the amount to match', async () => {
    const { client, user, box } = await tooMuch();
    await user.click(within(box).getByRole('button', { name: 'Change the amount to 48.45 SGD' }));
    expect(screen.getByLabelText('Amount')).toHaveValue('48.45');
    await waitFor(() => expect(pays()).toHaveLength(3));
    expect(screen.queryByText(/more than the items/)).not.toBeInTheDocument();
    expect(lastPreview(client)).toMatchObject({ total: 4845, discount: 0 });
    expect(lastPreview(client).items).toHaveLength(3);
    await settled();
    expect(save()).toBeEnabled();
  });

  it('adds the difference as an item called Other, shared by everyone', async () => {
    const { client, user, box } = await tooMuch();
    await user.click(within(box).getByRole('button', { name: /as “Other”/ }));
    expect(within(line('Other')).getByText('1.55 SGD')).toBeInTheDocument();
    expect(within(line('Other')).getByText('Everyone')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toHaveValue('50.00');
    await waitFor(() => expect(pays()).toHaveLength(3));
    expect(screen.queryByText(/more than the items/)).not.toBeInTheDocument();
    expect(lastPreview(client)).toMatchObject({ total: 5000, discount: 0 });
    expect(lastPreview(client).items!.at(-1)).toEqual({ label: 'Other', quantity: 1, amount: 155, shares: [] });
    await settled();
    expect(save()).toBeEnabled();
  });
});

describe('when the amount is less than the items explain', () => {
  it('offers the two choices and never an item below zero', async () => {
    const result = await openReceipt({ total: 4800 });
    const box = (await screen.findByText('The amount is 0.45 SGD less than the items add up to.')).closest('.difference') as HTMLElement;
    expect(save()).toBeDisabled();
    expect(within(box).getAllByRole('button').map((b) => b.textContent)).toEqual(['Change the amount to 48.45 SGD', 'Enter 0.45 SGD as a discount']);
    expect(screen.queryByRole('button', { name: /Other/ })).not.toBeInTheDocument();
    for (const [body] of result.client.previewExpense.mock.calls as Array<[CreateExpenseBody]>) for (const entry of body.items ?? []) expect(entry.amount).toBeGreaterThanOrEqual(0);
  });

  it('changes the amount to match', async () => {
    const { client, user } = await openReceipt({ total: 4800 });
    await user.click(await screen.findByRole('button', { name: 'Change the amount to 48.45 SGD' }));
    expect(screen.getByLabelText('Amount')).toHaveValue('48.45');
    // Everything is shared by everyone. Items: 13.18 for Ana, who gets the 2 cents left of the paella, 13.16 for the others.
    // Tax and tip 8.95 in proportion is 2.98 each, and the cent left over goes to Ana, who paid.
    await waitFor(() => expect(pays()).toEqual(['Ana16.17 SGD', 'Leo16.14 SGD', 'Sam16.14 SGD']));
    expect(lastPreview(client)).toMatchObject({ total: 4845, discount: 0 });
    await settled();
    expect(save()).toBeEnabled();
  });

  it('enters the difference as a discount, on top of the discount there was', async () => {
    // 39.50 + 3.95 + 5.00 - 1.00 is 47.45, and the amount is 47.00.
    const { client, user } = await openReceipt({ total: 4700, discount: 100 });
    const button = await screen.findByRole('button', { name: /as a discount/ });
    expect(button).toHaveTextContent('Enter 0.45 SGD as a discount');
    await user.click(button);
    expect(screen.getByLabelText('Discount')).toHaveValue('1.45');
    expect(screen.getByLabelText('Amount')).toHaveValue('47.00');
    await waitFor(() => expect(pays()).toHaveLength(3));
    expect(screen.queryByText(/less than the items/)).not.toBeInTheDocument();
    expect(lastPreview(client)).toMatchObject({ total: 4700, discount: 145 });
    expect(lastPreview(client).items!.map((i) => i.amount)).toEqual([3200, 450, 300]);
    await settled();
    expect(save()).toBeEnabled();
  });

  it('offers to use the sum when no amount was entered', async () => {
    const { user } = await openReceipt({ total: 0 });
    expect(await screen.findByText('No amount entered yet.')).toBeInTheDocument();
    expect(save()).toBeDisabled();
    expect(screen.queryByRole('button', { name: /as a discount/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use 48.45 SGD' }));
    expect(screen.getByLabelText('Amount')).toHaveValue('48.45');
    await waitFor(() => expect(pays()).toHaveLength(3));
    await settled();
    expect(save()).toBeEnabled();
  });
});

describe('Save', () => {
  it('is off while the server reports a problem, and says which next to the field', async () => {
    const { client, user } = await openReceipt({ total: 500, tax: 0, tip: 500, items: [item(50, 'Water', 0), item(51, 'Bread', 0)] });
    const problem = await screen.findByText(/so the items cannot all be zero/);
    expect(problem.closest('section')).toContainElement(line('Water'));
    expect(save()).toBeDisabled();
    expect(screen.getByText('Shown once the figures above add up.')).toBeInTheDocument();
    await user.click(save());
    expect(client.saveExpense).not.toHaveBeenCalled();

    // Nobody included.
    await user.click(screen.getByRole('button', { name: 'Change' }));
    for (const name of ['Ana', 'Sam', 'Leo']) await user.click(screen.getByRole('checkbox', { name }));
    const nobody = await screen.findByText('Choose at least one person to split with.');
    expect(nobody.closest('section')).toContainElement(screen.getByRole('checkbox', { name: 'Ana' }));
    expect(save()).toBeDisabled();

    // A draft may still be put aside as it is.
    client.saveExpense.mockResolvedValue(written(receipt()));
    await user.click(screen.getByRole('button', { name: 'Save draft for later' }));
    expect(client.saveExpense).toHaveBeenCalledTimes(1);
    expect(client.saveExpense.mock.calls[0]![1]).not.toHaveProperty('confirm');
  });

  it('is off until the answer for what is on the screen has arrived', async () => {
    const client = fakeClient();
    const waiting: Array<() => void> = [];
    client.previewExpense.mockImplementation((body: CreateExpenseBody) => new Promise((resolve) => waiting.push(() => resolve(previewAnswer(body)))));
    const user = userEvent.setup();
    render(<ExpenseForm client={client} members={MEMBERS} meId={SAM.id} tripId={1} homeCurrency="SGD" onSaved={vi.fn()} expense={receipt({ splitType: 'items' })} />);
    await waitFor(() => expect(waiting).toHaveLength(1));
    expect(save()).toBeDisabled();
    expect(screen.getAllByText('Working it out…').length).toBeGreaterThan(0);
    waiting[0]!();
    await waitFor(() => expect(save()).toBeEnabled());

    // A change turns it off again until the new answer is there, and a late answer to an old question is ignored.
    await user.click(person('Sam'));
    await user.click(line('Beer'));
    expect(save()).toBeDisabled();
    await waitFor(() => expect(waiting).toHaveLength(2));
    await user.click(line('Bread'));
    await waitFor(() => expect(waiting).toHaveLength(3));
    waiting[1]!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(save()).toBeDisabled();
    waiting[2]!();
    await waitFor(() => expect(save()).toBeEnabled());
    // Sam has the beer and the bread, and a third of the paella.
    expect(pays()).toEqual(['Ana13.11 SGD', 'Leo13.07 SGD', 'Sam22.27 SGD']);
  });

  it('is off when the server cannot be asked, until asking again works', async () => {
    const client = fakeClient();
    client.previewExpense.mockRejectedValueOnce(new ApiError(0, 'network', 'Could not reach TripSplitter. Check your connection and try again.'));
    const user = userEvent.setup();
    render(<ExpenseForm client={client} members={MEMBERS} meId={SAM.id} tripId={1} homeCurrency="SGD" onSaved={vi.fn()} expense={receipt({ splitType: 'items' })} />);
    expect(await screen.findByText(/Could not reach TripSplitter/)).toBeInTheDocument();
    expect(save()).toBeDisabled();
    client.previewExpense.mockImplementation(async (body: CreateExpenseBody) => previewAnswer(body));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(save()).toBeEnabled());
    expect(screen.queryByText(/Could not reach TripSplitter/)).not.toBeInTheDocument();
  });

  it('is off while the amount cannot be read, without asking the server', async () => {
    const { client, user } = await openReceipt();
    await settled();
    const asked = client.previewExpense.mock.calls.length;
    await user.type(screen.getByLabelText('Amount'), '9');
    expect(screen.getByRole('alert')).toHaveTextContent('such as 84.50');
    expect(save()).toBeDisabled();
    expect(client.previewExpense).toHaveBeenCalledTimes(asked);
  });

  it('does not ask the server for a split that is worked out in the form', async () => {
    const { client, user } = setup();
    await user.type(screen.getByLabelText('Amount'), '10');
    await user.click(screen.getByRole('radio', { name: 'Portions' }));
    expect(client.previewExpense).not.toHaveBeenCalled();
  });

  it('creates a new expense that was entered by hand', async () => {
    const { client, onSaved, user } = setup();
    const saved = written(expenseView({ splitType: 'items' }));
    client.createExpense.mockResolvedValue(saved);
    await user.type(screen.getByLabelText('What was it for?'), 'Lunch');
    await user.click(screen.getByRole('radio', { name: 'By item' }));
    expect(screen.getByText('Nothing here yet. Add each line of the receipt.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Add an item' }));
    await user.type(screen.getByLabelText('What was it?'), 'Laksa');
    await user.type(screen.getByLabelText('Line total'), '12');
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    await user.click(await screen.findByRole('button', { name: 'Use 12.00 SGD' }));
    await user.click(person('Leo'));
    await user.click(line('Laksa'));
    await waitFor(() => expect(pays()).toEqual(['Ana0.00 SGD', 'Leo12.00 SGD', 'Sam0.00 SGD']));
    await settled();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(client.createExpense).toHaveBeenCalledTimes(1);
    expect(client.createExpense.mock.calls[0]![1]).toMatchObject({
      status: 'confirmed',
      description: 'Lunch',
      payerId: SAM.id,
      total: 1200,
      splitType: 'items',
      items: [{ label: 'Laksa', quantity: 1, amount: 1200, shares: [{ memberId: LEO.id }] }],
    });
    expect(onSaved).toHaveBeenCalledWith(saved);
  });
});
