# PRD 4: By-item split

Depends on PRDs 2 and 3. Runs alone. Owns `web/src/split-items/`, and may edit the expense form and its split type registry, the API client and types under `web/`, the expense routes under `src/api/`, and `test/api/` and `test/web/`.

Read [README.md](README.md) and `docs/foundation-api.md` first. Validation and arithmetic come from PRD 0 and are not reimplemented here.

## Goal

One person can split a long restaurant receipt by item, alone, quickly.

## Screen

Added to the expense form's split type registry and enabled as the third option of the switch.

```
Casa Pepe                 84.50 SGD
Paid by: Ana

Paella x2        32.00    Ana, Sam
Beer              4.50    Sam
Bread             3.00    everyone
...
Tax               7.68    [ ] already in the prices
Tip               5.00

Sam 31.20 · Leo 22.80 · Ana 30.50
[ Save ]
```

- Tapping an item opens a list of the members included in the expense, to tick. More than one person can share an item.
- An item with nobody ticked shows "everyone" and is shared by all members included in the expense.
- **Paint mode**: pick a person at the top, then tap each of their items. This is the fast path for long receipts.
- Items can be added, edited and removed. The amount field is labelled "Line total". Changing the quantity does not change the amount.
- Tax, tip, service charge and discount are editable figures, zero or more. "Already in the prices" sets `tax_included`.
- The per-person amounts update on every change through the preview route, so the screen and the saved result cannot disagree.
- Save is disabled while the preview reports a problem.

### When the figures do not add up

The preview reports the difference as total minus expected total.

| Difference | Choices offered |
|---|---|
| Positive: the total is more than the items explain | Change the total to match, or add the difference as an item called "Other" shared by everyone |
| Negative: the total is less than the items explain | Change the total to match, or enter the difference as a discount |

A negative item is never created.

Other problems from the preview, such as nobody included or zero-value items with a tip, are shown next to the field they concern.

## API

- `POST /api/expenses/preview` takes an unsaved expense in the same shape as create and save, and returns each person's amount in the expense currency, or the list of problems. It changes nothing. Member and item references are checked against the caller's group exactly as for a save.
- Create, save and confirm already accept items through PRD 2 and use the same validation. This build adds tests for them with item splits.

## Left out

Letting each person claim their own items from the group message is not part of this build.

## Tests

API:

- Preview and save of an item split, with an unassigned item, a shared item and an item with quantity 2.
- Tax not included, tax included with a service charge, and a discount.
- Positive and negative differences reported with the right sign.
- Zero-value items with a tip refused.
- An item assigned to a member not included in the expense refused.
- A member from another group in a preview refused.
- A manually entered item split created through `POST`, not only saved through `PUT`.
- Confirming a receipt draft after assigning its items.

Components: paint mode, each choice in the difference table, and Save disabled while there is a problem.

## Done when

A 12-line receipt from the test set can be split by item by one person, and the saved amounts match a hand calculation.
