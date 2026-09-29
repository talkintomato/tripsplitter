import { describe, expect, it } from 'vitest';
import { ConfigError, buildConfig, isChatIdListed, loadConfig, receiptReadingEnabled } from '../../src/config.js';

const required = {
  BOT_TOKEN: '123456:TEST-TOKEN',
  BOT_USERNAME: 'trip_bot',
  MINI_APP_NAME: 'split',
  LINK_SECRET: 'a-secret-of-at-least-thirty-two-characters',
};
function failure(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('Expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('takes the environment as an argument and applies the defaults', () => {
    expect(loadConfig(required)).toEqual({
      botToken: '123456:TEST-TOKEN',
      botUsername: 'trip_bot',
      miniAppName: 'split',
      allowedChatIds: [],
      linkSecret: 'a-secret-of-at-least-thirty-two-characters',
      databasePath: './data/tripsplitter.db',
      photoDir: 'data/photos',
      openaiApiKey: undefined,
      receiptModel: 'gpt-6-luna',
      receiptDailyCap: 30,
      receiptGlobalDailyCap: 300,
      agentEnabled: false,
      agentModel: 'gpt-6-luna',
      agentDailyCap: 100,
      agentGlobalDailyCap: 1000,
      mcpEnabled: false,
      mcpDailyCapPerConnection: 300,
      port: 3000,
      nodeEnv: 'development',
      devFakeUser: undefined,
      webhookUrl: undefined,
      webhookSecret: undefined,
    });
  });

  it('reads every variable', () => {
    const config = loadConfig({
      ...required,
      NODE_ENV: 'production',
      ALLOWED_CHAT_IDS: ' -1001234567890, -42 ,7',
      DATABASE_PATH: '/data/trips.db',
      OPENAI_API_KEY: 'placeholder-key',
      RECEIPT_MODEL: 'some-model',
      RECEIPT_DAILY_CAP: '5',
      RECEIPT_GLOBAL_DAILY_CAP: '50',
      PORT: '8080',
      WEBHOOK_URL: 'https://trips.example.com',
      WEBHOOK_SECRET: 'abcdefghijklmnop_-123',
    });
    expect(config).toMatchObject({
      nodeEnv: 'production',
      allowedChatIds: [-1001234567890, -42, 7],
      databasePath: '/data/trips.db',
      openaiApiKey: 'placeholder-key',
      receiptModel: 'some-model',
      receiptDailyCap: 5,
      receiptGlobalDailyCap: 50,
      port: 8080,
      webhookUrl: 'https://trips.example.com',
      webhookSecret: 'abcdefghijklmnop_-123',
    });
    expect(receiptReadingEnabled(config)).toBe(true);
    expect(receiptReadingEnabled(loadConfig(required))).toBe(false);
    expect(isChatIdListed(config, -42)).toBe(true);
    expect(isChatIdListed(config, 42)).toBe(false);
  });

  it('names each missing required variable', () => {
    const error = failure({});
    expect(error.variables.sort()).toEqual(['BOT_TOKEN', 'BOT_USERNAME', 'LINK_SECRET', 'MINI_APP_NAME']);
    for (const name of error.variables) expect(error.message).toContain(name);
    expect(failure({ ...required, BOT_TOKEN: '  ' }).variables).toEqual(['BOT_TOKEN']);
    expect(failure({ ...required, MINI_APP_NAME: undefined }).variables).toEqual(['MINI_APP_NAME']);
  });

  it('refuses values that are not valid, naming the variable', () => {
    expect(failure({ ...required, LINK_SECRET: 'too-short' }).message).toMatch(/LINK_SECRET.*32/);
    expect(failure({ ...required, BOT_USERNAME: '@trip_bot' }).variables).toEqual(['BOT_USERNAME']);
    expect(failure({ ...required, ALLOWED_CHAT_IDS: '-100,abc' }).variables).toEqual(['ALLOWED_CHAT_IDS']);
    expect(failure({ ...required, PORT: 'eighty' }).variables).toEqual(['PORT']);
    expect(failure({ ...required, RECEIPT_DAILY_CAP: '0' }).variables).toEqual(['RECEIPT_DAILY_CAP']);
    expect(failure({ ...required, NODE_ENV: 'staging' }).variables).toEqual(['NODE_ENV']);
    expect(failure({ ...required, WEBHOOK_URL: 'not a url', WEBHOOK_SECRET: 'abcdefghijklmnop' }).variables).toEqual(['WEBHOOK_URL']);
  });

  it('DEV_FAKE_USER with NODE_ENV=production stops startup', () => {
    const fake = JSON.stringify({ id: 1, first_name: 'Dev' });
    const error = failure({ ...required, NODE_ENV: 'production', DEV_FAKE_USER: fake });
    expect(error.variables).toEqual(['DEV_FAKE_USER']);
    expect(error.message).toMatch(/DEV_FAKE_USER.*production/);
    expect(() => buildConfig({ nodeEnv: 'production', devFakeUser: { id: 1, firstName: 'Dev' } })).toThrow(ConfigError);

    expect(loadConfig({ ...required, NODE_ENV: 'development', DEV_FAKE_USER: fake }).devFakeUser).toEqual({ id: 1, firstName: 'Dev' });
    expect(loadConfig({ ...required, DEV_FAKE_USER: JSON.stringify({ id: 2, first_name: 'Dev', last_name: 'User', username: 'dev' }) }).devFakeUser).toEqual({
      id: 2,
      firstName: 'Dev',
      lastName: 'User',
      username: 'dev',
    });
    expect(failure({ ...required, DEV_FAKE_USER: '{not json' }).variables).toEqual(['DEV_FAKE_USER']);
    expect(failure({ ...required, DEV_FAKE_USER: '{"first_name":"No ID"}' }).variables).toEqual(['DEV_FAKE_USER']);
  });

  it('WEBHOOK_SECRET is required when WEBHOOK_URL is set', () => {
    expect(failure({ ...required, WEBHOOK_URL: 'https://trips.example.com' }).variables).toEqual(['WEBHOOK_SECRET']);
    expect(failure({ ...required, WEBHOOK_URL: 'https://trips.example.com', WEBHOOK_SECRET: 'has spaces and is long' }).variables).toEqual(['WEBHOOK_SECRET']);
    expect(loadConfig({ ...required, WEBHOOK_SECRET: 'abcdefghijklmnop' }).webhookUrl).toBeUndefined();
    expect(() => buildConfig({ webhookUrl: 'https://trips.example.com' })).toThrow(ConfigError);
  });

  it('does not read process.env when given an environment', () => {
    process.env.TRIPSPLITTER_TEST_PORT_PROBE = '1';
    const before = process.env.PORT;
    process.env.PORT = '9999';
    try {
      expect(loadConfig(required).port).toBe(3000);
    } finally {
      if (before === undefined) delete process.env.PORT;
      else process.env.PORT = before;
      delete process.env.TRIPSPLITTER_TEST_PORT_PROBE;
    }
  });
});

describe('buildConfig', () => {
  it('builds a config for tests without any environment variable', () => {
    const config = buildConfig();
    expect(config).toMatchObject({ nodeEnv: 'test', databasePath: ':memory:', allowedChatIds: [] });
    expect(config.linkSecret.length).toBeGreaterThanOrEqual(32);
    expect(buildConfig({ allowedChatIds: [-5], port: 1 })).toMatchObject({ allowedChatIds: [-5], port: 1 });
  });
});

describe('.env.example', () => {
  it('lists every variable of the config and no real secret', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    const names = [...text.matchAll(/^([A-Z_]+)=/gm)].map((m) => m[1]);
    expect(names.sort()).toEqual(
      [
        'NODE_ENV', 'BOT_TOKEN', 'BOT_USERNAME', 'MINI_APP_NAME', 'ALLOWED_CHAT_IDS', 'LINK_SECRET', 'DATABASE_PATH',
        'AGENT_ENABLED', 'AGENT_MODEL', 'AGENT_DAILY_CAP', 'AGENT_GLOBAL_DAILY_CAP', 'OPENAI_API_KEY', 'PHOTO_DIR', 'RECEIPT_MODEL', 'RECEIPT_DAILY_CAP', 'RECEIPT_GLOBAL_DAILY_CAP', 'PORT', 'WEBHOOK_URL', 'WEBHOOK_SECRET', 'DEV_FAKE_USER',
        'MCP_ENABLED', 'MCP_DAILY_CAP_PER_CONNECTION',
      ].sort(),
    );
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(text).toMatch(/^OPENAI_API_KEY=$/m);
    expect(text).toMatch(/^BOT_TOKEN=000000000:replace/m);
  });
});

describe('agent settings', () => {
  it('defaults enabled from the key, and supports explicit true/false', () => {
    expect(loadConfig(required)).toMatchObject({agentEnabled:false,agentModel:'gpt-6-luna',agentDailyCap:100,agentGlobalDailyCap:1000});
    expect(loadConfig({...required,OPENAI_API_KEY:'placeholder'}).agentEnabled).toBe(true);
    expect(loadConfig({...required,OPENAI_API_KEY:'placeholder',AGENT_ENABLED:'false'}).agentEnabled).toBe(false);
    expect(loadConfig({...required,AGENT_ENABLED:'true',AGENT_MODEL:'test-model',AGENT_DAILY_CAP:'7',AGENT_GLOBAL_DAILY_CAP:'0'})).toMatchObject({agentEnabled:true,agentModel:'test-model',agentDailyCap:7,agentGlobalDailyCap:0});
    expect(loadConfig({...required,OPENAI_API_KEY:'  ',AGENT_ENABLED:''}).agentEnabled).toBe(false);
    expect(buildConfig({openaiApiKey:'fake'}).agentEnabled).toBe(true);
    expect(loadConfig({...required,AGENT_DAILY_CAP:'0'}).agentDailyCap).toBe(0);
  });
  it('names invalid booleans, negative/fractional/unsafe caps', () => {
    expect(failure({...required,AGENT_ENABLED:'yes'}).variables).toEqual(['AGENT_ENABLED']);
    for(const name of ['AGENT_DAILY_CAP','AGENT_GLOBAL_DAILY_CAP'])
      for(const value of ['-1','1.5','no','9007199254740992'])expect(failure({...required,[name]:value}).variables).toEqual([name]);
  });
});

it('defaults photos beside the database and accepts an explicit PHOTO_DIR', () => {
  expect(loadConfig({ ...required, DATABASE_PATH: '/data/trips.db' }).photoDir).toBe('/data/photos');
  expect(loadConfig({ ...required, PHOTO_DIR: './uploads' }).photoDir).toBe('./uploads');
});
