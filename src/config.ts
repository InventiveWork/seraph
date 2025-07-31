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

  return config;
}

