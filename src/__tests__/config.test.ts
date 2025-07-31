import { loadConfig, SeraphConfig } from '../config';
import * as fs from 'fs';

jest.mock('fs', () => ({
  promises: {
    access: jest.fn(),
    readFile: jest.fn(),
  },
}));

const mockedFs = fs.promises as jest.Mocked<typeof fs.promises>;

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules(); // Clears the cache
    process.env = { ...originalEnv }; // Make a copy
    mockedFs.readFile.mockClear();
    mockedFs.access.mockClear();
  });

  afterAll(() => {
    process.env = originalEnv; // Restore old environment
  });

  it('should return the default config if no config file is found', async () => {
    const error = new Error('File not found');
    (error as any).code = 'ENOENT';
    mockedFs.access.mockRejectedValue(error);
    const config = await loadConfig();
    expect(config.port).toBe(8080);
    expect(config.workers).toBe(4);
  });

  it('should load the user config from seraph.config.json', async () => {
    const userConfig: Partial<SeraphConfig> = {
      port: 9000,
      workers: 8,
      llm: { provider: 'openai', model: 'gpt-4' },
    };
    mockedFs.access.mockResolvedValue(undefined);
    mockedFs.readFile.mockResolvedValue(JSON.stringify(userConfig));

    const config = await loadConfig();
    expect(config.port).toBe(9000);
    expect(config.workers).toBe(8);
    expect(config.llm?.provider).toBe('openai');
    expect(config.llm?.model).toBe('gpt-4');
  });

  it('should use GEMINI_API_KEY for gemini provider', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    const error = new Error('File not found');
    (error as any).code = 'ENOENT';
    mockedFs.access.mockRejectedValue(error); // No config file
    const config = await loadConfig();
    expect(config.apiKey).toBe('gemini-key');
  });

  it('should use ANTHROPIC_API_KEY for anthropic provider', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    const userConfig = { llm: { provider: 'anthropic' } };
    mockedFs.access.mockResolvedValue(undefined);
    mockedFs.readFile.mockResolvedValue(JSON.stringify(userConfig));
    const config = await loadConfig();
    expect(config.apiKey).toBe('anthropic-key');
  });

  it('should use OPENAI_API_KEY for openai provider', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    const userConfig = { llm: { provider: 'openai' } };
    mockedFs.access.mockResolvedValue(undefined);
    mockedFs.readFile.mockResolvedValue(JSON.stringify(userConfig));
    const config = await loadConfig();
    expect(config.apiKey).toBe('openai-key');
  });

  it('should prioritize the api key from the config file over environment variables', async () => {
    process.env.GEMINI_API_KEY = 'env-key';
    const userConfig = { apiKey: 'file-key' };
    mockedFs.access.mockResolvedValue(undefined);
    mockedFs.readFile.mockResolvedValue(JSON.stringify(userConfig));

    const config = await loadConfig();
    expect(config.apiKey).toBe('file-key');
  });

  it('should handle invalid JSON in the config file gracefully', async () => {
    mockedFs.access.mockResolvedValue(undefined);
    mockedFs.readFile.mockResolvedValue('invalid json');
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const config = await loadConfig();
    expect(config.port).toBe(8080); // Should fall back to default
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});

