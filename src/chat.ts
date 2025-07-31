import { SeraphConfig } from './config';
import { createLLMProvider } from './llm';

export async function chat(
  message: string,
  config: SeraphConfig,
  logs?: string[],
) {
  const provider = createLLMProvider(config);

  let prompt = message;
  if (logs && logs.length > 0) {
    prompt = `
      Based on the following recent logs, answer the user's question.

      Logs:
      ${logs.join('\n')}

      Question:
      ${message}
      `;
  }

  return provider.generate(prompt);
}
