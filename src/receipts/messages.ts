import { formatAmount } from '../core/index.js';

export const TEXT = {
  noGroup: "Add me to your trip's Telegram group first, then send receipts here or there.",
  chooseGroup: 'Which trip is this receipt for?',
  pendingExpired: 'That receipt expired or was replaced. Send the photo again.',
  heicPreviewMissing: 'Please resend this HEIC image as a photo or JPEG so I can read the receipt.',
  notSetUp: "Receipt reading isn't set up. Tap Add expense to enter it by hand.",
  limitReached: 'Daily receipt limit reached. Tap Add expense to enter it by hand.',
  reading: 'Reading receipt...',
  unreadable: "I couldn't read a receipt in that photo. Tap Add expense to enter it by hand.",
  unavailable: "Receipt reading isn't available right now. Tap Add expense to enter it by hand.",
  itemsDropped: "I couldn't match the items to the total, so check them.",
  checkCurrency: 'Check the currency before saving.',
  rateMissing: "Couldn't look up an exchange rate. Open to set it.",
  splitEvenly: 'Split evenly',
  openToSplit: 'Open to split',
  edit: 'Edit',
  tapStale: 'This draft was changed. Open it to see the latest.',
  tapHandled: 'Already handled.',
  tapCurrency: 'Check the currency first. Tap Open to split.',
  tapRateMissing: "Couldn't look up an exchange rate. Tap Open to split to enter one.",
  tapTripEnded: 'That trip has ended. Reopen it or add this to the new trip.',
  tapNotFound: "That expense isn't in this group.",
  tapInvalid: "This one can't be split evenly yet. Tap Open to split.",
  tapFailed: "That didn't work. Tap Open to split.",
} as const;

export interface DraftMessageInput {
  merchant: string | null;
  description: string;
  total: number;
  currency: string;
  itemCount: number;
  payerName: string;
  itemsDropped: boolean;
  currencyNeedsReview: boolean;
  unsupportedCurrency: string | null;
  rateMissing: boolean;
  duplicate: { merchant: string | null; total: number; currency: string; byName: string } | null;
}

function title(merchant: string | null, description: string): string {
  return merchant || description || 'Receipt';
}

/** The text of the message that offers a draft. Plain text, sent without a parse mode. */
export function draftMessage(input: DraftMessageInput): string {
  const head = [title(input.merchant, input.description), formatAmount(input.total, input.currency)];
  if (input.itemCount > 0) head.push(input.itemCount === 1 ? '1 item' : `${input.itemCount} items`);
  const lines = [head.join(' · '), `Paid by ${input.payerName}`];
  if (input.itemsDropped) lines.push(TEXT.itemsDropped);
  if (input.unsupportedCurrency) {
    lines.push(`${TEXT.checkCurrency} The receipt shows ${input.unsupportedCurrency}, which isn't supported.`);
  } else if (input.currencyNeedsReview) {
    lines.push(TEXT.checkCurrency);
  }
  if (input.rateMissing) lines.push(TEXT.rateMissing);
  if (input.duplicate) {
    const d = input.duplicate;
    lines.push(`This looks like one already added: ${d.merchant || 'Receipt'}, ${formatAmount(d.total, d.currency)}, by ${d.byName}.`);
  }
  return lines.join('\n');
}

export interface SavedMessageInput {
  merchant: string | null;
  description: string;
  total: number;
  currency: string;
  payerName: string;
  people: number;
}

/** The text that replaces the draft message once Split evenly has saved the expense. */
export function savedMessage(input: SavedMessageInput): string {
  const between = input.people === 1 ? '1 person' : `${input.people} people`;
  return [
    `${title(input.merchant, input.description)} · ${formatAmount(input.total, input.currency)}`,
    `Paid by ${input.payerName} · split evenly between ${between}`,
  ].join('\n');
}
