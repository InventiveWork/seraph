export interface ToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface LLMResponse {
  text?: string;
  toolCalls?: ToolCall[];
}

export interface LLMProvider {
  generate(prompt: string, tools?: any[]): Promise<LLMResponse>;
}
