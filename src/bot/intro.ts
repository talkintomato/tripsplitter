import { InlineKeyboard, type Api } from 'grammy';
import type { Config } from '../config.js';
import { launchUrl } from '../core/index.js';
import { setIntroMessage, systemScope, type Db, type Group } from '../db/index.js';
import { describeError, type BotLogger } from './support.js';

export function introText(config: Config): string {
  const bot = `@${config.botUsername}`;
  return [
    'Hi, I track shared expenses for this group.',
    '',
    `To add a receipt: post the photo with ${bot} in the caption, or reply to a photo with ${bot}.`,
    'To add anything else: tap Add expense.',
    `Or just tell me: ${bot} taxi 24 dollars, split between everyone`,
    '',
    "I notice who posts here so I know who is in the group. I don't store ordinary chat messages. Text with a tagged receipt becomes its description. Messages written to me are kept for the conversation, up to 8 turns, and forgotten after 30 minutes without a message.",
    'If you write to me, I send your message to an AI service to understand it.',
    'I only look at photos tagged with my name. Tagged photos are sent to an AI service to be read, and I keep a reference to the photo, not the photo.',
  ].join('\n');
}

/** URL buttons, because `web_app` buttons do not work in groups. */
export function introKeyboard(config: Config, group: Pick<Group, 'id' | 'linkVersion'>): InlineKeyboard {
  const link = { groupId: group.id, linkVersion: group.linkVersion };
  return new InlineKeyboard()
    .url('Add expense', launchUrl(config, { ...link, view: 'add' }))
    .url('Balances', launchUrl(config, { ...link, view: 'balances' }));
}

/**
 * Posts the intro message, pins it when the bot may, and saves its ID. Returns false when the message could
 * not be posted. A failure to pin is logged and does not count as a failure.
 */
export async function postIntro(api: Api, config: Config, db: Db, group: Group, logger: BotLogger): Promise<boolean> {
  let messageId: number;
  try {
    const sent = await api.sendMessage(group.chatId, introText(config), {
      reply_markup: introKeyboard(config, group),
      link_preview_options: { is_disabled: true },
    });
    messageId = sent.message_id;
  } catch (error) {
    logger.error('Could not post the intro message', { chatId: group.chatId, error: describeError(error) });
    return false;
  }
  setIntroMessage(db, systemScope(group.id), messageId);
  try {
    await api.pinChatMessage(group.chatId, messageId, { disable_notification: true });
  } catch (error) {
    logger.error('Could not pin the intro message', { chatId: group.chatId, error: describeError(error) });
  }
  return true;
}
