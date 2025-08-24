import { SeraphConfig } from './config';
import { createLLMProvider } from './llm';
import { AgentTool } from './mcp-server';

export async function chat(
  prompt: string,
  config: SeraphConfig,
  tools: AgentTool[],
  logs?: string[],
): Promise<string> {
  let provider;
  try {
    provider = createLLMProvider(config);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('API key not found') || errorMsg.includes('Invalid API key')) {
      return `❌ Error: ${errorMsg}\n\n💡 To fix this:\n1. Set your API key as an environment variable:\n   export GEMINI_API_KEY="your-api-key-here"\n2. Or add it to your seraph.config.json file:\n   {\n     "apiKey": "your-api-key-here",\n     ...\n   }\n\n🔑 Get your API key from: https://makersuite.google.com/app/apikey`;
    }
    throw error;
  }

  const systemPrompt = `You are Seraph, a lightweight, autonomous SRE agent. Your primary goal is to analyze logs, detect anomalies, and provide insightful, actionable responses. You have access to a set of external tools to help you accomplish this.

When you receive a request, you may reason and use the available tools to gather information before providing a final answer. If a tool is not necessary, you can respond directly.
`;

  let fullPrompt: string;
  if (logs && logs.length > 0) {
    fullPrompt = `
      Based on the following recent logs, answer the user's question.

      --- Logs ---
      ${logs.join('\n')}
      --- End Logs ---

      Question: ${prompt}
    `;
  } else {
    fullPrompt = prompt;
  }

  const conversation = [{ role: 'system', content: systemPrompt }, { role: 'user', content: fullPrompt }];

  for (let i = 0; i < 5; i++) {
    const currentPrompt = conversation.map(m => `${m.role}: ${m.content}`).join('\n\n');
    
    let response;
    try {
      // Add a timeout to prevent hanging
      let timeoutId: NodeJS.Timeout;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('LLM request timed out after 30 seconds')), 30000);
      });
      
      try {
        response = await Promise.race([
          provider.generate(currentPrompt, tools),
          timeoutPromise
        ]) as any;
      } finally {
        // Always clear the timeout to prevent open handles
        if (timeoutId!) {
          clearTimeout(timeoutId);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return `❌ Error generating response: ${errorMsg}\n\n💡 This might be due to:\n- Network connectivity issues\n- API rate limits\n- Invalid API key\n- Service unavailability\n\nPlease try again or check your configuration.`;
    }

    if (response.text) {
      conversation.push({ role: 'assistant', content: response.text });
    }

    if (!response.toolCalls || response.toolCalls.length === 0) {
      return response.text || 'I am unable to provide a response.';
    }

    const toolCall = response.toolCalls[0];
    console.log(`Calling tool: ${toolCall.name} with input: ${JSON.stringify(toolCall.arguments)}`);
    
    const tool = tools.find(t => t.name === toolCall.name);
    if (tool) {
      try {
        const toolResult = await tool.execute(toolCall.arguments);
        const toolResultText = JSON.stringify(toolResult);
        
        console.log(`--- Observation ---
${toolResultText}`);
        conversation.push({ role: 'user', content: `Observation from ${toolCall.name}: ${toolResultText}` });
      } catch (e: any) {
        const errorMessage = `Error executing tool ${toolCall.name}: ${e.message}`;
        console.error(errorMessage);
        conversation.push({ role: 'user', content: errorMessage });
      }
    } else {
      const errorMessage = `Error: Tool '${toolCall.name}' not found.`;
      console.error(errorMessage);
      conversation.push({ role: 'user', content: errorMessage });
    }
  }

  const lastResponse = conversation.filter(m => m.role === 'assistant').pop();
  return lastResponse?.content || 'The agent could not produce a final answer after 5 iterations.';
}