import type { Api } from 'grammy';

export type PhotoDownloader = (fileId: string) => Promise<Uint8Array>;
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

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
