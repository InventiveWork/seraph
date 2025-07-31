import { OpenAIProvider } from '../openai';
import OpenAI from 'openai';
import { SeraphConfig } from '../../config';

jest.mock('openai');

describe('OpenAIProvider', () => {
  const mockedOpenAI = OpenAI as jest.MockedClass<typeof OpenAI>;

  it('should handle errors from the OpenAI API', async () => {
    const create = jest.fn().mockRejectedValue(new Error('OpenAI API error'));
    mockedOpenAI.prototype.chat = { completions: { create } } as any;

    const config: SeraphConfig = {
      port: 8080,
      workers: 4,
      apiKey: 'test-key',
      serverApiKey: null,
    };
    const provider = new OpenAIProvider(config);

    await expect(provider.generate('test prompt')).rejects.toThrow('OpenAI API error');
  });

  it('should throw an error if no API key is provided', () => {
    const config: SeraphConfig = {
      port: 8080,
      workers: 4,
      apiKey: null,
      serverApiKey: null,
    };
    expect(() => new OpenAIProvider(config)).toThrow('OpenAI API key not found in config.');
  });
});
