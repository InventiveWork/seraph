// src/memory.ts - Unified Memory Management System
// Combines Redis cache, short-term memory, and memory management functionality

import Redis from 'ioredis';
import * as crypto from 'crypto';
import { LLMResponse } from './llm/provider';
import { metrics } from './metrics';

// ===== CORE INTERFACES =====

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

export interface Incident {
  id: string;
  log: string;
  reason: string;
  timestamp: number;
  resolution?: string;
  status?: 'investigating' | 'resolved' | 'escalated';
  tags: string[];
  severity?: 'low' | 'medium' | 'high' | 'critical';
  investigationId?: string;
  embedding: number[];
  correlatedIncidents?: string[];
}

export interface Session {
  id: string;
  userId?: string;
  startTime: number;
  lastActivity: number;
  context: {
    recentQueries: string[];
    activeServices: string[];
    investigationHistory: string[];
    userPreferences?: any;
  };
}

export interface SessionContext {
  sessionId: string;
  userId?: string;
  serviceContext: string[];
  recentQueries: string[];
  lastActivity: number;
}

export interface Pattern {
  id?: string;
  signature: string;
  description?: string;
  frequency: number;
  firstSeen?: number;
  lastSeen: number;
  confidence: number;
  affectedServices?: string[];
  commonResolutions: string[];
  escalationRate?: number;
}

export interface MemoryConfig {
  redis?: {
    url?: string;
    host?: string;
    port?: number;
    password?: string;
    keyPrefix?: string;
  };
  // Cache settings
  similarityThreshold?: number;
  ttlSeconds?: number;
  embeddingDim?: number;
  verbose?: boolean;
  // Memory settings
  shortTermTtl?: number;    // TTL for short-term memories
  sessionTtl?: number;      // TTL for session context
  incidentTtl?: number;     // How long to remember incidents (hours)
  patternTtl?: number;      // How long to track patterns (hours)
  maxIncidents?: number;    // Max incidents to track
  correlationThreshold?: number; // Similarity threshold for correlation
}

// ===== UNIFIED MEMORY MANAGER =====

export class MemoryManager {
  protected redis: Redis | null = null;
  protected config: MemoryConfig;
  protected isConnected = false;
  private initPromise: Promise<void> | null = null;
  
  constructor(config: MemoryConfig = {}) {
    this.config = {
      // Cache defaults
      similarityThreshold: 0.85,
      ttlSeconds: 3600, // 1 hour
      embeddingDim: 384, // sentence-transformer dimension
      verbose: false,
      // Memory defaults
      shortTermTtl: 86400,    // 24 hours
      sessionTtl: 3600,       // 1 hour
      incidentTtl: 72,        // 72 hours for incidents
      patternTtl: 168,        // 1 week for patterns
      maxIncidents: 1000,     // Track last 1000 incidents
      correlationThreshold: 0.75, // Correlation threshold
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

  // ===== REDIS CONNECTION MANAGEMENT =====

  async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  private async initRedis(): Promise<void> {
    if (!this.config.redis) return;
    
    try {
      const redisConfig = this.config.redis;
      
      if (redisConfig.url) {
        this.redis = new Redis(redisConfig.url);
      } else {
        this.redis = new Redis({
          host: redisConfig.host || 'localhost',
          port: redisConfig.port || 6379,
          password: redisConfig.password,
          keyPrefix: redisConfig.keyPrefix || 'memory:',
          maxRetriesPerRequest: 3,
          connectTimeout: 10000,
          commandTimeout: 5000,
        });
      }

      // Set up event handlers
      this.redis.on('connect', () => {
        this.isConnected = true;
        if (this.config.verbose) {
          console.log('[MemoryManager] Connected to Redis');
        }
      });

      this.redis.on('error', (error) => {
        this.isConnected = false;
        if (this.config.verbose) {
          console.error('[MemoryManager] Redis connection error:', error.message);
        }
      });

      this.redis.on('close', () => {
        this.isConnected = false;
        if (this.config.verbose) {
          console.log('[MemoryManager] Redis connection closed');
        }
      });

      // Wait for connection to be established or fail
      await new Promise<void>((resolve) => {
        const connectTimeout = setTimeout(() => {
          this.redis?.disconnect();
          resolve();
        }, 1000);

        this.redis?.once('connect', () => {
          clearTimeout(connectTimeout);
          this.isConnected = true;
          resolve();
        });

        this.redis?.once('error', () => {
          clearTimeout(connectTimeout);
          this.isConnected = false;
          resolve();
        });
      })
      
    } catch (error) {
      this.isConnected = false;
      if (this.config.verbose) {
        console.error('[MemoryManager] Failed to initialize Redis:', error);
      }
      // Clean up Redis connection on failure
      if (this.redis) {
        this.redis.disconnect();
        this.redis = null;
      }
    }
  }

  async waitForRedisReady(options: {
    enabled: boolean;
    maxRetries?: number;
    retryDelayMs?: number;
    timeoutMs?: number;
  }): Promise<boolean> {
    if (!options.enabled || !this.config.redis) {
      if (this.config.verbose) {
        console.log('[MemoryManager] Redis caching not enabled, skipping wait');
      }
      return false;
    }

    const maxRetries = options.maxRetries ?? 30;
    const retryDelayMs = options.retryDelayMs ?? 1000;
    const timeoutMs = options.timeoutMs ?? 60000;
    const startTime = Date.now();

    if (this.config.verbose) {
      console.log(`[MemoryManager] Waiting for Redis to be ready (max ${maxRetries} retries, ${timeoutMs}ms timeout)`);
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Check overall timeout
      if (Date.now() - startTime > timeoutMs) {
        if (this.config.verbose) {
          console.error(`[MemoryManager] Timeout waiting for Redis after ${timeoutMs}ms`);
        }
        return false;
      }

      try {
        // Initialize Redis if not already done
        if (!this.initPromise) {
          this.initPromise = this.initRedis();
        }
        await this.initPromise;

        if (this.redis && this.isConnected) {
          // Test Redis connection
          await this.redis.ping();
          if (this.config.verbose) {
            console.log(`[MemoryManager] Redis ready on attempt ${attempt}`);
          }
          return true;
        }
      } catch (error) {
        if (this.config.verbose && attempt % 5 === 0) { // Log every 5th attempt to reduce noise
          console.log(`[MemoryManager] Redis not ready, attempt ${attempt}/${maxRetries}: ${error}`);
        }
      }

      // Wait before next attempt, unless this was the last attempt
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }

    if (this.config.verbose) {
      console.error(`[MemoryManager] Redis failed to become ready after ${maxRetries} attempts`);
    }
    return false;
  }

  async disconnect(): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch (error) {
        // Ignore disconnection errors
      }
      this.redis = null;
      this.isConnected = false;
    }
  }

  // ===== EMBEDDING UTILITIES =====

  createEmbedding(text: string): number[] {
    // Simple hash-based embedding for demo purposes
    const hash = crypto.createHash('sha256').update(text).digest();
    const embedding: number[] = [];
    
    for (let i = 0; i < Math.min(this.config.embeddingDim!, hash.length); i++) {
      embedding.push((hash[i] / 255) * 2 - 1); // Normalize to [-1, 1]
    }
    
    // Pad or truncate to desired dimension
    while (embedding.length < this.config.embeddingDim!) {
      embedding.push(Math.random() * 2 - 1);
    }
    
    return embedding.slice(0, this.config.embeddingDim);
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // ===== BASIC CACHE OPERATIONS =====

  async get(key: string, expectedTokens?: number): Promise<LLMResponse | null> {
    if (!this.redis || !this.isConnected) {
      if (this.config.verbose) {
        console.log('[MemoryManager] Cache miss - Redis not available');
      }
      return null;
    }

    try {
      await this.ensureInitialized();
      
      // Direct key lookup first
      const cachedData = await this.redis.get(`cache:${key}`);
      if (cachedData) {
        const entry: CacheEntry = JSON.parse(cachedData);
        
        // Update hit counter
        entry.hits++;
        await this.redis.setex(`cache:${key}`, this.config.ttlSeconds!, JSON.stringify(entry));
        
        if (this.config.verbose) {
          console.log(`[MemoryManager] Cache hit for key: ${key.substring(0, 50)}...`);
        }
        
        return entry.response;
      }

      // Vector similarity search fallback
      const queryEmbedding = this.createEmbedding(key);
      const allKeys = await this.redis.keys('cache:*');
      
      for (const cacheKey of allKeys) {
        try {
          const entryData = await this.redis.get(cacheKey);
          if (!entryData) continue;
          
          const entry: CacheEntry = JSON.parse(entryData);
          const similarity = this.cosineSimilarity(queryEmbedding, entry.embedding);
          
          if (similarity >= this.config.similarityThreshold!) {
            entry.hits++;
            await this.redis.setex(cacheKey, this.config.ttlSeconds!, JSON.stringify(entry));
            
            if (this.config.verbose) {
              console.log(`[MemoryManager] Similarity cache hit: ${similarity.toFixed(3)} for key: ${key.substring(0, 50)}...`);
            }
            
            return entry.response;
          }
        } catch (parseError) {
          // Skip malformed entries
          continue;
        }
      }
      
      if (this.config.verbose) {
        console.log(`[MemoryManager] Cache miss for key: ${key.substring(0, 50)}...`);
      }
      return null;
      
    } catch (error) {
      if (this.config.verbose) {
        console.error('[MemoryManager] Cache get error:', error);
      }
      return null;
    }
  }

  async set(key: string, response: LLMResponse, tokens?: number): Promise<void> {
    if (!this.redis || !this.isConnected) {
      return;
    }

    try {
      await this.ensureInitialized();
      
      const embedding = this.createEmbedding(key);
      const entry: CacheEntry = {
        response,
        embedding,
        tokens: tokens || 0,
        timestamp: Date.now(),
        hits: 0,
      };

      await this.redis.setex(
        `cache:${key}`,
        this.config.ttlSeconds!,
        JSON.stringify(entry)
      );
      
      if (this.config.verbose) {
        console.log(`[MemoryManager] Cached response for key: ${key.substring(0, 50)}... (${tokens || 0} tokens)`);
      }
      
    } catch (error) {
      if (this.config.verbose) {
        console.error('[MemoryManager] Cache set error:', error);
      }
    }
  }

  // ===== INCIDENT MEMORY =====

  generateIncidentId(incident: { log: string; reason: string; timestamp: number }): string {
    const data = `${incident.log}-${incident.reason}-${incident.timestamp}`;
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  }

  async rememberIncident(incident: Omit<Incident, 'id' | 'embedding'>): Promise<string> {
    if (!this.redis || !this.isConnected) {
      console.warn('[MemoryManager] Redis not available for incident storage');
      return '';
    }

    try {
      const id = this.generateIncidentId(incident);
      const embedding = this.createEmbedding(`${incident.log} ${incident.reason}`);
      
      const fullIncident: Incident = {
        ...incident,
        id,
        embedding,
        correlatedIncidents: await this.findCorrelatedIncidents(embedding, id),
      };

      // Store incident with TTL
      const key = `incident:${id}`;
      const ttlSeconds = (this.config.incidentTtl || 72) * 3600;
      await this.redis.setex(key, ttlSeconds, JSON.stringify(fullIncident));

      // Add to incident timeline
      await this.redis.zadd('incident:timeline', incident.timestamp, id);

      // Trim timeline to max incidents
      await this.redis.zremrangebyrank(
        'incident:timeline', 
        0, 
        -(this.config.maxIncidents! + 1)
      );

      // Update pattern tracking
      await this.updatePatterns(fullIncident);

      if (this.config.verbose) {
        console.log(`[MemoryManager] Remembered incident: ${id}`);
      }

      return id;
    } catch (error) {
      console.error('[MemoryManager] Error remembering incident:', error);
      return '';
    }
  }

  async findCorrelatedIncidents(embedding: number[], excludeId: string): Promise<string[]> {
    if (!this.redis || !this.isConnected) return [];

    try {
      const correlatedIds: string[] = [];
      const threshold = this.config.correlationThreshold || 0.75;
      
      // Get recent incidents
      const recentIds = await this.redis.zrevrange('incident:timeline', 0, 99); // Last 100 incidents
      
      for (const id of recentIds) {
        if (id === excludeId) continue;
        
        const incidentData = await this.redis.get(`incident:${id}`);
        if (!incidentData) continue;
        
        try {
          const incident: Incident = JSON.parse(incidentData);
          const similarity = this.cosineSimilarity(embedding, incident.embedding);
          
          if (similarity >= threshold) {
            correlatedIds.push(id);
          }
        } catch (error) {
          continue; // Skip malformed entries
        }
      }
      
      return correlatedIds.slice(0, 5); // Limit to top 5 correlations
    } catch (error) {
      console.error('[MemoryManager] Error finding correlations:', error);
      return [];
    }
  }

  async recallSimilarIncidents(query: string, limit: number = 5): Promise<Incident[]> {
    if (!this.redis || !this.isConnected) return [];

    try {
      const queryEmbedding = this.createEmbedding(query);
      const similarities: Array<{ incident: Incident; similarity: number }> = [];
      
      // Get recent incidents
      const recentIds = await this.redis.zrevrange('incident:timeline', 0, 199); // Last 200 incidents
      
      for (const id of recentIds) {
        const incidentData = await this.redis.get(`incident:${id}`);
        if (!incidentData) continue;
        
        try {
          const incident: Incident = JSON.parse(incidentData);
          const similarity = this.cosineSimilarity(queryEmbedding, incident.embedding);
          
          if (similarity >= 0.3) { // Minimum similarity threshold
            similarities.push({ incident, similarity });
          }
        } catch (error) {
          continue; // Skip malformed entries
        }
      }
      
      // Sort by similarity and return top results
      return similarities
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit)
        .map(s => s.incident);
        
    } catch (error) {
      console.error('[MemoryManager] Error recalling incidents:', error);
      return [];
    }
  }

  // ===== PATTERN DETECTION =====

  async updatePatterns(incident: Incident): Promise<void> {
    if (!this.redis || !this.isConnected) return;

    try {
      // Extract potential patterns from log and reason
      const patterns = this.extractPatterns(incident);
      
      for (const patternSig of patterns) {
        const key = `pattern:${crypto.createHash('sha256').update(patternSig).digest('hex').substring(0, 16)}`;
        
        const existingData = await this.redis.get(key);
        let pattern: Pattern;
        
        if (existingData) {
          pattern = JSON.parse(existingData);
          pattern.frequency++;
          pattern.lastSeen = Date.now();
          pattern.confidence = Math.min(pattern.confidence + 0.1, 1.0);
          
          if (incident.resolution) {
            pattern.commonResolutions = [...new Set([...pattern.commonResolutions, incident.resolution])];
          }
        } else {
          pattern = {
            signature: patternSig,
            frequency: 1,
            lastSeen: Date.now(),
            confidence: 0.3,
            commonResolutions: incident.resolution ? [incident.resolution] : [],
          };
        }
        
        const ttlSeconds = (this.config.patternTtl || 168) * 3600;
        await this.redis.setex(key, ttlSeconds, JSON.stringify(pattern));
      }
    } catch (error) {
      console.error('[MemoryManager] Error updating patterns:', error);
    }
  }

  private extractPatterns(incident: Incident): string[] {
    const patterns: string[] = [];
    
    // Extract error patterns
    const errorMatch = incident.log.match(/error|exception|failure|timeout|refused/i);
    if (errorMatch) {
      patterns.push(`error_pattern:${errorMatch[0].toLowerCase()}`);
    }
    
    // Extract service patterns
    const serviceMatch = incident.log.match(/(\w+)-service|\b(\w+)\.(com|io|net)\b/i);
    if (serviceMatch) {
      patterns.push(`service_pattern:${serviceMatch[1] || serviceMatch[2]}`);
    }
    
    // Extract resource patterns
    const resourceMatch = incident.log.match(/memory|cpu|disk|network|database/i);
    if (resourceMatch) {
      patterns.push(`resource_pattern:${resourceMatch[0].toLowerCase()}`);
    }
    
    return patterns;
  }

  async detectPatterns(): Promise<Pattern[]> {
    if (!this.redis || !this.isConnected) return [];

    try {
      const patternKeys = await this.redis.keys('pattern:*');
      const patterns: Pattern[] = [];
      
      for (const key of patternKeys) {
        const patternData = await this.redis.get(key);
        if (patternData) {
          try {
            const pattern: Pattern = JSON.parse(patternData);
            patterns.push(pattern);
          } catch (error) {
            continue; // Skip malformed entries
          }
        }
      }
      
      return patterns.sort((a, b) => b.confidence - a.confidence);
    } catch (error) {
      console.error('[MemoryManager] Error detecting patterns:', error);
      return [];
    }
  }

  // ===== SESSION MANAGEMENT =====

  async updateSessionContext(sessionId: string, context: Partial<SessionContext>): Promise<void> {
    if (!this.redis || !this.isConnected) return;

    try {
      const key = `session:${sessionId}`;
      const existingData = await this.redis.get(key);
      
      let sessionContext: SessionContext;
      if (existingData) {
        sessionContext = { ...JSON.parse(existingData), ...context };
      } else {
        sessionContext = {
          sessionId,
          serviceContext: [],
          recentQueries: [],
          lastActivity: Date.now(),
          ...context,
        };
      }
      
      sessionContext.lastActivity = Date.now();
      
      await this.redis.setex(key, this.config.sessionTtl!, JSON.stringify(sessionContext));
    } catch (error) {
      console.error('[MemoryManager] Error updating session context:', error);
    }
  }

  async getSessionContext(sessionId: string): Promise<SessionContext | null> {
    if (!this.redis || !this.isConnected) return null;

    try {
      const sessionData = await this.redis.get(`session:${sessionId}`);
      return sessionData ? JSON.parse(sessionData) : null;
    } catch (error) {
      console.error('[MemoryManager] Error getting session context:', error);
      return null;
    }
  }

  // ===== ENHANCED CONTEXT BUILDING =====

  async buildEnhancedContext(query: string, sessionId?: string): Promise<string> {
    const contexts: string[] = [];
    
    // Add session context
    if (sessionId) {
      const session = await this.getSessionContext(sessionId);
      if (session) {
        contexts.push(`Recent queries: ${session.recentQueries.slice(-3).join(', ')}`);
        contexts.push(`Active services: ${session.serviceContext.slice(-3).join(', ')}`);
      }
    }
    
    // Add recent incident context
    const recentIncidents = await this.recallSimilarIncidents(query, 2);
    if (recentIncidents.length > 0) {
      contexts.push(`Related incidents: ${recentIncidents.map(i => i.reason).join('; ')}`);
    }
    
    return contexts.length > 0 ? contexts.join('\n') : 'No additional context available';
  }

  // ===== MEMORY STATISTICS =====

  async getMemoryStats(): Promise<any> {
    if (!this.redis || !this.isConnected) {
      return { 
        connected: false,
        size: 0
      };
    }

    try {
      const [
        incidentCount,
        patternCount,
        sessionCount,
        cacheCount
      ] = await Promise.all([
        this.redis.zcard('incident:timeline'),
        this.redis.eval('return #redis.call("keys", "pattern:*")', 0),
        this.redis.eval('return #redis.call("keys", "session:*")', 0),
        this.redis.eval('return #redis.call("keys", "cache:*")', 0)
      ]);

      return {
        connected: true,
        incidents: incidentCount,
        patterns: patternCount,
        sessions: sessionCount,
        cacheEntries: cacheCount,
      };
    } catch (error) {
      console.error('[MemoryManager] Error getting memory stats:', error);
      return { connected: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ===== LEGACY COMPATIBILITY =====
  
  // Maintain compatibility with SimpleRedisCache interface
  async clear(): Promise<void> {
    if (!this.redis || !this.isConnected) return;

    try {
      const keys = await this.redis.keys('*');
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch (error) {
      console.error('[MemoryManager] Error clearing cache:', error);
    }
  }

  async close(): Promise<void> {
    await this.disconnect();
  }

  async cleanup(): Promise<void> {
    await this.clear();
    await this.disconnect();
  }

  isHealthy(): boolean {
    return this.isConnected;
  }

  async getStats(): Promise<any> {
    return await this.getMemoryStats();
  }
}

// Export legacy class names for compatibility
export class SimpleRedisCache extends MemoryManager {}
export class ShortTermMemory extends MemoryManager {}