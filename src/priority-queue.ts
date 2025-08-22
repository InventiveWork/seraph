// Priority Queue Implementation for Intelligent Alert Scheduling
import { v4 as uuidv4 } from 'uuid';

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
    
    const result = this.heap[0];
    const lastElement = this.heap.pop()!;
    
    this.alertIndex.delete(result.id);
    
    if (this.heap.length > 0) {
      this.heap[0] = lastElement;
      this.alertIndex.set(lastElement.id, 0);
      this.bubbleDown(0);
    }
    
    return result;
  }

  /**
   * Peek at highest priority alert without removing
   */
  peek(): QueuedAlert | null {
    return this.heap.length > 0 ? this.heap[0] : null;
  }

  /**
   * Remove specific alert by ID (for preemption/cancellation)
   */
  removeById(alertId: string): boolean {
    const index = this.alertIndex.get(alertId);
    if (index === undefined) return false;

    const lastElement = this.heap.pop()!;
    this.alertIndex.delete(alertId);

    if (index < this.heap.length) {
      this.heap[index] = lastElement;
      this.alertIndex.set(lastElement.id, index);
      
      // Restore heap property
      this.bubbleUp(index);
      this.bubbleDown(index);
    }

    return true;
  }

  /**
   * Update priority of existing alert
   */
  updatePriority(alertId: string, newPriority: AlertPriority, newScore: number): boolean {
    const index = this.alertIndex.get(alertId);
    if (index === undefined) return false;

    const oldPriority = this.heap[index].priority;
    this.heap[index].priority = newPriority;
    this.heap[index].priorityScore = newScore;

    // Restore heap property
    if (newPriority < oldPriority) {
      this.bubbleUp(index);
    } else if (newPriority > oldPriority) {
      this.bubbleDown(index);
    }

    return true;
  }

  /**
   * Get queue metrics for monitoring
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

    this.heap.forEach(alert => {
      byPriority[alert.priority]++;
      totalWaitTime += (now - alert.enqueuedAt);
      totalPriorityScore += alert.priorityScore;
      
      if (!oldestAlert || alert.enqueuedAt < oldestAlert) {
        oldestAlert = alert.enqueuedAt;
      }
    });

    return {
      totalQueued: this.heap.length,
      byPriority,
      avgWaitTime: this.heap.length > 0 ? totalWaitTime / this.heap.length : 0,
      avgPriorityScore: this.heap.length > 0 ? totalPriorityScore / this.heap.length : 0,
      oldestAlert,
    };
  }

  /**
   * Get all alerts matching a condition (for debugging/monitoring)
   */
  findAlerts(predicate: (alert: QueuedAlert) => boolean): QueuedAlert[] {
    return this.heap.filter(predicate);
  }

  /**
   * Clear all alerts
   */
  clear(): void {
    this.heap = [];
    this.alertIndex.clear();
  }

  /**
   * Get current queue size
   */
  size(): number {
    return this.heap.length;
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /**
   * Cleanup when shutting down
   */
  shutdown(): void {
    if (this.agingInterval) {
      clearInterval(this.agingInterval);
      this.agingInterval = null;
    }
  }

  // Private helper methods

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      
      if (this.compareAlerts(this.heap[index], this.heap[parentIndex]) >= 0) {
        break;
      }
      
      this.swap(index, parentIndex);
      index = parentIndex;
    }
  }

  private bubbleDown(index: number): void {
    const length = this.heap.length;
    
    while (true) {
      let smallest = index;
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      
      if (leftChild < length && this.compareAlerts(this.heap[leftChild], this.heap[smallest]) < 0) {
        smallest = leftChild;
      }
      
      if (rightChild < length && this.compareAlerts(this.heap[rightChild], this.heap[smallest]) < 0) {
        smallest = rightChild;
      }
      
      if (smallest === index) break;
      
      this.swap(index, smallest);
      index = smallest;
    }
  }

  private swap(i: number, j: number): void {
    [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
    
    // Update index mapping
    this.alertIndex.set(this.heap[i].id, i);
    this.alertIndex.set(this.heap[j].id, j);
  }

  /**
   * Compare alerts for priority ordering
   * Returns < 0 if a has higher priority than b
   */
  private compareAlerts(a: QueuedAlert, b: QueuedAlert): number {
    // Primary: Priority level (lower number = higher priority)
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    
    // Secondary: Priority score (higher score = higher priority)
    if (Math.abs(a.priorityScore - b.priorityScore) > 0.01) {
      return b.priorityScore - a.priorityScore;
    }
    
    // Tertiary: Age (older alerts get slight priority boost)
    return a.enqueuedAt - b.enqueuedAt;
  }

  private findLowestPriorityAlert(): QueuedAlert | null {
    if (this.heap.length === 0) return null;
    
    let lowest = this.heap[0];
    for (let i = 1; i < this.heap.length; i++) {
      if (this.compareAlerts(this.heap[i], lowest) > 0) {
        lowest = this.heap[i];
      }
    }
    return lowest;
  }

  /**
   * Age priorities to prevent starvation
   * Gradually increases priority scores of waiting alerts
   */
  private agePriorities(): void {
    const now = Date.now();
    const AGING_RATE = 0.1; // Increase score by 0.1 per minute of waiting
    let changed = false;

    for (let i = 0; i < this.heap.length; i++) {
      const alert = this.heap[i];
      const waitingMinutes = (now - alert.enqueuedAt) / (60 * 1000);
      const ageBoost = waitingMinutes * AGING_RATE;
      
      if (ageBoost > 0.1) { // Only update if significant boost
        alert.priorityScore += ageBoost;
        changed = true;
      }
    }

    // Rebuild heap if priorities changed significantly
    if (changed) {
      this.rebuildHeap();
    }
  }

  private rebuildHeap(): void {
    // Rebuild index mapping
    this.alertIndex.clear();
    this.heap.forEach((alert, index) => {
      this.alertIndex.set(alert.id, index);
    });

    // Heapify from bottom up
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
      this.bubbleDown(i);
    }
  }
}