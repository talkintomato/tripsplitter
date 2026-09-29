import { dirname, join } from 'node:path';
import { z } from 'zod';

/** Thrown by `loadConfig` when the environment is incomplete or invalid. The message names each variable. */
export class ConfigError extends Error {
  /** Names of the environment variables that were missing or invalid. */
  readonly variables: string[];

  constructor(message: string, variables: string[]) {
    super(message);
    this.name = 'ConfigError';
    this.variables = variables;
  }
}

/** A blank value in a .env file means "not set". */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const requiredString = z.preprocess(blankToUndefined, z.string({ error: 'is required' }).trim().min(1));
const optionalString = z.preprocess(blankToUndefined, z.string().trim().optional());

const positiveInt = (fallback: number) =>
  z.preprocess(
    blankToUndefined,
    z.coerce.number({ error: 'must be a whole number' }).int('must be a whole number').positive('must be above zero').default(fallback),
  );

const chatIdList = z.preprocess(
  blankToUndefined,
  z
    .string()
    .default('')
    .transform((value, ctx) => {
      const ids: number[] = [];
      for (const part of value.split(',')) {
        const text = part.trim();
        if (text === '') continue;
        if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
          ctx.addIssue({ code: 'custom', message: `"${text}" is not a chat ID` });
          return z.NEVER;
        }
        ids.push(Number(text));
      }
      return ids;
    }),
);

const fakeUser = z.preprocess(
  blankToUndefined,
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be JSON, for example {"id":1,"first_name":"Dev"}' });
        return z.NEVER;
      }
      const result = z
        .object({
          id: z.number().int().positive(),
          first_name: z.string().min(1).default('Dev'),
          last_name: z.string().optional(),
          username: z.string().optional(),
        })
        .safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({ code: 'custom', message: 'must be JSON with a numeric "id", for example {"id":1,"first_name":"Dev"}' });
        return z.NEVER;
      }
      const user: DevFakeUser = {
        id: result.data.id,
        firstName: result.data.first_name,
        ...(result.data.last_name !== undefined ? { lastName: result.data.last_name } : {}),
        ...(result.data.username !== undefined ? { username: result.data.username } : {}),
      };
      return user;
    }),
);

const envSchema = z.object({
  BOT_TOKEN: requiredString,
  BOT_USERNAME: z.preprocess(
    blankToUndefined,
    z
      .string({ error: 'is required' })
      .trim()
      .min(1)
      .refine((v) => !v.startsWith('@'), 'must not start with @'),
  ),
  MINI_APP_NAME: requiredString,
  ALLOWED_CHAT_IDS: chatIdList,
  LINK_SECRET: z.preprocess(
    blankToUndefined,
    z.string({ error: 'is required' }).min(32, 'must be at least 32 characters'),
  ),
  DATABASE_PATH: z.preprocess(blankToUndefined, z.string().default('./data/tripsplitter.db')),
  PHOTO_DIR: optionalString,
  PLACE_LOOKUP: z.preprocess(blankToUndefined, z.enum(['true', 'false']).default('true')),
  OPENAI_API_KEY: optionalString,
  RECEIPT_MODEL: z.preprocess(blankToUndefined, z.string().default('gpt-6-luna')),
  RECEIPT_DAILY_CAP: positiveInt(30),
  RECEIPT_GLOBAL_DAILY_CAP: z.preprocess(blankToUndefined, z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(300)),
  AGENT_ENABLED: z.preprocess(blankToUndefined, z.enum(['true', 'false']).optional()),
  AGENT_MODEL: z.preprocess(blankToUndefined, z.string().trim().min(1).default('gpt-6-luna')),
  AGENT_DAILY_CAP: z.preprocess(blankToUndefined, z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(100)),
  AGENT_GLOBAL_DAILY_CAP: z.preprocess(blankToUndefined, z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(1000)),
  MCP_ENABLED: z.preprocess(blankToUndefined, z.enum(['true', 'false']).default('false')),
  MCP_DAILY_CAP_PER_CONNECTION: z.preprocess(blankToUndefined, z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(300)),
  PORT: positiveInt(3000),
  NODE_ENV: z.preprocess(blankToUndefined, z.enum(['development', 'test', 'production']).default('development')),
  DEV_FAKE_USER: fakeUser,
  WEBHOOK_URL: z.preprocess(blankToUndefined, z.url('must be a URL').optional()),
  WEBHOOK_SECRET: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,256}$/, 'must be 16 to 256 characters: letters, digits, _ and -')
      .optional(),
  ),
});

/** Fake Telegram user for the development-only bypass (PRD 2). Same shape as `TelegramUser` in `src/api/auth.ts`. */
export interface DevFakeUser {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
}

export interface Config {
  /** BOT_TOKEN */
  botToken: string;
  /** BOT_USERNAME, without the @ */
  botUsername: string;
  /** MINI_APP_NAME */
  miniAppName: string;
  /** ALLOWED_CHAT_IDS, parsed. Empty means the bot works in every chat it is added to. */
  allowedChatIds: number[];
  /** LINK_SECRET */
  linkSecret: string;
  /** DATABASE_PATH */
  databasePath: string;
  /** PHOTO_DIR, default: photos beside DATABASE_PATH. */
  photoDir: string;
  /** PLACE_LOOKUP: optional reverse geocoding. */
  placeLookup: boolean;
  /** OPENAI_API_KEY. Undefined unless set. Receipt reading is off without it. */
  openaiApiKey: string | undefined;
  /** RECEIPT_MODEL */
  receiptModel: string;
  /** RECEIPT_DAILY_CAP */
  receiptDailyCap: number;
  /** RECEIPT_GLOBAL_DAILY_CAP. Zero disables the overall limit. */
  receiptGlobalDailyCap: number;
  agentEnabled: boolean;
  agentModel: string;
  agentDailyCap: number;
  agentGlobalDailyCap: number;
  /** Serves the MCP server at /mcp and lets people connect clients through the bot. */
  mcpEnabled: boolean;
  /** Tool calls per MCP connection per day. */
  mcpDailyCapPerConnection: number;
  /** PORT */
  port: number;
  /** NODE_ENV */
  nodeEnv: 'development' | 'test' | 'production';
  /** DEV_FAKE_USER, parsed. Never set when nodeEnv is `production`: loading such a config fails. */
  devFakeUser: DevFakeUser | undefined;
  /** WEBHOOK_URL. Undefined means long polling. */
  webhookUrl: string | undefined;
  /** WEBHOOK_SECRET. Path segment and header value of the webhook. Always set when `webhookUrl` is. */
  webhookSecret: string | undefined;
}

/**
 * Reads and validates configuration from environment variables.
 * Throws `ConfigError` naming every missing or invalid variable.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const byVariable = new Map<string, string>();
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? 'environment');
      if (!byVariable.has(name)) byVariable.set(name, issue.message);
    }
    const lines = [...byVariable].map(([name, message]) => `  ${name}: ${message}`);
    throw new ConfigError(`Invalid configuration. Fix these environment variables:\n${lines.join('\n')}`, [
      ...byVariable.keys(),
    ]);
  }
  const e = parsed.data;
  const problems: Array<[string, string]> = [];
  if (e.DEV_FAKE_USER !== undefined && e.NODE_ENV === 'production') {
    problems.push(['DEV_FAKE_USER', 'must not be set when NODE_ENV is production']);
  }
  if (e.WEBHOOK_URL !== undefined && e.WEBHOOK_SECRET === undefined) {
    problems.push(['WEBHOOK_SECRET', 'is required when WEBHOOK_URL is set']);
  }
  if (problems.length > 0) {
    throw new ConfigError(
      `Invalid configuration. Fix these environment variables:\n${problems.map(([n, m]) => `  ${n}: ${m}`).join('\n')}`,
      problems.map(([n]) => n),
    );
  }
  return {
    botToken: e.BOT_TOKEN,
    botUsername: e.BOT_USERNAME,
    miniAppName: e.MINI_APP_NAME,
    allowedChatIds: e.ALLOWED_CHAT_IDS,
    linkSecret: e.LINK_SECRET,
    databasePath: e.DATABASE_PATH,
    photoDir: e.PHOTO_DIR ?? join(dirname(e.DATABASE_PATH), 'photos'),
    placeLookup: e.PLACE_LOOKUP === 'true',
    openaiApiKey: e.OPENAI_API_KEY,
    receiptModel: e.RECEIPT_MODEL,
    receiptDailyCap: e.RECEIPT_DAILY_CAP,
    receiptGlobalDailyCap: e.RECEIPT_GLOBAL_DAILY_CAP,
    agentEnabled: e.AGENT_ENABLED === undefined ? e.OPENAI_API_KEY !== undefined : e.AGENT_ENABLED === 'true',
    agentModel: e.AGENT_MODEL,
    agentDailyCap: e.AGENT_DAILY_CAP,
    agentGlobalDailyCap: e.AGENT_GLOBAL_DAILY_CAP,
    mcpEnabled: e.MCP_ENABLED === 'true',
    mcpDailyCapPerConnection: e.MCP_DAILY_CAP_PER_CONNECTION,
    port: e.PORT,
    nodeEnv: e.NODE_ENV,
    devFakeUser: e.DEV_FAKE_USER,
    webhookUrl: e.WEBHOOK_URL,
    webhookSecret: e.WEBHOOK_SECRET,
  };
}

/**
 * Builds a config object for tests without reading any environment variable.
 * Every field has a harmless default. Pass overrides for what the test cares about.
 * Throws `ConfigError` for the two combinations `loadConfig` refuses.
 */
export function buildConfig(overrides: Partial<Config> = {}): Config {
  const config = buildUnchecked(overrides);
  if (config.devFakeUser !== undefined && config.nodeEnv === 'production') {
    throw new ConfigError('DEV_FAKE_USER must not be set when NODE_ENV is production', ['DEV_FAKE_USER']);
  }
  if (config.webhookUrl !== undefined && config.webhookSecret === undefined) {
    throw new ConfigError('WEBHOOK_SECRET is required when WEBHOOK_URL is set', ['WEBHOOK_SECRET']);
  }
  return config;
}

function buildUnchecked(overrides: Partial<Config>): Config {
  return {
    botToken: '123456:TEST-TOKEN',
    botUsername: 'tripsplitter_test_bot',
    miniAppName: 'app',
    allowedChatIds: [],
    linkSecret: 'test-link-secret-0123456789-abcdefghij',
    databasePath: ':memory:',
    photoDir: join(dirname(overrides.databasePath ?? './data/test.db'), 'photos'),
    placeLookup: true,
    openaiApiKey: undefined,
    receiptModel: 'gpt-6-luna',
    receiptDailyCap: 30,
    receiptGlobalDailyCap: 300,
    agentEnabled: Boolean(overrides.openaiApiKey),
    agentModel: 'gpt-6-luna',
    agentDailyCap: 100,
    agentGlobalDailyCap: 1000,
    mcpEnabled: false,
    mcpDailyCapPerConnection: 300,
    port: 3000,
    nodeEnv: 'test',
    devFakeUser: undefined,
    webhookUrl: undefined,
    webhookSecret: undefined,
    ...overrides,
  };
}

/** True when `OPENAI_API_KEY` is set, so receipts can be read. */
export function receiptReadingEnabled(config: Config): boolean {
  return config.openaiApiKey !== undefined && config.openaiApiKey !== '';
}

/** True when the chat ID itself is in ALLOWED_CHAT_IDS. Earlier IDs of an upgraded group are not looked at here. */
export function isChatIdListed(config: Config, chatId: number): boolean {
  return config.allowedChatIds.includes(chatId);
}
