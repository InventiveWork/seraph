import { createLLMProvider } from '../';
import { GeminiProvider } from '../gemini';
import { AnthropicProvider } from '../anthropic';
import { OpenAIProvider } from '../openai';
import { SeraphConfig } from '../../config';

jest.mock('../gemini');
jest.mock('../anthropic');
jest.mock('../openai');

describe('createLLMProvider', () => {
  it('should create a GeminiProvider by default', () => {
    const config: SeraphConfig = {
      port: 8080,
      workers: 4,
      apiKey: 'test-key',
    };
    const provider = createLLMProvider(config);
    expect(provider).toBeInstanceOf(GeminiProvider);
  });

  it('should create a GeminiProvider when specified', () => {
    const config: SeraphConfig = {
      port: 8080,
      workers: 4,
      apiKey: 'test-key',
      llm: {
        provider: 'gemini',
      },
    };
    const provider = createLLMProvider(config);
    expect(provider).toBeInstanceOf(GeminiProvider);
  });

  it('should create an AnthropicProvider when specified', () => {
    const config: SeraphConfig = {
      port: 8080,
      workers: 4,
      apiKey: 'test-key',
      llm: {
        provider: 'anthropic',
      },
    };
    const provider = createLLMProvider(config);
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it('should create an OpenAIProvider when specified', () => {
    const config: SeraphConfig = {
      port: 8080,
      workers: 4,
      apiKey: 'test-key',
      llm: {
        provider: 'openai',
      },
    };
    const provider = createLLMProvider(config);
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });
});
