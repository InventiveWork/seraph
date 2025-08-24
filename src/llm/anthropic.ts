import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider, LLMResponse } from './provider';
import { SeraphConfig } from '../config';
import { CircuitBreaker, RetryManager, RetryPredicates } from '../circuit-breaker';
import { sanitizeErrorMessage, validateApiKey } from '../validation';

function formatTools(tools: any[]): any[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema || t.schema,
  }));
}

export class AnthropicProvider implements LLMProvider {
  private anthropic: Anthropic;
  private model: string;
  private circuitBreaker: CircuitBreaker;
  private retryManager: RetryManager;

  constructor(config: SeraphConfig) {
    if (!config.apiKey) {
      throw new Error('Anthropic API key not found in config');
    }

    const validation = validateApiKey(config.apiKey);
    if (!validation.valid) {
      throw new Error(`Invalid API key: ${validation.errors.join(', ')}`);
    }

    this.anthropic = new Anthropic({ apiKey: config.apiKey });
    this.model = config.llm?.model ?? 'claude-3-5-sonnet-20241022';
    
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      recoveryTimeout: 60000, // 1 minute
      monitoringPeriod: 300000, // 5 minutes
      successThreshold: 3,
    });
    
    this.retryManager = new RetryManager(3, 1000, 30000, true);
  }

  async generate(prompt: string, tools?: any[]): Promise<LLMResponse> {
    try {
      return await this.circuitBreaker.execute(async () => {
        return await this.retryManager.executeWithRetry(
          async () => {
            const request: Anthropic.Messages.MessageCreateParams = {
              model: this.model,
              max_tokens: 1024,
              messages: [{ role: 'user', content: prompt }],
            };

            if (tools && tools.length > 0) {
              request.tools = formatTools(tools);
            }

            const response = await this.anthropic.messages.create(request);
            
            const textContent = response.content.find(block => block.type === 'text')?.text;
            const toolCalls = response.content
              .filter((block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use')
              .map(block => ({
                name: block.name,
                arguments: block.input as Record<string, any>,
              }));

            return {
              text: textContent,
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            };
          },
          RetryPredicates.llmErrors,
        );
      });
    } catch (error) {
      const sanitizedMessage = sanitizeErrorMessage(error as Error);
      throw new Error(`Anthropic API error: ${sanitizedMessage}`);
    }
  }

  getCircuitBreakerMetrics() {
    return this.circuitBreaker.getMetrics();
  }
}
