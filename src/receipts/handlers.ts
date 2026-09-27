import { InlineKeyboard, type Api, type Bot, type Context } from 'grammy';
import type { Message, PhotoSize, User } from 'grammy/types';
import { displayNameOf } from '../api/auth.js';
import { receiptReadingEnabled, type Config } from '../config.js';
import { computeShares, launchUrl, type Notifier, type RateSuggester } from '../core/index.js';
import {
  confirmExpense,
  createExpense,
  ensureGroup,
  findGroupByChatId,
  findMemberByTelegramId,
  findPossibleDuplicates,
  getExpense,
  getOrCreateActiveTrip,
  getTrip,
  inTransaction,
  listMembers,
  memberScope,
  NotFoundError,
  now,
  reserveReceiptRead,
  setTripRate,
  singaporeDate,
  StaleEditError,
  systemScope,
  upsertTelegramMember,
  ValidationError,
  type Db,
  type ExpenseDetail,
  type Group,
  type Member,
  type Scope,
} from '../db/index.js';
import { planDraft } from './interpret.js';
import { draftMessage, savedMessage, TEXT } from './messages.js';
import { createOpenAIReader, detectImageType, ReceiptReadError, type ReceiptReader } from './reader.js';
import type { ReceiptReading } from './schema.js';

/** Gets the bytes of a Telegram file. */
export type PhotoDownloader = (fileId: string) => Promise<Uint8Array>;

export interface ReceiptDeps {
  isAllowedChat: (chatId: number) => boolean;
  notifier: Notifier;
  suggestRate: RateSuggester;
  /** Defaults to the OpenAI reader when `OPENAI_API_KEY` is set. Tests pass a fake. */
  readReceipt?: ReceiptReader;
  /** Defaults to a download from Telegram with the bot token. Tests pass a fake. */
  downloadPhoto?: PhotoDownloader;
  /** Where failures are reported. Never receives message text, the token or image data. Defaults to `console.error`. */
  logError?: (message: string) => void;
}

/** Prefix of the data of the Split evenly button. The rest is the expense ID and the version shown. */
export const CALLBACK_PREFIX = 'rcpt';
const CALLBACK_PATTERN = /^rcpt:(\d{1,15}):(\d{1,15})$/;
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const DESCRIPTION_MAX = 500;

/** `rcpt:<expenseId>:<version>`, at most 36 bytes. Telegram allows 64. */
export function callbackData(expenseId: number, version: number): string {
  return `${CALLBACK_PREFIX}:${expenseId}:${version}`;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mentionPattern(botUsername: string, flags: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9_@])@${escapeRegExp(botUsername)}(?![A-Za-z0-9_])`, flags);
}

/** True when the text mentions `@<botUsername>`, whatever the case. */
export function mentionsBot(text: string | undefined, botUsername: string): boolean {
  return typeof text === 'string' && mentionPattern(botUsername, 'i').test(text);
}

/** The text without the mention, as the description of the expense. */
export function descriptionFrom(text: string | undefined, botUsername: string): string {
  return (text ?? '')
    .replace(mentionPattern(botUsername, 'gi'), '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DESCRIPTION_MAX)
    .trim();
}

function largest(photo: PhotoSize[]): PhotoSize | undefined {
  return [...photo].sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

export interface ReceiptTrigger {
  fileId: string;
  description: string;
}

/** The photo to read when the message is a tagged receipt, else null. */
export function findTrigger(message: Message, botUsername: string): ReceiptTrigger | null {
  if (message.photo && message.photo.length > 0) {
    if (!mentionsBot(message.caption, botUsername)) return null;
    const size = largest(message.photo);
    return size ? { fileId: size.file_id, description: descriptionFrom(message.caption, botUsername) } : null;
  }
  const replied = message.reply_to_message;
  if (replied?.photo && replied.photo.length > 0 && mentionsBot(message.text, botUsername)) {
    const size = largest(replied.photo);
    return size ? { fileId: size.file_id, description: descriptionFrom(message.text, botUsername) } : null;
  }
  return null;
}

/**
 * Downloads a file from Telegram. The URL holds the bot token, so it stays inside this function:
 * it is not logged, not put in an error and not given to the model.
 */
export function createTelegramDownloader(api: Pick<Api, 'getFile'>, botToken: string, fetchFn: typeof fetch = fetch): PhotoDownloader {
  return async (fileId) => {
    const file = await api.getFile(fileId);
    if (!file.file_path) throw new Error('Telegram gave no path for the file.');
    if (file.file_size !== undefined && file.file_size > MAX_PHOTO_BYTES) throw new Error('The photo is too large.');
    let response: Response;
    try {
      response = await fetchFn(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
    } catch {
      throw new Error('Could not download the photo from Telegram.');
    }
    if (!response.ok) throw new Error(`Could not download the photo from Telegram: status ${response.status}.`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0) throw new Error('The photo is empty.');
    if (data.byteLength > MAX_PHOTO_BYTES) throw new Error('The photo is too large.');
    return data;
  };
}

interface Who {
  group: Group;
  member: Member;
  scope: Scope;
}

const errorName = (error: unknown) =>
  error instanceof ReceiptReadError ? `${error.name} ${error.kind}` : error instanceof Error ? error.name : 'unknown error';

/**
 * Registers the handlers for tagged receipt photos and for the Split evenly button.
 * The bot's own middleware must run before these: it sets up the group and learns the sender.
 */
export function registerReceiptHandlers(bot: Bot, config: Config, db: Db, deps: ReceiptDeps): void {
  const logError = deps.logError ?? ((message: string) => console.error(message));
  const reader: ReceiptReader | undefined =
    deps.readReceipt ??
    (receiptReadingEnabled(config) && config.openaiApiKey !== undefined
      ? createOpenAIReader({ apiKey: config.openaiApiKey, model: config.receiptModel })
      : undefined);
  const download = deps.downloadPhoto ?? createTelegramDownloader(bot.api, config.botToken);

  /** The group of the chat and the member behind the sender. The bot's middleware has made both already. */
  function identify(chat: { id: number; title?: string }, from: User): Who {
    const profile = {
      telegramUserId: from.id,
      displayName: displayNameOf({
        id: from.id,
        firstName: from.first_name,
        ...(from.last_name !== undefined ? { lastName: from.last_name } : {}),
        ...(from.username !== undefined ? { username: from.username } : {}),
      }),
      username: from.username ?? null,
    };
    const group = findGroupByChatId(db, chat.id) ?? ensureGroup(db, chat.id, chat.title ?? 'Trip', [profile]).group;
    const member =
      findMemberByTelegramId(db, systemScope(group.id), from.id) ?? upsertTelegramMember(db, systemScope(group.id), profile).member;
    return { group, member, scope: memberScope(group.id, member.id) };
  }

  async function lookUpRate(homeCurrency: string, currency: string): Promise<string | null> {
    try {
      return await deps.suggestRate(homeCurrency, currency);
    } catch (error) {
      logError(`receipts: rate lookup failed: ${errorName(error)}`);
      return null;
    }
  }

  /** One model call per reservation. Null when the limit stops a retry. Throws when the read fails. */
  async function readWithRetry(groupId: number, fileId: string): Promise<ReceiptReading> {
    if (!reader) throw new ReceiptReadError('other', 'No reader.');
    const data = await download(fileId);
    const image = { data, mediaType: detectImageType(data) };
    try {
      return await reader(image);
    } catch (error) {
      if (!(error instanceof ReceiptReadError) || !error.retryable) throw error;
      if (!reserveReceiptRead(db, groupId, config.receiptDailyCap, now(), config.receiptGlobalDailyCap)) throw error;
      return await reader(image);
    }
  }

  function memberNames(scope: Scope): Map<number, string> {
    return new Map(listMembers(db, scope, { includeMerged: true }).map((m) => [m.id, m.displayName]));
  }

  async function handleReceipt(ctx: Context, message: Message, from: User, trigger: { fileId: string; description: string }): Promise<void> {
    const chatId = message.chat.id;
    const reply = { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } };

    if (!reader) {
      await ctx.api.sendMessage(chatId, TEXT.notSetUp, reply);
      return;
    }
    const who = identify(message.chat, from);
    if (!reserveReceiptRead(db, who.group.id, config.receiptDailyCap, now(), config.receiptGlobalDailyCap)) {
      await ctx.api.sendMessage(chatId, TEXT.limitReached, reply);
      return;
    }
    const status = await ctx.api.sendMessage(chatId, TEXT.reading, reply);
    const finish = (text: string, keyboard?: InlineKeyboard) =>
      ctx.api.editMessageText(chatId, status.message_id, text, keyboard ? { reply_markup: keyboard } : {});

    let reading: ReceiptReading;
    try {
      reading = await readWithRetry(who.group.id, trigger.fileId);
    } catch (error) {
      logError(`receipts: read failed: ${errorName(error)}`);
      await finish(TEXT.unavailable);
      return;
    }

    let text: string;
    let keyboard: InlineKeyboard;
    try {
      // After the model returns, so that a trip ended in the meantime is handled.
      const { trip } = getOrCreateActiveTrip(db, who.scope);
      const active = listMembers(db, who.scope, { activeOnly: true });
      const included = active.length > 0 ? active : [who.member];
      const plan = planDraft(
        reading,
        trip.homeCurrency,
        who.member.id,
        included.map((m) => m.id),
      );
      if (plan.kind === 'unreadable') {
        await finish(TEXT.unreadable);
        return;
      }

      const created = createExpense(db, who.scope, {
        tripId: trip.id,
        status: 'draft',
        payerId: who.member.id,
        description: trigger.description,
        merchant: plan.merchant,
        expenseDate: plan.date ?? singaporeDate(new Date(message.date * 1000)),
        total: plan.total,
        tax: plan.tax,
        taxIncluded: plan.taxIncluded,
        tip: plan.tip,
        serviceCharge: plan.serviceCharge,
        discount: plan.discount,
        currency: plan.currency,
        currencyNeedsReview: plan.currencyNeedsReview,
        splitType: 'even',
        shares: included.map((m) => ({ memberId: m.id })),
        items: plan.items,
        receiptFileId: trigger.fileId,
      });

      if (created.fxRateSource === 'missing') {
        const rate = await lookUpRate(trip.homeCurrency, created.currency);
        if (rate !== null) {
          try {
            const result = setTripRate(db, who.scope, trip.id, created.currency, rate, 'suggested');
            if (result.changed) {
              await deps.notifier.tripRateChanged({
                chatId,
                actorName: who.member.displayName,
                homeCurrency: trip.homeCurrency,
                currency: created.currency,
                rate: result.tripRate.rate,
                origin: 'suggested',
                expensesChanged: result.changedExpenses.length,
              });
            }
          } catch (error) {
            logError(`receipts: could not store the rate: ${errorName(error)}`);
          }
        }
      }

      // Read again: setting the rate gives the draft a new version, and the button must hold the current one.
      const draft = getExpense(db, who.scope, created.id);
      const names = memberNames(who.scope);
      const duplicate = findPossibleDuplicates(db, who.scope, draft.tripId, {
        merchant: draft.merchant,
        total: draft.total,
        currency: draft.currency,
        expenseDate: draft.expenseDate,
        excludeId: draft.id,
      })[0];

      text = draftMessage({
        merchant: draft.merchant,
        description: draft.description,
        total: draft.total,
        currency: draft.currency,
        itemCount: draft.items.length,
        payerName: names.get(draft.payerId) ?? who.member.displayName,
        itemsDropped: plan.itemsDropped,
        currencyNeedsReview: draft.currencyNeedsReview,
        unsupportedCurrency: plan.unsupportedCurrency,
        rateMissing: draft.fxRateSource === 'missing',
        duplicate: duplicate
          ? {
              merchant: duplicate.merchant,
              total: duplicate.total,
              currency: duplicate.currency,
              byName: names.get(duplicate.createdBy) ?? 'someone',
            }
          : null,
      });
      keyboard = new InlineKeyboard()
        .text(TEXT.splitEvenly, callbackData(draft.id, draft.version))
        .url(TEXT.openToSplit, expenseUrl(who.group, draft.id));
    } catch (error) {
      logError(`receipts: could not create the draft: ${errorName(error)}`);
      await finish(TEXT.unavailable);
      return;
    }
    await finish(text, keyboard);
  }

  function expenseUrl(group: Group, expenseId: number): string {
    return launchUrl(config, { groupId: group.id, linkVersion: group.linkVersion, view: 'expense', expenseId });
  }

  /** The reply for a refusal of `confirmExpense`, or null for an error that is not a refusal. */
  function refusalText(error: unknown): string | null {
    if (error instanceof StaleEditError) return TEXT.tapStale;
    if (error instanceof NotFoundError) return TEXT.tapNotFound;
    if (error instanceof ValidationError) {
      switch (error.code) {
        case 'trip_ended':
          return TEXT.tapTripEnded;
        case 'invalid_status':
          return TEXT.tapHandled;
        case 'currency_needs_review':
          return TEXT.tapCurrency;
        case 'rate_missing':
          return TEXT.tapRateMissing;
        default:
          return TEXT.tapInvalid;
      }
    }
    return null;
  }

  interface Confirmed {
    detail: ExpenseDetail;
    rate: { homeCurrency: string; currency: string; rate: string; expensesChanged: number } | null;
  }

  /** Confirms the draft. With the rate missing, looks it up once more and stores it together with the confirmation. */
  async function confirmWithLookup(scope: Scope, expenseId: number, version: number): Promise<Confirmed> {
    try {
      return { detail: confirmExpense(db, scope, expenseId, version), rate: null };
    } catch (error) {
      if (!(error instanceof ValidationError) || error.code !== 'rate_missing') throw error;
      const draft = getExpense(db, scope, expenseId);
      const trip = getTrip(db, scope, draft.tripId);
      const rate = await lookUpRate(trip.homeCurrency, draft.currency);
      if (rate === null) throw error;
      // One transaction: when the confirmation is refused after all, the rate is not stored either.
      return inTransaction(db, () => {
        if (getExpense(db, scope, expenseId).version !== version) confirmExpense(db, scope, expenseId, version);
        let result;
        try {
          result = setTripRate(db, scope, trip.id, draft.currency, rate, 'suggested');
        } catch (rateError) {
          if (rateError instanceof ValidationError && rateError.code === 'trip_ended') throw rateError;
          logError(`receipts: could not store the rate: ${errorName(rateError)}`);
          throw error;
        }
        const current = getExpense(db, scope, expenseId);
        const detail = confirmExpense(db, scope, expenseId, current.version);
        return {
          detail,
          rate: result.changed
            ? { homeCurrency: trip.homeCurrency, currency: draft.currency, rate: result.tripRate.rate, expensesChanged: result.changedExpenses.length }
            : null,
        };
      });
    }
  }

  async function handleTap(ctx: Context, chat: { id: number; title?: string }, from: User, expenseId: number, version: number): Promise<void> {
    const who = identify(chat, from);
    let confirmed: Confirmed;
    try {
      confirmed = await confirmWithLookup(who.scope, expenseId, version);
    } catch (error) {
      const text = refusalText(error);
      if (text === null) logError(`receipts: could not confirm: ${errorName(error)}`);
      await ctx.answerCallbackQuery({ text: text ?? TEXT.tapFailed, show_alert: true });
      return;
    }

    const { detail, rate } = confirmed;
    const names = memberNames(who.scope);
    const nameOf = (memberId: number) => names.get(memberId) ?? 'someone';
    const shares = computeShares(detail, detail.items, detail.shares);
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(
        savedMessage({
          merchant: detail.merchant,
          description: detail.description,
          total: detail.total,
          currency: detail.currency,
          payerName: nameOf(detail.payerId),
          people: shares.size,
        }),
        { reply_markup: new InlineKeyboard().url(TEXT.edit, expenseUrl(who.group, detail.id)) },
      );
    } catch (error) {
      logError(`receipts: could not replace the draft message: ${errorName(error)}`);
    }
    if (rate) {
      await deps.notifier.tripRateChanged({ chatId: chat.id, actorName: who.member.displayName, origin: 'suggested', ...rate });
    }
    await deps.notifier.expenseSaved({
      chatId: chat.id,
      actorName: who.member.displayName,
      expenseId: detail.id,
      groupId: who.group.id,
      description: detail.description || detail.merchant || 'Receipt',
      total: detail.total,
      currency: detail.currency,
      splitType: detail.splitType,
      shares: [...shares].map(([memberId, amount]) => ({ name: nameOf(memberId), amount })),
    });
  }

  bot.on('message', async (ctx, next) => {
    const message = ctx.message;
    const from = message.from;
    if (from.is_bot || !deps.isAllowedChat(message.chat.id)) return next();
    const trigger = findTrigger(message, config.botUsername);
    if (!trigger) return next();
    try {
      await handleReceipt(ctx, message, from, trigger);
    } catch (error) {
      logError(`receipts: failed: ${errorName(error)}`);
    }
  });

  bot.callbackQuery(CALLBACK_PATTERN, async (ctx) => {
    const from = ctx.callbackQuery.from;
    const chat = ctx.callbackQuery.message?.chat;
    if (from.is_bot || !chat || !deps.isAllowedChat(chat.id)) return;
    const match = CALLBACK_PATTERN.exec(ctx.callbackQuery.data);
    if (!match) return;
    try {
      await handleTap(ctx, chat, from, Number(match[1]), Number(match[2]));
    } catch (error) {
      logError(`receipts: tap failed: ${errorName(error)}`);
    }
  });
}
