// Memory Management for AI Agents - Built on Redis Cache Foundation
import { SimpleRedisCache } from './simple-redis-cache';
import { LLMResponse } from './llm/provider';

export interface Incident {
  id: string;
  log: string;
  reason: string;
  timestamp: number;
  resolution?: string;
  tags: string[];
  embedding: number[];
}

export interface SessionContext {
  sessionId: string;
  userId?: string;
  serviceContext: string[];
  recentQueries: string[];
  lastActivity: number;
}

export interface Pattern {
  signature: string;
  frequency: number;
  lastSeen: number;
  commonResolutions: string[];
  confidence: number;
}

export interface MemoryConfig {
  redis?: {
    url?: string;
    host?: string;
    port?: number;
    password?: string;
  };
  shortTermTtl?: number;    // TTL for short-term memories
  sessionTtl?: number;      // TTL for session context
  maxIncidents?: number;    // Max incidents to track
}

export class MemoryManager extends SimpleRedisCache {
  protected override config: MemoryConfig;
  
  constructor(config: MemoryConfig = {}) {
    // Extend the response cache with memory capabilities
    super({
      redis: config.redis ? {
        ...config.redis,
        keyPrefix: 'memory:',
      } : undefined,
      similarityThreshold: 0.85,
      ttlSeconds: config.shortTermTtl ?? 3600,
    });
    
    this.config = {
      shortTermTtl: 86400,    // 24 hours
      sessionTtl: 3600,       // 1 hour
      maxIncidents: 1000,     // Track last 1000 incidents
      ...config,
    };
  }

  // ===== SHORT-TERM MEMORY OPERATIONS =====

  async rememberIncident(incident: Omit<Incident, 'id' | 'embedding'>): Promise<void> {
    if (!this.redis || !this.isConnected) {return;}

    try {
      const id = this.generateIncidentId(incident);
      const embedding = this.createEmbedding(`${incident.log  } ${  incident.reason}`);
      
      const fullIncident: Incident = {
        ...incident,
        id,
        embedding,
      };

      // Store incident with TTL
      const key = `incident:${id}`;
      await this.redis.setex(
        key, 
        this.config.shortTermTtl!, 
        JSON.stringify(fullIncident),
      );

      // Add to incident timeline
      await this.redis.zadd(
        'incident:timeline', 
        incident.timestamp, 
        id,
      );

      // Trim timeline to max incidents
      await this.redis.zremrangebyrank(
        'incident:timeline', 
        0, 
        -(this.config.maxIncidents! + 1),
      );

    } catch (error) {
      console.warn('[MemoryManager] Failed to remember incident:', error);
    }
  }

  async recallSimilarIncidents(query: string, limit: number = 5): Promise<Incident[]> {
    if (!this.redis || !this.isConnected) {return [];}

    try {
      const queryEmbedding = this.createEmbedding(query);
      
      // Get recent incidents from timeline
      const recentIds = await this.redis.zrevrange('incident:timeline', 0, 100);
      const incidents: Incident[] = [];

      for (const id of recentIds) {
        const data = await this.redis.get(`incident:${id}`);
        if (data) {
          try {
            const incident: Incident = JSON.parse(data);
            const similarity = this.cosineSimilarity(queryEmbedding, incident.embedding);
            
            if (similarity >= 0.7) { // Lower threshold for incident matching
              incidents.push({ ...incident, similarity } as any);
            }
          } catch {
            // Skip malformed incidents
          }
        }
      }

      // Sort by similarity and return top results
      return incidents
        .sort((a, b) => (b as any).similarity - (a as any).similarity)
        .slice(0, limit);

    } catch (error) {
      console.warn('[MemoryManager] Failed to recall incidents:', error);
      return [];
    }
  }

  async getRecentIncidents(hours: number = 24): Promise<Incident[]> {
    if (!this.redis || !this.isConnected) {return [];}

    try {
      const cutoff = Date.now() - (hours * 60 * 60 * 1000);
      const recentIds = await this.redis.zrangebyscore(
        'incident:timeline', 
        cutoff, 
        '+inf',
      );

      const incidents: Incident[] = [];
      for (const id of recentIds) {
        const data = await this.redis.get(`incident:${id}`);
        if (data) {
          try {
            incidents.push(JSON.parse(data));
          } catch {
            // Skip malformed incidents
          }
        }
      }

      return incidents.sort((a, b) => b.timestamp - a.timestamp);

    } catch (error) {
      console.warn('[MemoryManager] Failed to get recent incidents:', error);
      return [];
    }
  }

  // ===== SESSION MEMORY OPERATIONS =====

  async updateSessionContext(sessionId: string, context: Partial<SessionContext>): Promise<void> {
    if (!this.redis || !this.isConnected) {return;}

    try {
      const key = `session:${sessionId}`;
      const existing = await this.redis.get(key);
      
      let sessionContext: SessionContext;
      if (existing) {
        sessionContext = { ...JSON.parse(existing), ...context };
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
      
      await this.redis.setex(
        key,
        this.config.sessionTtl!,
        JSON.stringify(sessionContext),
      );

    } catch (error) {
      console.warn('[MemoryManager] Failed to update session:', error);
    }
  }

  async getSessionContext(sessionId: string): Promise<SessionContext | null> {
    if (!this.redis || !this.isConnected) {return null;}

    try {
      const data = await this.redis.get(`session:${sessionId}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.warn('[MemoryManager] Failed to get session:', error);
      return null;
    }
  }

  // ===== PATTERN RECOGNITION =====

  async detectPatterns(): Promise<Pattern[]> {
    if (!this.redis || !this.isConnected) {return [];}

    try {
      // Get recent incidents for pattern analysis
      const incidents = await this.getRecentIncidents(72); // Last 3 days
      const patternMap = new Map<string, Pattern>();

      for (const incident of incidents) {
        // Create pattern signature from incident characteristics
        const signature = this.createPatternSignature(incident);
        
        if (patternMap.has(signature)) {
          const pattern = patternMap.get(signature)!;
          pattern.frequency++;
          pattern.lastSeen = Math.max(pattern.lastSeen, incident.timestamp);
          
          if (incident.resolution) {
            pattern.commonResolutions.push(incident.resolution);
          }
        } else {
          patternMap.set(signature, {
            signature,
            frequency: 1,
            lastSeen: incident.timestamp,
            commonResolutions: incident.resolution ? [incident.resolution] : [],
            confidence: 0,
          });
        }
      }

      // Calculate confidence and filter significant patterns
      const patterns = Array.from(patternMap.values())
        .map(pattern => ({
          ...pattern,
          confidence: Math.min(pattern.frequency / 10, 1.0), // Max confidence at 10 occurrences
        }))
        .filter(pattern => pattern.frequency >= 2) // At least 2 occurrences
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 20); // Limit to top 20 patterns to prevent unbounded growth

      return patterns;

    } catch (error) {
      console.warn('[MemoryManager] Failed to detect patterns:', error);
      return [];
    }
  }

  // ===== MEMORY-ENHANCED CONTEXT GENERATION =====

  async buildEnhancedContext(query: string, sessionId?: string): Promise<string> {
    const contextParts: string[] = [];

    // Get similar incidents
    const similarIncidents = await this.recallSimilarIncidents(query, 3);
    if (similarIncidents.length > 0) {
      contextParts.push(
        'Similar recent incidents:',
        ...similarIncidents.map(i => `- ${i.log} (resolved: ${i.resolution ?? 'pending'})`),
      );
    }

    // Get session context
    if (sessionId) {
      const session = await this.getSessionContext(sessionId);
      if (session?.recentQueries.length) {
        contextParts.push(
          'Recent queries in this session:',
          ...session.recentQueries.slice(-3).map(q => `- ${q}`),
        );
      }
    }

    // Get patterns
    const patterns = await this.detectPatterns();
    const relevantPatterns = patterns.filter(p => 
      this.cosineSimilarity(
        this.createEmbedding(query),
        this.createEmbedding(p.signature),
      ) > 0.6,
    ).slice(0, 2);

    if (relevantPatterns.length > 0) {
      contextParts.push(
        'Relevant patterns:',
        ...relevantPatterns.map(p => 
          `- ${p.signature} (${p.frequency}x, confidence: ${(p.confidence * 100).toFixed(0)}%)`,
        ),
      );
    }

    return contextParts.length > 0 
      ? `\nMemory Context:\n${contextParts.join('\n')}\n`
      : '';
  }

  // ===== UTILITY METHODS =====

  private generateIncidentId(incident: Omit<Incident, 'id' | 'embedding'>): string {
    const hash = require('crypto')
      .createHash('md5')
      .update(`${incident.log}:${incident.timestamp}`)
      .digest('hex');
    return hash.substring(0, 8);
  }

  private createPatternSignature(incident: Incident): string {
    // Extract key characteristics for pattern matching
    const logType = incident.log.match(/^(ERROR|WARN|INFO|CRITICAL)/)?.[1] ?? 'UNKNOWN';
    const service = incident.tags.find(t => t.startsWith('service:'))?.replace('service:', '') ?? 'unknown';
    const errorType = incident.log.match(/(timeout|connection|memory|disk|cpu|network)/i)?.[1] ?? 'general';
    
    return `${logType}:${service}:${errorType.toLowerCase()}`;
  }

  async getMemoryStats(): Promise<any> {
    const baseStats = await this.getStats();
    
    if (!this.redis || !this.isConnected) {
      return { ...baseStats, memory: { incidents: 0, sessions: 0, patterns: 0 } };
    }

    try {
      const incidentCount = await this.redis.zcard('incident:timeline');
      const sessionKeys = await this.redis.keys('session:*');
      const patterns = await this.detectPatterns();

      return {
        ...baseStats,
        memory: {
          incidents: incidentCount,
          sessions: sessionKeys.length,
          patterns: patterns.length,
          topPatterns: patterns.slice(0, 5).map(p => ({
            signature: p.signature,
            frequency: p.frequency,
            confidence: p.confidence,
          })),
        },
      };
    } catch {
      return { ...baseStats, memory: { incidents: 0, sessions: 0, patterns: 0 } };
    }
  }
}