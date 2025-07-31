import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider } from './provider';
import { SeraphConfig } from '../config';

export class AnthropicProvider implements LLMProvider {
  private anthropic: Anthropic;
  private model: string;

  constructor(config: SeraphConfig) {
    if (!config.apiKey) {
      throw new Error('Anthropic API key not found in config.');
    }
    this.anthropic = new Anthropic({ apiKey: config.apiKey });
    this.model = config.llm?.model || 'claude-3-opus-20240229';
  }

  async generate(prompt: string): Promise<string> {
    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    
    if (response.content[0].type === 'text') {
      return response.content[0].text;
    }

    return '';
  }
}
