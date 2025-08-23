export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

export interface CircuitBreakerOptions {
  failureThreshold: number; // Number of failures before opening
  recoveryTimeout: number; // Time in ms before attempting recovery
  monitoringPeriod: number; // Time window for monitoring failures
  successThreshold: number; // Number of successes needed to close circuit
}

export interface CircuitBreakerMetrics {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  totalRequests: number;
  totalFailures: number;
  totalSuccesses: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private totalRequests = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private failureWindow: number[] = [];
  
  constructor(private options: CircuitBreakerOptions) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (this.shouldAttemptReset()) {
        this.state = CircuitState.HALF_OPEN;
        this.successes = 0;
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    this.totalRequests++;

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.successes++;
    this.totalSuccesses++;
    this.lastSuccessTime = Date.now();
    
    if (this.state === CircuitState.HALF_OPEN) {
      if (this.successes >= this.options.successThreshold) {
        this.reset();
      }
    } else if (this.state === CircuitState.CLOSED) {
      // Reset failure count on success
      this.failures = 0;
      this.failureWindow = [];
    }
  }

  private onFailure(): void {
    this.failures++;
    this.totalFailures++;
    this.lastFailureTime = Date.now();
    this.failureWindow.push(Date.now());
    
    // Clean old failures outside monitoring period
    const cutoff = Date.now() - this.options.monitoringPeriod;
    this.failureWindow = this.failureWindow.filter(time => time > cutoff);
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.OPEN;
    } else if (this.state === CircuitState.CLOSED) {
      if (this.failureWindow.length >= this.options.failureThreshold) {
        this.state = CircuitState.OPEN;
      }
    }
  }

  private shouldAttemptReset(): boolean {
    return this.lastFailureTime !== null && 
           Date.now() - this.lastFailureTime >= this.options.recoveryTimeout;
  }

  private reset(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.failureWindow = [];
  }

  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
    };
  }

  getState(): CircuitState {
    return this.state;
  }

  forceOpen(): void {
    this.state = CircuitState.OPEN;
  }

  forceClose(): void {
    this.reset();
  }
}

export class RetryManager {
  constructor(
    private maxRetries: number = 3,
    private baseDelay: number = 1000,
    private maxDelay: number = 30000,
    private jitter: boolean = true,
  ) {}

  async executeWithRetry<T>(
    operation: () => Promise<T>,
    retryPredicate: (error: Error) => boolean = () => true,
  ): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        
        if (attempt === this.maxRetries || !retryPredicate(lastError)) {
          throw lastError;
        }
        
        const delay = this.calculateDelay(attempt);
        await this.sleep(delay);
      }
    }
    
    throw lastError!;
  }

  private calculateDelay(attempt: number): number {
    // Exponential backoff with jitter
    let delay = Math.min(this.baseDelay * Math.pow(2, attempt), this.maxDelay);
    
    if (this.jitter) {
      // Add random jitter to prevent thundering herd
      delay = delay * (0.5 + Math.random() * 0.5);
    }
    
    return Math.floor(delay);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Predefined retry predicates for common scenarios
export const RetryPredicates = {
  networkErrors: (error: Error): boolean => {
    const networkErrorCodes = ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'];
    return networkErrorCodes.some(code => error.message.includes(code));
  },
  
  httpRetryableErrors: (error: Error): boolean => {
    // Retry on 5xx errors and some 4xx errors
    const retryableStatusCodes = [408, 429, 500, 502, 503, 504];
    const statusCodeMatch = error.message.match(/status code (\d+)/);
    if (statusCodeMatch) {
      const statusCode = parseInt(statusCodeMatch[1], 10);
      return retryableStatusCodes.includes(statusCode);
    }
    return false;
  },
  
  llmErrors: (error: Error): boolean => {
    // Retry on rate limiting and temporary errors, but not on auth errors
    const message = error.message.toLowerCase();
    return message.includes('rate limit') || 
           message.includes('timeout') || 
           message.includes('temporarily unavailable') ||
           message.includes('overloaded');
  },
};