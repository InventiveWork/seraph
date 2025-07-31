import { chat } from '../chat';
import { createLLMProvider } from '../llm';
import { SeraphConfig } from '../config';

jest.mock('../llm');

const mockCreateLLMProvider = createLLMProvider as jest.Mock;

describe('chat', () => {
  const config = {} as SeraphConfig;
  const generateMock = jest.fn();

  beforeEach(() => {
    generateMock.mockClear();
    mockCreateLLMProvider.mockReturnValue({
      generate: generateMock,
    });
  });

  it('should call the LLM provider with the message and system prompt', async () => {
    const message = 'Hello, world!';
    const expectedPrompt = `You are a helpful AI assistant. You have access to a set of tools to help you answer the user's question.\n\n${message}`;
    await chat(message, config, []);

    expect(generateMock).toHaveBeenCalledWith(expectedPrompt);
  });

  it('should call the LLM provider with a formatted prompt including logs and system prompt', async () => {
    const message = 'What is the error?';
    const logs = ['ERROR: Something went wrong', 'WARN: Something else is fishy'];
    const expectedPrompt = `You are a helpful AI assistant. You have access to a set of tools to help you answer the user's question.\n\n
      Based on the following recent logs, answer the user's question.

      Logs:
      ${logs.join('\n')}

      Question:
      ${message}
      `;
    await chat(message, config, [], logs);

    expect(generateMock).toHaveBeenCalledWith(expectedPrompt);
  });

  it('should return the generated response', async () => {
    const message = 'Hello, world!';
    const expectedResponse = 'This is a generated response.';
    generateMock.mockResolvedValue(expectedResponse);

    const response = await chat(message, config, []);

    expect(response).toBe(expectedResponse);
  });
});
