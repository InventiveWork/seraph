import { SeraphConfig } from './config';
import { createLLMProvider } from './llm';
import { AgentTool } from './mcp-manager';

export async function chat(
  message: string,
  config: SeraphConfig,
  tools: AgentTool[],
  logs?: string[],
): Promise<string> {
  const provider = createLLMProvider(config);

  let systemPrompt = `You are Seraph, a lightweight, autonomous SRE agent. Your primary goal is to analyze logs, detect anomalies, and provide insightful, actionable responses. You have access to a set of external tools through the Model Context Protocol (MCP) to help you accomplish this.

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

  let userRequest: string;
  if (logs && logs.length > 0) {
    userRequest = `
      Based on the following recent logs, answer the user's question.

      Logs:
      ${logs.join('\n')}

      Question:
      ${message}
      `;
  } else {
    userRequest = `User Request: ${message}`;
  }

  // Add the system prompt to the beginning of the prompt
  const prompt = `${systemPrompt}\n\n${userRequest}`;

  let response = await provider.generate(prompt);
  console.log(`\n--- Thought ---\n${response}`);

  // ReAct loop
  for (let i = 0; i < 5; i++) { // Limit to 5 iterations to prevent infinite loops
    const actionMatch = response.match(/Action: (.*)\[(.*)\]/);

    if (actionMatch) {
      const toolName = actionMatch[1];
      const toolInput = actionMatch[2];
      const tool = tools.find((t) => t.name === toolName);

      if (tool) {
        console.log(`\n--- Action ---
Calling tool: ${tool.name} with input: ${toolInput}`);
        try {
          const toolResult = await tool.execute(JSON.parse(toolInput));
          let toolResultText = '';
          if (Array.isArray(toolResult.content) && toolResult.content.length > 0) {
            const firstPart = toolResult.content[0];
            if (typeof firstPart === 'object' && firstPart !== null && 'type' in firstPart && firstPart.type === 'text' && 'text' in firstPart) {
              toolResultText = firstPart.text as string;
            }
          } else {
            toolResultText = JSON.stringify(toolResult.content);
          }
          
          console.log(`\n--- Observation ---
${toolResultText}`);
          const newPrompt = `${prompt}\nObservation: ${toolResultText}`;
          response = await provider.generate(newPrompt);
          console.log(`\n--- Thought ---
${response}`);
        } catch (error: any) {
          console.log(`\n--- Observation ---
Error executing tool ${toolName}: ${error.message}`);
          const newPrompt = `${prompt}\nObservation: Error executing tool ${toolName}: ${error.message}`;
          response = await provider.generate(newPrompt);
          console.log(`\n--- Thought ---
${response}`);
        }
      } else {
        const observation = `Unknown tool: ${toolName}`;
        console.log(`\n--- Observation ---
${observation}`);
        const newPrompt = `${prompt}\nObservation: ${observation}`;
        response = await provider.generate(newPrompt);
        console.log(`\n--- Thought ---
${response}`);
      }
    } else {
      // If there's no action, it's the final answer
      return response;
    }
  }

  return "The agent could not produce a final answer after 5 iterations.";
}