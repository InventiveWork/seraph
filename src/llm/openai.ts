import OpenAI from 'openai';
import { LLMProvider, LLMResponse } from './provider';
import { SeraphConfig } from '../config';
import { CircuitBreaker, RetryManager, RetryPredicates } from '../circuit-breaker';
import { sanitizeErrorMessage, validateApiKey } from '../validation';

function formatTools(tools: any[]): any[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema || t.schema,
    },
  }));
}

export class OpenAIProvider implements LLMProvider {
  private openai: OpenAI;
  private model: string;
  private circuitBreaker: CircuitBreaker;
  private retryManager: RetryManager;

  constructor(config: SeraphConfig) {
    if (!config.apiKey) {
      throw new Error('OpenAI API key not found in config');
    }

    const validation = validateApiKey(config.apiKey);
    if (!validation.valid) {
      throw new Error(`Invalid API key: ${validation.errors.join(', ')}`);
    }

    this.openai = new OpenAI({ apiKey: config.apiKey });
    this.model = config.llm?.model || 'gpt-4-turbo';
    
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
            const request: OpenAI.Chat.ChatCompletionCreateParams = {
              model: this.model,
              messages: [{ role: 'user', content: prompt }],
            };

            if (tools && tools.length > 0) {
              request.tools = formatTools(tools);
            }

            const response = await this.openai.chat.completions.create(request);
            const message = response.choices[0].message;

            const toolCalls = message.tool_calls?.map(tc => ({
              name: tc.function.name,
              arguments: JSON.parse(tc.function.arguments),
            }));

            return {
              text: message.content || undefined,
              toolCalls,
            };
          },
          RetryPredicates.llmErrors,
        );
      });
    } catch (error) {
      const sanitizedMessage = sanitizeErrorMessage(error as Error);
      throw new Error(`OpenAI API error: ${sanitizedMessage}`);
    }
  }

  getCircuitBreakerMetrics() {
    return this.circuitBreaker.getMetrics();
  }
}
