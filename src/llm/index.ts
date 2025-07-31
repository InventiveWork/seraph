import { LLMProvider } from './provider';
import { GeminiProvider } from './gemini';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { SeraphConfig } from '../config';

export function createLLMProvider(config: SeraphConfig): LLMProvider {
  switch (config.llm?.provider) {
    case 'gemini':
      return new GeminiProvider(config);
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    default:
      return new GeminiProvider(config);
  }
}
