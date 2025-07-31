import * as fs from 'fs';
import * as path from 'path';

export interface SeraphConfig {
  port: number;
  workers: number;
  apiKey: string | null;
  llm?: {
    provider: 'gemini' | 'anthropic' | 'openai';
    model?: string;
  };
  alertManager?: {
    url: string;
  };
  preFilters?: string[];
}

const defaultConfig: SeraphConfig = {
  port: 8080,
  workers: 4,
  apiKey: process.env.SERAPH_API_KEY || null,
  llm: {
    provider: 'gemini',
  },
  alertManager: {
    url: 'http://localhost:9093/api/v2/alerts' // Default for Prometheus Alertmanager
  },
  preFilters: [],
};

export function loadConfig(): SeraphConfig {
  const configPath = path.join(process.cwd(), 'seraph.config.json');
  let userConfig: Partial<SeraphConfig> = {};

  if (fs.existsSync(configPath)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (error) {
      console.error("Error reading or parsing 'seraph.config.json'.", error);
    }
  }

  const config: SeraphConfig = {
    ...defaultConfig,
    ...userConfig,
    llm: { ...defaultConfig.llm, ...userConfig.llm } as SeraphConfig['llm'],
    alertManager: { ...defaultConfig.alertManager, ...userConfig.alertManager } as SeraphConfig['alertManager'],
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
