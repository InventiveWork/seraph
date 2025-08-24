import { CircuitBreaker, CircuitState, RetryManager, RetryPredicates } from '../circuit-breaker';

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker;

  beforeEach(() => {
    circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      recoveryTimeout: 1000,
      monitoringPeriod: 5000,
      successThreshold: 2,
    });
  });

  it('should start in CLOSED state', () => {
    expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('should execute successful operations', async () => {
    const operation = jest.fn().mockResolvedValue('success');
    const result = await circuitBreaker.execute(operation);
    
    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('should open circuit after threshold failures', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('failure'));
    
    // First 3 failures should open the circuit
    for (let i = 0; i < 3; i++) {
      try {
        await circuitBreaker.execute(operation);
      } catch (error) {
        // Expected
      }
    }
    
    expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
  });

  it('should reject requests when circuit is open', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('failure'));
    
    // Trigger circuit opening
    for (let i = 0; i < 3; i++) {
      try {
        await circuitBreaker.execute(operation);
      } catch (error) {
        // Expected
      }
    }
    
    // Now circuit should be open and reject immediately
    await expect(circuitBreaker.execute(operation)).rejects.toThrow('Circuit breaker is OPEN');
    expect(operation).toHaveBeenCalledTimes(3); // Should not call operation again
  });

  it('should transition to HALF_OPEN after recovery timeout', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('failure'));
    
    // Open the circuit
    for (let i = 0; i < 3; i++) {
      try {
        await circuitBreaker.execute(operation);
      } catch (error) {
        // Expected
      }
    }
    
    expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
    
    // Wait for recovery timeout
    await new Promise(resolve => setTimeout(resolve, 1100));
    
    // Next call should transition to HALF_OPEN, then we need success threshold to close
    const successOperation = jest.fn().mockResolvedValue('success');
    await circuitBreaker.execute(successOperation);
    expect(circuitBreaker.getState()).toBe(CircuitState.HALF_OPEN);
    
    // Need one more success to reach success threshold and close circuit
    await circuitBreaker.execute(successOperation);
    expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('should track metrics correctly', async () => {
    const successOperation = jest.fn().mockResolvedValue('success');
    const failOperation = jest.fn().mockRejectedValue(new Error('failure'));
    
    await circuitBreaker.execute(successOperation);
    
    try {
      await circuitBreaker.execute(failOperation);
    } catch (error) {
      // Expected
    }
    
    const metrics = circuitBreaker.getMetrics();
    expect(metrics.totalRequests).toBe(2);
    expect(metrics.totalSuccesses).toBe(1);
    expect(metrics.totalFailures).toBe(1);
  });

  it('should force open and close', () => {
    circuitBreaker.forceOpen();
    expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
    
    circuitBreaker.forceClose();
    expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
  });
});

describe('RetryManager', () => {
  let retryManager: RetryManager;

  beforeEach(() => {
    retryManager = new RetryManager(3, 100, 1000, false); // No jitter for predictable tests
  });

  it('should execute successful operations without retry', async () => {
    const operation = jest.fn().mockResolvedValue('success');
    const result = await retryManager.executeWithRetry(operation);
    
    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should retry failed operations', async () => {
    const operation = jest.fn()
      .mockRejectedValueOnce(new Error('failure 1'))
      .mockRejectedValueOnce(new Error('failure 2'))
      .mockResolvedValue('success');
    
    const result = await retryManager.executeWithRetry(operation);
    
    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should respect max retry limit', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('failure'));
    
    await expect(retryManager.executeWithRetry(operation)).rejects.toThrow('failure');
    expect(operation).toHaveBeenCalledTimes(4); // Initial + 3 retries
  });

  it('should use retry predicate to determine if retry should happen', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('Auth failed'));
    const predicate = jest.fn().mockReturnValue(false); // Don't retry
    
    await expect(retryManager.executeWithRetry(operation, predicate)).rejects.toThrow('Auth failed');
    expect(operation).toHaveBeenCalledTimes(1); // Should not retry
    expect(predicate).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('RetryPredicates', () => {
  describe('networkErrors', () => {
    it('should return true for network errors', () => {
      const networkError = new Error('ECONNRESET: Connection reset');
      expect(RetryPredicates.networkErrors(networkError)).toBe(true);
    });

    it('should return false for non-network errors', () => {
      const authError = new Error('Unauthorized');
      expect(RetryPredicates.networkErrors(authError)).toBe(false);
    });
  });

  describe('httpRetryableErrors', () => {
    it('should return true for retryable status codes', () => {
      const retryableError = new Error('Request failed with status code 503');
      expect(RetryPredicates.httpRetryableErrors(retryableError)).toBe(true);
    });

    it('should return false for non-retryable status codes', () => {
      const authError = new Error('Request failed with status code 401');
      expect(RetryPredicates.httpRetryableErrors(authError)).toBe(false);
    });
  });

  describe('llmErrors', () => {
    it('should return true for rate limit errors', () => {
      const rateLimitError = new Error('Rate limit exceeded');
      expect(RetryPredicates.llmErrors(rateLimitError)).toBe(true);
    });

    it('should return true for timeout errors', () => {
      const timeoutError = new Error('Request timeout');
      expect(RetryPredicates.llmErrors(timeoutError)).toBe(true);
    });

    it('should return false for auth errors', () => {
      const authError = new Error('Invalid API key');
      expect(RetryPredicates.llmErrors(authError)).toBe(false);
    });
  });
});