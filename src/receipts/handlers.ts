import { sendDraftWaiting } from '../bot/personal-notices.js';
import { expenseNoticeContext, rateAffectedMembers } from '../tools/notice-context.js';
import { InlineKeyboard, type Api, type Bot, type Context } from 'grammy';
import type { Message, PhotoSize, User } from 'grammy/types';
import { groupChoiceKeyboard, GROUP_UNAVAILABLE, privateChatKey, privateGroupChoice, type Membership } from '../bot/group-choice.js';
import { displayNameOf } from '../api/auth.js';
import { receiptReadingEnabled, type Config } from '../config.js';
import { computeShares, encodeLaunch, formatAmount, launchUrl, type Notifier, type RateSuggester } from '../core/index.js';
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
  getTripBalances,
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
import { draftMessage, savedMessage, receiptHtml, TEXT } from './messages.js';
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
  fileSize?: number;
  heic?: boolean;
  previewFileId?: string;
}

/** Image documents use the same gate as photos. HEIC uses Telegram's JPEG preview. */
function imageFile(message: Message): Omit<ReceiptTrigger, 'description'> | null {
  const photo = message.photo && largest(message.photo);
  if (photo) return { fileId: photo.file_id, ...(photo.file_size !== undefined ? { fileSize: photo.file_size } : {}) };
  const doc = message.document;
  if (!doc || !/^image\/(jpeg|png|webp|heic)$/i.test(doc.mime_type ?? '')) return null;
  return {
    fileId: doc.file_id,
    ...(doc.file_size !== undefined ? { fileSize: doc.file_size } : {}),
    ...(doc.mime_type?.toLowerCase() === 'image/heic' ? { heic: true } : {}),
    ...(doc.thumbnail ? { previewFileId: doc.thumbnail.file_id } : {}),
  };
}

/** Private images are addressed to the bot; group images still require a mention. */
export function findTrigger(message: Message, botUsername: string): ReceiptTrigger | null {
  const privateChat = message.chat.type === 'private';
  const file = imageFile(message);
  if (file) {
    if (!privateChat && !mentionsBot(message.caption, botUsername)) return null;
    const description = privateChat
      ? (message.caption ?? '').replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX).trim()
      : descriptionFrom(message.caption, botUsername);
    return { ...file, description };
  }
  const replied = message.reply_to_message && imageFile(message.reply_to_message);
  if (replied && mentionsBot(message.text, botUsername)) {
    return { ...replied, description: descriptionFrom(message.text, botUsername) };
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
 * Registers private and tagged group receipt images and the Split evenly button.
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
  const selection = privateGroupChoice(bot, db, deps.isAllowedChat);
  // One unprocessed image per person/private chat; no bytes are retained. New images replace older ones.
  const pending = new Map<string, { message: Pick<Message, 'message_id' | 'date' | 'chat'>; trigger: ReceiptTrigger; at: number }>();
  function purgePending(): void {
    const cutoff = now().getTime() - 10 * 60_000;
    for (const [key, value] of pending) if (value.at <= cutoff) pending.delete(key);
  }
  selection.onReset.push(ctx => { purgePending(); pending.delete(privateChatKey(ctx)); });
  const withScope = (who: Membership): Who => ({ ...who, scope: memberScope(who.group.id, who.member.id) });

  /** The group of the chat and the member behind the sender. The bot's middleware has made both already. */
  function identify(chat: { id: number; title?: string }, from: User): Who | undefined {
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
    return member.mergedInto === null ? withScope({ group, member }) : undefined;
  }

  async function lookUpRate(homeCurrency: string, currency: string): Promise<string | null> {
    try {
      return await deps.suggestRate(homeCurrency, currency);
    } catch (error) {
      logError(`receipts: rate lookup failed: ${errorName(error)}`);
      return null;
    }
  }

  /** One model call per reservation. Throws when reading fails or the cap stops a retry. */
  async function readWithRetry(groupId: number, trigger: ReceiptTrigger): Promise<ReceiptReading> {
    if (!reader) throw new ReceiptReadError('other', 'No reader.');
    if ((trigger.fileSize ?? 0) > MAX_PHOTO_BYTES) throw new Error('The photo is too large.');
    const data = await download(trigger.heic ? trigger.previewFileId! : trigger.fileId);
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

  async function handleReceipt(ctx: Context, message: Pick<Message, 'message_id' | 'date' | 'chat'>, who: Who, trigger: ReceiptTrigger): Promise<void> {
    const chatId = message.chat.id;
    const reply = { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } };

    if (!reader) {
      await ctx.api.sendMessage(chatId, TEXT.notSetUp, reply);
      return;
    }
    if (trigger.heic && !trigger.previewFileId) {
      await ctx.api.sendMessage(chatId, TEXT.heicPreviewMissing, reply);
      return;
    }
    if (!reserveReceiptRead(db, who.group.id, config.receiptDailyCap, now(), config.receiptGlobalDailyCap)) {
      await ctx.api.sendMessage(chatId, TEXT.limitReached, reply);
      return;
    }
    const status = await ctx.api.sendMessage(chatId, TEXT.reading, reply);
    const finish = (text: string, keyboard?: InlineKeyboard) =>
      ctx.api.editMessageText(chatId, status.message_id, keyboard ? receiptHtml(text) : text, keyboard ? { parse_mode: 'HTML', reply_markup: keyboard } : {});

    let reading: ReceiptReading;
    try {
      reading = await readWithRetry(who.group.id, trigger);
    } catch (error) {
      logError(`receipts: read failed: ${errorName(error)}`);
      await finish(TEXT.unavailable);
      return;
    }

    let text: string;
    let keyboard: InlineKeyboard;
    let draft: ExpenseDetail;
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
        // Only the reason, never what the photo said.
        logError(`receipts: no draft: ${!reading.is_receipt ? 'not recognised as a receipt' : reading.total === null ? 'no total found' : 'total not usable'}`);
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

      await sendDraftWaiting(bot.api, config, db, { error: (message, details) => logError(`${message}: ${JSON.stringify(details)}`) }, { groupId: who.group.id, actorMemberId: who.member.id, actorName: who.member.displayName, tripName: trip.name, expenseId: created.id });

      if (created.fxRateSource === 'missing') {
        const rate = await lookUpRate(trip.homeCurrency, created.currency);
        if (rate !== null) {
          try {
            const before = getTripBalances(db, who.scope, trip.id).balances;
            const result = setTripRate(db, who.scope, trip.id, created.currency, rate, 'suggested');
            if (result.changed) {
              await deps.notifier.tripRateChanged({
                chatId: who.group.chatId,
                groupId: who.group.id, actorMemberId: who.member.id, tripId: trip.id, tripName: trip.name,
                affectedMemberIds: rateAffectedMembers(db, who.scope, trip.id, before),
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
      draft = getExpense(db, who.scope, created.id);
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
      if (message.chat.type === 'private') text = `For ${who.group.title}\n${text}\nUse /group to switch.`;
      keyboard = new InlineKeyboard().text(TEXT.splitEvenly, callbackData(draft.id, draft.version));
      if (message.chat.type === 'private' && config.webhookUrl) {
        const url = new URL(config.webhookUrl);
        url.searchParams.set('startapp', encodeLaunch({ groupId: who.group.id, linkVersion: who.group.linkVersion, view: 'expense', expenseId: draft.id }, config.linkSecret));
        keyboard.webApp(TEXT.openToSplit, url.toString());
      } else keyboard.url(TEXT.openToSplit, expenseUrl(who.group, draft.id));
    } catch (error) {
      logError(`receipts: could not create the draft: ${errorName(error)}`);
      await finish(TEXT.unavailable);
      return;
    }
    // Nothing is posted to the group for a draft: the group hears about it once it is confirmed (expenseSaved).
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
    rate: { tripId: number; tripName: string; affectedMemberIds: number[]; homeCurrency: string; currency: string; rate: string; expensesChanged: number } | null;
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
        const before = getTripBalances(db, scope, trip.id).balances;
        let result;
        try {
          result = setTripRate(db, scope, trip.id, draft.currency, rate, 'suggested');
        } catch (rateError) {
          if (rateError instanceof ValidationError && rateError.code === 'trip_ended') throw rateError;
          logError(`receipts: could not store the rate: ${errorName(rateError)}`);
          throw error;
        }
        const affectedMemberIds = rateAffectedMembers(db, scope, trip.id, before);
        const current = getExpense(db, scope, expenseId);
        const detail = confirmExpense(db, scope, expenseId, current.version);
        return {
          detail,
          rate: result.changed
            ? { tripId: trip.id, tripName: trip.name, affectedMemberIds, homeCurrency: trip.homeCurrency, currency: draft.currency, rate: result.tripRate.rate, expensesChanged: result.changedExpenses.length }
            : null,
        };
      });
    }
  }

  async function handleTap(ctx: Context, who: Who, expenseId: number, version: number): Promise<void> {
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
    await ctx.answerCallbackQuery().catch(error => { logError(`receipts: could not answer the tap: ${errorName(error)}`); });
    try {
      await ctx.editMessageText(
        receiptHtml(savedMessage({
          merchant: detail.merchant,
          description: detail.description,
          total: detail.total,
          currency: detail.currency,
          payerName: nameOf(detail.payerId),
          people: shares.size,
        })),
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().url(TEXT.edit, expenseUrl(who.group, detail.id)) },
      );
    } catch (error) {
      logError(`receipts: could not replace the draft message: ${errorName(error)}`);
    }
    if (rate) {
      await deps.notifier.tripRateChanged({ groupId: who.group.id, actorMemberId: who.member.id, chatId: who.group.chatId, actorName: who.member.displayName, origin: 'suggested', ...rate });
    }
    await deps.notifier.expenseSaved({
      chatId: who.group.chatId,
      actorName: who.member.displayName,
      expenseId: detail.id,
      personal: expenseNoticeContext(db, who.scope, detail),
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
    const privateChat = message.chat.type === 'private';
    if (from.is_bot || message.sender_chat || (!privateChat && !['group', 'supergroup'].includes(message.chat.type)) ||
      (!privateChat && !deps.isAllowedChat(message.chat.id))) return next();
    const trigger = findTrigger(message, config.botUsername);
    if (!trigger) return next();
    await selection.serial(ctx, async () => {
      try {
        purgePending();
        if (privateChat) {
          pending.delete(privateChatKey(ctx));
          const who = selection.identify(ctx);
          if (who) { await handleReceipt(ctx, message, withScope(who), trigger); return; }
          const groups = selection.memberships(ctx);
          if (!groups.length) { await ctx.reply(TEXT.noGroup); return; }
          pending.set(privateChatKey(ctx), {
            message: { message_id: message.message_id, date: message.date, chat: message.chat }, trigger, at: now().getTime(),
          });
          await ctx.reply(TEXT.chooseGroup, {
            reply_markup: groupChoiceKeyboard(groups, group => `rcpt:g:${message.message_id}:${group.id}`),
          });
        } else {
          const who = identify(message.chat, from);
          if (who) await handleReceipt(ctx, message, who, trigger);
        }
      } catch (error) { logError(`receipts: failed: ${errorName(error)}`); }
    });
  });

  bot.callbackQuery(/^rcpt:g:(\d{1,15}):(\d{1,15})$/, async ctx => {
    if (ctx.from.is_bot || ctx.chat?.type !== 'private') return;
    await selection.serial(ctx, async () => {
      purgePending();
      const request = pending.get(privateChatKey(ctx));
      if (!request || request.message.message_id !== Number(ctx.match[1])) {
        await ctx.answerCallbackQuery({ text: TEXT.pendingExpired, show_alert: true }); return;
      }
      const who = selection.memberships(ctx).find(m => m.group.id === Number(ctx.match[2]));
      if (!who) { await ctx.answerCallbackQuery({ text: GROUP_UNAVAILABLE, show_alert: true }); return; }
      // Consume before any await: double taps cannot read/create twice.
      pending.delete(privateChatKey(ctx));
      selection.remember(ctx, who);
      await ctx.answerCallbackQuery().catch(error => { logError(`receipts: could not answer the selection: ${errorName(error)}`); });
      await ctx.editMessageText(`Using ${who.group.title}. Use /group to switch.`, { reply_markup: { inline_keyboard: [] } })
        .catch(error => { logError(`receipts: could not replace the selection: ${errorName(error)}`); });
      try { await handleReceipt(ctx, request.message, withScope(who), request.trigger); }
      catch (error) { logError(`receipts: failed: ${errorName(error)}`); }
    });
  });

  bot.callbackQuery(CALLBACK_PATTERN, async (ctx) => {
    const from = ctx.callbackQuery.from;
    const chat = ctx.callbackQuery.message?.chat;
    if (from.is_bot || !chat || (chat.type !== 'private' && !deps.isAllowedChat(chat.id))) return;
    const match = CALLBACK_PATTERN.exec(ctx.callbackQuery.data);
    if (!match) return;
    await selection.serial(ctx, async () => {
      try {
        const expenseId = Number(match[1]);
        // Resolve against the expense's group, even if /group was changed since the draft was sent.
        const membership = chat.type === 'private' ? selection.memberships(ctx).find(m => {
          try { getExpense(db, memberScope(m.group.id, m.member.id), expenseId); return true; }
          catch (error) { if (error instanceof NotFoundError) return false; throw error; }
        }) : identify(chat, from);
        if (!membership) { await ctx.answerCallbackQuery({ text: TEXT.tapNotFound, show_alert: true }); return; }
        await handleTap(ctx, withScope(membership), expenseId, Number(match[2]));
      } catch (error) { logError(`receipts: tap failed: ${errorName(error)}`); }
    });
  });
}
