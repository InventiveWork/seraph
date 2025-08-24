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
    console.error(`[Worker ${process.pid}] Error during cache initialization:`, error);
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
    /docker0: port \d+\([^)]+\) entered (blocking|forwarding|learning|listening|disabled) state/i, // Docker bridge network state changes
    /bridge.*port \d+\([^)]+\) entered (blocking|forwarding|learning|listening|disabled) state/i, // Bridge network state changes
    /entered (blocking|forwarding|learning|listening|disabled) state/i, // General bridge state changes
  ];

  // Debug: Log the exact content being processed for network state logs
  if (processedLog.includes('entered') && processedLog.includes('state')) {
    console.log(`[Worker ${process.pid}] DEBUG: Processing network log: "${processedLog}"`);
  }

  if (routinePatterns.some(pattern => pattern.test(processedLog))) {
    console.log(`[Worker ${process.pid}] DEBUG: Filtered out routine log: "${processedLog.substring(0, 100)}..."`);
    return { decision: 'ok', reason: 'Routine operational log' };
  }

  // Truncate log for prompt to avoid token limits
  const truncatedLog = processedLog.length > 1500 ? `${processedLog.substring(0, 1500)  }...[truncated]` : processedLog;

  const prompt = `You are an SRE triage system. Analyze this log and respond ONLY using the log_triage tool.

MANDATORY: Use the log_triage tool with:
- decision: "alert" OR "ok" (exact strings only)
- reason: brief explanation (max 10 words)

ALERT patterns (call log_triage with decision="alert"):
- CrashLoopBackOff, ImagePullBackOff, Failed, Error syncing
- crashed, panic, segfault, out of memory, memory leak
- connection refused/failed, timeout, unavailable, down
- authentication failed, access denied, unauthorized
- disk full, no space, resource exhausted
- ERROR, FATAL, CRITICAL, SEVERE levels

OK patterns (call log_triage with decision="ok"):
- successful, completed, ready, started (without errors)
- INFO, DEBUG, routine events, health checks
- normal container lifecycle events
- network state changes (blocking/forwarding)

Log: ${truncatedLog}

RESPOND NOW using ONLY the log_triage tool - no text response allowed.`;

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

    if (!response?.toolCalls || response.toolCalls.length === 0) {
      console.error(`[Worker ${process.pid}] LLM failed to use tool. Response:`, JSON.stringify(response, null, 2));
      
      // Try to parse decision from text response as fallback
      if (response?.text) {
        const text = response.text.toLowerCase();
        
        // Check for explicit patterns that should trigger alerts
        const alertPatterns = [
          'crashloopbackoff', 'imagepullbackoff', 'failed', 'error syncing',
          'crashed', 'panic', 'segfault', 'out of memory', 'memory leak',
          'connection refused', 'connection failed', 'timeout', 'unavailable', 'down',
          'authentication failed', 'access denied', 'unauthorized',
          'disk full', 'no space', 'resource exhausted',
          'error:', 'fatal:', 'critical:', 'severe:'
        ];
        
        // Check if this looks like an error that should be alerted
        const shouldAlert = alertPatterns.some(pattern => text.includes(pattern));
        
        if (shouldAlert) {
          console.log(`[Worker ${process.pid}] Fallback: Detected alert pattern in malformed response`);
          return { decision: 'alert', reason: 'Error detected via fallback parsing' };
        }
      }
      
      // Default to 'ok' for unknown/malformed responses  
      return { decision: 'ok', reason: 'Malformed LLM response, defaulting ok' };
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
  // Wait for startup initialization to complete
  while (!cacheInitialized) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // Worker only handles log analysis
  const analysis = await analyzeLog(log);
  if (analysis.decision === 'alert') {
    metrics.alertsTriggered.inc({ provider: config.llm?.provider, model: config.llm?.model });
    parentPort?.postMessage({ type: 'alert', data: { log, reason: analysis.reason } });
  }
});
