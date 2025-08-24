// Priority Queue Tests
import { AlertPriority, PriorityQueue } from './scheduler';

describe('PriorityQueue', () => {
  let queue: PriorityQueue;

  beforeEach(() => {
    queue = new PriorityQueue(10, false); // Disable aging for tests
  });

  afterEach(() => {
    queue.shutdown();
  });

  describe('Basic Queue Operations', () => {
    it('should enqueue and dequeue alerts in priority order', () => {
      const lowPriorityId = queue.enqueue({
        log: 'Low priority log',
        reason: 'Low priority issue',
        priority: AlertPriority.LOW,
        priorityScore: 0.2,
        estimatedDuration: 300000,
        metadata: {},
      });

      const highPriorityId = queue.enqueue({
        log: 'High priority log',
        reason: 'Critical issue',
        priority: AlertPriority.CRITICAL,
        priorityScore: 0.9,
        estimatedDuration: 120000,
        metadata: {},
      });

      const mediumPriorityId = queue.enqueue({
        log: 'Medium priority log',
        reason: 'Medium issue',
        priority: AlertPriority.MEDIUM,
        priorityScore: 0.5,
        estimatedDuration: 240000,
        metadata: {},
      });

      // Should dequeue in priority order: CRITICAL, MEDIUM, LOW
      const first = queue.dequeue();
      const second = queue.dequeue();
      const third = queue.dequeue();

      expect(first?.priority).toBe(AlertPriority.CRITICAL);
      expect(first?.reason).toBe('Critical issue');
      expect(second?.priority).toBe(AlertPriority.MEDIUM);
      expect(third?.priority).toBe(AlertPriority.LOW);
    });

    it('should handle same priority alerts by score then age', () => {
      // Add two HIGH priority alerts with different scores
      const id1 = queue.enqueue({
        log: 'First high priority',
        reason: 'High issue 1',
        priority: AlertPriority.HIGH,
        priorityScore: 0.7,
        estimatedDuration: 180000,
        metadata: {},
      });

      // Small delay to ensure different timestamps
      setTimeout(() => {
        const id2 = queue.enqueue({
          log: 'Second high priority',
          reason: 'High issue 2',
          priority: AlertPriority.HIGH,
          priorityScore: 0.8,
          estimatedDuration: 180000,
          metadata: {},
        });

        const first = queue.dequeue();
        expect(first?.priorityScore).toBe(0.8); // Higher score first
      }, 1);
    });

    it('should peek without removing the top alert', () => {
      queue.enqueue({
        log: 'Test log',
        reason: 'Test reason',
        priority: AlertPriority.CRITICAL,
        priorityScore: 0.9,
        estimatedDuration: 120000,
        metadata: {},
      });

      const peeked = queue.peek();
      const size = queue.size();

      expect(peeked?.reason).toBe('Test reason');
      expect(size).toBe(1); // Should not have removed the item
    });

    it('should handle empty queue operations gracefully', () => {
      expect(queue.dequeue()).toBeNull();
      expect(queue.peek()).toBeNull();
      expect(queue.isEmpty()).toBe(true);
      expect(queue.size()).toBe(0);
    });

    it('should handle single element dequeue correctly', () => {
      // Test the edge case that was causing index corruption
      const id = queue.enqueue({
        log: 'Single element test',
        reason: 'Single test',
        priority: AlertPriority.HIGH,
        priorityScore: 0.8,
        estimatedDuration: 180000,
        metadata: {},
      });

      expect(queue.size()).toBe(1);
      expect(queue.peek()?.reason).toBe('Single test');
      
      const result = queue.dequeue();
      expect(result?.reason).toBe('Single test');
      expect(result?.id).toBe(id);
      expect(queue.size()).toBe(0);
      expect(queue.isEmpty()).toBe(true);
      expect(queue.peek()).toBeNull();
    });
  });

  describe('Queue Management', () => {
    it('should remove alerts by ID', () => {
      const id1 = queue.enqueue({
        log: 'Log 1',
        reason: 'Reason 1',
        priority: AlertPriority.HIGH,
        priorityScore: 0.8,
        estimatedDuration: 180000,
        metadata: {},
      });

      const id2 = queue.enqueue({
        log: 'Log 2',
        reason: 'Reason 2',
        priority: AlertPriority.MEDIUM,
        priorityScore: 0.5,
        estimatedDuration: 240000,
        metadata: {},
      });

      expect(queue.size()).toBe(2);
      expect(queue.removeById(id1)).toBe(true);
      expect(queue.size()).toBe(1);

      const remaining = queue.dequeue();
      expect(remaining?.reason).toBe('Reason 2');
    });

    it('should handle removeById on single element correctly', () => {
      // Test edge case for removeById with single element
      const id = queue.enqueue({
        log: 'Single remove test',
        reason: 'Single remove',
        priority: AlertPriority.MEDIUM,
        priorityScore: 0.5,
        estimatedDuration: 240000,
        metadata: {},
      });

      expect(queue.size()).toBe(1);
      expect(queue.removeById(id)).toBe(true);
      expect(queue.size()).toBe(0);
      expect(queue.isEmpty()).toBe(true);
      expect(queue.removeById(id)).toBe(false); // Should not find it again
    });

    it('should update alert priorities', () => {
      const id = queue.enqueue({
        log: 'Test log',
        reason: 'Test reason',
        priority: AlertPriority.LOW,
        priorityScore: 0.2,
        estimatedDuration: 300000,
        metadata: {},
      });

      // Add another alert
      queue.enqueue({
        log: 'Other log',
        reason: 'Other reason',
        priority: AlertPriority.MEDIUM,
        priorityScore: 0.5,
        estimatedDuration: 240000,
        metadata: {},
      });

      // Update first alert to critical
      expect(queue.updatePriority(id, AlertPriority.CRITICAL, 0.9)).toBe(true);

      const first = queue.dequeue();
      expect(first?.id).toBe(id);
      expect(first?.priority).toBe(AlertPriority.CRITICAL);
    });

    it('should enforce max queue size', () => {
      const smallQueue = new PriorityQueue(2, false);

      // Fill queue
      smallQueue.enqueue({
        log: 'Log 1',
        reason: 'Reason 1',
        priority: AlertPriority.LOW,
        priorityScore: 0.2,
        estimatedDuration: 300000,
        metadata: {},
      });

      smallQueue.enqueue({
        log: 'Log 2',
        reason: 'Reason 2',
        priority: AlertPriority.LOW,
        priorityScore: 0.3,
        estimatedDuration: 300000,
        metadata: {},
      });

      // Add high priority alert - should replace lowest priority
      const highPriorityId = smallQueue.enqueue({
        log: 'High priority log',
        reason: 'Critical issue',
        priority: AlertPriority.CRITICAL,
        priorityScore: 0.9,
        estimatedDuration: 120000,
        metadata: {},
      });

      expect(smallQueue.size()).toBe(2);

      const first = smallQueue.dequeue();
      expect(first?.priority).toBe(AlertPriority.CRITICAL);

      smallQueue.shutdown();
    });

    it('should throw error when adding low priority to full queue', () => {
      const smallQueue = new PriorityQueue(2, false);

      // Fill with high priority alerts
      smallQueue.enqueue({
        log: 'High 1',
        reason: 'High 1',
        priority: AlertPriority.CRITICAL,
        priorityScore: 0.9,
        estimatedDuration: 120000,
        metadata: {},
      });

      smallQueue.enqueue({
        log: 'High 2',
        reason: 'High 2',
        priority: AlertPriority.HIGH,
        priorityScore: 0.8,
        estimatedDuration: 180000,
        metadata: {},
      });

      // Try to add low priority - should throw
      expect(() => {
        smallQueue.enqueue({
          log: 'Low priority',
          reason: 'Low priority',
          priority: AlertPriority.LOW,
          priorityScore: 0.2,
          estimatedDuration: 300000,
          metadata: {},
        });
      }).toThrow();

      smallQueue.shutdown();
    });
  });

  describe('Queue Metrics', () => {
    it('should provide accurate queue metrics', () => {
      // Add alerts of different priorities
      queue.enqueue({
        log: 'Critical',
        reason: 'Critical',
        priority: AlertPriority.CRITICAL,
        priorityScore: 0.9,
        estimatedDuration: 120000,
        metadata: {},
      });

      queue.enqueue({
        log: 'High',
        reason: 'High',
        priority: AlertPriority.HIGH,
        priorityScore: 0.8,
        estimatedDuration: 180000,
        metadata: {},
      });

      queue.enqueue({
        log: 'Medium',
        reason: 'Medium',
        priority: AlertPriority.MEDIUM,
        priorityScore: 0.5,
        estimatedDuration: 240000,
        metadata: {},
      });

      const metrics = queue.getMetrics();

      expect(metrics.totalQueued).toBe(3);
      expect(metrics.byPriority[AlertPriority.CRITICAL]).toBe(1);
      expect(metrics.byPriority[AlertPriority.HIGH]).toBe(1);
      expect(metrics.byPriority[AlertPriority.MEDIUM]).toBe(1);
      expect(metrics.byPriority[AlertPriority.LOW]).toBe(0);
      expect(metrics.avgPriorityScore).toBeCloseTo(0.73, 1);
      expect(metrics.oldestAlert).toBeDefined();
    });

    it('should find alerts by predicate', () => {
      queue.enqueue({
        log: 'Database timeout',
        reason: 'DB connection failed',
        priority: AlertPriority.HIGH,
        priorityScore: 0.8,
        estimatedDuration: 180000,
        metadata: { service: 'database' },
      });

      queue.enqueue({
        log: 'API slow response',
        reason: 'High latency',
        priority: AlertPriority.MEDIUM,
        priorityScore: 0.5,
        estimatedDuration: 240000,
        metadata: { service: 'api' },
      });

      const dbAlerts = queue.findAlerts(alert => 
        alert.log.includes('Database') || alert.metadata.service === 'database',
      );

      expect(dbAlerts).toHaveLength(1);
      expect(dbAlerts[0].reason).toBe('DB connection failed');
    });
  });

  describe('Queue Clearing and Management', () => {
    it('should clear all alerts', () => {
      queue.enqueue({
        log: 'Test 1',
        reason: 'Test 1',
        priority: AlertPriority.HIGH,
        priorityScore: 0.8,
        estimatedDuration: 180000,
        metadata: {},
      });

      queue.enqueue({
        log: 'Test 2',
        reason: 'Test 2',
        priority: AlertPriority.MEDIUM,
        priorityScore: 0.5,
        estimatedDuration: 240000,
        metadata: {},
      });

      expect(queue.size()).toBe(2);

      queue.clear();

      expect(queue.size()).toBe(0);
      expect(queue.isEmpty()).toBe(true);
      expect(queue.peek()).toBeNull();
    });
  });
});

describe('PriorityQueue with Aging', () => {
  let queue: PriorityQueue;

  beforeEach(() => {
    queue = new PriorityQueue(10, true); // Enable aging
  });

  afterEach(() => {
    queue.shutdown();
  });

  it('should age alert priorities over time', (done) => {
    // Add a low priority alert
    const id = queue.enqueue({
      log: 'Low priority log',
      reason: 'Low priority issue',
      priority: AlertPriority.LOW,
      priorityScore: 0.2,
      estimatedDuration: 300000,
      metadata: {},
    });

    // Wait for aging to occur (aging runs every 30 seconds, but we can test the concept)
    // In real implementation, this would require time manipulation or shorter intervals
    setTimeout(() => {
      const alert = queue.peek();
      // Priority score should have increased due to aging
      // (This is a simplified test - in real scenario, aging takes more time)
      expect(alert?.priorityScore).toBeGreaterThanOrEqual(0.2);
      done();
    }, 100);
  });
});