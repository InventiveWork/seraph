import { GoogleGenerativeAI } from '@google/generative-ai';
import { LLMProvider } from './provider';
import { SeraphConfig } from '../config';

export class GeminiProvider implements LLMProvider {
  private genAI: GoogleGenerativeAI;
  private model: string;

  constructor(config: SeraphConfig) {
    if (!config.apiKey) {
      throw new Error('Gemini API key not found in config.');
    }
    this.genAI = new GoogleGenerativeAI(config.apiKey);
    this.model = config.llm?.model || 'gemini-1.5-pro-latest';
  }

  async generate(prompt: string): Promise<string> {
    const model = this.genAI.getGenerativeModel({ model: this.model });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  }
}
