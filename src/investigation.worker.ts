// src/investigation.worker.ts

import { parentPort, workerData } from 'worker_threads';
import { createLLMProvider } from './llm';
import { LLMProvider } from './llm/provider';
import { AgentTool } from './mcp-manager';

const { config } = workerData;
const provider: LLMProvider = createLLMProvider(config);

async function investigate(log: string, reason: string, tools: AgentTool[], investigationId: string): Promise<any> {
  const MAX_TURNS = 5;
  let scratchpad: any[] = [{ 
    observation: `Initial alert for log: "${log}". Reason: "${reason}". 
    
    INVESTIGATION REQUIREMENTS:
    - MUST write multiple custom Prometheus queries to investigate metrics around this incident
    - MUST check Prometheus alerts, targets, and rules for correlation
    - MUST use time-based queries to understand trends before/during the incident
    - MUST use Git tools to check recent commits and correlate with incident timing
    - MUST clone or examine the Seraph repository for code context
    - MUST correlate metrics data, log patterns, and code changes for comprehensive root cause analysis` 
  }];
  
  // Track tool usage for enhanced alerting
  const toolUsageLog: Array<{tool: string, timestamp: string, args: any, success: boolean, executionTime?: number}> = [];
  
  const toolSchemas = tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

  console.log(`[Investigator ${process.pid}] Starting investigation ${investigationId} with tools: ${JSON.stringify(toolSchemas.map(t => t.name))}`);

  for (let i = 0; i < MAX_TURNS; i++) {
    console.log(`[Investigator ${process.pid}] Investigation ${investigationId} Turn ${i + 1}`);
    const prompt = `
      You are an SRE investigator performing a root cause analysis. Use ALL available tools systematically to investigate infrastructure issues.

      CRITICAL: You MUST write custom Prometheus queries during EVERY investigation to:
      - Query specific metrics related to the incident (error rates, latency, resource usage)
      - Check metrics around the incident timeframe using time ranges (e.g., [5m], [15m], [1h])
      - Investigate infrastructure health metrics that might correlate with the issue
      - Use PromQL functions like rate(), sum(), avg(), max() to analyze trends

      Examples of custom Prometheus queries you should write based on incident type:
      
      For ERROR/FAILURE logs:
      - sum(rate(http_requests_total{status=~"5.."}[5m])) by (pod) - HTTP error rates
      - rate(log_messages_total{level="error"}[10m]) - Application error trends
      - sum(rate(container_last_seen[5m])) by (container) - Container restart rates
      
      For PERFORMANCE issues:
      - histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) - Response latency
      - avg(container_cpu_usage_seconds_total) by (pod) - CPU usage trends
      - avg(container_memory_working_set_bytes) by (pod) - Memory usage patterns
      
      For NETWORK/CONNECTIVITY issues:
      - rate(node_network_receive_drop_total[5m]) - Network packet drops
      - sum(rate(container_network_receive_errors_total[5m])) by (pod) - Network errors
      - up{job=~".*"} - Service availability status
      
      For RESOURCE issues:
      - node_filesystem_avail_bytes / node_filesystem_size_bytes - Disk usage
      - rate(node_disk_io_time_seconds_total[5m]) - Disk I/O patterns
      - rate(node_context_switches_total[5m]) - System load indicators

      Here is a summary of what you know so far, which includes your previous thoughts and the results of tools you have used:
      ${JSON.stringify(scratchpad, null, 2)}

      Investigation checklist - ensure you:
      1. Check current Prometheus alerts for related issues
      2. Query target health to identify infrastructure problems  
      3. Write custom PromQL queries specific to the incident type
      4. Use Kubernetes tools to check pod status, events, and resource usage
      5. Get pod logs and describe failing resources for context
      6. Correlate metrics data with log patterns and Kubernetes state
      7. Use Git tools to check for recent code changes if relevant

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
        const startTime = Date.now();
        const timestamp = new Date().toISOString();
        
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

          const executionTime = Date.now() - startTime;
          toolUsageLog.push({
            tool: toolCall.name,
            timestamp,
            args: toolCall.arguments,
            success: true,
            executionTime
          });

          scratchpad.push({ observation: `Result from ${toolCall.name}: ${JSON.stringify(toolResult)}` });
        } catch (e: any) {
          const executionTime = Date.now() - startTime;
          toolUsageLog.push({
            tool: toolCall.name,
            timestamp,
            args: toolCall.arguments,
            success: false,
            executionTime
          });
          
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
    - "suggestedRemediation" (array of strings): A list of SPECIFIC, ACTIONABLE steps to fix the issue immediately.

    CRITICAL REQUIREMENTS for suggestedRemediation:
    - Include exact commands with proper syntax (kubectl, docker, systemctl, etc.)
    - Specify exact file paths, service names, and configuration changes
    - Provide step-by-step procedures in the correct order
    - Include verification commands to confirm fixes worked
    - Add rollback instructions if the fix might cause issues
    - Be specific enough that any SRE can execute immediately without guessing

    Example good remediation steps:
    ✓ "Restart the failed pod: kubectl delete pod <pod-name> -n <namespace>"
    ✓ "Check disk space on node: kubectl exec -it <pod> -- df -h /var/lib/docker"
    ✓ "Scale deployment to increase replicas: kubectl scale deployment <name> --replicas=3"
    ✓ "Verify fix by checking pod status: kubectl get pods -n <namespace> --watch"
    
    Example bad remediation steps:
    ✗ "Investigate the issue further"
    ✗ "Check system resources"
    ✗ "Restart services if needed"
  `;
  const finalReportResponse = await provider.generate(synthesisPrompt);
  console.log(`[Investigator ${process.pid}] Final report response:`, finalReportResponse.text?.substring(0, 500));
  
  let finalAnalysis = { rootCauseAnalysis: "Could not determine root cause.", impactAssessment: "Unknown.", suggestedRemediation: ["Manual investigation required."] };
  
  if (finalReportResponse.text) {
    try {
      // Try multiple JSON extraction methods
      const cleanedResponse = finalReportResponse.text
        .replace(/```json\s*/g, '')  // Remove markdown code blocks
        .replace(/```\s*/g, '')      // Remove remaining code blocks
        .trim();
      
      // Try to find complete JSON object
      let jsonStr = '';
      const jsonStart = cleanedResponse.indexOf('{');
      if (jsonStart !== -1) {
        // Find the matching closing brace
        let braceCount = 0;
        let jsonEnd = -1;
        for (let i = jsonStart; i < cleanedResponse.length; i++) {
          if (cleanedResponse[i] === '{') braceCount++;
          if (cleanedResponse[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              jsonEnd = i;
              break;
            }
          }
        }
        
        if (jsonEnd !== -1) {
          jsonStr = cleanedResponse.substring(jsonStart, jsonEnd + 1);
        } else {
          // JSON might be truncated, try to close it
          const partial = cleanedResponse.substring(jsonStart);
          jsonStr = partial + '}';  // Add missing closing brace
        }
      }
      
      if (jsonStr) {
        console.log(`[Investigator ${process.pid}] Extracted JSON:`, jsonStr.substring(0, 200));
        finalAnalysis = JSON.parse(jsonStr);
        console.log(`[Investigator ${process.pid}] Successfully parsed final analysis`);
      } else {
        console.error(`[Investigator ${process.pid}] No valid JSON structure found in response`);
      }
    } catch (e) {
      console.error(`[Investigator ${process.pid}] JSON parsing failed:`, e);
      console.error(`[Investigator ${process.pid}] Response length:`, finalReportResponse.text.length);
      
      // Try to extract partial information using regex as fallback
      try {
        const rootCauseMatch = finalReportResponse.text.match(/"rootCauseAnalysis":\s*"([^"]+)"/);
        const impactMatch = finalReportResponse.text.match(/"impactAssessment":\s*"([^"]+)"/);
        const remediationMatch = finalReportResponse.text.match(/"suggestedRemediation":\s*\[([\s\S]*?)\]/);
        
        if (rootCauseMatch || impactMatch || remediationMatch) {
          console.log(`[Investigator ${process.pid}] Extracting partial analysis from malformed JSON`);
          finalAnalysis = {
            rootCauseAnalysis: rootCauseMatch ? rootCauseMatch[1] : "Could not determine root cause.",
            impactAssessment: impactMatch ? impactMatch[1] : "Unknown.",
            suggestedRemediation: remediationMatch ? 
              remediationMatch[1].split(',').map(s => s.replace(/"/g, '').trim()).filter(s => s.length > 0) :
              ["Manual investigation required."]
          };
        }
      } catch (fallbackError) {
        console.error(`[Investigator ${process.pid}] Fallback parsing also failed:`, fallbackError);
      }
    }
  } else {
    console.error(`[Investigator ${process.pid}] No response text received`);
  }
  return { finalAnalysis, investigationTrace: scratchpad, toolUsage: toolUsageLog };
}


parentPort?.on('message', async (message: any) => {
  if (message.type === 'investigate') {
    const { log, reason, tools, investigationId } = message.data;
    // Don't initialize MCP in worker - main thread handles all MCP connections
    const result = await investigate(log, reason, tools, investigationId);
    parentPort?.postMessage({ type: 'investigation_complete', data: { ...result, initialLog: log, triageReason: reason, investigationId } });
  }
});
