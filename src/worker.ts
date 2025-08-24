// src/worker.ts - Unified Worker for all investigation types

import { parentPort, workerData } from 'worker_threads';
import { createLLMProvider } from './llm';
import { LLMProvider } from './llm/provider';
import { AgentTool } from './mcp-server';
import { MemoryManager, SimpleRedisCache } from './memory';
import { metrics } from './metrics';

const { config } = workerData;
const provider: LLMProvider = createLLMProvider(config);

// Initialize memory manager for enhanced investigations
const memoryManager = new MemoryManager({
  redis: config.llmCache?.redis ? {
    url: config.llmCache.redis.url ?? process.env.REDIS_URL,
    host: config.llmCache.redis.host ?? process.env.REDIS_HOST ?? 'localhost',
    port: config.llmCache.redis.port ?? parseInt(process.env.REDIS_PORT ?? '6379'),
    password: config.llmCache.redis.password ?? process.env.REDIS_PASSWORD,
  } : undefined,
  shortTermTtl: 86400,    // 24 hours for incidents
  sessionTtl: 3600,       // 1 hour for sessions
  maxIncidents: 1000,     // Track last 1000 incidents
});

// Initialize simple Redis cache for basic caching
const llmCache = new SimpleRedisCache({
  redis: config.llmCache?.redis ? {
    url: config.llmCache.redis.url ?? process.env.REDIS_URL,
    host: config.llmCache.redis.host ?? process.env.REDIS_HOST ?? 'localhost',
    port: config.llmCache.redis.port ?? parseInt(process.env.REDIS_PORT ?? '6379'),
    password: config.llmCache.redis.password ?? process.env.REDIS_PASSWORD,
    keyPrefix: config.llmCache.redis.keyPrefix ?? 'agent:',
  } : undefined,
  similarityThreshold: config.llmCache?.similarityThreshold ?? 0.85,
  ttlSeconds: config.llmCache?.ttlSeconds ?? 3600, // 1 hour
  verbose: config.verbose ?? false,
});

// Initialize cache connection on worker startup with proper Redis coordination
let cacheInitialized = false;
(async () => {
  try {
    // Check if Redis caching is enabled in the configuration
    const redisCachingEnabled = !!(config.llmCache?.redis);
    
    if (redisCachingEnabled) {
      console.log(`[Worker ${process.pid}] Redis cache enabled, waiting for readiness...`);
      const redisReady = await llmCache.waitForRedisReady({
        enabled: true,
        maxRetries: 30,      // 30 retries
        retryDelayMs: 1000,  // 1 second between retries
        timeoutMs: 60000,    // 60 second total timeout
      });
      
      if (redisReady) {
        console.log(`[Worker ${process.pid}] Redis cache initialized successfully`);
      } else {
        console.log(`[Worker ${process.pid}] Redis cache failed to initialize, continuing without cache`);
      }
    } else {
      console.log(`[Worker ${process.pid}] Redis caching not enabled`);
    }
    
    cacheInitialized = true;
  } catch (error) {
    console.error(`[Worker ${process.pid}] Cache initialization error:`, error);
    cacheInitialized = true; // Continue without cache
  }
})();

// ===== BASIC AGENT FUNCTIONALITY =====

async function basicInvestigate(log: string, reason: string, tools?: AgentTool[]): Promise<any> {
  console.log(`[Agent ${process.pid}] Starting basic investigation`);
  
  const availableTools = tools || [];
  const toolSchemas = availableTools.map(tool => ({ 
    name: tool.name, 
    description: tool.description, 
    inputSchema: tool.inputSchema 
  }));

  // Wait for cache to be initialized before processing
  while (!cacheInitialized) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Filter for network state logs - these are routine and don't need LLM analysis
  const networkStatePattern = /bridge|state (UP|DOWN)|NOARP|BROADCAST|MULTICAST|interface/i;
  if (networkStatePattern.test(log) && log.length < 200) {
    console.log(`[Agent ${process.pid}] Skipping network state log: ${log.substring(0, 100)}`);
    return {
      finalAnalysis: {
        rootCauseAnalysis: 'Network interface state change - routine operation',
        impactAssessment: 'Minimal impact - normal network stack operation',
        suggestedRemediation: ['No action required - routine network state transition'],
        lessonsLearned: ['Network state changes are normal system operations'],
      },
      investigationTrace: [
        { observation: `Filtered network state log: ${log}` },
        { thought: 'This is a routine network operation that does not require investigation' }
      ],
      toolUsage: [],
    };
  }

  console.log(`[Agent ${process.pid}] Analyzing: ${log.substring(0, 100)}... with tools: [${toolSchemas.map(t => t.name).join(', ')}]`);

  let cacheKey = `${log}-${reason}`;
  if (availableTools.length > 0) {
    cacheKey += `-${toolSchemas.map(t => t.name).sort().join(',')}`;
  }

  // Check cache first
  const cachedResult = await llmCache.get(cacheKey);
  if (cachedResult) {
    console.log(`[Agent ${process.pid}] Cache hit for log analysis`);
    metrics.llmCacheHits?.inc();
    return cachedResult;
  }

  // Cache miss - generate new analysis
  console.log(`[Agent ${process.pid}] Cache miss - generating new analysis`);
  metrics.llmCacheMisses?.inc();

  const systemPrompt = `You are Seraph, an AI SRE agent. Analyze logs to detect anomalies and provide actionable insights.

When you receive a log entry with an anomaly, you should:
1. Analyze the log for patterns, errors, and potential issues
2. If tools are available, use them to gather more context
3. Provide specific, actionable remediation steps
4. Always use the FINISH tool to conclude your analysis

Available tools: ${JSON.stringify(toolSchemas, null, 2)}`;

  const userPrompt = `
Log: ${log}
Reason: ${reason}

Please analyze this log entry and provide insights. Use available tools if helpful, then use FINISH tool to conclude.`;

  const conversation = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  const finishTool = {
    name: 'FINISH',
    description: 'Complete the analysis with final conclusions',
    inputSchema: {
      type: 'object',
      properties: {
        rootCauseAnalysis: { type: 'string', description: 'Analysis of the root cause' },
        impactAssessment: { type: 'string', description: 'Assessment of impact' },
        suggestedRemediation: { 
          type: 'array', 
          items: { type: 'string' }, 
          description: 'Specific actionable steps to fix the issue' 
        },
        lessonsLearned: { 
          type: 'array', 
          items: { type: 'string' }, 
          description: 'Lessons learned for future reference' 
        }
      },
      required: ['rootCauseAnalysis', 'impactAssessment', 'suggestedRemediation']
    }
  };

  const allTools = [...availableTools, finishTool];
  const scratchpad: any[] = [];
  const MAX_TURNS = 5;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const currentPrompt = conversation.map(m => `${m.role}: ${m.content}`).join('\n\n');
    
    try {
      const response = await provider.generate(currentPrompt, allTools);
      
      if (response.text) {
        conversation.push({ role: 'assistant', content: response.text });
        scratchpad.push({ thought: response.text });
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        const toolCall = response.toolCalls[0];
        
        if (toolCall.name === 'FINISH') {
          const analysis = {
            rootCauseAnalysis: toolCall.arguments.rootCauseAnalysis || 'Unable to determine root cause',
            impactAssessment: toolCall.arguments.impactAssessment || 'Impact assessment unavailable',
            suggestedRemediation: toolCall.arguments.suggestedRemediation || ['Manual investigation required'],
            lessonsLearned: toolCall.arguments.lessonsLearned || ['Continue monitoring for similar issues'],
          };

          const result = {
            finalAnalysis: analysis,
            investigationTrace: scratchpad,
            toolUsage: [],
          };

          // Cache the result (convert to LLMResponse format)
          const cacheableResult = {
            text: JSON.stringify(result),
            toolCalls: [],
          };
          await llmCache.set(cacheKey, cacheableResult);
          return result;
        }

        // Execute other tools via main thread
        const toolResult = await executeToolViaMainThread(toolCall, availableTools);
        const resultText = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
        
        conversation.push({ role: 'user', content: `Tool result from ${toolCall.name}: ${resultText}` });
        scratchpad.push({ observation: `Tool ${toolCall.name} result: ${resultText}` });
      }
    } catch (error) {
      console.error(`[Agent ${process.pid}] Error in turn ${turn}:`, error);
      break;
    }
  }

  // Fallback if no FINISH tool was called
  const fallbackResult = {
    finalAnalysis: {
      rootCauseAnalysis: 'Analysis incomplete - reached maximum turns',
      impactAssessment: 'Unable to complete impact assessment',
      suggestedRemediation: ['Manual investigation required'],
      lessonsLearned: ['Improve tool usage patterns'],
    },
    investigationTrace: scratchpad,
    toolUsage: [],
  };

  // Cache the result (convert to LLMResponse format)
  const cacheableResult = {
    text: JSON.stringify(fallbackResult),
    toolCalls: [],
  };
  await llmCache.set(cacheKey, cacheableResult);
  return fallbackResult;
}

// ===== MEMORY-ENHANCED INVESTIGATION =====

async function memoryEnhancedInvestigate(log: string, reason: string, tools: AgentTool[], investigationId: string, sessionId?: string): Promise<any> {
  console.log(`[Investigator ${process.pid}] Starting memory-enhanced investigation ${investigationId}`);
  
  // ===== MEMORY RECALL PHASE =====
  
  // 1. Build enhanced context from memory
  const memoryContext = await memoryManager.buildEnhancedContext(log, sessionId);
  
  // 2. Get similar incidents
  const similarIncidents = await memoryManager.recallSimilarIncidents(log, 3);
  
  // 3. Detect relevant patterns
  const patterns = await memoryManager.detectPatterns();
  const relevantPatterns = patterns.filter(p => p.confidence > 0.3).slice(0, 2);
  
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
    - MUST write multiple custom Prometheus queries to investigate metrics around this incident
    - MUST check Prometheus alerts, targets, and rules for correlation
    - MUST use time-based queries to understand trends before/during the incident
    - MUST use Git tools to check recent commits and correlate with incident timing
    - MUST clone or examine the Seraph repository for code context
    - MUST correlate metrics data, log patterns, and code changes for comprehensive root cause analysis
    - Incorporate insights from similar incidents and patterns`, 
  }];
  
  // Track tool usage for enhanced alerting
  const toolUsageLog: Array<{tool: string, timestamp: string, args: any, success: boolean, executionTime?: number}> = [];
  
  const toolSchemas = tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

  console.log(`[Investigator ${process.pid}] Starting investigation ${investigationId} with tools: ${JSON.stringify(toolSchemas.map(t => t.name))}`);

  for (let i = 0; i < MAX_TURNS; i++) {
    console.log(`[Investigator ${process.pid}] Memory-enhanced investigation ${investigationId} Turn ${i + 1}`);
    const prompt = `
      You are a memory-enhanced SRE investigator performing root cause analysis with access to historical context.

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

      Based on your memory-enhanced investigation and context from similar incidents, what is your next thought? 
      Use the FINISH tool when you have a complete analysis incorporating memory insights.
    `;

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
    const availableTools = [...tools, finishTool];
    
    // Check cache first - estimate tokens for investigation (usually ~500-1500 tokens)
    const estimatedTokens = Math.min(1500, prompt.length / 3); // More complex prompts = more tokens
    const cachedResponse = await memoryManager.get(prompt, estimatedTokens);
    
    let response;
    if (cachedResponse) {
      // Cache hit! Use cached response
      response = cachedResponse;
      metrics.llmCacheHits?.inc();
      console.log(`[Investigator ${process.pid}] Cache hit for investigation ${investigationId} turn ${i + 1}`);
    } else {
      // Cache miss - call LLM and cache result
      response = await provider.generate(prompt, availableTools);
      
      if (response && (response.toolCalls || response.text)) {
        // Cache the response for future use
        await memoryManager.set(prompt, response, estimatedTokens);
      }
      metrics.llmCacheMisses?.inc();
    }
    
    if (response.text) {
      scratchpad.push({ thought: response.text });
    }

    if (response.toolCalls && response.toolCalls.length > 0) {
      const toolCall = response.toolCalls[0];
      scratchpad.push({ thought: `I should use the ${toolCall.name} tool with args ${JSON.stringify(toolCall.arguments)}.` });

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
        
        console.log(`[Investigator ${process.pid}] Investigation complete with memory updates`);
        break;
      }

      const tool = tools.find(t => t.name === toolCall.name);
      if (tool) {
        const startTime = Date.now();
        const timestamp = new Date().toISOString();
        
        try {
          // Execute tool via main thread
          const toolResult = await executeToolViaMainThread(toolCall, tools, investigationId);

          const executionTime = Date.now() - startTime;
          toolUsageLog.push({
            tool: toolCall.name,
            timestamp,
            args: toolCall.arguments,
            success: true,
            executionTime,
          });

          scratchpad.push({ observation: `Result from ${toolCall.name}: ${JSON.stringify(toolResult)}` });
        } catch (e: any) {
          const executionTime = Date.now() - startTime;
          toolUsageLog.push({
            tool: toolCall.name,
            timestamp,
            args: toolCall.arguments,
            success: false,
            executionTime,
          });
          
          scratchpad.push({ observation: `Error executing ${toolCall.name}: ${e.message}` });
        }
      } else {
        scratchpad.push({ observation: `Error: Tool '${toolCall.name}' not found.` });
      }
    } else {
      scratchpad.push({ observation: 'I have not used a tool. I should either use a tool or use the FINISH tool to complete the investigation.' });
    }
  }

  const synthesisPrompt = `
    Memory-Enhanced Investigation Summary
    
    Investigation trace: ${JSON.stringify(scratchpad, null, 2)}
    
    Memory context: ${memoryContext}
    
    Provide a comprehensive analysis incorporating:
    1. Root cause analysis with memory insights
    2. Impact assessment considering historical patterns
    3. Specific actionable remediation steps
    4. Lessons learned for future incidents
    
    Format as JSON with fields:
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
  
  // Check cache for final synthesis as well
  const synthesisTokens = Math.min(1000, synthesisPrompt.length / 3);
  const cachedSynthesis = await memoryManager.get(synthesisPrompt, synthesisTokens);
  
  let finalReportResponse;
  if (cachedSynthesis) {
    finalReportResponse = cachedSynthesis;
    metrics.llmCacheHits?.inc();
    console.log(`[Investigator ${process.pid}] Cache hit for final synthesis ${investigationId}`);
  } else {
    finalReportResponse = await provider.generate(synthesisPrompt);
    
    if (finalReportResponse?.text) {
      await memoryManager.set(synthesisPrompt, finalReportResponse, synthesisTokens);
    }
    metrics.llmCacheMisses?.inc();
  }
  console.log(`[Investigator ${process.pid}] Final report response:`, finalReportResponse.text?.substring(0, 500));
  
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
          if (cleanedResponse[i] === '{') {braceCount++;}
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
          jsonStr = `${partial}}`;  // Add missing closing brace
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
            rootCauseAnalysis: rootCauseMatch ? rootCauseMatch[1] : 'Could not determine root cause.',
            impactAssessment: impactMatch ? impactMatch[1] : 'Unknown.',
            suggestedRemediation: remediationMatch ? 
              remediationMatch[1].split(',').map(s => s.replace(/"/g, '').trim()).filter(s => s.length > 0) :
              ['Manual investigation required.'],
            lessonsLearned: ['Investigate similar patterns in the future.'],
            memoryInsights: {
              similarIncidents: 0,
              appliedPatterns: 0,
              newPatternDetected: false,
            },
          };
        }
      } catch (fallbackError) {
        console.error(`[Investigator ${process.pid}] Fallback parsing also failed:`, fallbackError);
      }
    }
  } else {
    console.error(`[Investigator ${process.pid}] No response text received`);
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

// ===== HELPER FUNCTIONS =====

async function executeToolViaMainThread(toolCall: any, availableTools: AgentTool[], investigationId?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      parentPort?.removeListener('message', onMessage);
      reject(new Error('Tool execution timed out'));
    }, 10000);
    
    const onMessage = (msg: any) => {
      if (msg.type === 'tool_result' && (!investigationId || msg.investigationId === investigationId)) {
        clearTimeout(timeout);
        parentPort?.removeListener('message', onMessage);
        resolve(msg.data);
      }
    };
    
    // Attach listener first, then send message to prevent race condition
    parentPort?.on('message', onMessage);
    parentPort?.postMessage({ 
      type: 'execute_tool', 
      data: { 
        name: toolCall.name, 
        arguments: toolCall.arguments, 
        investigationId 
      } 
    });
  });
}

// ===== LEGACY COMPATIBILITY =====

async function handleLegacyLogMessage(log: string): Promise<void> {
  try {
    const llmProvider = createLLMProvider(config);
    const prompt = `Analyze the following log entry and determine if it indicates a significant error, warning, or other issue that requires attention:

Log: ${log}

Respond with a JSON object containing:
- decision: either "ok" or "alert"
- reason: brief explanation of your decision

Example responses:
{"decision": "alert", "reason": "database connection error detected"}
{"decision": "ok", "reason": "normal informational log"}`;

    const response = await llmProvider.generate(prompt, [
      {
        name: 'log_triage',
        description: 'Triage a log entry for potential issues',
        parameters: {
          type: 'object',
          properties: {
            decision: { type: 'string', enum: ['ok', 'alert'] },
            reason: { type: 'string' }
          },
          required: ['decision', 'reason']
        }
      }
    ]);

    // Handle unexpected response format
    if (!response || typeof response !== 'object' || !response.toolCalls) {
      throw new Error('Invalid response format from LLM provider');
    }

    if (response.toolCalls && response.toolCalls.length > 0) {
      const analysis = response.toolCalls[0].arguments;
      metrics.logsProcessed.inc();

      if (analysis.decision === 'alert') {
        metrics.alertsTriggered.inc({ provider: config.llmProvider, model: config.llmModel });
        parentPort?.postMessage({
          type: 'alert',
          data: {
            log,
            reason: analysis.reason,
          },
        });
      }
    }
  } catch (error) {
    metrics.analysisErrors.inc({ type: 'legacy' });
    console.error(`[Worker ${process.pid}] Error in legacy log analysis:`, String(error));
  }
}

// ===== MESSAGE HANDLERS =====

parentPort?.on('message', async (message: any) => {
  try {
    // Handle legacy string messages for backward compatibility
    if (typeof message === 'string') {
      await handleLegacyLogMessage(message);
      return;
    }
    
    switch (message.type) {
      case 'investigate':
        const { log, reason, tools, investigationId, sessionId } = message.data;
        const result = await memoryEnhancedInvestigate(log, reason, tools, investigationId, sessionId);
        parentPort?.postMessage({ 
          type: 'investigation_complete', 
          data: { ...result, initialLog: log, triageReason: reason, investigationId } 
        });
        break;

      case 'enhanced_investigate':
        const enhancedData = message.data;
        const enhancedResult = await memoryEnhancedInvestigate(
          enhancedData.log, 
          enhancedData.reason, 
          enhancedData.tools, 
          enhancedData.investigationId,
          enhancedData.sessionId
        );
        parentPort?.postMessage({ 
          type: 'enhanced_investigation_complete', 
          data: { ...enhancedResult, initialLog: enhancedData.log, triageReason: enhancedData.reason, investigationId: enhancedData.investigationId } 
        });
        break;

      case 'analyze':
        const { log: basicLog, reason: basicReason, tools: basicTools } = message.data;
        const basicResult = await basicInvestigate(basicLog, basicReason, basicTools);
        parentPort?.postMessage({ 
          type: 'analysis_complete', 
          data: { ...basicResult, initialLog: basicLog, triageReason: basicReason } 
        });
        break;

      default:
        console.warn(`[Worker ${process.pid}] Unknown message type:`, message.type);
    }
  } catch (error) {
    console.error(`[Worker ${process.pid}] Error handling message:`, error);
    parentPort?.postMessage({ 
      type: 'error', 
      data: { error: error instanceof Error ? error.message : String(error) } 
    });
  }
});