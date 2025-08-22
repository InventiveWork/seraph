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
      ...config
    };
    
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

  private async initRedis(): Promise<void> {
    try {
      const redisConfig = this.config.redis!;
      
      console.log('[SimpleRedisCache] Attempting Redis connection to:', {
        host: redisConfig.host || 'localhost',
        port: redisConfig.port || 6379,
        hasPassword: !!redisConfig.password,
        keyPrefix: redisConfig.keyPrefix
      });
      
      if (redisConfig.url) {
        this.redis = new Redis(redisConfig.url);
      } else {
        this.redis = new Redis({
          host: redisConfig.host || 'localhost',
          port: redisConfig.port || 6379,
          password: redisConfig.password,
          lazyConnect: true,
          maxRetriesPerRequest: 2,
          retryStrategy: (times) => {
            if (times > 3) {
              console.error('[SimpleRedisCache] Max Redis connection retries reached');
              return null;
            }
            return Math.min(times * 100, 2000);
          }
        });
      }

      await this.redis.connect();
      this.isConnected = true;
      metrics.llmCacheRedisConnected?.set(1);
      console.log('[SimpleRedisCache] Successfully connected to Redis');
      
      this.redis.on('error', (err) => {
        console.error('[SimpleRedisCache] Redis error:', err.message);
        this.isConnected = false;
        metrics.llmCacheRedisConnected?.set(0);
      });
      
      this.redis.on('connect', () => {
        console.log('[SimpleRedisCache] Redis reconnected');
        this.isConnected = true;
        metrics.llmCacheRedisConnected?.set(1);
      });
      
    } catch (error) {
      console.error('[SimpleRedisCache] Redis connection failed:', error instanceof Error ? error.message : error);
      console.error('[SimpleRedisCache] Cache will be disabled for this session');
      this.redis = null;
      this.isConnected = false;
      metrics.llmCacheRedisConnected?.set(0);
    }
  }

  // Simple text embedding using character n-grams (no external dependencies)
  protected createEmbedding(text: string): number[] {
    const normalized = text.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const dim = this.config.embeddingDim!;
    const embedding = new Array(dim).fill(0);
    
    // Use overlapping 3-grams for semantic similarity
    for (let i = 0; i < normalized.length - 2; i++) {
      const trigram = normalized.substring(i, i + 3);
      const hash = this.simpleHash(trigram) % dim;
      embedding[hash] += 1;
    }
    
    // Normalize vector
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    return magnitude > 0 ? embedding.map(val => val / magnitude) : embedding;
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

  protected cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private generateKey(text: string): string {
    const prefix = this.config.redis?.keyPrefix || 'llm:';
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    return `${prefix}${hash}`;
  }

  async get(prompt: string, estimatedTokens: number = 100): Promise<LLMResponse | null> {
    if (!this.redis || !this.isConnected) {
      return null;
    }

    try {
      const embedding = this.createEmbedding(prompt);
      
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
      
      // Then try similarity search on recent entries
      const pattern = `${this.config.redis?.keyPrefix || 'llm:'}*`;
      const keys = await this.redis.keys(pattern);
      
      let bestMatch: { entry: CacheEntry; key: string } | null = null;
      let bestSimilarity = 0;
      
      // Limit similarity search to recent entries for performance
      const recentKeys = keys.slice(0, 100);
      
      for (const key of recentKeys) {
        const data = await this.redis.get(key);
        if (!data) continue;
        
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
      }
      
      if (bestMatch) {
        await this.updateHitCount(bestMatch.key, bestMatch.entry);
        metrics.llmCacheHits?.inc();
        metrics.llmTokensSaved?.inc(bestMatch.entry.tokens);
        console.log(`[SimpleRedisCache] Similarity hit: ${bestSimilarity.toFixed(3)}`);
        return bestMatch.entry.response;
      }
      
      metrics.llmCacheMisses?.inc();
      return null;
      
    } catch (error) {
      console.warn('[SimpleRedisCache] Get error:', error);
      metrics.llmCacheRedisErrors?.inc();
      return null;
    }
  }

  async set(prompt: string, response: LLMResponse, tokens: number): Promise<void> {
    if (!this.redis || !this.isConnected) {
      return;
    }

    try {
      const embedding = this.createEmbedding(prompt);
      const key = this.generateKey(prompt);
      
      const entry: CacheEntry = {
        response,
        embedding,
        tokens,
        timestamp: Date.now(),
        hits: 0,
      };
      
      await this.redis.setex(key, this.config.ttlSeconds || 3600, JSON.stringify(entry));
      metrics.llmCacheRedisWrites?.inc();
      
    } catch (error) {
      console.warn('[SimpleRedisCache] Set error:', error);
      metrics.llmCacheRedisErrors?.inc();
    }
  }

  private async updateHitCount(key: string, entry: CacheEntry): Promise<void> {
    try {
      entry.hits++;
      await this.redis!.setex(key, this.config.ttlSeconds || 3600, JSON.stringify(entry));
    } catch {
      // Ignore hit count update errors
    }
  }

  async getStats(): Promise<any> {
    if (!this.redis || !this.isConnected) {
      return { connected: false, size: 0 };
    }

    try {
      const pattern = `${this.config.redis?.keyPrefix || 'llm:'}*`;
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
        await this.redis.quit();
      } catch {
        // Ignore close errors
      }
      this.redis = null;
      this.isConnected = false;
    }
  }

  isHealthy(): boolean {
    return this.isConnected;
  }

  async cleanup(): Promise<void> {
    if (!this.redis || !this.isConnected) return;

    try {
      // Remove expired entries (Redis handles this automatically with TTL)
      // But we can clean up entries with 0 hits that are old
      const pattern = `${this.config.redis?.keyPrefix || 'llm:'}*`;
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
      console.warn('[SimpleRedisCache] Cleanup error:', error);
    }
  }
}