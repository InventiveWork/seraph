// Alert Priority Calculator - Intelligent scoring for alert prioritization
import { AlertPriority, QueuedAlert } from './priority-queue';

export interface PriorityWeights {
  keywords: number;        // Weight for keyword-based scoring
  serviceImpact: number;   // Weight for service impact scoring
  timeContext: number;     // Weight for time-based context
  historical: number;      // Weight for historical patterns
}

export interface ServiceConfig {
  name: string;
  criticality: 'critical' | 'high' | 'medium' | 'low';
  businessImpact: number;  // 0-1 scale
  userCount?: number;      // Estimated affected users
}

export interface PriorityCalculatorConfig {
  weights: PriorityWeights;
  services: ServiceConfig[];
  businessHours: {
    start: number; // Hour of day (0-23)
    end: number;   // Hour of day (0-23)
    timezone: string;
  };
  criticalKeywords: string[];
  highPriorityKeywords: string[];
  mediumPriorityKeywords: string[];
}

export interface PriorityResult {
  priority: AlertPriority;
  score: number;
  breakdown: {
    keywordScore: number;
    serviceImpactScore: number;
    timeContextScore: number;
    historicalScore: number;
  };
  reasoning: string[];
}

export class AlertPriorityCalculator {
  private config: PriorityCalculatorConfig;
  private serviceMap = new Map<string, ServiceConfig>();
  private historicalPatterns = new Map<string, number>(); // pattern -> frequency
  
  // Keyword patterns with different priority levels
  private criticalPatterns = [
    /critical|emergency|down|outage|unavailable|disaster/i,
    /payment.*fail|transaction.*error|billing.*issue/i,
    /database.*crash|db.*down|data.*corruption/i,
    /security.*breach|unauthorized.*access|attack/i,
  ];
  
  private highPriorityPatterns = [
    /high|urgent|severe|major/i,
    /timeout|connection.*refused|service.*unavailable/i,
    /memory.*leak|cpu.*spike|disk.*full/i,
    /authentication.*fail|login.*issue/i,
  ];
  
  private mediumPriorityPatterns = [
    /warning|warn|medium|moderate/i,
    /slow|performance|latency|delay/i,
    /retry|backoff|rate.*limit/i,
  ];

  constructor(config: PriorityCalculatorConfig) {
    this.config = config;
    this.buildServiceMap();
    this.initializeHistoricalPatterns();
  }

  /**
   * Calculate priority and score for an alert
   */
  calculatePriority(log: string, reason: string, metadata?: any): PriorityResult {
    const breakdown = {
      keywordScore: this.calculateKeywordScore(log, reason),
      serviceImpactScore: this.calculateServiceImpactScore(log, reason, metadata),
      timeContextScore: this.calculateTimeContextScore(),
      historicalScore: this.calculateHistoricalScore(log, reason),
    };

    // Weighted score calculation
    const totalScore = 
      breakdown.keywordScore * this.config.weights.keywords +
      breakdown.serviceImpactScore * this.config.weights.serviceImpact +
      breakdown.timeContextScore * this.config.weights.timeContext +
      breakdown.historicalScore * this.config.weights.historical;

    const priority = this.scoreToPriority(totalScore);
    const reasoning = this.buildReasoning(breakdown, priority, log, reason);

    return {
      priority,
      score: totalScore,
      breakdown,
      reasoning,
    };
  }

  /**
   * Update historical patterns based on completed investigations
   */
  updateHistoricalPattern(log: string, reason: string, actualPriority: AlertPriority, investigationTime: number): void {
    const pattern = this.extractPattern(log, reason);
    const frequency = this.historicalPatterns.get(pattern) || 0;
    
    // Weight recent patterns more heavily
    const newFrequency = frequency * 0.9 + (actualPriority <= AlertPriority.HIGH ? 1 : 0.5);
    this.historicalPatterns.set(pattern, newFrequency);
    
    // Prune old patterns to prevent memory growth
    if (this.historicalPatterns.size > 1000) {
      this.pruneHistoricalPatterns();
    }
  }

  /**
   * Batch update for service configurations
   */
  updateServiceConfigs(services: ServiceConfig[]): void {
    this.config.services = services;
    this.buildServiceMap();
  }

  /**
   * Get current configuration
   */
  getConfig(): PriorityCalculatorConfig {
    return { ...this.config };
  }

  // Private calculation methods

  private calculateKeywordScore(log: string, reason: string): number {
    const text = `${log} ${reason}`.toLowerCase();
    
    // Check critical patterns first
    for (const pattern of this.criticalPatterns) {
      if (pattern.test(text)) {
        return 1.0; // Maximum keyword score
      }
    }
    
    // Check high priority patterns
    for (const pattern of this.highPriorityPatterns) {
      if (pattern.test(text)) {
        return 0.8;
      }
    }
    
    // Check medium priority patterns
    for (const pattern of this.mediumPriorityPatterns) {
      if (pattern.test(text)) {
        return 0.6;
      }
    }
    
    // Check configured keywords
    const criticalKeywords = this.config.criticalKeywords || [];
    const highKeywords = this.config.highPriorityKeywords || [];
    const mediumKeywords = this.config.mediumPriorityKeywords || [];
    
    for (const keyword of criticalKeywords) {
      if (text.includes(keyword.toLowerCase())) {
        return 1.0;
      }
    }
    
    for (const keyword of highKeywords) {
      if (text.includes(keyword.toLowerCase())) {
        return 0.8;
      }
    }
    
    for (const keyword of mediumKeywords) {
      if (text.includes(keyword.toLowerCase())) {
        return 0.6;
      }
    }
    
    return 0.3; // Default low score
  }

  private calculateServiceImpactScore(log: string, reason: string, metadata?: any): number {
    const text = `${log} ${reason}`.toLowerCase();
    
    // Try to identify service from metadata first
    let service: ServiceConfig | undefined;
    if (metadata?.service) {
      service = this.serviceMap.get(metadata.service);
    }
    
    // If not in metadata, try to extract from log content
    if (!service) {
      service = this.extractServiceFromText(text);
    }
    
    if (!service) {
      return 0.4; // Default score for unknown service
    }
    
    // Score based on service criticality
    const criticalityScores = {
      'critical': 1.0,
      'high': 0.8,
      'medium': 0.6,
      'low': 0.4,
    };
    
    let score = criticalityScores[service.criticality];
    
    // Boost score based on business impact
    score = score * (0.7 + 0.3 * service.businessImpact);
    
    // Additional boost for high user count
    if (service.userCount && service.userCount > 10000) {
      score = Math.min(1.0, score * 1.2);
    }
    
    return score;
  }

  private calculateTimeContextScore(): number {
    const now = new Date();
    const hour = now.getUTCHours(); // Use UTC hours for consistency
    const isWeekend = now.getUTCDay() === 0 || now.getUTCDay() === 6;
    
    let score = 0.4; // Base score
    
    // Higher priority during business hours
    if (hour >= this.config.businessHours.start && hour <= this.config.businessHours.end) {
      score += 0.4; // Increased from 0.3 to ensure > 0.7 during business hours
    }
    
    // Lower priority on weekends
    if (isWeekend) {
      score -= 0.2;
    }
    
    // Higher priority during peak hours (assume 9-11 AM, 2-4 PM)
    if ((hour >= 9 && hour <= 11) || (hour >= 14 && hour <= 16)) {
      score += 0.3; // Increased from 0.2 to ensure > 0.8 during peak hours
    }
    
    return Math.max(0, Math.min(1, score));
  }

  private calculateHistoricalScore(log: string, reason: string): number {
    const pattern = this.extractPattern(log, reason);
    const frequency = this.historicalPatterns.get(pattern) || 0;
    
    // Convert frequency to score (0-1)
    // Higher frequency = higher priority (common problems need faster resolution)
    return Math.min(1.0, frequency / 10);
  }

  private scoreToPriority(score: number): AlertPriority {
    if (score >= 0.85) {return AlertPriority.CRITICAL;}  // Raised threshold 
    if (score >= 0.65) {return AlertPriority.HIGH;}      // Raised threshold
    if (score >= 0.4) {return AlertPriority.MEDIUM;}
    return AlertPriority.LOW;
  }

  private buildReasoning(breakdown: any, priority: AlertPriority, log: string, reason: string): string[] {
    const reasoning: string[] = [];
    
    const totalScore = breakdown.keywordScore * this.config.weights.keywords +
                      breakdown.serviceImpactScore * this.config.weights.serviceImpact +
                      breakdown.timeContextScore * this.config.weights.timeContext +
                      breakdown.historicalScore * this.config.weights.historical;
    
    reasoning.push(`Priority: ${AlertPriority[priority]} (score: ${totalScore.toFixed(1)})`);
    
    if (breakdown.keywordScore > 0.8) {
      reasoning.push(`Critical keywords detected in: "${reason}"`);
    }
    
    if (breakdown.serviceImpactScore > 0.8) {
      reasoning.push('High service impact - affects critical business function');
    }
    
    if (breakdown.timeContextScore > 0.7) {
      reasoning.push('During business hours - higher user impact expected');
    }
    
    if (breakdown.historicalScore > 0.6) {
      reasoning.push('Common issue pattern - requires swift resolution');
    }
    
    if (breakdown.keywordScore < 0.4 && breakdown.serviceImpactScore < 0.4) {
      reasoning.push('Low impact alert - can be handled with standard priority');
    }
    
    return reasoning;
  }

  private extractServiceFromText(text: string): ServiceConfig | undefined {
    // Try to match service names in the log text
    for (const [serviceName, serviceConfig] of this.serviceMap) {
      if (text.includes(serviceName.toLowerCase()) || 
          text.includes(serviceName.toLowerCase().replace(/-/g, '_'))) {
        return serviceConfig;
      }
    }
    
    // Try common service patterns
    const servicePatterns = [
      { pattern: /payment|billing|checkout/, name: 'payment-service' },
      { pattern: /auth|login|user|account/, name: 'auth-service' },
      { pattern: /database|db|postgres|mysql/, name: 'database' },
      { pattern: /api|gateway|proxy/, name: 'api-gateway' },
      { pattern: /notification|email|sms/, name: 'notification-service' },
    ];
    
    for (const { pattern, name } of servicePatterns) {
      if (pattern.test(text)) {
        return this.serviceMap.get(name);
      }
    }
    
    return undefined;
  }

  private extractPattern(log: string, reason: string): string {
    // Extract a normalized pattern for historical tracking
    const text = `${log} ${reason}`.toLowerCase();
    
    // Remove specific values but keep structure
    const pattern = text
      .replace(/\d+/g, 'N')                    // Numbers -> N
      .replace(/[a-f0-9-]{8,}/g, 'ID')         // IDs -> ID  
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, 'TIMESTAMP') // Timestamps
      .replace(/https?:\/\/[^\s]+/g, 'URL')    // URLs
      .replace(/\s+/g, ' ')                    // Normalize spaces
      .trim();
    
    return pattern.substring(0, 200); // Limit pattern length
  }

  private buildServiceMap(): void {
    this.serviceMap.clear();
    for (const service of this.config.services) {
      this.serviceMap.set(service.name, service);
    }
  }

  private initializeHistoricalPatterns(): void {
    // Initialize with some common patterns
    // In production, this would be loaded from persistent storage
    this.historicalPatterns.set('error database connection timeout', 5);
    this.historicalPatterns.set('warning high cpu usage detected', 3);
    this.historicalPatterns.set('critical service unavailable', 8);
    this.historicalPatterns.set('info deployment completed successfully', 1);
  }

  private pruneHistoricalPatterns(): void {
    // Keep only the top 500 patterns by frequency
    const sorted = Array.from(this.historicalPatterns.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 500);
    
    this.historicalPatterns.clear();
    for (const [pattern, frequency] of sorted) {
      this.historicalPatterns.set(pattern, frequency);
    }
  }
}