// Short-Term Memory for AI Agents - Context Layer
import { SimpleRedisCache } from './simple-redis-cache';
import { LLMResponse } from './llm/provider';
import { metrics } from './metrics';
import * as crypto from 'crypto';

export interface Incident {
  id: string;
  log: string;
  reason: string;
  timestamp: number;
  resolution?: string;
  status: 'investigating' | 'resolved' | 'escalated';
  tags: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  investigationId?: string;
  embedding: number[];
  correlatedIncidents?: string[]; // IDs of related incidents
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

export interface Pattern {
  id: string;
  signature: string;
  description: string;
  frequency: number;
  firstSeen: number;
  lastSeen: number;
  confidence: number;
  affectedServices: string[];
  commonResolutions: string[];
  escalationRate: number;
}

export interface MemoryConfig {
  redis?: {
    url?: string;
    host?: string;
    port?: number;
    password?: string;
  };
  incidentTtl?: number;     // How long to remember incidents (hours)
  sessionTtl?: number;      // How long to keep session context (hours)
  patternTtl?: number;      // How long to track patterns (hours)
  maxIncidents?: number;    // Max incidents to track per service
  correlationThreshold?: number; // Similarity threshold for correlation
}

export class ShortTermMemory extends SimpleRedisCache {
  private memoryConfig: MemoryConfig;
  
  constructor(config: MemoryConfig = {}) {
    super({
      redis: config.redis ? {
        ...config.redis,
        keyPrefix: 'memory:',
      } : undefined,
      similarityThreshold: 0.80,
      ttlSeconds: config.incidentTtl ? config.incidentTtl * 3600 : 86400, // 24 hours default
    });
    
    this.memoryConfig = {
      incidentTtl: 72,          // 72 hours for incidents
      sessionTtl: 8,            // 8 hours for sessions
      patternTtl: 168,          // 1 week for patterns
      maxIncidents: 1000,       // Track up to 1000 incidents
      correlationThreshold: 0.75, // Correlation threshold
      ...config,
    };
  }

  // ===== INCIDENT MEMORY =====

  async rememberIncident(incident: Omit<Incident, 'id' | 'embedding'>): Promise<string> {
    if (!this.redis || !this.isConnected) {
      console.warn('[ShortTermMemory] Redis not available for incident storage');
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

      // Store the incident
      await this.redis.setex(
        `incident:${id}`,
        this.memoryConfig.incidentTtl! * 3600,
        JSON.stringify(fullIncident),
      );

      // Add to timeline for chronological access
      await this.redis.zadd('incident:timeline', incident.timestamp, id);

      // Add to service-specific index
      const service = this.extractService(fullIncident);
      if (service) {
        await this.redis.zadd(`incident:service:${service}`, incident.timestamp, id);
        
        // Maintain max incidents per service
        await this.redis.zremrangebyrank(
          `incident:service:${service}`, 
          0, 
          -(this.memoryConfig.maxIncidents! + 1),
        );
      }

      // Add to severity index
      await this.redis.zadd(`incident:severity:${incident.severity}`, incident.timestamp, id);

      // Update pattern tracking
      await this.updatePatternTracking(fullIncident);

      console.log(`[ShortTermMemory] Remembered incident ${id} with ${fullIncident.correlatedIncidents?.length ?? 0} correlations`);
      return id;

    } catch (error) {
      console.error('[ShortTermMemory] Failed to remember incident:', error);
      return '';
    }
  }

  async recallSimilarIncidents(query: string, options: {
    limit?: number;
    timeWindow?: number; // hours
    severity?: string[];
    services?: string[];
    excludeResolved?: boolean;
  } = {}): Promise<Incident[]> {
    
    const { limit = 5, timeWindow = 72, severity, services, excludeResolved = false } = options;
    
    if (!this.redis || !this.isConnected) {return [];}

    try {
      const queryEmbedding = this.createEmbedding(query);
      const cutoff = Date.now() - (timeWindow * 60 * 60 * 1000);
      
      // Get candidates based on filters
      let candidateIds: string[] = [];
      
      if (services && services.length > 0) {
        // Query specific services
        for (const service of services) {
          const serviceIds = await this.redis.zrangebyscore(
            `incident:service:${service}`, 
            cutoff, 
            '+inf',
          );
          candidateIds.push(...serviceIds);
        }
      } else {
        // Query general timeline
        candidateIds = await this.redis.zrangebyscore('incident:timeline', cutoff, '+inf');
      }

      // Remove duplicates
      candidateIds = [...new Set(candidateIds)];

      const incidents: (Incident & { similarity: number })[] = [];

      // Evaluate similarity for each candidate
      for (const id of candidateIds.slice(-200)) { // Limit to recent 200 for performance
        const data = await this.redis.get(`incident:${id}`);
        if (!data) {continue;}

        try {
          const incident: Incident = JSON.parse(data);
          
          // Apply filters
          if (severity && !severity.includes(incident.severity)) {continue;}
          if (excludeResolved && incident.status === 'resolved') {continue;}
          
          // Calculate similarity
          const similarity = this.cosineSimilarity(queryEmbedding, incident.embedding);
          
          if (similarity >= this.memoryConfig.correlationThreshold!) {
            incidents.push({ ...incident, similarity });
          }
        } catch {
          // Skip malformed incidents
        }
      }

      // Sort by similarity and return top results
      return incidents
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit)
        .map(({ similarity, ...incident }) => incident);

    } catch (error) {
      console.error('[ShortTermMemory] Failed to recall incidents:', error);
      return [];
    }
  }

  async getIncidentById(id: string): Promise<Incident | null> {
    if (!this.redis || !this.isConnected) {return null;}

    try {
      const data = await this.redis.get(`incident:${id}`);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  async updateIncident(id: string, updates: Partial<Incident>): Promise<boolean> {
    if (!this.redis || !this.isConnected) {return false;}

    try {
      const existing = await this.getIncidentById(id);
      if (!existing) {return false;}

      const updated = { ...existing, ...updates };
      
      await this.redis.setex(
        `incident:${id}`,
        this.memoryConfig.incidentTtl! * 3600,
        JSON.stringify(updated),
      );

      return true;
    } catch {
      return false;
    }
  }

  // ===== SESSION MEMORY =====

  async createSession(sessionId: string, userId?: string): Promise<Session> {
    const session: Session = {
      id: sessionId,
      userId,
      startTime: Date.now(),
      lastActivity: Date.now(),
      context: {
        recentQueries: [],
        activeServices: [],
        investigationHistory: [],
      },
    };

    if (this.redis && this.isConnected) {
      try {
        await this.redis.setex(
          `session:${sessionId}`,
          this.memoryConfig.sessionTtl! * 3600,
          JSON.stringify(session),
        );
      } catch (error) {
        console.warn('[ShortTermMemory] Failed to create session:', error);
      }
    }

    return session;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    if (!this.redis || !this.isConnected) {return null;}

    try {
      const data = await this.redis.get(`session:${sessionId}`);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  async updateSession(sessionId: string, updates: {
    query?: string;
    service?: string;
    investigationId?: string;
    preferences?: any;
  }): Promise<void> {
    
    if (!this.redis || !this.isConnected) {return;}

    try {
      let session = await this.getSession(sessionId);
      if (!session) {
        session = await this.createSession(sessionId);
      }

      // Update session context
      session.lastActivity = Date.now();
      
      if (updates.query) {
        session.context.recentQueries.unshift(updates.query);
        session.context.recentQueries = session.context.recentQueries.slice(0, 10); // Keep last 10
      }
      
      if (updates.service && !session.context.activeServices.includes(updates.service)) {
        session.context.activeServices.unshift(updates.service);
        session.context.activeServices = session.context.activeServices.slice(0, 5); // Keep last 5
      }
      
      if (updates.investigationId) {
        session.context.investigationHistory.unshift(updates.investigationId);
        session.context.investigationHistory = session.context.investigationHistory.slice(0, 20); // Keep last 20
      }

      if (updates.preferences) {
        session.context.userPreferences = { ...session.context.userPreferences, ...updates.preferences };
      }

      await this.redis.setex(
        `session:${sessionId}`,
        this.memoryConfig.sessionTtl! * 3600,
        JSON.stringify(session),
      );

    } catch (error) {
      console.warn('[ShortTermMemory] Failed to update session:', error);
    }
  }

  // ===== PATTERN DETECTION =====

  async detectPatterns(): Promise<Pattern[]> {
    if (!this.redis || !this.isConnected) {return [];}

    try {
      const cutoff = Date.now() - (this.memoryConfig.patternTtl! * 60 * 60 * 1000);
      const recentIncidents = await this.redis.zrangebyscore('incident:timeline', cutoff, '+inf');
      
      const patternMap = new Map<string, Pattern>();

      // Analyze incidents for patterns
      for (const incidentId of recentIncidents) {
        const data = await this.redis.get(`incident:${incidentId}`);
        if (!data) {continue;}

        try {
          const incident: Incident = JSON.parse(data);
          const signature = this.generatePatternSignature(incident);
          
          if (patternMap.has(signature)) {
            const pattern = patternMap.get(signature)!;
            pattern.frequency++;
            pattern.lastSeen = Math.max(pattern.lastSeen, incident.timestamp);
            
            // Track affected services
            const service = this.extractService(incident);
            if (service && !pattern.affectedServices.includes(service)) {
              pattern.affectedServices.push(service);
            }
            
            // Track resolutions
            if (incident.resolution && !pattern.commonResolutions.includes(incident.resolution)) {
              pattern.commonResolutions.push(incident.resolution);
            }
            
            // Track escalation rate
            if (incident.status === 'escalated') {
              pattern.escalationRate = (pattern.escalationRate * (pattern.frequency - 1) + 1) / pattern.frequency;
            } else {
              pattern.escalationRate = (pattern.escalationRate * (pattern.frequency - 1) + 0) / pattern.frequency;
            }
            
          } else {
            patternMap.set(signature, {
              id: crypto.createHash('md5').update(signature).digest('hex').substring(0, 8),
              signature,
              description: this.generatePatternDescription(incident),
              frequency: 1,
              firstSeen: incident.timestamp,
              lastSeen: incident.timestamp,
              confidence: 0,
              affectedServices: [this.extractService(incident)].filter(Boolean),
              commonResolutions: incident.resolution ? [incident.resolution] : [],
              escalationRate: incident.status === 'escalated' ? 1 : 0,
            });
          }
        } catch {
          // Skip malformed incidents
        }
      }

      // Calculate confidence scores and filter significant patterns
      const patterns = Array.from(patternMap.values())
        .map(pattern => ({
          ...pattern,
          confidence: this.calculatePatternConfidence(pattern),
        }))
        .filter(pattern => pattern.frequency >= 2 && pattern.confidence > 0.3)
        .sort((a, b) => b.confidence - a.confidence);

      // Store significant patterns for quick access
      for (const pattern of patterns.slice(0, 50)) { // Store top 50 patterns
        await this.redis.setex(
          `pattern:${pattern.id}`,
          this.memoryConfig.patternTtl! * 3600,
          JSON.stringify(pattern),
        );
      }

      return patterns;

    } catch (error) {
      console.error('[ShortTermMemory] Failed to detect patterns:', error);
      return [];
    }
  }

  async getPattern(id: string): Promise<Pattern | null> {
    if (!this.redis || !this.isConnected) {return null;}

    try {
      const data = await this.redis.get(`pattern:${id}`);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  // ===== CORRELATION & CONTEXT =====

  async buildContextForQuery(query: string, sessionId?: string): Promise<string> {
    const contextParts: string[] = [];

    // Get similar incidents
    const similarIncidents = await this.recallSimilarIncidents(query, { limit: 3, timeWindow: 48 });
    if (similarIncidents.length > 0) {
      contextParts.push('🔍 Recent Similar Incidents:');
      similarIncidents.forEach(incident => {
        const timeAgo = Math.round((Date.now() - incident.timestamp) / (1000 * 60 * 60));
        contextParts.push(`  • ${incident.reason} (${timeAgo}h ago, ${incident.status})`);
        if (incident.resolution) {
          contextParts.push(`    Resolution: ${incident.resolution}`);
        }
      });
      contextParts.push('');
    }

    // Get session context
    if (sessionId) {
      const session = await this.getSession(sessionId);
      if (session) {
        if (session.context.recentQueries.length > 0) {
          contextParts.push('💭 Recent Session Activity:');
          session.context.recentQueries.slice(0, 3).forEach(q => {
            contextParts.push(`  • ${q}`);
          });
          contextParts.push('');
        }
        
        if (session.context.activeServices.length > 0) {
          contextParts.push(`🔧 Active Services: ${session.context.activeServices.join(', ')}`);
          contextParts.push('');
        }
      }
    }

    // Get relevant patterns
    const patterns = await this.detectPatterns();
    const relevantPatterns = patterns.filter(p => {
      const patternEmbedding = this.createEmbedding(p.signature);
      const queryEmbedding = this.createEmbedding(query);
      return this.cosineSimilarity(patternEmbedding, queryEmbedding) > 0.6;
    }).slice(0, 2);

    if (relevantPatterns.length > 0) {
      contextParts.push('📊 Detected Patterns:');
      relevantPatterns.forEach(pattern => {
        contextParts.push(`  • ${pattern.description} (${pattern.frequency}x, confidence: ${(pattern.confidence * 100).toFixed(0)}%)`);
        if (pattern.commonResolutions.length > 0) {
          contextParts.push(`    Common fix: ${pattern.commonResolutions[0]}`);
        }
      });
      contextParts.push('');
    }

    return contextParts.length > 0 ? contextParts.join('\n') : '';
  }

  // ===== UTILITY METHODS =====

  private async findCorrelatedIncidents(embedding: number[], excludeId: string): Promise<string[]> {
    if (!this.redis || !this.isConnected) {return [];}

    try {
      const recentIds = await this.redis.zrevrange('incident:timeline', 0, 50);
      const correlatedIds: string[] = [];

      for (const id of recentIds) {
        if (id === excludeId) {continue;}
        
        const data = await this.redis.get(`incident:${id}`);
        if (!data) {continue;}

        try {
          const incident: Incident = JSON.parse(data);
          const similarity = this.cosineSimilarity(embedding, incident.embedding);
          
          if (similarity >= this.memoryConfig.correlationThreshold!) {
            correlatedIds.push(id);
          }
        } catch {
          // Skip malformed incidents
        }
      }

      return correlatedIds.slice(0, 5); // Limit to 5 correlations
    } catch {
      return [];
    }
  }

  private async updatePatternTracking(incident: Incident): Promise<void> {
    // This will be used by the pattern detection system
    // For now, patterns are detected on-demand in detectPatterns()
  }

  private generateIncidentId(incident: Omit<Incident, 'id' | 'embedding'>): string {
    const hash = crypto
      .createHash('md5')
      .update(`${incident.log}:${incident.reason}:${incident.timestamp}`)
      .digest('hex');
    return hash.substring(0, 12);
  }

  private extractService(incident: Incident): string {
    // Try to extract service from tags first
    const serviceTag = incident.tags.find(tag => tag.startsWith('service:'));
    if (serviceTag) {return serviceTag.replace('service:', '');}
    
    // Try to extract from log content
    const serviceMatch = incident.log.match(/service[:\s]+([a-zA-Z0-9-_]+)/i);
    if (serviceMatch) {return serviceMatch[1].toLowerCase();}
    
    // Try to extract from common patterns
    const patterns = ['api', 'database', 'redis', 'postgres', 'nginx', 'frontend', 'backend'];
    for (const pattern of patterns) {
      if (incident.log.toLowerCase().includes(pattern)) {return pattern;}
    }
    
    return 'unknown';
  }

  private generatePatternSignature(incident: Incident): string {
    const service = this.extractService(incident);
    const errorType = this.extractErrorType(incident.log);
    const severity = incident.severity;
    
    return `${service}:${errorType}:${severity}`;
  }

  private generatePatternDescription(incident: Incident): string {
    const service = this.extractService(incident);
    const errorType = this.extractErrorType(incident.log);
    
    return `${errorType} issues in ${service} service`;
  }

  protected extractErrorType(log: string): string {
    const errorPatterns = {
      'connection': ['connection', 'timeout', 'refused', 'unreachable'],
      'memory': ['memory', 'oom', 'heap', 'allocation'],
      'disk': ['disk', 'space', 'filesystem', 'storage'],
      'network': ['network', 'dns', 'socket', 'port'],
      'auth': ['auth', 'permission', 'unauthorized', 'forbidden'],
      'performance': ['slow', 'latency', 'performance', 'bottleneck'],
    };

    const logLower = log.toLowerCase();
    for (const [type, keywords] of Object.entries(errorPatterns)) {
      if (keywords.some(keyword => logLower.includes(keyword))) {
        return type;
      }
    }
    
    return 'general';
  }

  private calculatePatternConfidence(pattern: Pattern): number {
    const frequencyScore = Math.min(pattern.frequency / 10, 1); // Max at 10 occurrences
    const recencyScore = Math.max(0, 1 - (Date.now() - pattern.lastSeen) / (7 * 24 * 60 * 60 * 1000)); // Decay over 1 week
    const resolutionScore = pattern.commonResolutions.length > 0 ? 0.3 : 0;
    
    return (frequencyScore * 0.5 + recencyScore * 0.3 + resolutionScore);
  }

  async getMemoryStats(): Promise<any> {
    const baseStats = await this.getStats();
    
    if (!this.redis || !this.isConnected) {
      return { 
        ...baseStats, 
        memory: { 
          incidents: 0, 
          sessions: 0, 
          patterns: 0,
          correlations: 0, 
        }, 
      };
    }

    try {
      const incidentCount = await this.redis.zcard('incident:timeline');
      const sessionKeys = await this.redis.keys('session:*');
      const patternKeys = await this.redis.keys('pattern:*');
      
      const patterns = await this.detectPatterns();
      const totalCorrelations = patterns.reduce((sum, p) => sum + p.frequency, 0);

      return {
        ...baseStats,
        memory: {
          incidents: incidentCount,
          sessions: sessionKeys.length,
          patterns: patterns.length,
          correlations: totalCorrelations,
          avgPatternConfidence: patterns.length > 0 
            ? (patterns.reduce((sum, p) => sum + p.confidence, 0) / patterns.length).toFixed(2)
            : 0,
          topPatterns: patterns.slice(0, 3).map(p => ({
            description: p.description,
            frequency: p.frequency,
            confidence: `${(p.confidence * 100).toFixed(0)  }%`,
          })),
        },
      };
    } catch {
      return { ...baseStats, memory: { incidents: 0, sessions: 0, patterns: 0 } };
    }
  }
}