import { GeminiProvider } from '../gemini';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SeraphConfig } from '../../config';

jest.mock('@google/generative-ai');

describe('GeminiProvider', () => {
  const mockedGoogleGenerativeAI = GoogleGenerativeAI as jest.MockedClass<typeof GoogleGenerativeAI>;

  it('should handle errors from the Gemini API', async () => {
    const generateContent = jest.fn().mockRejectedValue(new Error('Gemini API error'));
    mockedGoogleGenerativeAI.prototype.getGenerativeModel = jest.fn().mockReturnValue({
      generateContent,
    } as any);

    const config: SeraphConfig = {
      port: 8080,
      workers: 4,
      apiKey: 'test-key',
      serverApiKey: null,
    };
    const provider = new GeminiProvider(config);

    await expect(provider.generate('test prompt')).rejects.toThrow('Gemini API error');
  });

  it('should throw an error if no API key is provided', () => {
    const config: SeraphConfig = {
      port: 8080,
      workers: 4,
      apiKey: null,
      serverApiKey: null,
    };
    expect(() => new GeminiProvider(config)).toThrow('Gemini API key not found in config');
  });
});
