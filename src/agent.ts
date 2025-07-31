import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { SeraphConfig } from './config';
import { AlerterClient } from './alerter';
import { createLLMProvider } from './llm';
import { metrics } from './metrics';

// This code runs if we are in a worker thread
if (!isMainThread) {
  const { config } = workerData;
  const alerterClient = new AlerterClient(config);
  const provider = createLLMProvider(config);

  const analyzeLog = async (log: string) => {
    const end = metrics.llmAnalysisLatency.startTimer({ provider: config.llm?.provider, model: config.llm?.model });
    const prompt = `
    Analyze the following log entry and determine if it requires an alert.
    Respond with a JSON object with two fields: "decision" and "reason".
    The "decision" field should be either "alert" or "ok".
    The "reason" field should be a short explanation of the decision.

    Log entry:
    ${log}
    `;

    try {
      let text = await provider.generate(prompt);
      end();
      
      // Clean the response to ensure it's valid JSON
      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch && jsonMatch[1]) {
        text = jsonMatch[1];
      }

      return JSON.parse(text);
    } catch (error: any) {
      end();
      metrics.analysisErrors.inc();
      console.error(`[Worker ${process.pid}] Error analyzing log:`, error.message);
      
      // Record the analysis error as a mitigation event
      alerterClient.sendAlert({
        source: 'log_analysis_error',
        type: 'analysis_failed',
        details: error.message,
        log: log,
      });

      return { decision: 'error', reason: 'Error analyzing log' };
    }
  };

  parentPort?.on('message', async (log: string) => {
    console.log(`[Worker ${process.pid}] Received log:`, log.substring(0, 100) + '...');
    const analysis = await analyzeLog(log);

    if (analysis.decision === 'alert') {
      metrics.alertsTriggered.inc({ provider: config.llm?.provider, model: config.llm?.model });
      console.log(`[Worker ${process.pid}] Anomaly detected! Reason: ${analysis.reason}`);
      alerterClient.sendAlert({
        source: 'log_analysis',
        type: 'anomaly_detected',
        details: analysis.reason,
        log: log,
      });
    }
  });
}

export class AgentManager {
  private workers: Worker[] = [];
  private nextWorker = 0;
  private recentLogs: string[] = [];

  constructor(private config: SeraphConfig) {
    if (isMainThread) {
      this.initWorkers();
    }
  }

  private initWorkers() {
    metrics.activeWorkers.set(this.config.workers);
    for (let i = 0; i < this.config.workers; i++) {
      const worker = new Worker(__filename, {
        workerData: { config: this.config },
      });
      worker.on('error', (err) => console.error(`Worker error:`, err));
      worker.on('exit', (code) => {
        if (code !== 0) console.error(`Worker stopped with exit code ${code}`);
      });
      this.workers.push(worker);
    }
  }

  public dispatch(log: string) {
    metrics.logsProcessed.inc();

    // Pre-filtering logic
    if (this.config.preFilters && this.config.preFilters.length > 0) {
      for (const filter of this.config.preFilters) {
        try {
          const regex = new RegExp(filter);
          if (regex.test(log)) {
            metrics.logsSkipped.inc();
            // Optionally log that a log was skipped
            // console.log(`[AgentManager] Log skipped by filter: ${filter}`);
            return; // Skip sending this log to a worker
          }
        } catch (error: any) {
          console.error(`[AgentManager] Invalid regex in preFilters: ${filter}`, error.message);
        }
      }
    }

    if (this.workers.length === 0) {
      console.error("No workers available to process logs.");
      return;
    }
    this.workers[this.nextWorker].postMessage(log);
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;

    // Store the log
    this.recentLogs.push(log);
    if (this.recentLogs.length > 100) {
      this.recentLogs.shift();
    }
  }

  public getRecentLogs(): string[] {
    return this.recentLogs;
  }

  public shutdown() {
    console.log("Shutting down all workers...");
    for (const worker of this.workers) {
      worker.terminate();
    }
  }
}
