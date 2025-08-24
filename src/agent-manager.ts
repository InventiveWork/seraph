// src/agent-manager.ts

import { Worker } from 'worker_threads';
import { SeraphConfig } from './config';
import { AlerterClient } from './alerter';
import { metrics } from './metrics';
import { ReportStore } from './report-store';
import { mcpManager } from './mcp-manager';
import { InvestigationScheduler, SchedulerConfig } from './investigation-scheduler';
import { PriorityCalculatorConfig } from './alert-priority-calculator';
import { join } from 'path';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';

interface ActiveInvestigation {
  worker: Worker;
  log: string;
  timeoutHandle: NodeJS.Timeout;
}

export class AgentManager {
  private triageWorkers: Worker[] = [];
  private investigationWorkers: Worker[] = [];
  private nextTriageWorker = 0;
  private nextInvestigationWorker = 0;
  
  private recentLogs: string[] = [];
  private currentLogsSize = 0;
  
  private restartAttempts: Map<number, number> = new Map();
  private readonly MAX_RESTART_ATTEMPTS = 5;
  private readonly RESTART_DELAY_MS = 5000;

  // Priority queue system
  private investigationScheduler: InvestigationScheduler | null = null;
  private priorityQueueEnabled: boolean;

  // Legacy simple queue (fallback)
  private activeInvestigations: Map<string, ActiveInvestigation> = new Map();
  private recentReasons: Map<string, number> = new Map(); // For deduplication
  private readonly MAX_CONCURRENT_INVESTIGATIONS = 3;
  private readonly DEDUPLICATION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  private readonly INVESTIGATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  private readonly LOG_CLEANUP_INTERVAL_MASK = 15; // Every 16 logs (power of 2 for bitwise optimization)

  private reportStore: ReportStore;
  private alerterClient: AlerterClient;
  private config: SeraphConfig;
  private initializationPromise: Promise<void>;
  private builtInMcpUrl: string;
  private pruningInterval: NodeJS.Timeout | null = null;
  private readonly maxLogsSize: number;
  private readonly workerCount: number;
  private readonly maxLogSizeTenth: number;

  constructor(config: SeraphConfig) {
    this.config = config;
    this.maxLogsSize = (config.recentLogsMaxSizeMb ?? 10) * 1024 * 1024; // Cache calculation
    this.workerCount = config.workers ?? 4; // Cache worker count
    this.maxLogSizeTenth = this.maxLogsSize * 0.1; // Pre-compute 10% threshold
    this.priorityQueueEnabled = config.priorityQueue?.enabled ?? false;
    this.reportStore = new ReportStore();
    this.alerterClient = new AlerterClient(config);
    this.builtInMcpUrl = `http://localhost:${(this.config.port ?? 8080) + 1}/mcp`;
    this.schedulePruning();
    this.initializationPromise = this.initialize();
  }

  public async waitForInitialization() {
    return this.initializationPromise;
  }

  private async initialize() {
    await this.initMcpManager();
    this.initTriageWorkers();
    this.initInvestigationWorkers();
    
    // Initialize priority queue system if enabled
    if (this.priorityQueueEnabled) {
      this.initPriorityQueueSystem();
    }
  }

  private async initMcpManager() {
    try {
      console.log(`Initializing with built-in MCP server at ${this.builtInMcpUrl}`);
      await mcpManager.initialize(this.builtInMcpUrl);
      console.log('Built-in MCP tools initialized successfully.');
    } catch (error) {
      console.error('Error initializing built-in MCP server:', error);
    }
  }

  private initTriageWorkers() {
    const numWorkers = this.workerCount > 1 ? Math.floor(this.workerCount / 2) : 1;
    metrics.activeWorkers.set({ type: 'triage' }, numWorkers);
    for (let i = 0; i < numWorkers; i++) {
      this.createTriageWorker(i);
    }
  }

  private initInvestigationWorkers() {
    const numWorkers = this.workerCount > 1 ? Math.ceil(this.workerCount / 2) : 1;
    metrics.activeWorkers.set({ type: 'investigation' }, numWorkers);
    for (let i = 0; i < numWorkers; i++) {
      this.createInvestigationWorker(i);
    }
  }

  private initPriorityQueueSystem() {
    console.log('[AgentManager] Initializing priority queue system...');
    
    const schedulerConfig: SchedulerConfig = {
      maxConcurrentInvestigations: this.config.priorityQueue?.maxConcurrentInvestigations ?? 5,
      maxQueueSize: this.config.priorityQueue?.maxQueueSize ?? 100,
      investigationTimeoutMs: this.config.priorityQueue?.investigationTimeoutMs ?? 300000, // 5 min
      preemptionEnabled: this.config.priorityQueue?.preemptionEnabled ?? true,
      preemptionThreshold: this.config.priorityQueue?.preemptionThreshold ?? 0.3,
      burstModeEnabled: this.config.priorityQueue?.burstModeEnabled ?? true,
      burstModeConcurrency: this.config.priorityQueue?.burstModeConcurrency ?? 8,
      burstModeThreshold: this.config.priorityQueue?.burstModeThreshold ?? 2, // HIGH priority
    };

    const priorityCalculatorConfig: PriorityCalculatorConfig = {
      weights: this.config.priorityQueue?.priorityWeights ?? {
        keywords: 0.3,
        serviceImpact: 0.4,
        timeContext: 0.2,
        historical: 0.1,
      },
      services: this.config.priorityQueue?.services ?? [],
      businessHours: this.config.priorityQueue?.businessHours ?? {
        start: 9,
        end: 17,
        timezone: 'UTC',
      },
      criticalKeywords: this.config.priorityQueue?.criticalKeywords ?? [],
      highPriorityKeywords: this.config.priorityQueue?.highPriorityKeywords ?? [],
      mediumPriorityKeywords: this.config.priorityQueue?.mediumPriorityKeywords ?? [],
    };

    this.investigationScheduler = new InvestigationScheduler(
      schedulerConfig,
      priorityCalculatorConfig,
      this.investigationWorkers,
    );

    console.log('[AgentManager] Priority queue system initialized successfully');
  }

  private getWorkerPath(filename: string): string {
    // First try relative to current __dirname (works in production when compiled)
    const currentDirPath = join(__dirname, filename);
    if (existsSync(currentDirPath)) {
      return currentDirPath;
    }

    // For test environment, try dist directory
    const distPath = join(process.cwd(), 'dist', filename);
    if (existsSync(distPath)) {
      return distPath;
    }

    // Fallback to current __dirname path (will throw appropriate error if not found)
    return currentDirPath;
  }

  private createTriageWorker(index: number) {
    // Always use compiled JS files for workers, even in test environment
    const workerPath = this.getWorkerPath('agent.worker.js');
    const worker = new Worker(workerPath, { workerData: { config: this.config } });
    this.triageWorkers[index] = worker;

    worker.on('message', (message: any) => {
      if (message.type === 'alert') {
        this.handleAlert(message.data.log, message.data.reason);
      }
    });
    this.setupWorkerLifecycle(worker, index, 'triage', this.createTriageWorker.bind(this));
  }

  private createInvestigationWorker(index: number) {
    // Always use compiled JS files for workers, even in test environment
    const workerPath = this.getWorkerPath('investigation.worker.js');
    const worker = new Worker(workerPath, { workerData: { config: this.config } });
    this.investigationWorkers[index] = worker;

    worker.on('message', async (message: any) => {
      if (message.type === 'investigation_complete') {
        this.handleInvestigationComplete(message.data);
      } else if (message.type === 'execute_tool') {
        const { name, arguments: args, investigationId } = message.data;
        // Reset the timeout since the worker is making progress
        this.resetInvestigationTimeout(investigationId);
        const tool = mcpManager.getDynamicTools().find(t => t.name === name);
        if (tool) {
          try {
            const result = await tool.execute(args);
            worker.postMessage({ type: 'tool_result', data: result, investigationId });
          } catch (error: any) {
            worker.postMessage({ type: 'tool_result', data: { error: error.message }, investigationId });
          }
        } else {
          worker.postMessage({ type: 'tool_result', data: { error: `Tool ${name} not found.` }, investigationId });
        }
      }
    });
    this.setupWorkerLifecycle(worker, index, 'investigation', this.createInvestigationWorker.bind(this));
  }

  private setupWorkerLifecycle(worker: Worker, index: number, type: string, createFn: (index: number) => void) {
    this.restartAttempts.set(index, 0);
    worker.on('error', (err) => console.error(`Worker ${type} ${index} error:`, err));
    worker.on('exit', (code) => {
      if (code !== 0) {
        const attempts = (this.restartAttempts.get(index) ?? 0) + 1;
        this.restartAttempts.set(index, attempts);
        if (attempts <= this.MAX_RESTART_ATTEMPTS) {
          console.error(`${type} worker ${index} stopped. Restarting... (attempt ${attempts}/${this.MAX_RESTART_ATTEMPTS})`);
          setTimeout(() => {
            try {
              createFn(index);
              // Only reset restart attempts if worker creation was successful
              this.restartAttempts.set(index, 0);
            } catch (error) {
              console.error(`Failed to restart ${type} worker ${index}:`, error);
              // Don't reset attempts on failure, let them accumulate
            }
          }, this.RESTART_DELAY_MS);
        } else {
          console.error(`${type} worker ${index} has reached max restart attempts.`);
        }
      } else {
        // Reset restart attempts on normal exit
        this.restartAttempts.set(index, 0);
      }
    });
  }

  private schedulePruning() {
    if (this.config.reportRetentionDays) {
      this.pruningInterval = setInterval(() => this.reportStore.pruneOldReports(this.config.reportRetentionDays!), 24 * 60 * 60 * 1000);
    }
  }

  // Trigger investigations programmatically
  public triggerInvestigation(log: string, reason: string): boolean {
    return this.handleAlert(log, reason);
  }

  private handleAlert(log: string, reason: string): boolean {
    // Use priority queue system if enabled
    if (this.priorityQueueEnabled && this.investigationScheduler) {
      return this.handleAlertWithPriorityQueue(log, reason);
    }
    
    // Fallback to legacy simple queue
    return this.handleAlertLegacy(log, reason);
  }

  private handleAlertWithPriorityQueue(log: string, reason: string): boolean {
    console.log(`[AgentManager] Processing alert with priority queue: ${reason}`);
    
    // Check for deduplication (still needed for priority queue)
    const reasonKey = this.normalizeReason(reason);
    const now = Date.now();
    const lastSeen = this.recentReasons.get(reasonKey);
    
    if (lastSeen && (now - lastSeen) < this.DEDUPLICATION_WINDOW_MS) {
      console.log(`[AgentManager] Skipping duplicate alert: ${reason} (last seen ${Math.round((now - lastSeen) / 1000)}s ago)`);
      return false;
    }
    
    this.recentReasons.set(reasonKey, now);
    this.cleanupOldReasons(now);
    
    // Extract metadata for priority calculation
    const metadata = {
      source: 'agent-manager',
      timestamp: now,
    };
    
    // Schedule with priority queue (fire-and-forget with proper error handling)
    // Wrap in try-catch to handle synchronous errors and ensure promise is handled
    try {
      this.investigationScheduler!.scheduleAlert(log, reason, metadata)
        .then(investigationId => {
          if (investigationId) {
            console.log(`[AgentManager] Alert scheduled with ID: ${investigationId}`);
          } else {
            console.warn(`[AgentManager] Failed to schedule alert: ${reason}`);
          }
        })
        .catch(error => {
          console.error(`[AgentManager] Error scheduling alert: ${error.message ?? error}`);
        });
    } catch (error) {
      console.error(`[AgentManager] Synchronous error scheduling alert: ${error instanceof Error ? error.message : error}`);
    }
    
    return true;
  }

  private handleAlertLegacy(log: string, reason: string): boolean {
    // Check for deduplication
    const reasonKey = this.normalizeReason(reason);
    const now = Date.now();
    const lastSeen = this.recentReasons.get(reasonKey);
    
    if (lastSeen && (now - lastSeen) < this.DEDUPLICATION_WINDOW_MS) {
      console.log(`Skipping duplicate alert for: ${reason} (last seen ${Math.round((now - lastSeen) / 1000)}s ago)`);
      return false;
    }
    
    // Check concurrent investigation limit
    if (this.activeInvestigations.size >= this.MAX_CONCURRENT_INVESTIGATIONS) {
      console.log(`Investigation queue full (${this.activeInvestigations.size}/${this.MAX_CONCURRENT_INVESTIGATIONS}). Dropping alert: ${reason}`);
      return false;
    }
    
    console.log(`Triage alert received for: ${reason}. Dispatching to investigation worker...`);
    this.recentReasons.set(reasonKey, now);
    
    // Cleanup old deduplication entries
    this.cleanupOldReasons(now);
    
    // Sanitize tools to only include serializable data before sending to worker
    const toolSchemas = mcpManager.getDynamicTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    const investigationId = uuidv4();
    
    const worker = this.investigationWorkers[this.nextInvestigationWorker];
    worker.postMessage({
      type: 'investigate',
      data: { log, reason, tools: toolSchemas, investigationId },
    });

    const timeoutHandle = setTimeout(() => {
      this.handleInvestigationTimeout(investigationId);
    }, this.INVESTIGATION_TIMEOUT_MS);

    this.activeInvestigations.set(investigationId, { worker, log, timeoutHandle });
    
    // Safe round-robin worker selection
    this.nextInvestigationWorker = (this.nextInvestigationWorker + 1) % this.investigationWorkers.length;
    return true;
  }

  private normalizeReason(reason: string): string {
    // Normalize similar reasons to prevent duplicate investigations
    let normalized = reason.toLowerCase()
      .replace(/\d+/g, 'N') // Replace numbers with 'N'
      .replace(/\s+/g, ' ')  // Normalize whitespace
      .trim();
    
    // Additional normalization for common patterns
    normalized = normalized
      .replace(/domain name.*not found/g, 'domain_name_not_found')
      .replace(/dns.*resolution.*fail/g, 'dns_resolution_failure')
      .replace(/no upstream.*connection/g, 'no_upstream_connections')
      .replace(/service.*connectivity.*error/g, 'service_connectivity_error')
      .replace(/getaddrinfo.*err=N/g, 'getaddrinfo_error');
    
    return normalized;
  }

  private cleanupOldReasons(now: number) {
    for (const [reason, timestamp] of this.recentReasons) {
      if ((now - timestamp) > this.DEDUPLICATION_WINDOW_MS) {
        this.recentReasons.delete(reason);
      }
    }
  }

  private handleInvestigationTimeout(investigationId: string) {
    const investigation = this.activeInvestigations.get(investigationId);
    if (!investigation) {
      return; // Investigation already completed
    }

    console.error(`[AgentManager] Investigation ${investigationId} timed out after ${this.INVESTIGATION_TIMEOUT_MS / 1000}s. Active investigations: ${this.activeInvestigations.size}/${this.MAX_CONCURRENT_INVESTIGATIONS}`);
    
    // Clear from active investigations first
    this.activeInvestigations.delete(investigationId);
    
    // Terminate the stuck worker. The 'exit' handler will restart it.
    try {
      investigation.worker.terminate();
    } catch (error) {
      console.error(`Error terminating worker for investigation ${investigationId}:`, error);
    }
    
    this.alerterClient.sendSystemAlert({
      source: 'agent_manager',
      type: 'investigation_timeout',
      details: `Investigation timed out after ${this.INVESTIGATION_TIMEOUT_MS / 1000}s: ${investigation.log.substring(0, 200)}...`,
    });
  }

  private resetInvestigationTimeout(investigationId: string) {
    const investigation = this.activeInvestigations.get(investigationId);
    if (investigation) {
      clearTimeout(investigation.timeoutHandle);
      investigation.timeoutHandle = setTimeout(() => {
        this.handleInvestigationTimeout(investigationId);
      }, this.INVESTIGATION_TIMEOUT_MS);
    }
  }

  private async handleInvestigationComplete(data: any) {
    const { investigationId, initialLog, triageReason, investigationTrace, finalAnalysis, toolUsage } = data;
    
    // Handle completion in priority queue system
    if (this.priorityQueueEnabled && this.investigationScheduler) {
      await this.investigationScheduler.onInvestigationComplete(investigationId, true);
    } else {
      // Legacy handling
      const investigation = this.activeInvestigations.get(investigationId);
      if (investigation) {
        clearTimeout(investigation.timeoutHandle);
        this.activeInvestigations.delete(investigationId);
      }
      console.log(`Investigation ${investigationId} complete for: ${triageReason}. Active investigations: ${this.activeInvestigations.size}/${this.MAX_CONCURRENT_INVESTIGATIONS}`);
    }

    try {
      const initialAlert = await this.alerterClient.sendInitialAlert(initialLog, triageReason);
      const report = await this.reportStore.saveReport({ initialLog, triageReason, investigationTrace, finalAnalysis, toolUsage });
      await this.alerterClient.sendEnrichedAnalysis(initialAlert.incidentId, finalAnalysis, report.incidentId, toolUsage);

      console.log(`Report ${report.incidentId} saved and enriched analysis sent for incident ${initialAlert.incidentId}.`);
    } catch (error) {
      console.error(`Failed to complete investigation ${investigationId}:`, error);
    }
  }

  public dispatch(log: string) {
    metrics.logsProcessed.inc();

    if (this.config.preFilters?.some(filter => new RegExp(filter).test(log))) {
      metrics.logsSkipped.inc();
      return;
    }

    if (this.triageWorkers.length === 0) {
      console.error('No triage workers available to process logs.');
      return;
    }
    this.triageWorkers[this.nextTriageWorker].postMessage(log);
    // Safe round-robin worker selection
    this.nextTriageWorker = (this.nextTriageWorker + 1) % this.triageWorkers.length;

    this.storeRecentLog(log);
  }

  private storeRecentLog(log: string) {
    const logSize = Buffer.byteLength(log, 'utf8');
    const maxSize = this.maxLogsSize;
    const maxCount = 100;
    
    // Don't store if log is too large
    if (logSize > this.maxLogSizeTenth) { // Don't allow single log to exceed 10% of total capacity
      console.warn(`Log entry too large (${logSize} bytes), skipping storage`);
      return;
    }
    
    this.recentLogs.push(log);
    this.currentLogsSize += logSize;
    
    // Proactively clean up when approaching limits - optimized for hot path
    const logs = this.recentLogs;
    while (logs.length > 0 && 
           (this.currentLogsSize > maxSize || logs.length > maxCount)) {
      const removedLog = logs.shift()!; // Safe due to length check
      this.currentLogsSize -= Buffer.byteLength(removedLog, 'utf8');
    }
    
    // Periodic cleanup to prevent slow memory leaks - optimized with bitwise
    if ((this.recentLogs.length & this.LOG_CLEANUP_INTERVAL_MASK) === 0) {
      this.validateLogsSizeAccuracy();
    }
  }

  private validateLogsSizeAccuracy() {
    // Recalculate size to prevent drift from encoding issues - optimized loop
    let actualSize = 0;
    const logs = this.recentLogs;
    const length = logs.length;
    for (let i = 0; i < length; i++) {
      actualSize += Buffer.byteLength(logs[i], 'utf8');
    }
    
    if (Math.abs(actualSize - this.currentLogsSize) > 1024) { // Allow 1KB drift
      console.warn(`Log size drift detected. Correcting from ${this.currentLogsSize} to ${actualSize}`);
      this.currentLogsSize = actualSize;
    }
  }

  public getRecentLogs(): string[] {
    return this.recentLogs;
  }

  public shutdown() {
    console.log('Shutting down all workers...');
    
    // Clear pruning interval
    if (this.pruningInterval) {
      clearInterval(this.pruningInterval);
      this.pruningInterval = null;
    }
    
    // Shutdown priority queue system if enabled
    if (this.investigationScheduler) {
      this.investigationScheduler.shutdown();
    }
    
    // Legacy cleanup
    this.activeInvestigations.forEach(inv => clearTimeout(inv.timeoutHandle));
    [...this.triageWorkers, ...this.investigationWorkers].forEach(w => w.terminate());
    this.reportStore.close();
  }

  /**
   * Get priority queue metrics (for monitoring/debugging)
   */
  public getPriorityQueueMetrics() {
    if (this.priorityQueueEnabled && this.investigationScheduler) {
      return this.investigationScheduler.getMetrics();
    }
    return null;
  }

  /**
   * Enable or disable priority queue system at runtime
   */
  public setPriorityQueueEnabled(enabled: boolean) {
    if (enabled && !this.priorityQueueEnabled) {
      this.priorityQueueEnabled = true;
      this.initPriorityQueueSystem();
      console.log('[AgentManager] Priority queue system enabled');
    } else if (!enabled && this.priorityQueueEnabled) {
      this.priorityQueueEnabled = false;
      if (this.investigationScheduler) {
        this.investigationScheduler.shutdown();
        this.investigationScheduler = null;
      }
      console.log('[AgentManager] Priority queue system disabled');
    }
  }
}
