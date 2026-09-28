import { displayAmount as formatAmount, escapeHtml, toPlainText } from '../tools/summary.js';

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
  checkCurrency: 'Currency read from the receipt. Change it if it’s wrong.',
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

/** Plain content; the Telegram call site applies receiptHtml after adding its group wrapper. */
export function draftMessage(input: DraftMessageInput): string {
  const lines = [`Total: ${formatAmount(input.total, input.currency)}`, `Paid by ${input.payerName}`];
  if (input.itemCount > 0) lines.push(input.itemCount === 1 ? '1 item' : `${input.itemCount} items`);
  if (input.itemsDropped) lines.push(`⚠️ ${TEXT.itemsDropped}`);
  if (input.unsupportedCurrency) {
    lines.push(`⚠️ The receipt shows ${input.unsupportedCurrency}, which isn't supported, so ${input.currency} is used. Change it if it’s wrong.`);
  } else if (input.currencyNeedsReview) {
    lines.push(TEXT.checkCurrency);
  }
  if (input.rateMissing) lines.push(`⚠️ ${TEXT.rateMissing}`);
  if (input.duplicate) {
    const d = input.duplicate;
    lines.push(`⚠️ This looks like one already added: ${d.merchant || 'Receipt'}, ${formatAmount(d.total, d.currency)}, by ${d.byName}.`);
  }
  return toPlainText({icon:'✅',title:`Approve ${title(input.merchant,input.description)}`,blocks:[{lines}]});
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
  return `✅ Added ${title(input.merchant,input.description)} · ${formatAmount(input.total,input.currency)}`;
}

/** Escape the entire card, including the private-chat group wrapper, before enabling HTML. */
export function receiptHtml(text: string): string {
  return text.split('\n').map(line => {
    const escaped = escapeHtml(line);
    return line.startsWith('✅ ') ? `<b>${escaped}</b>` : escaped;
  }).join('\n');
}
