import OpenAI from 'openai';
import { LLMProvider } from './provider';
import { SeraphConfig } from '../config';

export class OpenAIProvider implements LLMProvider {
  private openai: OpenAI;
  private model: string;

  constructor(config: SeraphConfig) {
    if (!config.apiKey) {
      throw new Error('OpenAI API key not found in config.');
    }
    this.openai = new OpenAI({ apiKey: config.apiKey });
    this.model = config.llm?.model || 'gpt-4-turbo';
  }

  async generate(prompt: string): Promise<string> {
    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.choices[0].message.content || '';
  }
}
