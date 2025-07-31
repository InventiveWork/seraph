import { GeminiProvider } from '../gemini';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SeraphConfig } from '../../config';

jest.mock('@google/generative-ai');

describe('GeminiProvider', () => {
  const mockedGoogleGenerativeAI = GoogleGenerativeAI as jest.MockedClass<typeof GoogleGenerativeAI>;

  it('should call the generateContent method with the correct prompt', async () => {
    const generateContent = jest.fn().mockResolvedValue({
      response: {
        text: () => 'test response',
      },
    });
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
    const response = await provider.generate('test prompt');

    expect(generateContent).toHaveBeenCalledWith('test prompt');
    expect(response).toBe('test response');
  });
});
