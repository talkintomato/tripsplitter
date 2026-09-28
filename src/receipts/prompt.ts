import { CURRENCIES } from '../core/index.js';

/** The instructions sent with every receipt photo. The list of currencies comes from `CURRENCIES`. */
export function buildReceiptPrompt(): string {
  const currencies = CURRENCIES.map((c) => `${c.code} (${c.name}, ${c.decimals === 0 ? 'no decimals' : `${c.decimals} decimals`})`).join(', ');
  return `The image is a photo that a traveller took, most likely of a receipt or a bill. Read it and return its contents in the required structure. The result becomes a draft expense that a group of friends will split, so a wrong number costs someone money. A value you leave as null is safe, because a person fills it in. A value you invent is not.

Return what is printed
- Copy the figures as they are printed. Do not calculate a value that is not printed: no adding up items to get a total, no working out a tax from a percentage, no splitting a total into items. When a value is not printed or cannot be read, return null for it, and leave out any item whose amount you cannot read.
- Amounts are plain decimal strings in major units with a dot as the decimal separator and no currency symbol or thousands separator: "84.50", "1200". Keep the number of decimals that is printed.
- total is the final amount to pay, after tax, service charge and discounts. When the receipt shows both a subtotal and a total, return the total. When no total is printed, return null.

Not a receipt
- Treat as a receipt anything that shows an amount someone paid or has to pay for something: a paper receipt, a bill, an invoice, an e-receipt, a booking or order confirmation (hotels, flights, trains, tours), a payment confirmation, or a screenshot of any of these from an email or an app. For a booking, the merchant is the hotel, airline or company, and the total is the full price to pay, including taxes and fees.
- When the image is anything else, for example a menu, a person, a view or a screenshot of a chat, return is_receipt false, with every other value null or false and an empty list of items.

Items
- One entry per printed line, in the printed order, with the label as printed.
- amount is the full line total as printed. For a line "Beer x2 16.00" the amount is "16.00" and the quantity is 2. Never multiply or divide an amount by the quantity. When a line shows both a unit price and a line total, return the line total.
- quantity is the printed quantity, and 1 when none is printed.
- A line printed with a negative amount, such as a discount, a voucher or a promotion, is not an item. Leave it out of the items and add its amount, made positive, to discount. discount is the sum of all such lines and of any discount printed separately, as a positive amount.
- Subtotal, tax, service charge, tip, rounding, total, payment and change lines are not items.

Tax, tip and service charge
- tax, tip and service_charge are the amounts printed for them, or null when not printed.
- tax_included is true when the item prices already include the tax, which receipts show with wording such as "incl. GST", "tax included" or "of which VAT", and false when the tax is added on top of the items to reach the total. Return null when you cannot tell.

Date
- date is the date of the purchase as an ISO date, YYYY-MM-DD. Work out the order of day and month from the country of the merchant. Return null when no date is printed.

Currency
- currency is the ISO 4217 code of the currency the amounts are in. The app supports these: ${currencies}.
- When the receipt prints a code or an unambiguous name or symbol, such as "SGD", "S$", "RM", "THB", "Rp", "€" or "₩", return that currency and set currency_certain to true.
- Several currencies share a symbol: "$" is used for SGD, USD, AUD and NZD among others, and "¥" for JPY and CNY. When only such a symbol is printed, or no currency is shown at all, work out the currency from the merchant's address, phone number, tax name and the language of the receipt, return your best answer, and set currency_certain to false, because that is a guess.
- When you cannot work it out, return null with currency_certain false.
- When the receipt is in a currency that is not in the list, still return its real ISO code, for example "CHF". Do not replace it with a supported one and do not convert the amounts.`;
}
