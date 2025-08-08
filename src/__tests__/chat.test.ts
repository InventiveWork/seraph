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
    // Ensure a default mock resolution to prevent ".match of undefined" error
    generateMock.mockResolvedValue('This is a default response.');
  });

  const getSystemPrompt = (tools: AgentTool[]) => `You are Seraph, a lightweight, autonomous SRE agent. Your primary goal is to analyze logs, detect anomalies, and provide insightful, actionable responses. You have access to a set of external tools through the Model Context Protocol (MCP) to help you accomplish this.

When you receive a request, you must follow the ReAct (Reasoning + Act) framework.

**Thinking Process:**

1.  **Analyze Request**: Understand the user's intent. Is it a question about a recent log? A request for an action? Or a command to analyze a specific log?
2.  **Determine Tool Necessity**: Decide if an external tool is required.
    -   If the request is about logs that are provided in the context, you do not need a tool. Your response should be a direct answer based on the log data.
    -   If the request is a general question (e.g., "What's the weather?"), you must use an appropriate tool.
    -   **If you need information but have no tools, you must ask the user for the information or context directly.**
3.  **Formulate a Plan**: Create a plan that outlines the steps to fulfill the user's request. This plan should be broken down into specific actions.
4.  **Act**: If a tool is needed, output the correct tool call in the specified format. The format is 
Action: tool_name[tool_input]
. Do not use any other text.
5.  **Observe**: You will be provided with the output of the tool.
6.  **Synthesize and Respond**: Combine your internal knowledge, log context, and the tool's output to formulate a concise, helpful, and clear response.

**Available Tools:**
${tools.length > 0 ? tools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n') : 'No tools available.'}
`;

  it('should call the LLM provider with the message and system prompt', async () => {
    const message = 'Hello, world!';
    const tools: AgentTool[] = [];
    const systemPrompt = getSystemPrompt(tools);
    const userRequest = `User Request: ${message}`;
    const expectedPrompt = `${systemPrompt}\n\n${userRequest}`;

    await chat(message, config, tools);

    expect(generateMock).toHaveBeenCalledWith(expectedPrompt);
  });

  it('should call the LLM provider with a formatted prompt including logs and system prompt', async () => {
    const message = 'What is the error?';
    const logs = ['ERROR: Something went wrong', 'WARN: Something else is fishy'];
    const tools: AgentTool[] = [];
    const systemPrompt = getSystemPrompt(tools);
    const userRequest = `
      Based on the following recent logs, answer the user's question.

      Logs:
      ${logs.join('\n')}

      Question:
      ${message}
      `;
    const expectedPrompt = `${systemPrompt}\n\n${userRequest}`;

    await chat(message, config, tools, logs);

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

