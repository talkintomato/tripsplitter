import { createHmac } from 'node:crypto';

export const BOT_TOKEN = '123456:TEST-TOKEN';

/** Builds initData the way Telegram does, signed with the bot token. */
export function signInitData(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  const dataCheckString = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

export function initDataFor(user: Record<string, unknown>, authDate: Date, extra: Record<string, string> = {}, botToken = BOT_TOKEN): string {
  return signInitData(
    { query_id: 'AAF9tEstAAAAAH20Sy0', user: JSON.stringify(user), auth_date: String(Math.floor(authDate.getTime() / 1000)), ...extra },
    botToken,
  );
}
