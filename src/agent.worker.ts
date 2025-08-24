// src/agent.worker.ts

import { parentPort, workerData } from 'worker_threads';
import { createLLMProvider } from './llm';
import { metrics } from './metrics';
import { SimpleRedisCache } from './simple-redis-cache';

const { config } = workerData;
const provider = createLLMProvider(config);

// Initialize simple Redis cache for this worker
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

// Initialize cache connection on worker startup
let cacheInitialized = false;
(async () => {
  try {
    await llmCache.ensureInitialized();
    cacheInitialized = true;
    console.log(`[Worker ${process.pid}] Redis cache initialized successfully`);
  } catch (error) {
    console.error(`[Worker ${process.pid}] Failed to initialize Redis cache:`, error);
    cacheInitialized = true; // Mark as initialized even on failure to proceed without cache
  }
})();

const triageTool = {
  name: 'log_triage',
  description: 'Determines if a log entry requires an alert.',
  inputSchema: {
    type: 'object',
    properties: {
      decision: {
        type: 'string',
        enum: ['alert', 'ok'],
        description: 'The decision whether to alert or not.',
      },
      reason: {
        type: 'string',
        description: 'A brief, 5-word explanation of the decision.',
      },
    },
    required: ['decision', 'reason'],
  },
};

const analyzeLog = async (log: string) => {
  // Pre-validate log entry
  if (!log || log.trim().length === 0) {
    return { decision: 'ok', reason: 'Empty log entry' };
  }
  
  if (log.length > 10000) {
    return { decision: 'ok', reason: 'Log entry too large' };
  }

  // Extract readable log content from JSON structure if present
  let processedLog = log;
  try {
    const parsedLog = JSON.parse(log);
    if (parsedLog.log && typeof parsedLog.log === 'string') {
      // Extract the actual log message from Fluent Bit format (container logs)
      processedLog = parsedLog.log;
    } else if (parsedLog.MESSAGE && typeof parsedLog.MESSAGE === 'string') {
      // Extract the actual log message from systemd/Fluent Bit format (system logs)
      processedLog = parsedLog.MESSAGE;
    } else if (typeof parsedLog === 'object') {
      // If it's an object but not the expected format, stringify it cleanly
      processedLog = JSON.stringify(parsedLog, null, 2);
    }
  } catch (e) {
    // If it's not JSON, use as-is
    processedLog = log;
  }

  // Filter out routine operational logs that don't need alerting
  const routinePatterns = [
    /HTTP status=20[0-9]/i,  // Successful HTTP responses
    /GET \/metrics/i,        // Metrics endpoint requests
    /GET \/health/i,         // Health check requests
    /connection established/i,
    /connection closed/i,
    /\[ info\]/i,            // Info level logs
    /\[Investigator \d+\]/i, // Investigation worker logs
    /Investigation .* Turn \d+/i, // Investigation turn logs
    /Investigation .* complete/i, // Investigation completion logs
    /Starting investigation/i,    // Investigation start logs
    /AlerterClient/i,        // Alerter client logs
    /Report .* saved/i,      // Report save logs
    /Triage alert received/i, // Triage alert logs
  ];

  if (routinePatterns.some(pattern => pattern.test(processedLog))) {
    return { decision: 'ok', reason: 'Routine operational log' };
  }

  // Truncate log for prompt to avoid token limits
  const truncatedLog = processedLog.length > 1500 ? `${processedLog.substring(0, 1500)  }...[truncated]` : processedLog;

  const prompt = `
  You are a high-speed SRE triage system. Analyze this log entry and use the available tool to respond.

  CRITICAL: You must call the "log_triage" tool function with two parameters:
  - decision: either "alert" or "ok" 
  - reason: brief 5-word explanation

  Decision criteria for "alert":
  - Kubernetes pod errors: CrashLoopBackOff, ImagePullBackOff, Failed, Error syncing pod
  - Application crashes: crashed, memory leak, out of memory, segfault, panic
  - System failures: connection failed, timeout, refused, unavailable, down
  - Security issues: authentication failed, access denied, unauthorized
  - Resource issues: disk full, no space, resource exhausted
  - Error levels: ERROR, FATAL, CRITICAL, SEVERE
  
  Decision criteria for "ok":
  - Successful operations: successful, completed, ready, started
  - Info messages: INFO, DEBUG level logs
  - Routine events: metrics requests, health checks, normal status updates
  - Container lifecycle: created, started (without errors), stopped (planned)

  Pay special attention to Kubernetes error patterns even in verbose JSON logs.

  Log to analyze:
  ${truncatedLog}

  Call the log_triage tool now with your decision and reason.
  `;

  try {
    // Check cache first - estimate tokens for triage (usually ~100-200 tokens)
    const estimatedTokens = Math.min(200, prompt.length / 4); // Rough estimate: 4 chars per token
    const cachedResponse = await llmCache.get(prompt, estimatedTokens);
    
    let response;
    if (cachedResponse) {
      // Cache hit! Use cached response
      response = cachedResponse;
      metrics.llmCacheHits?.inc();
    } else {
      // Cache miss - call LLM and cache result
      response = await provider.generate(prompt, [triageTool]);
      
      if (response && (response.toolCalls || response.text)) {
        // Cache the response for future use
        await llmCache.set(prompt, response, estimatedTokens);
      }
      metrics.llmCacheMisses?.inc();
    }

    if (!response?.toolCalls) {
      console.error(`[Worker ${process.pid}] Malformed response from LLM:`, response);
      // Default to 'ok' to avoid excessive noise on malformed responses
      return { decision: 'ok', reason: 'Malformed LLM response' };
    }
    
    const triageCall = response.toolCalls?.find(tc => tc.name === 'log_triage');
    if (triageCall) {
      return {
        decision: triageCall.arguments.decision,
        reason: triageCall.arguments.reason,
      };
    }
    
    // Parse response text for decision patterns
    if (response.text) {
      const content = response.text.toLowerCase();
      
      // Extract decision from malformed responses
      const decisionMatch = content.match(/decision\s*=\s*['"]?(alert|ok)['"]?/);
      const reasonMatch = content.match(/reason\s*=\s*['"]([^'"]+)['"]?/);
      
      if (decisionMatch) {
        return {
          decision: decisionMatch[1] as 'alert' | 'ok',
          reason: reasonMatch?.[1]?.substring(0, 50) || 'Parsed from malformed response',
        };
      }
      
      // Legacy fallback for content-based detection
      if (content.includes('alert') || content.includes('error') || content.includes('fail') || content.includes('problem') || content.includes('timeout')) {
        return { decision: 'alert', reason: 'Content suggests alert needed' };
      } else if (content.includes('ok') || content.includes('normal') || content.includes('routine') || content.includes('success')) {
        return { decision: 'ok', reason: 'Content suggests normal operation' };
      }
    }
    
    // Default to 'ok' for logs that don't clearly indicate problems (reduces noise)
    return { decision: 'ok', reason: 'No clear indicators found' };

  } catch (error: any) {
    console.error(`[Worker ${process.pid}] Error analyzing log:`, error.message);
    return { decision: 'ok', reason: 'Analysis error, skip' };
  }
};

parentPort?.on('message', async (log: string) => {
  // Wait for cache initialization on first message
  if (!cacheInitialized) {
    await llmCache.ensureInitialized();
    cacheInitialized = true;
  }
  
  // Worker only handles log analysis
  const analysis = await analyzeLog(log);
  if (analysis.decision === 'alert') {
    metrics.alertsTriggered.inc({ provider: config.llm?.provider, model: config.llm?.model });
    parentPort?.postMessage({ type: 'alert', data: { log, reason: analysis.reason } });
  }
});
