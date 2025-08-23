// Investigation Scheduler - Smart resource allocation and preemption for investigations
import { Worker } from 'worker_threads';
import { v4 as uuidv4 } from 'uuid';
import { PriorityQueue, QueuedAlert, AlertPriority } from './priority-queue';
import { AlertPriorityCalculator, PriorityCalculatorConfig } from './alert-priority-calculator';
import { metrics } from './metrics';

export interface RunningInvestigation {
  id: string;
  alert: QueuedAlert;
  worker: Worker;
  startTime: number;
  estimatedEndTime: number;
  estimatedDuration: number;
  timeoutHandle: NodeJS.Timeout;
  canPreempt: boolean;
  preemptionSaveState?: any;
}

export interface SchedulerConfig {
  maxConcurrentInvestigations: number;
  maxQueueSize: number;
  investigationTimeoutMs: number;
  preemptionEnabled: boolean;
  preemptionThreshold: number; // Priority difference needed for preemption
  burstModeEnabled: boolean;    // Allow temporary concurrency increase
  burstModeConcurrency: number; // Max concurrent during burst
  burstModeThreshold: AlertPriority; // Priority level that triggers burst
}

export interface SchedulerMetrics {
  queueMetrics: any;
  runningInvestigations: number;
  preemptionsTotal: number;
  burstModeActive: boolean;
  avgInvestigationTime: number;
  priorityAccuracy: number;
}

export class InvestigationScheduler {
  private config: SchedulerConfig;
  private priorityQueue: PriorityQueue;
  private priorityCalculator: AlertPriorityCalculator;
  private runningInvestigations = new Map<string, RunningInvestigation>();
  private workers: Worker[] = [];
  private nextWorkerIndex = 0;
  
  // Performance tracking
  private completedInvestigations: Array<{
    priority: AlertPriority;
    estimatedTime: number;
    actualTime: number;
    timestamp: number;
  }> = [];
  private preemptionCount = 0;
  private burstModeActive = false;
  private burstModeStart = 0;

  constructor(
    config: SchedulerConfig,
    priorityCalculatorConfig: PriorityCalculatorConfig,
    workers: Worker[]
  ) {
    this.config = config;
    this.priorityQueue = new PriorityQueue(config.maxQueueSize, true);
    this.priorityCalculator = new AlertPriorityCalculator(priorityCalculatorConfig);
    this.workers = workers;
    
    this.startPeriodicScheduling();
  }

  /**
   * Schedule a new alert for investigation
   */
  async scheduleAlert(log: string, reason: string, metadata?: any, sessionId?: string): Promise<string | null> {
    try {
      // Calculate priority
      const priorityResult = this.priorityCalculator.calculatePriority(log, reason, metadata);
      
      console.log(`[Scheduler] Alert priority: ${AlertPriority[priorityResult.priority]} (${priorityResult.score.toFixed(2)})`);
      console.log(`[Scheduler] Reasoning: ${priorityResult.reasoning.join(', ')}`);

      // Check if burst mode should be activated
      if (this.config.burstModeEnabled && 
          priorityResult.priority <= this.config.burstModeThreshold && 
          !this.burstModeActive) {
        this.activateBurstMode();
      }

      // Estimate investigation duration based on historical data
      const estimatedDuration = this.estimateInvestigationDuration(priorityResult.priority, log, reason);

      // Create queued alert
      const queuedAlert: Omit<QueuedAlert, 'id' | 'enqueuedAt'> = {
        log,
        reason,
        priority: priorityResult.priority,
        priorityScore: priorityResult.score,
        estimatedDuration,
        sessionId,
        metadata: metadata || {},
      };

      // Check for preemption opportunity
      if (this.config.preemptionEnabled && priorityResult.priority <= AlertPriority.HIGH) {
        const preemptionTarget = this.findPreemptionTarget(priorityResult.priority, priorityResult.score);
        if (preemptionTarget) {
          return await this.preemptInvestigation(preemptionTarget, queuedAlert);
        }
      }

      // Try immediate scheduling if capacity available
      const maxConcurrent = this.burstModeActive ? 
        this.config.burstModeConcurrency : 
        this.config.maxConcurrentInvestigations;

      if (this.runningInvestigations.size < maxConcurrent) {
        return await this.startInvestigation(queuedAlert);
      }

      // Queue the alert
      const alertId = this.priorityQueue.enqueue(queuedAlert);
      
      metrics.queuedAlerts?.inc({ priority: AlertPriority[priorityResult.priority] });
      
      console.log(`[Scheduler] Queued alert ${alertId} with priority ${AlertPriority[priorityResult.priority]}`);
      return alertId;

    } catch (error: any) {
      console.error(`[Scheduler] Failed to schedule alert: ${error.message}`);
      return null;
    }
  }

  /**
   * Handle investigation completion
   */
  async onInvestigationComplete(investigationId: string, success: boolean): Promise<void> {
    const investigation = this.runningInvestigations.get(investigationId);
    if (!investigation) return;

    const actualTime = Date.now() - investigation.startTime;
    
    // Track performance for future estimations
    this.completedInvestigations.push({
      priority: investigation.alert.priority,
      estimatedTime: investigation.estimatedDuration,
      actualTime,
      timestamp: Date.now(),
    });

    // Update priority calculator with actual results
    this.priorityCalculator.updateHistoricalPattern(
      investigation.alert.log,
      investigation.alert.reason,
      investigation.alert.priority,
      actualTime
    );

    // Cleanup
    clearTimeout(investigation.timeoutHandle);
    this.runningInvestigations.delete(investigationId);

    console.log(`[Scheduler] Investigation ${investigationId} completed in ${actualTime}ms (estimated: ${investigation.estimatedDuration}ms)`);

    // Try to schedule next queued alert
    await this.scheduleNextFromQueue();

    // Check if burst mode should be deactivated
    if (this.burstModeActive && this.shouldDeactivateBurstMode()) {
      this.deactivateBurstMode();
    }

    metrics.investigationDuration?.observe(actualTime / 1000);
    metrics.runningInvestigations?.set(this.runningInvestigations.size);
  }

  /**
   * Handle investigation timeout
   */
  async onInvestigationTimeout(investigationId: string): Promise<void> {
    const investigation = this.runningInvestigations.get(investigationId);
    if (!investigation) return;

    console.error(`[Scheduler] Investigation ${investigationId} timed out after ${this.config.investigationTimeoutMs}ms`);

    // Terminate the worker
    try {
      investigation.worker.terminate();
    } catch (error) {
      console.error(`[Scheduler] Error terminating worker: ${error}`);
    }

    // Track timeout
    metrics.investigationTimeouts?.inc({ priority: AlertPriority[investigation.alert.priority] });

    await this.onInvestigationComplete(investigationId, false);
  }

  /**
   * Cancel a queued or running investigation
   */
  async cancelInvestigation(alertId: string): Promise<boolean> {
    // Try to remove from queue first
    if (this.priorityQueue.removeById(alertId)) {
      console.log(`[Scheduler] Cancelled queued alert ${alertId}`);
      return true;
    }

    // Try to cancel running investigation
    const runningInvestigation = Array.from(this.runningInvestigations.values())
      .find(inv => inv.alert.id === alertId);

    if (runningInvestigation) {
      clearTimeout(runningInvestigation.timeoutHandle);
      try {
        runningInvestigation.worker.terminate();
      } catch (error) {
        console.error(`[Scheduler] Error terminating worker: ${error}`);
      }
      this.runningInvestigations.delete(runningInvestigation.id);
      
      await this.scheduleNextFromQueue();
      
      console.log(`[Scheduler] Cancelled running investigation ${runningInvestigation.id}`);
      return true;
    }

    return false;
  }

  /**
   * Get current scheduler metrics
   */
  getMetrics(): SchedulerMetrics {
    const queueMetrics = this.priorityQueue.getMetrics();
    
    // Calculate average investigation time
    const recentCompletions = this.completedInvestigations
      .filter(c => Date.now() - c.timestamp < 3600000) // Last hour
      .slice(-50); // Last 50 completions

    const avgInvestigationTime = recentCompletions.length > 0 ?
      recentCompletions.reduce((sum, c) => sum + c.actualTime, 0) / recentCompletions.length : 0;

    // Calculate priority accuracy (how often estimates match actual priority needs)
    const priorityAccuracy = this.calculatePriorityAccuracy(recentCompletions);

    return {
      queueMetrics,
      runningInvestigations: this.runningInvestigations.size,
      preemptionsTotal: this.preemptionCount,
      burstModeActive: this.burstModeActive,
      avgInvestigationTime,
      priorityAccuracy,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<SchedulerConfig>): void {
    this.config = { ...this.config, ...newConfig };
    console.log(`[Scheduler] Configuration updated`);
  }

  /**
   * Shutdown scheduler
   */
  shutdown(): void {
    this.priorityQueue.shutdown();
    
    // Clear all running investigations
    for (const investigation of this.runningInvestigations.values()) {
      clearTimeout(investigation.timeoutHandle);
    }
    
    this.runningInvestigations.clear();
  }

  // Private methods

  private async startInvestigation(queuedAlert: Omit<QueuedAlert, 'id' | 'enqueuedAt'>): Promise<string> {
    const investigationId = uuidv4();
    const worker = this.getNextWorker();
    const now = Date.now();

    const investigation: RunningInvestigation = {
      id: investigationId,
      alert: {
        ...queuedAlert,
        id: investigationId,
        enqueuedAt: now,
      },
      worker,
      startTime: now,
      estimatedEndTime: now + queuedAlert.estimatedDuration,
      estimatedDuration: queuedAlert.estimatedDuration,
      canPreempt: queuedAlert.priority >= AlertPriority.MEDIUM,
      timeoutHandle: setTimeout(() => {
        this.onInvestigationTimeout(investigationId);
      }, this.config.investigationTimeoutMs),
    };

    this.runningInvestigations.set(investigationId, investigation);

    // Send investigation to worker
    worker.postMessage({
      type: 'investigate',
      data: {
        log: queuedAlert.log,
        reason: queuedAlert.reason,
        investigationId,
        sessionId: queuedAlert.sessionId,
        priority: queuedAlert.priority,
        tools: [], // Tools will be added by caller
      }
    });

    console.log(`[Scheduler] Started investigation ${investigationId} with priority ${AlertPriority[queuedAlert.priority]}`);
    
    metrics.startedInvestigations?.inc({ priority: AlertPriority[queuedAlert.priority] });
    metrics.runningInvestigations?.set(this.runningInvestigations.size);

    return investigationId;
  }

  private async scheduleNextFromQueue(): Promise<void> {
    const maxConcurrent = this.burstModeActive ? 
      this.config.burstModeConcurrency : 
      this.config.maxConcurrentInvestigations;

    while (this.runningInvestigations.size < maxConcurrent && !this.priorityQueue.isEmpty()) {
      const nextAlert = this.priorityQueue.dequeue();
      if (nextAlert) {
        await this.startInvestigation(nextAlert);
      }
    }
  }

  private findPreemptionTarget(newPriority: AlertPriority, newScore: number): RunningInvestigation | null {
    let bestTarget: RunningInvestigation | null = null;
    let bestScoreDiff = this.config.preemptionThreshold;

    for (const investigation of this.runningInvestigations.values()) {
      if (!investigation.canPreempt) continue;
      
      const scoreDiff = investigation.alert.priorityScore - newScore;
      const priorityDiff = investigation.alert.priority - newPriority;
      
      if (priorityDiff > 0 && scoreDiff > bestScoreDiff) {
        bestTarget = investigation;
        bestScoreDiff = scoreDiff;
      }
    }

    return bestTarget;
  }

  private async preemptInvestigation(
    target: RunningInvestigation, 
    newAlert: Omit<QueuedAlert, 'id' | 'enqueuedAt'>
  ): Promise<string> {
    console.log(`[Scheduler] Preempting investigation ${target.id} (${AlertPriority[target.alert.priority]}) for higher priority alert (${AlertPriority[newAlert.priority]})`);

    // Save state if possible (for future resumption)
    target.preemptionSaveState = {
      investigationId: target.id,
      alert: target.alert,
      preemptedAt: Date.now(),
    };

    // Terminate current investigation
    clearTimeout(target.timeoutHandle);
    try {
      target.worker.terminate();
    } catch (error) {
      console.error(`[Scheduler] Error terminating worker for preemption: ${error}`);
    }

    // Re-queue the preempted alert with boosted priority
    const preemptedAlert = {
      ...target.alert,
      priorityScore: target.alert.priorityScore + 0.1, // Slight boost to prevent re-preemption
    };
    
    this.priorityQueue.enqueue(preemptedAlert);
    this.runningInvestigations.delete(target.id);

    this.preemptionCount++;
    metrics.preemptions?.inc({ 
      preempted_priority: AlertPriority[target.alert.priority],
      new_priority: AlertPriority[newAlert.priority]
    });

    // Start new investigation
    return await this.startInvestigation(newAlert);
  }

  private estimateInvestigationDuration(priority: AlertPriority, log: string, reason: string): number {
    // Base estimates by priority (in milliseconds)
    const baseEstimates = {
      [AlertPriority.CRITICAL]: 120000,  // 2 minutes
      [AlertPriority.HIGH]: 180000,      // 3 minutes  
      [AlertPriority.MEDIUM]: 240000,    // 4 minutes
      [AlertPriority.LOW]: 300000,       // 5 minutes
    };

    let estimate = baseEstimates[priority];

    // Adjust based on historical data
    const recentCompletions = this.completedInvestigations
      .filter(c => c.priority === priority)
      .slice(-10); // Last 10 of this priority

    if (recentCompletions.length > 0) {
      const avgActual = recentCompletions.reduce((sum, c) => sum + c.actualTime, 0) / recentCompletions.length;
      estimate = Math.floor(estimate * 0.3 + avgActual * 0.7); // Weighted blend
    }

    // Complexity adjustments
    const text = `${log} ${reason}`.toLowerCase();
    if (text.includes('database') || text.includes('connection')) {
      estimate *= 1.2; // Database issues often take longer
    }
    if (text.includes('kubernetes') || text.includes('deployment')) {
      estimate *= 1.3; // K8s issues can be complex
    }
    if (text.includes('timeout') || text.includes('error')) {
      estimate *= 0.9; // Often quick to diagnose
    }

    return Math.max(30000, Math.min(600000, estimate)); // 30s to 10min bounds
  }

  private getNextWorker(): Worker {
    const worker = this.workers[this.nextWorkerIndex];
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
    return worker;
  }

  private startPeriodicScheduling(): void {
    // Check queue every 5 seconds for scheduling opportunities
    setInterval(() => {
      this.scheduleNextFromQueue();
      this.updateMetrics();
    }, 5000);
  }

  private activateBurstMode(): void {
    if (this.burstModeActive) return;
    
    this.burstModeActive = true;
    this.burstModeStart = Date.now();
    
    console.log(`[Scheduler] Burst mode activated - allowing up to ${this.config.burstModeConcurrency} concurrent investigations`);
    metrics.burstModeActivations?.inc();
  }

  private deactivateBurstMode(): void {
    if (!this.burstModeActive) return;
    
    const duration = Date.now() - this.burstModeStart;
    this.burstModeActive = false;
    
    console.log(`[Scheduler] Burst mode deactivated after ${duration}ms`);
    metrics.burstModeDuration?.observe(duration / 1000);
  }

  private shouldDeactivateBurstMode(): boolean {
    if (!this.burstModeActive) return false;
    
    // Deactivate if no critical/high priority alerts in queue
    const queueMetrics = this.priorityQueue.getMetrics();
    const criticalAndHigh = queueMetrics.byPriority[AlertPriority.CRITICAL] + 
                           queueMetrics.byPriority[AlertPriority.HIGH];
    
    // Also deactivate if burst mode has been active for more than 10 minutes
    const burstDuration = Date.now() - this.burstModeStart;
    
    return criticalAndHigh === 0 || burstDuration > 600000;
  }

  private calculatePriorityAccuracy(completions: typeof this.completedInvestigations): number {
    if (completions.length === 0) return 0;
    
    // Simple accuracy metric: percentage of investigations that finished 
    // within 150% of estimated time
    const accurate = completions.filter(c => 
      c.actualTime <= c.estimatedTime * 1.5 && 
      c.actualTime >= c.estimatedTime * 0.5
    ).length;
    
    return (accurate / completions.length) * 100;
  }

  private updateMetrics(): void {
    const queueMetrics = this.priorityQueue.getMetrics();
    
    metrics.queueSize?.set(queueMetrics.totalQueued);
    metrics.avgWaitTime?.set(queueMetrics.avgWaitTime / 1000); // Convert to seconds
    metrics.burstModeActive?.set(this.burstModeActive ? 1 : 0);
    
    // Priority distribution
    Object.entries(queueMetrics.byPriority).forEach(([priority, count]) => {
      metrics.queuePriorityDistribution?.set({ priority }, count);
    });
  }
}