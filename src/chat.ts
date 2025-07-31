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

  let systemPrompt = `You are a helpful AI assistant. You have access to a set of tools to help you answer the user's question.`;

  if (tools.length > 0) {
    systemPrompt += `

Available tools:
${tools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')}

You can call a tool by responding with a JSON object with two fields: "tool" and "args".
The "tool" field should be the name of the tool to call.
The "args" field should be an object with the arguments to pass to the tool.
`;
  }

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

  // Add the system prompt to the beginning of the prompt
  prompt = `${systemPrompt}\n\n${prompt}`;

  const response = await provider.generate(prompt);

  try {
    const responseObject = JSON.parse(response);
    if (responseObject.tool && responseObject.args) {
      const tool = tools.find((t) => t.name === responseObject.tool);
      if (tool) {
        console.log(`Calling tool: ${tool.name}`);
        const toolResult = await tool.execute(responseObject.args);
        
        let toolResultText = '';
        if (Array.isArray(toolResult.content) && toolResult.content.length > 0) {
          const firstPart = toolResult.content[0];
          if (typeof firstPart === 'object' && firstPart !== null && 'type' in firstPart && firstPart.type === 'text' && 'text' in firstPart) {
            toolResultText = firstPart.text as string;
          }
        } else {
          toolResultText = JSON.stringify(toolResult.content);
        }

        // We can recursively call chat to process the tool's output
        return chat(
          `The tool ${tool.name} returned the following result: ${toolResultText}`,
          config,
          tools,
          logs,
        );
      } else {
        return `Unknown tool: ${responseObject.tool}`;
      }
    }
  } catch (error) {
    // If the response is not a valid JSON object, it's a regular message
    return response;
  }

  return response;
}