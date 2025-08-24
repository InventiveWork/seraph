// Enhanced Investigation Worker with Memory Management
import { parentPort, workerData } from 'worker_threads';
import { createLLMProvider } from './llm';
import { LLMProvider } from './llm/provider';
import { AgentTool } from './mcp-manager';
import { MemoryManager } from './memory-manager';
import { metrics } from './metrics';

const { config } = workerData;
const provider: LLMProvider = createLLMProvider(config);

// Initialize memory-aware system
const memoryManager = new MemoryManager({
  redis: config.llmCache?.redis ? {
    url: config.llmCache.redis.url || process.env.REDIS_URL,
    host: config.llmCache.redis.host || (process.env.REDIS_HOST ?? 'localhost'),
    port: config.llmCache.redis.port || parseInt(process.env.REDIS_PORT ?? '6379'),
    password: config.llmCache.redis.password || process.env.REDIS_PASSWORD,
  } : undefined,
  shortTermTtl: 86400,  // 24 hours for incidents
  sessionTtl: 3600,     // 1 hour for sessions
});

async function enhancedInvestigation(
  log: string, 
  reason: string, 
  tools: AgentTool[], 
  investigationId: string,
  sessionId?: string,
): Promise<any> {
  
  console.log(`[EnhancedInvestigator ${process.pid}] Starting memory-aware investigation ${investigationId}`);
  
  // ===== MEMORY RECALL PHASE =====
  
  // 1. Build enhanced context from memory
  const memoryContext = await memoryManager.buildEnhancedContext(log, sessionId);
  
  // 2. Get similar incidents
  const similarIncidents = await memoryManager.recallSimilarIncidents(log, 3);
  
  // 3. Detect relevant patterns
  const patterns = await memoryManager.detectPatterns();
  const relevantPatterns = patterns.filter(p => p.confidence > 0.3).slice(0, 2);
  
  // ===== ENHANCED INVESTIGATION =====
  
  const MAX_TURNS = 5;
  const scratchpad: any[] = [{ 
    observation: `Memory-Enhanced Investigation for: "${log}"
    
    Reason: "${reason}"
    ${memoryContext}
    
    INVESTIGATION STRATEGY:
    ${similarIncidents.length > 0 ? 
    `- Consider similar recent incidents: ${similarIncidents.map(i => i.reason).join(', ')}` : 
    '- No similar recent incidents found'
}
    ${relevantPatterns.length > 0 ? 
    `- Apply known patterns: ${relevantPatterns.map(p => p.signature).join(', ')}` : 
    '- No established patterns detected'
}
    - Use systematic troubleshooting approach
    - Document findings for future reference
    
    INVESTIGATION REQUIREMENTS:
    - Write custom Prometheus queries to investigate metrics
    - Check recent system changes and deployments
    - Correlate with historical incident patterns
    - Use Git tools and Kubernetes diagnostics
    - Provide actionable resolution steps`, 
  }];
  
  const toolUsageLog: Array<{tool: string, timestamp: string, args: any, success: boolean}> = [];
  const toolSchemas = tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

  // Investigation loop with memory context
  for (let i = 0; i < MAX_TURNS; i++) {
    console.log(`[EnhancedInvestigator ${process.pid}] Turn ${i + 1} with memory context`);
    
    const prompt = `
      You are a memory-enhanced SRE investigator with access to historical context.
      
      Current scratchpad (your investigation so far):
      ${JSON.stringify(scratchpad, null, 2)}
      
      MEMORY CONTEXT:
      ${memoryContext}
      
      ${similarIncidents.length > 0 ? `
      SIMILAR RECENT INCIDENTS:
      ${similarIncidents.map(incident => `
      - ${incident.log}
        Resolution: ${incident.resolution ?? 'Unresolved'}
        Tags: ${incident.tags.join(', ')}
      `).join('\n')}
      ` : ''}
      
      ${relevantPatterns.length > 0 ? `
      DETECTED PATTERNS:
      ${relevantPatterns.map(pattern => `
      - Pattern: ${pattern.signature}
        Frequency: ${pattern.frequency} occurrences
        Confidence: ${(pattern.confidence * 100).toFixed(0)}%
        Common resolutions: ${pattern.commonResolutions.slice(0, 2).join(', ')}
      `).join('\n')}
      ` : ''}
      
      Based on this enhanced context and memory, what is your next investigation step?
      Use the FINISH tool when you have a complete analysis incorporating memory insights.
    `;

    // Check cache for this enhanced prompt
    const estimatedTokens = Math.min(2000, prompt.length / 3);
    const cachedResponse = await memoryManager.get(prompt, estimatedTokens);
    
    let response;
    if (cachedResponse) {
      response = cachedResponse;
      metrics.llmCacheHits?.inc();
    } else {
      const finishTool = { 
        name: 'FINISH', 
        description: 'Call when you have a complete memory-enhanced analysis.',
        inputSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'Complete analysis incorporating memory insights.' },
            newPattern: { type: 'string', description: 'Any new pattern detected during investigation.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tags for this incident.' },
          },
          required: ['summary'],
        },
      };
      
      response = await provider.generate(prompt, [...tools, finishTool]);
      
      if (response && (response.toolCalls || response.text)) {
        await memoryManager.set(prompt, response, estimatedTokens);
      }
      metrics.llmCacheMisses?.inc();
    }
    
    if (response.text) {
      scratchpad.push({ thought: response.text });
    }

    if (response.toolCalls && response.toolCalls.length > 0) {
      const toolCall = response.toolCalls[0];
      
      if (toolCall.name === 'FINISH') {
        // Extract final analysis and memory updates
        const analysis = toolCall.arguments;
        
        // Store this incident in memory for future reference
        await memoryManager.rememberIncident({
          log,
          reason,
          timestamp: Date.now(),
          resolution: analysis.summary,
          tags: analysis.tags || ['investigation', 'auto-resolved'],
        });
        
        // Update session context
        if (sessionId) {
          await memoryManager.updateSessionContext(sessionId, {
            recentQueries: [log],
            serviceContext: analysis.tags?.filter((t: string) => t.startsWith('service:')) ?? [],
          });
        }
        
        console.log(`[EnhancedInvestigator ${process.pid}] Investigation complete with memory updates`);
        break;
      }

      // Execute other tools normally
      scratchpad.push({ thought: `Using ${toolCall.name} tool with args ${JSON.stringify(toolCall.arguments)}.` });
      
      const tool = tools.find(t => t.name === toolCall.name);
      if (tool) {
        const startTime = Date.now();
        try {
          let timeout: NodeJS.Timeout | null = null;
          let onMessage: ((msg: any) => void) | null = null;
          
          const toolResult = await new Promise((resolve, reject) => {
            timeout = setTimeout(() => {
              if (onMessage && parentPort) {
                parentPort.removeListener('message', onMessage);
              }
              reject(new Error('Tool execution timed out'));
            }, 10000);
            
            onMessage = (msg: any) => {
              if (msg.type === 'tool_result' && msg.investigationId === investigationId) {
                if (timeout) {
                  clearTimeout(timeout);
                  timeout = null;
                }
                if (parentPort && onMessage) {
                  parentPort.removeListener('message', onMessage);
                }
                resolve(msg.data);
              }
            };
            
            parentPort?.on('message', onMessage);
            parentPort?.postMessage({ 
              type: 'execute_tool', 
              data: { name: tool.name, arguments: toolCall.arguments, investigationId }, 
            });
          })
            .finally(() => {
            // Final cleanup - ensure timeout and listener are always cleared
              if (timeout) {
                clearTimeout(timeout);
                timeout = null;
              }
              if (onMessage && parentPort) {
                parentPort.removeListener('message', onMessage);
                onMessage = null;
              }
            });

          toolUsageLog.push({
            tool: toolCall.name,
            timestamp: new Date().toISOString(),
            args: toolCall.arguments,
            success: true,
          });

          scratchpad.push({ observation: `Tool result: ${JSON.stringify(toolResult)}` });
          
        } catch (e: any) {
          toolUsageLog.push({
            tool: toolCall.name,
            timestamp: new Date().toISOString(),
            args: toolCall.arguments,
            success: false,
          });
          
          scratchpad.push({ observation: `Tool error: ${e.message}` });
        }
      }
    }
  }

  // ===== FINAL SYNTHESIS WITH MEMORY =====
  
  const synthesisPrompt = `
    Memory-Enhanced Investigation Summary
    
    Investigation trace: ${JSON.stringify(scratchpad, null, 2)}
    
    Memory context: ${memoryContext}
    
    Provide a comprehensive analysis incorporating:
    1. Root cause analysis with memory insights
    2. Impact assessment considering historical patterns
    3. Specific actionable remediation steps
    4. Lessons learned for future incidents
    
    Format as JSON with fields: rootCauseAnalysis, impactAssessment, suggestedRemediation, lessonsLearned
  `;
  
  const synthesisTokens = Math.min(1500, synthesisPrompt.length / 3);
  const cachedSynthesis = await memoryManager.get(synthesisPrompt, synthesisTokens);
  
  let finalReportResponse;
  if (cachedSynthesis) {
    finalReportResponse = cachedSynthesis;
    metrics.llmCacheHits?.inc();
  } else {
    finalReportResponse = await provider.generate(synthesisPrompt);
    if (finalReportResponse?.text) {
      await memoryManager.set(synthesisPrompt, finalReportResponse, synthesisTokens);
    }
    metrics.llmCacheMisses?.inc();
  }
  
  // Parse and enhance final analysis
  let finalAnalysis = { 
    rootCauseAnalysis: 'Could not determine root cause.', 
    impactAssessment: 'Unknown.', 
    suggestedRemediation: ['Manual investigation required.'],
    lessonsLearned: ['Investigate similar patterns in the future.'],
    memoryInsights: {
      similarIncidents: similarIncidents.length,
      appliedPatterns: relevantPatterns.length,
      newPatternDetected: false,
    },
  };
  
  if (finalReportResponse.text) {
    try {
      const parsed = JSON.parse(finalReportResponse.text.replace(/```json|```/g, '').trim());
      finalAnalysis = { ...finalAnalysis, ...parsed };
    } catch {
      // Keep default analysis if parsing fails
    }
  }
  
  return { 
    finalAnalysis, 
    investigationTrace: scratchpad, 
    toolUsage: toolUsageLog,
    memoryContext: {
      similarIncidents,
      appliedPatterns: relevantPatterns,
      memoryStats: await memoryManager.getMemoryStats(),
    },
  };
}

parentPort?.on('message', async (message: any) => {
  if (message.type === 'investigate') {
    const { log, reason, tools, investigationId, sessionId } = message.data;
    const result = await enhancedInvestigation(log, reason, tools, investigationId, sessionId);
    parentPort?.postMessage({ 
      type: 'investigation_complete', 
      data: { ...result, initialLog: log, triageReason: reason, investigationId }, 
    });
  }
});