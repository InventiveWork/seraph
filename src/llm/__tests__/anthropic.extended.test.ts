import { AnthropicProvider } from '../anthropic';
import Anthropic from '@anthropic-ai/sdk';
import { SeraphConfig } from '../../config';

jest.mock('@anthropic-ai/sdk');

describe('AnthropicProvider', () => {
  const mockedAnthropic = Anthropic as jest.MockedClass<typeof Anthropic>;

  it('should handle errors from the Anthropic API', async () => {
    const create = jest.fn().mockRejectedValue(new Error('Anthropic API error'));
    mockedAnthropic.prototype.messages = { create } as any;

    const config: SeraphConfig = {
      port: 8080,
      workers: 4,
      apiKey: 'test-key',
      serverApiKey: null,
    };
    const provider = new AnthropicProvider(config);

    await expect(provider.generate('test prompt')).rejects.toThrow('Anthropic API error');
  });

  it('should throw an error if no API key is provided', () => {
    const config: SeraphConfig = {
      port: 8080,
      workers: 4,
      apiKey: null,
      serverApiKey: null,
    };
    expect(() => new AnthropicProvider(config)).toThrow('Anthropic API key not found in config');
  });
});
