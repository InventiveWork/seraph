import { OpenAIProvider } from '../openai';
import OpenAI from 'openai';
import { SeraphConfig } from '../../config';

jest.mock('openai');

describe('OpenAIProvider', () => {
  const mockedOpenAI = OpenAI as jest.MockedClass<typeof OpenAI>;

  it('should call the chat.completions.create method with the correct prompt', async () => {
    const create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: 'test response' } }],
    });
    mockedOpenAI.prototype.chat = { completions: { create } } as any;

    const config: SeraphConfig = {
      port: 8080,
      workers: 4,
      apiKey: 'test-key',
      serverApiKey: null,
    };
    const provider = new OpenAIProvider(config);
    const response = await provider.generate('test prompt');

    expect(create).toHaveBeenCalledWith({
      model: 'gpt-4-turbo',
      messages: [{ role: 'user', content: 'test prompt' }],
    });
    expect(response).toEqual({ text: 'test response', toolCalls: undefined });
  });
});
