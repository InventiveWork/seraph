import { chat } from '../chat';
import { createLLMProvider } from '../llm';
import { SeraphConfig } from '../config';
import { AgentTool } from '../mcp-manager';

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
    // Default mock for tests that don't care about the response content
    generateMock.mockResolvedValue({ text: 'Default response' });
  });

  it('should call the LLM provider with a conversational prompt', async () => {
    const message = 'Hello, world!';
    const tools: AgentTool[] = [];
    
    await chat(message, config, tools);

    const receivedPrompt = generateMock.mock.calls[0][0];
    expect(receivedPrompt).toContain('system: You are Seraph');
    expect(receivedPrompt).toContain('user: Hello, world!');
    expect(generateMock.mock.calls[0][1]).toEqual(tools);
  });

  it('should include logs in the conversational prompt', async () => {
    const message = 'What is the error?';
    const logs = ['ERROR: Something went wrong', 'WARN: Something else is fishy'];
    const tools: AgentTool[] = [];

    await chat(message, config, tools, logs);

    const receivedPrompt = generateMock.mock.calls[0][0];
    expect(receivedPrompt).toContain('system: You are Seraph');
    expect(receivedPrompt).toContain('--- Logs ---');
    expect(receivedPrompt).toContain('ERROR: Something went wrong');
    expect(receivedPrompt).toContain('Question: What is the error?');
    expect(generateMock.mock.calls[0][1]).toEqual(tools);
  });

  it('should return the final text response', async () => {
    const message = 'Hello, world!';
    const expectedResponse = 'This is a generated response.';
    generateMock.mockResolvedValue({ text: expectedResponse });

    const response = await chat(message, config, []);

    expect(response).toBe(expectedResponse);
  });
});

