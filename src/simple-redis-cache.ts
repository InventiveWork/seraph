// Simple Redis-based LLM Cache with Embedding Similarity
// Follows AI agent caching best practices
import Redis from 'ioredis';
import * as crypto from 'crypto';
import { LLMResponse } from './llm/provider';
import { metrics } from './metrics';

export interface CacheEntry {
  response: LLMResponse;
  embedding: number[];
  tokens: number;
  timestamp: number;
  hits: number;
  // Vector search metadata
  metadata?: {
    podName?: string;
    namespace?: string;
    serviceName?: string;
    errorType?: string;
    logLevel?: string;
    containerId?: string;
  };
}

export interface SimpleCacheConfig {
  redis?: {
    url?: string;
    host?: string;
    port?: number;
    password?: string;
    keyPrefix?: string;
  };
  similarityThreshold?: number;
  ttlSeconds?: number;
  embeddingDim?: number;
  verbose?: boolean;
}

export class SimpleRedisCache {
  protected redis: Redis | null = null;
  protected config: SimpleCacheConfig;
  protected isConnected = false;
  private initPromise: Promise<void> | null = null;
  
  constructor(config: SimpleCacheConfig = {}) {
    this.config = {
      similarityThreshold: 0.85,
      ttlSeconds: 3600, // 1 hour
      embeddingDim: 384, // sentence-transformer dimension
      verbose: false, // Default to false for logging
      ...config,
    };
    
    // Disable verbose logging during tests to prevent Jest cleanup issues
    if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined) {
      this.config.verbose = false;
    }
    
    if (config.redis) {
      // Store the promise so we can await it later
      this.initPromise = this.initRedis();
    }
  }

  // Public method to ensure initialization is complete
  async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  // Wait for Redis to be ready with startup coordination and retries
  // This should be called at application startup when Redis caching is enabled
  async waitForRedisReady(options: {
    enabled: boolean;          // Whether Redis caching is enabled  
    maxRetries?: number;       // Max retry attempts (default: 30)
    retryDelayMs?: number;     // Delay between retries (default: 1000ms)
    timeoutMs?: number;        // Overall timeout (default: 60000ms)
  }): Promise<boolean> {
    if (!options.enabled || !this.config.redis) {
      if (this.config.verbose) {
        console.log('[SimpleRedisCache] Redis caching not enabled, skipping wait');
      }
      return false; // Redis not expected to be available
    }

    const maxRetries = options.maxRetries ?? 30;
    const retryDelayMs = options.retryDelayMs ?? 1000;
    const timeoutMs = options.timeoutMs ?? 60000;
    const startTime = Date.now();

    if (this.config.verbose) {
      console.log(`[SimpleRedisCache] Waiting for Redis to be ready (max ${maxRetries} retries, ${timeoutMs}ms timeout)`);
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Check overall timeout
      if (Date.now() - startTime > timeoutMs) {
        if (this.config.verbose) {
          console.error(`[SimpleRedisCache] Timeout waiting for Redis after ${timeoutMs}ms`);
        }
        break;
      }

      try {
        // Ensure initialization attempt
        if (this.initPromise) {
          await this.initPromise;
        }

        // Test Redis connectivity with a simple ping
        if (this.redis && this.isConnected) {
          await this.redis.ping();
          if (this.config.verbose) {
            console.log(`[SimpleRedisCache] Redis is ready! (attempt ${attempt}/${maxRetries})`);
          }
          return true;
        } else {
          // Try to reinitialize Redis connection
          this.initPromise = this.initRedis();
          await this.initPromise;
          
          if (this.redis && this.isConnected) {
            await this.redis.ping();
            if (this.config.verbose) {
              console.log(`[SimpleRedisCache] Redis is ready! (attempt ${attempt}/${maxRetries})`);
            }
            return true;
          }
        }
      } catch (error) {
        if (this.config.verbose) {
          console.log(`[SimpleRedisCache] Redis not ready yet (attempt ${attempt}/${maxRetries}): ${error instanceof Error ? error.message : error}`);
        }
      }

      // Wait before next retry (but not after the last attempt)
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }

    if (this.config.verbose) {
      console.error('[SimpleRedisCache] Failed to connect to Redis after all retries. Cache will be disabled.');
    }
    return false;
  }

  private async initRedis(): Promise<void> {
    try {
      const redisConfig = this.config.redis!;
      
      if (this.config.verbose) {
        console.log('[SimpleRedisCache] Attempting Redis connection to:', {
          host: redisConfig.host ?? 'localhost',
          port: redisConfig.port ?? 6379,
          hasPassword: !!redisConfig.password,
          keyPrefix: redisConfig.keyPrefix,
        });
      }
      
      if (redisConfig.url) {
        this.redis = new Redis(redisConfig.url);
      } else {
        this.redis = new Redis({
          host: redisConfig.host ?? 'localhost',
          port: redisConfig.port ?? 6379,
          password: redisConfig.password,
          lazyConnect: true,
          maxRetriesPerRequest: this.config.verbose === false ? 0 : 2, // No retries when not verbose (e.g., tests)
          connectTimeout: this.config.verbose === false ? 1000 : 10000, // Faster timeout when not verbose
          commandTimeout: this.config.verbose === false ? 1000 : 5000,
          retryStrategy: (times) => {
            if (times > (this.config.verbose === false ? 1 : 3)) {
              if (this.config.verbose) {
                console.error('[SimpleRedisCache] Max Redis connection retries reached');
              }
              return null;
            }
            return Math.min(times * 100, 2000);
          },
        });
      }

      await this.redis.connect();
      this.isConnected = true;
      metrics.llmCacheRedisConnected?.set(1);
      if (this.config.verbose) {
        console.log('[SimpleRedisCache] Successfully connected to Redis');
      }
      
      this.redis.on('error', (err) => {
        if (this.config.verbose) {
          console.error('[SimpleRedisCache] Redis error:', err.message);
        }
        this.isConnected = false;
        metrics.llmCacheRedisConnected?.set(0);
      });
      
      this.redis.on('connect', () => {
        if (this.config.verbose) {
          console.log('[SimpleRedisCache] Redis reconnected');
        }
        this.isConnected = true;
        metrics.llmCacheRedisConnected?.set(1);
      });
      
    } catch (error) {
      if (this.config.verbose) {
        console.error('[SimpleRedisCache] Redis connection failed:', error instanceof Error ? error.message : error);
        console.error('[SimpleRedisCache] Cache will be disabled for this session');
      }
      this.redis = null;
      this.isConnected = false;
      metrics.llmCacheRedisConnected?.set(0);
    }
  }

  // Advanced vector embedding with structured metadata and semantic features
  protected createEmbedding(text: string, context?: any): number[] {
    const dim = this.config.embeddingDim!;
    const embedding = new Array(dim).fill(0);
    
    // Extract structured metadata from log
    const metadata = this.extractLogMetadata(text);
    
    // Create multi-dimensional feature space
    const features = this.createFeatureVector(text, metadata, context);
    
    // Map features to embedding space using semantic hashing
    for (const [feature, weight] of Object.entries(features)) {
      const hash = this.simpleHash(feature) % dim;
      embedding[hash] += weight;
    }
    
    // Normalize vector for cosine similarity
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    return magnitude > 0 ? embedding.map(val => val / magnitude) : embedding;
  }

  // Extract structured metadata from Fluent Bit logs
  private extractLogMetadata(text: string): Record<string, any> {
    const metadata: Record<string, any> = {};
    
    try {
      // Parse JSON logs from Fluent Bit
      if (text.includes('{"') && text.includes('MESSAGE')) {
        const jsonMatch = text.match(/\{.*\}$/);
        if (jsonMatch) {
          const logData = JSON.parse(jsonMatch[0]);
          metadata.message = (logData.MESSAGE as string) ?? '';
          metadata.hostname = (logData._HOSTNAME as string) ?? '';
          metadata.syslogId = (logData.SYSLOG_IDENTIFIER as string) ?? '';
          
          // Extract pod info from MESSAGE field
          const message = metadata.message;
          if (message) {
            metadata.podName = this.extractPodName(message);
            metadata.namespace = this.extractNamespace(message) ?? 'default';
            metadata.errorType = this.extractErrorType(message);
            metadata.logLevel = this.extractLogLevel(message);
          }
        }
      }
    } catch {
      // Fall back to regex extraction for non-JSON logs
      metadata.podName = this.extractPodName(text);
      metadata.namespace = this.extractNamespace(text) ?? 'default';
      metadata.errorType = this.extractErrorType(text);
      metadata.logLevel = this.extractLogLevel(text);
    }
    
    return metadata;
  }

  // Create weighted feature vector for semantic differentiation
  private createFeatureVector(
    text: string, 
    metadata: Record<string, any>, 
    _context?: Record<string, any>,
  ): Record<string, number> {
    const features: Record<string, number> = {};
    
    // High-weight identity features (most important for differentiation)
    if (metadata.podName) {
      features[`pod:${metadata.podName}`] = 10.0;  // Very high weight
      features[`identity:${metadata.podName}:${metadata.namespace}`] = 8.0;
    }
    
    // Medium-weight contextual features
    if (metadata.namespace && metadata.namespace !== 'default') {
      features[`ns:${metadata.namespace}`] = 5.0;
    }
    
    if (metadata.errorType) {
      features[`error:${metadata.errorType}`] = 4.0;
    }
    
    if (metadata.logLevel) {
      features[`level:${metadata.logLevel}`] = 2.0;
    }
    
    // Low-weight content features (for actual similarity detection)
    const normalizedText = text.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const keywords = this.extractKeywords(normalizedText);
    
    for (const keyword of keywords) {
      features[`content:${keyword}`] = 1.0;
    }
    
    // Error type clustering
    if (text.includes('CrashLoopBackOff')) {
      features['error_pattern:crashloop'] = 3.0;
    }
    if (text.includes('ImagePullBackOff')) {
      features['error_pattern:imagepull'] = 3.0;
    }
    if (text.includes('OOMKilled')) {
      features['error_pattern:oom'] = 3.0;
    }
    
    return features;
  }

  // Extract error type from log message
  protected extractErrorType(text: string): string | null {
    const errorPatterns = [
      { pattern: /CrashLoopBackOff/i, type: 'crashloop' },
      { pattern: /ImagePullBackOff/i, type: 'imagepull' },
      { pattern: /ErrImagePull/i, type: 'imagepull' },
      { pattern: /OOMKilled/i, type: 'oom' },
      { pattern: /Failed to start container/i, type: 'container_start' },
      { pattern: /Error syncing pod/i, type: 'pod_sync' },
      { pattern: /connection refused/i, type: 'connection' },
      { pattern: /timeout/i, type: 'timeout' },
    ];
    
    for (const { pattern, type } of errorPatterns) {
      if (pattern.test(text)) {
        return type;
      }
    }
    
    return null;
  }

  // Extract log level
  private extractLogLevel(text: string): string | null {
    const levelPatterns = [
      { pattern: /\bE\d{4}/i, level: 'error' },
      { pattern: /\bW\d{4}/i, level: 'warning' },
      { pattern: /\bI\d{4}/i, level: 'info' },
      { pattern: /ERROR/i, level: 'error' },
      { pattern: /WARN/i, level: 'warning' },
      { pattern: /INFO/i, level: 'info' },
    ];
    
    for (const { pattern, level } of levelPatterns) {
      if (pattern.test(text)) {
        return level;
      }
    }
    
    return null;
  }

  // Extract meaningful keywords for content similarity
  private extractKeywords(text: string): string[] {
    const stopWords = new Set(['the', 'is', 'at', 'which', 'on', 'a', 'an', 'as', 'are', 'was', 'were', 'for', 'in', 'to', 'of', 'and', 'or']);
    const words = text.split(/\s+/).filter(word => 
      word.length > 2 && 
      !stopWords.has(word) && 
      !/^\d+$/.test(word), // Filter out pure numbers
    );
    
    return [...new Set(words)].slice(0, 10); // Top 10 unique keywords
  }

  // Extract pod name from log text or error message
  private extractPodName(text: string): string | null {
    // Match patterns like: pod="default/chaos-intermittent" or pod="pod-name" or "chaos-intermittent"
    const patterns = [
      /pod\s*=\s*"[^"]*\/([^"\/]+)"/i,         // pod="namespace/pod-name"
      /pod\s*=\s*"([^"\/]+)"/i,                 // pod="pod-name"
      /pod["\s]*[=/]\s*["\s]*([a-z0-9-]+)/i, // pod="pod-name" or pod/pod-name
      /"StartContainer.*for.*"([a-z0-9-]+)"/i, // "StartContainer" for "pod-name"
      /container=([a-z0-9-]+)/i,               // container=pod-name
      /"([a-z0-9]+-[a-z0-9]+-[a-z0-9]+[a-z0-9-]*)"/i, // Kubernetes pod name pattern
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1] && match[1].length > 3) { // Avoid false matches like single letters
        return match[1];
      }
    }
    return null;
  }

  // Extract namespace from log text
  private extractNamespace(text: string): string | null {
    const patterns = [
      /pod\s*=\s*"([^"\/]+)\/[^"]*"/i,         // pod="namespace/pod-name"
      /namespace["\s]*[=/]\s*["\s]*([a-z0-9-]+)/i,
      /namespace["\s]+([a-z0-9-]+)/i,
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }
    return null;
  }

  // Extract service name from log text
  private extractServiceName(text: string): string | null {
    const patterns = [
      /service["\s]*[=/]\s*["\s]*([a-z0-9-]+)/i,
      /service["\s]+([a-z0-9-]+)/i,
      /([a-z0-9-]+)(?:-service|-svc)/i,
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }
    return null;
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  // Classify error type for semantic grouping
  private classifyErrorType(text: string): string {
    const lowerText = text.toLowerCase();
    
    // Network errors
    if (/connection|network|timeout|refused|unreachable|dns/.test(lowerText)) {
      return 'network';
    }
    
    // Resource errors
    if (/memory|oom|disk|space|cpu|resource|limit/.test(lowerText)) {
      return 'resource';
    }
    
    // Application errors
    if (/crash|panic|segfault|exception|error/.test(lowerText)) {
      return 'application';
    }
    
    // Kubernetes specific
    if (/pod|container|image|pull|crashloop|backoff/.test(lowerText)) {
      return 'kubernetes';
    }
    
    // Authentication/Authorization
    if (/auth|permission|forbidden|unauthorized|token/.test(lowerText)) {
      return 'auth';
    }
    
    return 'general';
  }

  protected cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {return 0;}
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    if (normA === 0 || normB === 0) {return 0;}
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private generateKey(text: string): string {
    const prefix = this.config.redis?.keyPrefix ?? 'llm:';
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    return `${prefix}${hash}`;
  }

  async get(prompt: string, _estimatedTokens = 100, context?: Record<string, any>): Promise<LLMResponse | null> {
    if (!this.redis || !this.isConnected) {
      return null;
    }

    try {
      const embedding = this.createEmbedding(prompt, context);
      
      // First try exact match
      const exactKey = this.generateKey(prompt);
      const exactMatch = await this.redis.get(exactKey);
      
      if (exactMatch) {
        const entry: CacheEntry = JSON.parse(exactMatch);
        await this.updateHitCount(exactKey, entry);
        metrics.llmCacheHits?.inc();
        metrics.llmTokensSaved?.inc(entry.tokens);
        return entry.response;
      }
      
      // Then try similarity search on recent entries using SCAN instead of KEYS
      // SCAN is non-blocking and production-safe
      const pattern = `${this.config.redis?.keyPrefix ?? 'llm:'}*`;
      let bestMatch: { entry: CacheEntry; key: string } | null = null;
      let bestSimilarity = 0;
      let cursor = '0';
      let scannedCount = 0;
      const maxScanCount = 100; // Limit scan results for performance
      
      do {
        const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 10);
        cursor = result[0];
        const keys = result[1];
        
        for (const key of keys) {
          if (scannedCount >= maxScanCount) { break; }
          
          const data = await this.redis.get(key);
          if (!data) { continue; }
          
          try {
            const entry: CacheEntry = JSON.parse(data);
            const similarity = this.cosineSimilarity(embedding, entry.embedding);
            
            if (similarity >= this.config.similarityThreshold! && similarity > bestSimilarity) {
              bestSimilarity = similarity;
              bestMatch = { entry, key };
            }
          } catch {
            // Skip malformed entries
          }
          
          scannedCount++;
        }
        
        if (scannedCount >= maxScanCount) { break; }
      } while (cursor !== '0');
      
      if (bestMatch) {
        await this.updateHitCount(bestMatch.key, bestMatch.entry);
        metrics.llmCacheHits?.inc();
        metrics.llmTokensSaved?.inc(bestMatch.entry.tokens);
        if (this.config.verbose) {
          console.log(`[SimpleRedisCache] Similarity hit: ${bestSimilarity.toFixed(3)}`);
        }
        return bestMatch.entry.response;
      }
      
      metrics.llmCacheMisses?.inc();
      return null;
      
    } catch (error) {
      if (this.config.verbose) {
        console.warn('[SimpleRedisCache] Get error:', error);
      }
      metrics.llmCacheRedisErrors?.inc();
      return null;
    }
  }

  async set(prompt: string, response: LLMResponse, tokens: number, context?: Record<string, any>): Promise<void> {
    if (!this.redis || !this.isConnected) {
      return;
    }

    try {
      const embedding = this.createEmbedding(prompt, context);
      const key = this.generateKey(prompt);
      
      const entry: CacheEntry = {
        response,
        embedding,
        tokens,
        timestamp: Date.now(),
        hits: 0,
        metadata: this.extractLogMetadata(prompt),
      };
      
      await this.redis.setex(key, this.config.ttlSeconds ?? 3600, JSON.stringify(entry));
      metrics.llmCacheRedisWrites?.inc();
      
    } catch (error) {
      if (this.config.verbose) {
        console.warn('[SimpleRedisCache] Set error:', error);
      }
      metrics.llmCacheRedisErrors?.inc();
    }
  }

  private async updateHitCount(key: string, entry: CacheEntry): Promise<void> {
    try {
      entry.hits++;
      if (this.redis) {
        await this.redis.setex(key, this.config.ttlSeconds ?? 3600, JSON.stringify(entry));
      }
    } catch {
      // Ignore hit count update errors
    }
  }

  async getStats(): Promise<any> {
    if (!this.redis || !this.isConnected) {
      return { connected: false, size: 0 };
    }

    try {
      const pattern = `${this.config.redis?.keyPrefix ?? 'llm:'}*`;
      const keys = await this.redis.keys(pattern);
      
      let totalHits = 0;
      let totalTokens = 0;
      
      // Sample a few entries for stats
      const sampleSize = Math.min(keys.length, 20);
      for (let i = 0; i < sampleSize; i++) {
        const data = await this.redis.get(keys[i]);
        if (data) {
          try {
            const entry: CacheEntry = JSON.parse(data);
            totalHits += entry.hits;
            totalTokens += entry.tokens;
          } catch {
            // Skip malformed entries
          }
        }
      }
      
      return {
        connected: true,
        size: keys.length,
        avgHitsPerEntry: sampleSize > 0 ? totalHits / sampleSize : 0,
        avgTokensPerEntry: sampleSize > 0 ? totalTokens / sampleSize : 0,
        config: this.config,
      };
      
    } catch {
      return { connected: false, size: 0 };
    }
  }

  async close(): Promise<void> {
    if (this.redis) {
      try {
        // First disconnect to stop any pending operations
        this.redis.disconnect();
        // Then quit to properly close
        await this.redis.quit();
      } catch {
        // Force disconnect if quit fails
        this.redis.disconnect();
      } finally {
        this.redis = null;
        this.isConnected = false;
        metrics.llmCacheRedisConnected?.set(0);
      }
    }
  }

  isHealthy(): boolean {
    return this.isConnected;
  }

  async cleanup(): Promise<void> {
    if (!this.redis || !this.isConnected) {return;}

    try {
      // Remove expired entries (Redis handles this automatically with TTL)
      // But we can clean up entries with 0 hits that are old
      const pattern = `${this.config.redis?.keyPrefix ?? 'llm:'}*`;
      const keys = await this.redis.keys(pattern);
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours
      
      for (const key of keys) {
        const data = await this.redis.get(key);
        if (data) {
          try {
            const entry: CacheEntry = JSON.parse(data);
            if (entry.hits === 0 && (now - entry.timestamp) > maxAge) {
              await this.redis.del(key);
            }
          } catch {
            // Delete malformed entries
            await this.redis.del(key);
          }
        }
      }
    } catch (error) {
      if (this.config.verbose) {
        console.warn('[SimpleRedisCache] Cleanup error:', error);
      }
    }
  }

}