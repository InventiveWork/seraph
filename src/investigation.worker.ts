// src/investigation.worker.ts

import { parentPort, workerData } from 'worker_threads';
import { createLLMProvider } from './llm';
import { LLMProvider } from './llm/provider';
import { AgentTool } from './mcp-manager';

const { config } = workerData;
const provider: LLMProvider = createLLMProvider(config);

async function investigate(log: string, reason: string, tools: AgentTool[], investigationId: string): Promise<any> {
  const MAX_TURNS = 5;
  let scratchpad: any[] = [{ observation: `Initial alert for log: "${log}". Reason: "${reason}"` }];
  const toolSchemas = tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

  console.log(`[Investigator ${process.pid}] Starting investigation ${investigationId} with tools: ${JSON.stringify(toolSchemas.map(t => t.name))}`);

  for (let i = 0; i < MAX_TURNS; i++) {
    console.log(`[Investigator ${process.pid}] Investigation ${investigationId} Turn ${i + 1}`);
    const prompt = `
      You are an SRE investigator performing a root cause analysis.
      Here is a summary of what you know so far, which includes your previous thoughts and the results of tools you have used:
      ${JSON.stringify(scratchpad, null, 2)}

      Based on your investigation so far, what is your next thought? If you need to use a tool, call it. If you have gathered enough information, call the "FINISH" tool.
    `;

    const finishTool = { 
      name: 'FINISH', 
      description: 'Call this when you have a complete root cause analysis.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'A detailed summary of your findings and root cause analysis.' },
        },
        required: ['summary'],
      }
    };
    const availableTools = [...tools, finishTool];
    
    const response = await provider.generate(prompt, availableTools);
    
    if (response.text) {
      scratchpad.push({ thought: response.text });
    }

    if (response.toolCalls && response.toolCalls.length > 0) {
      const toolCall = response.toolCalls[0];
      scratchpad.push({ thought: `I should use the ${toolCall.name} tool with args ${JSON.stringify(toolCall.arguments)}.` });

      if (toolCall.name === 'FINISH') {
        break;
      }

      const tool = tools.find(t => t.name === toolCall.name);
      if (tool) {
        try {
          // In the worker, we can't execute the tool directly as mcpManager is on the main thread.
          // We need to ask the main thread to do it.
          
          // Set up message listener before sending request to avoid race condition
          const toolResult = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              parentPort?.removeListener('message', onMessage);
              reject(new Error('Tool execution timed out'));
            }, 10000);
            
            const onMessage = (msg: any) => {
              if (msg.type === 'tool_result' && msg.investigationId === investigationId) {
                clearTimeout(timeout);
                parentPort?.removeListener('message', onMessage);
                resolve(msg.data);
              }
            };
            
            // Attach listener first, then send message to prevent race condition
            parentPort?.on('message', onMessage);
            parentPort?.postMessage({ type: 'execute_tool', data: { name: tool.name, arguments: toolCall.arguments, investigationId } });
          });

          scratchpad.push({ observation: `Result from ${toolCall.name}: ${JSON.stringify(toolResult)}` });
        } catch (e: any) {
          scratchpad.push({ observation: `Error executing ${toolCall.name}: ${e.message}` });
        }
      } else {
        scratchpad.push({ observation: `Error: Tool '${toolCall.name}' not found.` });
      }
    } else {
      scratchpad.push({ observation: "I have not used a tool. I should either use a tool or use the FINISH tool to complete the investigation." });
    }
  }

  const synthesisPrompt = `
    You are an expert SRE. An incident has occurred. Based on the following investigation trace, provide a detailed analysis.
    
    Investigation Trace:
    ${JSON.stringify(scratchpad, null, 2)}

    Provide your final analysis as a JSON object with the following fields:
    - "rootCauseAnalysis" (string): Your detailed analysis of the likely root cause.
    - "impactAssessment" (string): Who or what is likely affected by this issue.
    - "suggestedRemediation" (array of strings): A list of concrete steps to fix the issue.
  `;
  const finalReportResponse = await provider.generate(synthesisPrompt);
  const finalJsonMatch = finalReportResponse.text?.match(/{[\s\S]*}/);
  let finalAnalysis = { rootCauseAnalysis: "Could not determine root cause.", impactAssessment: "Unknown.", suggestedRemediation: ["Manual investigation required."] };
  if (finalJsonMatch) {
    try {
      finalAnalysis = JSON.parse(finalJsonMatch[0]);
    } catch (e) { /* ignore parsing error */ }
  }
  return { finalAnalysis, investigationTrace: scratchpad };
}


parentPort?.on('message', async (message: any) => {
  if (message.type === 'investigate') {
    const { log, reason, tools, investigationId } = message.data;
    // Don't initialize MCP in worker - main thread handles all MCP connections
    const result = await investigate(log, reason, tools, investigationId);
    parentPort?.postMessage({ type: 'investigation_complete', data: { ...result, initialLog: log, triageReason: reason, investigationId } });
  }
});
