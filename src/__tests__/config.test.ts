import { loadConfig } from '../config';
import * as fs from 'fs';

jest.mock('fs');

describe('loadConfig', () => {
  const mockedFs = fs as jest.Mocked<typeof fs>;

  afterEach(() => {
    jest.resetAllMocks();
    delete process.env.SERAPH_API_KEY;
  });

  it('should return the default config if no config file is found', () => {
    mockedFs.existsSync.mockReturnValue(false);
    const config = loadConfig();
    expect(config.port).toBe(8080);
    expect(config.workers).toBe(4);
    expect(config.alertManager?.url).toBe('http://localhost:9093/api/v2/alerts');
  });

  it('should load the config from a file if it exists', () => {
    const userConfig = {
      port: 9000,
      workers: 8,
      alertManager: {
        url: 'http://custom-alertmanager.com'
      }
    };
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(userConfig));
    const config = loadConfig();
    expect(config.port).toBe(9000);
    expect(config.workers).toBe(8);
    expect(config.alertManager?.url).toBe('http://custom-alertmanager.com');
  });

  it('should use the environment variable for the api key if it is set', () => {
    process.env.SERAPH_API_KEY = 'test-key';
    mockedFs.existsSync.mockReturnValue(false);
    const config = loadConfig();
    expect(config.apiKey).toBe('test-key');
  });

  it('should prioritize the api key from the config file', () => {
    process.env.SERAPH_API_KEY = 'env-key';
    const userConfig = {
      apiKey: 'file-key',
    };
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(userConfig));
    const config = loadConfig();
    expect(config.apiKey).toBe('file-key');
  });
});
