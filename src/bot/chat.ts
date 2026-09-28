import { InlineKeyboard } from 'grammy';
import type { Message } from 'grammy/types';
import type { Config } from '../config.js';
import { launchUrl } from '../core/index.js';
import type { Group } from '../db/index.js';

/** Telegram offsets are UTF-16 offsets, as are JS string slices. */
export function agentText(message: Message, username: string, botId: number): string | null {
  if (message.from?.is_bot || message.sender_chat || message.photo || message.document || !message.text) return null;
  if (message.text.trimStart().startsWith('/') || message.entities?.some(e => e.type === 'bot_command')) return null;
  if (!['private', 'group', 'supergroup'].includes(message.chat.type)) return null;
  const mentions = (message.entities ?? []).filter(e =>
    (e.type === 'mention' && message.text!.slice(e.offset, e.offset + e.length).toLowerCase() === `@${username.toLowerCase()}`) ||
    (e.type === 'text_mention' && e.user.id === botId));
  if (message.chat.type !== 'private' && !mentions.length && message.reply_to_message?.from?.id !== botId) return null;
  // A tagged reply to a photo also belongs to the receipt reader.
  if ((message.reply_to_message?.photo || /^image\/(jpeg|png|webp|heic)$/i.test(message.reply_to_message?.document?.mime_type ?? '')) && mentions.length) return null;
  let text = message.text;
  for (const e of [...mentions].sort((a, b) => b.offset - a.offset)) text = text.slice(0, e.offset) + text.slice(e.offset + e.length);
  return text.trim();
}
export function appKeyboard(config: Config, group?: Group, privateChat = false, label = 'Add expense'): InlineKeyboard {
  if (group) return new InlineKeyboard().url(label, launchUrl(config, { groupId: group.id, linkVersion: group.linkVersion, view: label === 'View' ? 'home' : 'add' }));
  if (privateChat && config.webhookUrl) return new InlineKeyboard().webApp(label, config.webhookUrl);
  return new InlineKeyboard().url(label, `https://t.me/${config.botUsername}/${config.miniAppName}`);
}
export function helpText(config: Config): string {
  return `Try:\n@${config.botUsername} taxi 24 dollars, split between everyone\n@${config.botUsername} who owes what?\n@${config.botUsername} I paid Sam 20 SGD\n\nSend me a photo of a receipt in private chat, or mention me in its caption in a group. Image files work too. Use /group in private chat to change trips.`;
}
