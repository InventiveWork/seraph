import { AnthropicProvider } from '../anthropic';
import Anthropic from '@anthropic-ai/sdk';
import { SeraphConfig } from '../../config';

jest.mock('@anthropic-ai/sdk');

describe('AnthropicProvider', () => {
  const mockedAnthropic = Anthropic as jest.MockedClass<typeof Anthropic>;

  it('should call the messages.create method with the correct prompt', async () => {
    const create = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'test response' }],
    });
    mockedAnthropic.prototype.messages = { create } as any;

    const config: SeraphConfig = {
      port: 8080,
      workers: 4,
      apiKey: 'test-key',
    };
    const provider = new AnthropicProvider(config);
    const response = await provider.generate('test prompt');

    expect(create).toHaveBeenCalledWith({
      model: 'claude-3-opus-20240229',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'test prompt' }],
    });
    expect(response).toBe('test response');
  });
});
