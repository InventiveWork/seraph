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
};
