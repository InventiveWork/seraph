export interface LLMProvider {
  generate(prompt: string): Promise<string>;
}
