import { FunctionDeclarationSchema, GoogleGenerativeAI, Part } from '@google/generative-ai';
import { LLMProvider, LLMResponse } from './provider';
import { SeraphConfig } from '../config';
import { CircuitBreaker, RetryManager, RetryPredicates } from '../circuit-breaker';
import { sanitizeErrorMessage, validateApiKey } from '../validation';

function formatTools(tools: any[]): any {
  return {
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema || t.schema, // Accept both 'inputSchema' and 'schema'
    })),
  };
}

export class GeminiProvider implements LLMProvider {
  private genAI: GoogleGenerativeAI;
  private model: string;
  private circuitBreaker: CircuitBreaker;
  private retryManager: RetryManager;

  constructor(config: SeraphConfig) {
    if (!config.apiKey) {
      throw new Error('Gemini API key not found in config');
    }

    const validation = validateApiKey(config.apiKey);
    if (!validation.valid) {
      throw new Error(`Invalid API key: ${validation.errors.join(', ')}`);
    }

    this.genAI = new GoogleGenerativeAI(config.apiKey);
    this.model = config.llm?.model ?? 'gemini-2.5-flash-lite';
    
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
            const modelParams: any = { model: this.model };
            if (tools && tools.length > 0) {
              modelParams.tools = [formatTools(tools)];
            }

            const model = this.genAI.getGenerativeModel(modelParams);
            const result = await model.generateContent(prompt);
            const response = result.response;
            const responseContent = response.candidates?.[0]?.content;

            if (!responseContent || !Array.isArray(responseContent.parts) || responseContent.parts.length === 0) {
              return { text: response.text() };
            }

            const toolCalls = responseContent.parts
              .filter((part: Part) => part.functionCall)
              .map((part: Part) => ({
                name: part.functionCall!.name,
                arguments: part.functionCall!.args,
              }));

            return {
              text: response.text(),
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            };
          },
          RetryPredicates.llmErrors,
        );
      });
    } catch (error) {
      const sanitizedMessage = sanitizeErrorMessage(error as Error);
      throw new Error(`Gemini API error: ${sanitizedMessage}`);
    }
  }

  getCircuitBreakerMetrics() {
    return this.circuitBreaker.getMetrics();
  }
}
