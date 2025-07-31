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

  it('should call the LLM provider with the message as the prompt', async () => {
    const message = 'Hello, world!';
    await chat(message, config);

    expect(generateMock).toHaveBeenCalledWith(message);
  });

  it('should call the LLM provider with a formatted prompt including logs', async () => {
    const message = 'What is the error?';
    const logs = ['ERROR: Something went wrong', 'WARN: Something else is fishy'];
    const expectedPrompt = `
      Based on the following recent logs, answer the user's question.

      Logs:
      ${logs.join('\n')}

      Question:
      ${message}
      `;
    await chat(message, config, logs);

    expect(generateMock).toHaveBeenCalledWith(expectedPrompt);
  });

  it('should return the generated response', async () => {
    const message = 'Hello, world!';
    const expectedResponse = 'This is a generated response.';
    generateMock.mockResolvedValue(expectedResponse);

    const response = await chat(message, config);

    expect(response).toBe(expectedResponse);
  });
});
