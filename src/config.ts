import * as fs from 'fs';
import * as path from 'path';

export interface SeraphConfig {
  port: number;
  workers: number;
  apiKey: string | null;
  serverApiKey: string | null;
  llm?: {
    provider: 'gemini' | 'anthropic' | 'openai';
    model?: string;
  };
  alertManager?: {
    url: string;
  };
  preFilters?: string[];
  rateLimit?: {
    window: number;
    maxRequests: number;
  };
  recentLogsMaxSizeMb?: number;
}

const defaultConfig: SeraphConfig = {
  port: 8080,
  workers: 4,
  apiKey: process.env.SERAPH_API_KEY || null,
  serverApiKey: process.env.SERVER_API_KEY || null,
  llm: {
    provider: 'gemini',
  },
  alertManager: {
    url: 'http://localhost:9093/api/v2/alerts' // Default for Prometheus Alertmanager
  },
  preFilters: [],
  rateLimit: {
    window: 60000, // 1 minute
    maxRequests: 100,
  },
  recentLogsMaxSizeMb: 10, // 10MB
};

export async function loadConfig(): Promise<SeraphConfig> {
  const configPath = path.join(process.cwd(), 'seraph.config.json');
  let userConfig: Partial<SeraphConfig> = {};

  try {
    await fs.promises.access(configPath);
    userConfig = JSON.parse(await fs.promises.readFile(configPath, 'utf-8'));
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.error("Error reading or parsing 'seraph.config.json'.", error);
    }
  }

  const config: SeraphConfig = {
    ...defaultConfig,
    ...userConfig,
    llm: { ...defaultConfig.llm, ...userConfig.llm } as SeraphConfig['llm'],
    alertManager: { ...defaultConfig.alertManager, ...userConfig.alertManager } as SeraphConfig['alertManager'],
    rateLimit: { ...defaultConfig.rateLimit, ...userConfig.rateLimit } as SeraphConfig['rateLimit'],
  };

  // Set API key from environment variables if not already set
  if (!config.apiKey) {
    switch (config.llm?.provider) {
      case 'gemini':
        config.apiKey = process.env.GEMINI_API_KEY || null;
        break;
      case 'anthropic':
        config.apiKey = process.env.ANTHROPIC_API_KEY || null;
        break;
      case 'openai':
        config.apiKey = process.env.OPENAI_API_KEY || null;
        break;
      default:
        config.apiKey = process.env.SERAPH_API_KEY || null;
        break;
    }
  }

  // Validate configuration values
  if (typeof config.port !== 'number' || config.port <= 0) {
    throw new Error('Invalid configuration: port must be a positive number.');
  }
  if (typeof config.workers !== 'number' || config.workers <= 0) {
    throw new Error('Invalid configuration: workers must be a positive number.');
  }
  if (userConfig.apiKey !== undefined && typeof userConfig.apiKey !== 'string' && userConfig.apiKey !== null) {
    throw new Error('Invalid configuration: apiKey must be a string or null.');
  }
  if (userConfig.serverApiKey !== undefined && typeof userConfig.serverApiKey !== 'string' && userConfig.serverApiKey !== null) {
    throw new Error('Invalid configuration: serverApiKey must be a string or null.');
  }

  if (config.llm) {
    const validProviders = ['gemini', 'anthropic', 'openai'];
    if (!validProviders.includes(config.llm.provider)) {
      throw new Error(`Invalid configuration: llm.provider must be one of ${validProviders.join(', ')}.`);
    }
    if (userConfig.llm?.model !== undefined && typeof userConfig.llm.model !== 'string') {
      throw new Error('Invalid configuration: llm.model must be a string.');
    }
  }

  if (config.alertManager) {
    if (userConfig.alertManager?.url !== undefined && typeof userConfig.alertManager.url !== 'string') {
      throw new Error('Invalid configuration: alertManager.url must be a string.');
    }
  }

  if (config.preFilters) {
    if (!Array.isArray(config.preFilters) || !config.preFilters.every(f => typeof f === 'string')) {
      throw new Error('Invalid configuration: preFilters must be an array of strings.');
    }
  }

  if (config.rateLimit) {
    if (typeof config.rateLimit.window !== 'number' || config.rateLimit.window <= 0) {
      throw new Error('Invalid configuration: rateLimit.window must be a positive number.');
    }
    if (typeof config.rateLimit.maxRequests !== 'number' || config.rateLimit.maxRequests <= 0) {
      throw new Error('Invalid configuration: rateLimit.maxRequests must be a positive number.');
    }
  }

  if (userConfig.recentLogsMaxSizeMb !== undefined && (typeof userConfig.recentLogsMaxSizeMb !== 'number' || userConfig.recentLogsMaxSizeMb <= 0)) {
    throw new Error('Invalid configuration: recentLogsMaxSizeMb must be a positive number.');
  }

  return config;
}

