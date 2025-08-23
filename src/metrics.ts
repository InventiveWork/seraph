import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export const register = new Registry();

export const metrics = {
  logsProcessed: new Counter({
    name: 'seraph_logs_processed_total',
    help: 'Total number of logs processed by the agent.',
    registers: [register],
  }),
  alertsTriggered: new Counter({
    name: 'seraph_alerts_triggered_total',
    help: 'Total number of alerts triggered by the agent.',
    labelNames: ['provider', 'model'],
    registers: [register],
  }),
  activeWorkers: new Gauge({
    name: 'seraph_active_workers',
    help: 'Number of active worker threads.',
    labelNames: ['type'],
    registers: [register],
  }),
  llmAnalysisLatency: new Histogram({
    name: 'seraph_llm_analysis_latency_seconds',
    help: 'Latency of LLM analysis requests in seconds.',
    labelNames: ['provider', 'model'],
    buckets: [0.1, 0.5, 1, 2, 5, 10], // Buckets in seconds
    registers: [register],
  }),
  analysisErrors: new Counter({
    name: 'seraph_analysis_errors_total',
    help: 'Total number of errors during log analysis.',
    labelNames: ['type'],
    registers: [register],
  }),
  logsSkipped: new Counter({
    name: 'seraph_logs_skipped_total',
    help: 'Total number of logs skipped due to pre-filtering.',
    registers: [register],
  }),
  llmCacheHits: new Counter({
    name: 'seraph_llm_cache_hits_total',
    help: 'Total number of LLM cache hits.',
    registers: [register],
  }),
  llmCacheMisses: new Counter({
    name: 'seraph_llm_cache_misses_total',
    help: 'Total number of LLM cache misses.',
    registers: [register],
  }),
  llmTokensSaved: new Counter({
    name: 'seraph_llm_tokens_saved_total',
    help: 'Total number of tokens saved through LLM caching.',
    registers: [register],
  }),
  llmCacheSize: new Gauge({
    name: 'seraph_llm_cache_size',
    help: 'Current number of entries in LLM cache.',
    registers: [register],
  }),
  llmCacheRedisConnected: new Gauge({
    name: 'seraph_llm_cache_redis_connected',
    help: 'Redis connection status for LLM cache (1=connected, 0=disconnected).',
    registers: [register],
  }),
  llmCacheRedisHits: new Counter({
    name: 'seraph_llm_cache_redis_hits_total',
    help: 'Total number of Redis cache hits.',
    registers: [register],
  }),
  llmCacheRedisWrites: new Counter({
    name: 'seraph_llm_cache_redis_writes_total',
    help: 'Total number of writes to Redis cache.',
    registers: [register],
  }),
  llmCacheRedisErrors: new Counter({
    name: 'seraph_llm_cache_redis_errors_total',
    help: 'Total number of Redis cache errors.',
    registers: [register],
  }),

  // Priority Queue Metrics
  queuedAlerts: new Counter({
    name: 'seraph_queued_alerts_total',
    help: 'Total number of alerts queued by priority.',
    labelNames: ['priority'],
    registers: [register],
  }),
  startedInvestigations: new Counter({
    name: 'seraph_started_investigations_total',
    help: 'Total number of investigations started by priority.',
    labelNames: ['priority'],
    registers: [register],
  }),
  queueSize: new Gauge({
    name: 'seraph_queue_size',
    help: 'Current number of alerts in the priority queue.',
    registers: [register],
  }),
  runningInvestigations: new Gauge({
    name: 'seraph_running_investigations',
    help: 'Current number of running investigations.',
    registers: [register],
  }),
  avgWaitTime: new Gauge({
    name: 'seraph_queue_avg_wait_time_seconds',
    help: 'Average wait time for alerts in the queue.',
    registers: [register],
  }),
  investigationDuration: new Histogram({
    name: 'seraph_investigation_duration_seconds',
    help: 'Duration of investigations in seconds.',
    buckets: [10, 30, 60, 120, 300, 600], // 10s to 10min buckets
    registers: [register],
  }),
  investigationTimeouts: new Counter({
    name: 'seraph_investigation_timeouts_total',
    help: 'Total number of investigation timeouts by priority.',
    labelNames: ['priority'],
    registers: [register],
  }),
  preemptions: new Counter({
    name: 'seraph_preemptions_total',
    help: 'Total number of investigation preemptions.',
    labelNames: ['preempted_priority', 'new_priority'],
    registers: [register],
  }),
  burstModeActive: new Gauge({
    name: 'seraph_burst_mode_active',
    help: 'Burst mode status (1=active, 0=inactive).',
    registers: [register],
  }),
  burstModeActivations: new Counter({
    name: 'seraph_burst_mode_activations_total',
    help: 'Total number of burst mode activations.',
    registers: [register],
  }),
  burstModeDuration: new Histogram({
    name: 'seraph_burst_mode_duration_seconds',
    help: 'Duration of burst mode sessions in seconds.',
    buckets: [30, 60, 180, 300, 600, 1200], // 30s to 20min buckets
    registers: [register],
  }),
  queuePriorityDistribution: new Gauge({
    name: 'seraph_queue_priority_distribution',
    help: 'Number of alerts in queue by priority level.',
    labelNames: ['priority'],
    registers: [register],
  }),
  priorityScoreDistribution: new Histogram({
    name: 'seraph_priority_score_distribution',
    help: 'Distribution of priority scores assigned to alerts.',
    buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
    registers: [register],
  }),
  priorityAccuracy: new Gauge({
    name: 'seraph_priority_accuracy_percent',
    help: 'Accuracy of priority predictions (percentage).',
    registers: [register],
  }),
};
