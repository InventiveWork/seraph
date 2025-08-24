// src/scheduler.ts - Unified Investigation Scheduler and Priority Queue
// Combines priority queue and investigation scheduler functionality

import { Worker } from 'worker_threads';
import { v4 as uuidv4 } from 'uuid';
import { AlertPriorityCalculator, PriorityCalculatorConfig } from './alert-priority-calculator';
import { metrics } from './metrics';

// ===== PRIORITY QUEUE SYSTEM =====

export enum AlertPriority {
  CRITICAL = 1,
  HIGH = 2,
  MEDIUM = 3,
  LOW = 4,
}

export interface QueuedAlert {
  id: string;
  log: string;
  reason: string;
  priority: AlertPriority;
  priorityScore: number;
  enqueuedAt: number;
  estimatedDuration: number; // in milliseconds
  sessionId?: string;
  metadata: {
    source?: string;
    service?: string;
    severity?: string;
    tags?: string[];
  };
}

export interface QueueMetrics {
  totalQueued: number;
  byPriority: Record<AlertPriority, number>;
  avgWaitTime: number;
  avgPriorityScore: number;
  oldestAlert?: number; // timestamp
}

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
  queueMetrics: QueueMetrics;
  runningInvestigations: number;
  preemptionsTotal: number;
  burstModeActive: boolean;
  avgInvestigationTime: number;
  priorityAccuracy: number;
}

/**
 * Min-heap based priority queue for intelligent alert scheduling
 * Lower priority numbers = higher priority (CRITICAL = 1 is highest)
 */
export class PriorityQueue {
  private heap: QueuedAlert[] = [];
  private alertIndex = new Map<string, number>(); // alertId -> heap index for O(1) lookup
  private maxSize: number;
  private priorityAging: boolean;
  private agingInterval: NodeJS.Timeout | null = null;

  constructor(maxSize: number = 100, priorityAging: boolean = true) {
    this.maxSize = maxSize;
    this.priorityAging = priorityAging;
    
    if (priorityAging) {
      // Age priorities every 30 seconds
      this.agingInterval = setInterval(() => this.agePriorities(), 30000);
    }
  }

  /**
   * Add alert to queue with intelligent priority handling
   */
  enqueue(alert: Omit<QueuedAlert, 'id' | 'enqueuedAt'>): string {
    const queuedAlert: QueuedAlert = {
      ...alert,
      id: uuidv4(),
      enqueuedAt: Date.now(),
    };

    // Check if queue is full
    if (this.heap.length >= this.maxSize) {
      // Try to replace lowest priority alert if this one is higher priority
      const lowestPriorityAlert = this.findLowestPriorityAlert();
      if (lowestPriorityAlert && queuedAlert.priority < lowestPriorityAlert.priority) {
        this.removeById(lowestPriorityAlert.id);
        console.log(`[PriorityQueue] Replaced low priority alert ${lowestPriorityAlert.reason} with higher priority alert ${queuedAlert.reason}`);
      } else {
        throw new Error(`Priority queue full (${this.heap.length}/${this.maxSize}). Cannot enqueue alert with priority ${queuedAlert.priority}`);
      }
    }

    // Add to heap
    this.heap.push(queuedAlert);
    const index = this.heap.length - 1;
    this.alertIndex.set(queuedAlert.id, index);
    
    // Bubble up to maintain heap property
    this.bubbleUp(index);
    
    return queuedAlert.id;
  }

  /**
   * Remove and return highest priority alert
   */
  dequeue(): QueuedAlert | null {
    if (this.heap.length === 0) return null;
    
    // Handle single element case
    if (this.heap.length === 1) {
      const result = this.heap.pop()!;
      this.alertIndex.delete(result.id);
      return result;
    }

    // Store the result to return
    const result = this.heap[0];
    
    // Move last element to root
    const lastElement = this.heap.pop()!;
    this.heap[0] = lastElement;
    
    // Update index tracking
    this.alertIndex.delete(result.id);
    this.alertIndex.set(lastElement.id, 0);
    
    // Restore heap property
    this.bubbleDown(0);
    
    return result;
  }

  /**
   * Peek at highest priority alert without removing it
   */
  peek(): QueuedAlert | null {
    return this.heap.length > 0 ? this.heap[0] : null;
  }

  /**
   * Remove specific alert by ID
   */
  removeById(alertId: string): boolean {
    const index = this.alertIndex.get(alertId);
    if (index === undefined) return false;

    // Remove from index
    this.alertIndex.delete(alertId);

    // If it's the last element, just pop it
    if (index === this.heap.length - 1) {
      this.heap.pop();
      return true;
    }

    // Replace with last element
    const lastElement = this.heap.pop()!;
    this.heap[index] = lastElement;
    this.alertIndex.set(lastElement.id, index);

    // Restore heap property (might need to bubble up or down)
    const parent = Math.floor((index - 1) / 2);
    if (parent >= 0 && this.compare(index, parent) < 0) {
      this.bubbleUp(index);
    } else {
      this.bubbleDown(index);
    }

    return true;
  }

  /**
   * Get current queue metrics
   */
  getMetrics(): QueueMetrics {
    const byPriority: Record<AlertPriority, number> = {
      [AlertPriority.CRITICAL]: 0,
      [AlertPriority.HIGH]: 0,
      [AlertPriority.MEDIUM]: 0,
      [AlertPriority.LOW]: 0,
    };

    let totalWaitTime = 0;
    let totalPriorityScore = 0;
    let oldestAlert: number | undefined;

    const now = Date.now();

    for (const alert of this.heap) {
      byPriority[alert.priority]++;
      totalWaitTime += now - alert.enqueuedAt;
      totalPriorityScore += alert.priorityScore;
      
      if (!oldestAlert || alert.enqueuedAt < oldestAlert) {
        oldestAlert = alert.enqueuedAt;
      }
    }

    return {
      totalQueued: this.heap.length,
      byPriority,
      avgWaitTime: this.heap.length > 0 ? totalWaitTime / this.heap.length : 0,
      avgPriorityScore: this.heap.length > 0 ? totalPriorityScore / this.heap.length : 0,
      oldestAlert,
    };
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /**
   * Get current queue size
   */
  size(): number {
    return this.heap.length;
  }

  /**
   * Clear all alerts from queue
   */
  clear(): void {
    this.heap = [];
    this.alertIndex.clear();
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.agingInterval) {
      clearInterval(this.agingInterval);
      this.agingInterval = null;
    }
    this.clear();
  }

  /**
   * Shutdown alias for destroy
   */
  shutdown(): void {
    this.destroy();
  }

  /**
   * Update priority of existing alert
   */
  updatePriority(alertId: string, priority: AlertPriority, score: number): boolean {
    const index = this.alertIndex.get(alertId);
    if (index === undefined) return false;

    const alert = this.heap[index];
    alert.priority = priority;
    alert.priorityScore = score;

    // Restore heap property
    const parent = Math.floor((index - 1) / 2);
    if (parent >= 0 && this.compare(index, parent) < 0) {
      this.bubbleUp(index);
    } else {
      this.bubbleDown(index);
    }

    return true;
  }

  /**
   * Find alerts matching predicate
   */
  findAlerts(predicate: (alert: QueuedAlert) => boolean): QueuedAlert[] {
    return this.heap.filter(predicate);
  }

  // ===== PRIVATE HELPER METHODS =====

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.compare(index, parentIndex) >= 0) break;

      this.swap(index, parentIndex);
      index = parentIndex;
    }
  }

  private bubbleDown(index: number): void {
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;

      if (leftChild < this.heap.length && this.compare(leftChild, smallest) < 0) {
        smallest = leftChild;
      }

      if (rightChild < this.heap.length && this.compare(rightChild, smallest) < 0) {
        smallest = rightChild;
      }

      if (smallest === index) break;

      this.swap(index, smallest);
      index = smallest;
    }
  }

  private swap(i: number, j: number): void {
    // Update index tracking
    this.alertIndex.set(this.heap[i].id, j);
    this.alertIndex.set(this.heap[j].id, i);

    // Swap elements
    [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
  }

  private compare(i: number, j: number): number {
    const alertA = this.heap[i];
    const alertB = this.heap[j];

    // Primary sort: priority (lower number = higher priority)
    if (alertA.priority !== alertB.priority) {
      return alertA.priority - alertB.priority;
    }

    // Secondary sort: priority score (higher = better)
    if (Math.abs(alertA.priorityScore - alertB.priorityScore) > 0.01) {
      return alertB.priorityScore - alertA.priorityScore;
    }

    // Tertiary sort: enqueue time (older = higher priority)
    return alertA.enqueuedAt - alertB.enqueuedAt;
  }

  private findLowestPriorityAlert(): QueuedAlert | null {
    if (this.heap.length === 0) return null;

    // Find the alert with lowest priority (highest priority number)
    let lowestPriorityAlert = this.heap[0];
    for (const alert of this.heap) {
      if (alert.priority > lowestPriorityAlert.priority) {
        lowestPriorityAlert = alert;
      }
    }

    return lowestPriorityAlert;
  }

  private agePriorities(): void {
    if (!this.priorityAging || this.heap.length === 0) return;

    const now = Date.now();
    const ageThreshold = 5 * 60 * 1000; // 5 minutes
    let needsReheapify = false;

    for (const alert of this.heap) {
      const age = now - alert.enqueuedAt;
      
      // Age priorities for old alerts (but don't exceed CRITICAL)
      if (age > ageThreshold && alert.priority > AlertPriority.CRITICAL) {
        // Increase priority (decrease priority number) for aged alerts
        const ageBonus = Math.floor(age / ageThreshold) * 0.1;
        const newPriorityScore = Math.min(alert.priorityScore + ageBonus, 10.0);
        
        if (newPriorityScore !== alert.priorityScore) {
          alert.priorityScore = newPriorityScore;
          // Consider promoting to next priority level if score is high enough
          if (alert.priority === AlertPriority.LOW && newPriorityScore > 7.0) {
            alert.priority = AlertPriority.MEDIUM;
            needsReheapify = true;
          } else if (alert.priority === AlertPriority.MEDIUM && newPriorityScore > 8.5) {
            alert.priority = AlertPriority.HIGH;
            needsReheapify = true;
          }
        }
      }
    }

    // If priorities were changed, rebuild the heap
    if (needsReheapify) {
      this.rebuildHeap();
    }
  }

  private rebuildHeap(): void {
    // Rebuild the heap from scratch
    const alerts = [...this.heap];
    this.heap = [];
    this.alertIndex.clear();

    for (const alert of alerts) {
      this.heap.push(alert);
      this.alertIndex.set(alert.id, this.heap.length - 1);
    }

    // Heapify from bottom up
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
      this.bubbleDown(i);
    }
  }
}

// ===== INVESTIGATION SCHEDULER =====

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
  private schedulingInterval: NodeJS.Timeout | null = null;

  constructor(
    config: SchedulerConfig,
    priorityCalculatorConfig: PriorityCalculatorConfig,
    workers: Worker[],
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

      // Try to enqueue
      const alertId = this.priorityQueue.enqueue(queuedAlert);
      
      // Track metrics
      metrics.queuedAlerts?.inc({ priority: AlertPriority[priorityResult.priority] });
      
      console.log(`[Scheduler] Queued alert ${alertId} with priority ${AlertPriority[priorityResult.priority]}`);
      
      // Trigger immediate scheduling check
      this.scheduleNext();
      
      return alertId;
    } catch (error) {
      console.error(`[Scheduler] Failed to schedule alert:`, error);
      metrics.analysisErrors?.inc({ type: 'scheduling_error' });
      return null;
    }
  }

  /**
   * Get current scheduler metrics
   */
  getMetrics(): SchedulerMetrics {
    const queueMetrics = this.priorityQueue.getMetrics();
    
    // Calculate average investigation time from recent completions
    const recentCompletions = this.completedInvestigations.slice(-20);
    const avgInvestigationTime = recentCompletions.length > 0
      ? recentCompletions.reduce((sum, completion) => sum + completion.actualTime, 0) / recentCompletions.length
      : 0;

    // Calculate priority accuracy (how close estimates were to actual)
    const priorityAccuracy = recentCompletions.length > 0
      ? recentCompletions.reduce((sum, completion) => {
          const accuracy = Math.max(0, 1 - Math.abs(completion.estimatedTime - completion.actualTime) / completion.estimatedTime);
          return sum + accuracy;
        }, 0) / recentCompletions.length
      : 0;

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
   * Set up investigation completion callback
   */
  onInvestigationComplete(callback: (investigationId: string, result: any) => void): void {
    // Store callback for when investigations complete
    // This would need proper implementation based on requirements
  }

  /**
   * Shutdown alias for compatibility
   */
  async shutdown(): Promise<void> {
    await this.stop();
  }

  /**
   * Stop the scheduler and clean up resources
   */
  async stop(): Promise<void> {
    console.log('[Scheduler] Stopping investigation scheduler...');
    
    // Stop periodic scheduling
    if (this.schedulingInterval) {
      clearInterval(this.schedulingInterval);
      this.schedulingInterval = null;
    }

    // Cancel all running investigations
    for (const [investigationId, investigation] of this.runningInvestigations) {
      console.log(`[Scheduler] Cancelling investigation ${investigationId}`);
      
      if (investigation.timeoutHandle) {
        clearTimeout(investigation.timeoutHandle);
      }
      
      try {
        investigation.worker.terminate();
      } catch (error) {
        console.error(`[Scheduler] Error terminating worker for investigation ${investigationId}:`, error);
      }
    }
    
    this.runningInvestigations.clear();
    
    // Clean up priority queue
    this.priorityQueue.destroy();
    
    console.log('[Scheduler] Investigation scheduler stopped');
  }

  // ===== PRIVATE METHODS =====

  private startPeriodicScheduling(): void {
    // Schedule investigations every 2 seconds
    this.schedulingInterval = setInterval(() => {
      this.scheduleNext();
      this.checkBurstMode();
      this.updateMetrics();
    }, 2000);
  }

  private scheduleNext(): void {
    // Calculate current capacity
    const maxConcurrent = this.burstModeActive 
      ? this.config.burstModeConcurrency 
      : this.config.maxConcurrentInvestigations;

    // Check if we can start more investigations
    if (this.runningInvestigations.size >= maxConcurrent) {
      // Check if we can preempt a lower-priority investigation
      if (this.config.preemptionEnabled) {
        this.checkPreemption();
      }
      return;
    }

    // Get next alert from queue
    const nextAlert = this.priorityQueue.dequeue();
    if (!nextAlert) return;

    // Start investigation
    this.startInvestigation(nextAlert);
  }

  private startInvestigation(alert: QueuedAlert): void {
    const investigationId = uuidv4();
    const worker = this.getNextWorker();
    const startTime = Date.now();
    const estimatedEndTime = startTime + alert.estimatedDuration;

    console.log(`[Scheduler] Starting investigation ${investigationId} for alert ${alert.id} with priority ${AlertPriority[alert.priority]}`);

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      console.warn(`[Scheduler] Investigation ${investigationId} timed out after ${this.config.investigationTimeoutMs}ms`);
      this.completeInvestigation(investigationId, 'timeout');
    }, this.config.investigationTimeoutMs);

    // Create investigation record
    const investigation: RunningInvestigation = {
      id: investigationId,
      alert,
      worker,
      startTime,
      estimatedEndTime,
      estimatedDuration: alert.estimatedDuration,
      timeoutHandle,
      canPreempt: alert.priority > AlertPriority.HIGH, // Only non-critical alerts can be preempted
    };

    this.runningInvestigations.set(investigationId, investigation);

    // Send investigation request to worker
    worker.postMessage({
      type: 'investigate',
      data: {
        log: alert.log,
        reason: alert.reason,
        investigationId,
        sessionId: alert.sessionId,
        // Tools will be provided by the worker
      },
    });

    // Track metrics
    metrics.startedInvestigations?.inc({ priority: AlertPriority[alert.priority] });
  }

  private completeInvestigation(investigationId: string, reason: 'completed' | 'timeout' | 'preempted'): void {
    const investigation = this.runningInvestigations.get(investigationId);
    if (!investigation) return;

    const actualTime = Date.now() - investigation.startTime;
    
    console.log(`[Scheduler] Investigation ${investigationId} ${reason} after ${actualTime}ms`);

    // Clean up timeout
    if (investigation.timeoutHandle) {
      clearTimeout(investigation.timeoutHandle);
    }

    // Remove from running investigations
    this.runningInvestigations.delete(investigationId);

    // Track completion metrics
    if (reason === 'completed') {
      this.completedInvestigations.push({
        priority: investigation.alert.priority,
        estimatedTime: investigation.estimatedDuration,
        actualTime,
        timestamp: Date.now(),
      });

      // Keep only recent completions for memory efficiency
      if (this.completedInvestigations.length > 100) {
        this.completedInvestigations.splice(0, 50);
      }

      metrics.investigationsCompleted?.inc({ 
        priority: AlertPriority[investigation.alert.priority],
        reason,
      });
    } else {
      metrics.investigationsFailed?.inc({ 
        priority: AlertPriority[investigation.alert.priority],
        reason,
      });
    }

    // Try to schedule next investigation
    this.scheduleNext();
  }

  private checkPreemption(): void {
    const nextAlert = this.priorityQueue.peek();
    if (!nextAlert) return;

    // Find the lowest priority running investigation that can be preempted
    let preemptCandidate: RunningInvestigation | null = null;
    
    for (const investigation of this.runningInvestigations.values()) {
      if (investigation.canPreempt && 
          nextAlert.priority < investigation.alert.priority - this.config.preemptionThreshold) {
        if (!preemptCandidate || investigation.alert.priority > preemptCandidate.alert.priority) {
          preemptCandidate = investigation;
        }
      }
    }

    if (preemptCandidate) {
      console.log(`[Scheduler] Preempting investigation ${preemptCandidate.id} (priority ${AlertPriority[preemptCandidate.alert.priority]}) for higher priority alert (priority ${AlertPriority[nextAlert.priority]})`);
      
      this.preemptionCount++;
      
      // Save state for potential resumption
      preemptCandidate.preemptionSaveState = {
        progress: (Date.now() - preemptCandidate.startTime) / preemptCandidate.estimatedDuration,
        partialResults: null, // Would need worker communication to get partial state
      };

      // Complete the preempted investigation
      this.completeInvestigation(preemptCandidate.id, 'preempted');
      
      // Optionally re-queue the preempted alert with adjusted priority
      if (preemptCandidate.alert.priority > AlertPriority.HIGH) {
        const requeue: Omit<QueuedAlert, 'id' | 'enqueuedAt'> = {
          ...preemptCandidate.alert,
          priority: Math.max(AlertPriority.HIGH, preemptCandidate.alert.priority - 1) as AlertPriority,
          priorityScore: preemptCandidate.alert.priorityScore + 1, // Boost score for preempted alert
          estimatedDuration: Math.max(5000, preemptCandidate.estimatedDuration * 0.7), // Reduce estimate since partial work done
        };
        
        this.priorityQueue.enqueue(requeue);
      }
    }
  }

  private activateBurstMode(): void {
    console.log('[Scheduler] Activating burst mode for high-priority alerts');
    this.burstModeActive = true;
    this.burstModeStart = Date.now();
    
    metrics.burstModeActivations?.inc();
  }

  private checkBurstMode(): void {
    if (!this.burstModeActive) return;

    const burstDuration = Date.now() - this.burstModeStart;
    const maxBurstDuration = 10 * 60 * 1000; // 10 minutes

    // Deactivate burst mode if it's been active too long or no high-priority alerts remain
    if (burstDuration > maxBurstDuration || !this.hasHighPriorityAlerts()) {
      console.log('[Scheduler] Deactivating burst mode');
      this.burstModeActive = false;
      this.burstModeStart = 0;
      
      metrics.burstModeDeactivations?.inc();
    }
  }

  private hasHighPriorityAlerts(): boolean {
    const metrics = this.priorityQueue.getMetrics();
    return metrics.byPriority[AlertPriority.CRITICAL] > 0 || 
           metrics.byPriority[AlertPriority.HIGH] > 0;
  }

  private estimateInvestigationDuration(priority: AlertPriority, log: string, reason: string): number {
    // Base duration by priority
    const baseDurations = {
      [AlertPriority.CRITICAL]: 120000, // 2 minutes
      [AlertPriority.HIGH]: 180000,     // 3 minutes
      [AlertPriority.MEDIUM]: 300000,   // 5 minutes
      [AlertPriority.LOW]: 450000,      // 7.5 minutes
    };

    let duration = baseDurations[priority];

    // Adjust based on log complexity
    const logLength = log.length;
    if (logLength > 1000) {
      duration *= 1.5; // Complex logs take longer
    } else if (logLength < 100) {
      duration *= 0.7; // Simple logs are faster
    }

    // Adjust based on historical data
    const relevantCompletions = this.completedInvestigations
      .filter(completion => completion.priority === priority)
      .slice(-10);

    if (relevantCompletions.length > 3) {
      const avgActualTime = relevantCompletions.reduce((sum, completion) => sum + completion.actualTime, 0) / relevantCompletions.length;
      // Blend historical average with base estimate
      duration = duration * 0.3 + avgActualTime * 0.7;
    }

    return Math.max(30000, Math.min(600000, duration)); // 30s to 10min bounds
  }

  private getNextWorker(): Worker {
    const worker = this.workers[this.nextWorkerIndex];
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
    return worker;
  }

  private updateMetrics(): void {
    const queueMetrics = this.priorityQueue.getMetrics();
    
    // Update queue size metrics
    metrics.queueSize?.set(queueMetrics.totalQueued);
    
    // Update priority distribution
    for (const [priority, count] of Object.entries(queueMetrics.byPriority)) {
      metrics.queuePriorityDistribution?.set({ priority: AlertPriority[priority as any] }, count);
    }
    
    // Update running investigations
    metrics.runningInvestigations?.set(this.runningInvestigations.size);
    
    // Update average wait time
    if (queueMetrics.avgWaitTime > 0) {
      metrics.avgWaitTime?.set(queueMetrics.avgWaitTime / 1000); // Convert to seconds
    }
  }
}