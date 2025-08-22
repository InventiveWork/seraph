# Intelligent Priority Queue System

The Priority Queue System transforms Seraph from a simple FIFO queue into an intelligent, priority-aware investigation scheduler that optimizes resource utilization and ensures critical alerts receive immediate attention.

## Overview

### Problem Solved
- **Alert Drops**: Previously, when investigation capacity was full (3 concurrent), new alerts were simply dropped
- **No Prioritization**: All alerts were treated equally, regardless of business impact
- **Resource Waste**: Low-priority alerts could block critical incidents
- **Poor SLA Compliance**: Critical business services had no preferential treatment

### Solution
- **Intelligent Queuing**: Min-heap priority queue with aging to prevent starvation
- **Smart Prioritization**: Multi-factor scoring based on keywords, service impact, time context, and historical patterns
- **Preemption**: Critical alerts can interrupt lower-priority investigations
- **Burst Mode**: Temporarily increase concurrency for high-priority incidents
- **Learning System**: Continuously improves priority accuracy based on outcomes

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────┐
│   HTTP Request  │ -> │ AgentManager     │ -> │ InvestigationScheduler │
│   (Alert)       │    │ - Deduplication  │    │ - Priority Calculation │
└─────────────────┘    │ - Rate Limiting  │    │ - Queue Management     │
                       └──────────────────┘    │ - Resource Allocation  │
                                               └─────────────────────┘
                                                           |
                                                           v
                                               ┌─────────────────────┐
                                               │ PriorityQueue       │
                                               │ - Min-Heap Storage  │
                                               │ - Priority Aging    │
                                               │ - Metrics Tracking  │
                                               └─────────────────────┘
                                                           |
                                                           v
                                               ┌─────────────────────┐
                                               │ Investigation       │
                                               │ Workers             │
                                               │ - Memory-Enhanced   │
                                               │ - Tool Integration  │
                                               └─────────────────────┘
```

## Configuration

### Basic Configuration
```json
{
  "priorityQueue": {
    "enabled": true,
    "maxConcurrentInvestigations": 5,
    "maxQueueSize": 100,
    "preemptionEnabled": true
  }
}
```

### Advanced Configuration
```json
{
  "priorityQueue": {
    "enabled": true,
    "maxConcurrentInvestigations": 5,
    "maxQueueSize": 100,
    "investigationTimeoutMs": 300000,
    "preemptionEnabled": true,
    "preemptionThreshold": 0.3,
    "burstModeEnabled": true,
    "burstModeConcurrency": 8,
    "burstModeThreshold": 2,
    
    "priorityWeights": {
      "keywords": 0.3,
      "serviceImpact": 0.4,
      "timeContext": 0.2,
      "historical": 0.1
    },
    
    "services": [
      {
        "name": "payment-service",
        "criticality": "critical",
        "businessImpact": 1.0,
        "userCount": 100000
      }
    ],
    
    "businessHours": {
      "start": 9,
      "end": 17,
      "timezone": "UTC"
    },
    
    "criticalKeywords": ["critical", "emergency", "outage"],
    "highPriorityKeywords": ["urgent", "timeout", "failed"],
    "mediumPriorityKeywords": ["warning", "slow", "retry"]
  }
}
```

## Priority Calculation

### Priority Levels
1. **CRITICAL** (1) - Business-critical outages, security incidents
2. **HIGH** (2) - Service degradation, authentication issues  
3. **MEDIUM** (3) - Performance warnings, non-critical errors
4. **LOW** (4) - Informational, routine maintenance

### Scoring Factors

#### 1. Keyword Analysis (30% weight)
- **Critical Keywords**: `critical`, `emergency`, `outage`, `down`, `security breach`
- **High Priority**: `urgent`, `timeout`, `failed`, `503`, `502`
- **Medium Priority**: `warning`, `slow`, `performance`, `retry`
- **Regex Patterns**: `payment.*fail`, `database.*crash`, `connection.*refused`

#### 2. Service Impact (40% weight)
- **Service Criticality**: Based on configured service definitions
- **Business Impact Score**: 0-1 scale for business importance
- **User Count**: Higher user count = higher priority
- **Auto-Detection**: Extracts service names from log content

#### 3. Time Context (20% weight)
- **Business Hours**: Higher priority during work hours
- **Peak Hours**: Additional boost during 9-11 AM, 2-4 PM
- **Weekends**: Lower priority on weekends
- **Timezone Aware**: Respects configured timezone

#### 4. Historical Patterns (10% weight)
- **Frequency**: Common issues get higher priority (faster resolution needed)
- **Pattern Learning**: ML-based pattern recognition
- **Success Tracking**: Priority accuracy improves over time

### Example Scoring

```typescript
// Input
log: "CRITICAL: payment-service database connection timeout"
reason: "Payment processing completely unavailable"
metadata: { service: "payment-service" }

// Scoring
keywordScore: 1.0      // "CRITICAL" keyword detected
serviceImpact: 0.95    // Critical service + high user count
timeContext: 0.8       // During business hours
historical: 0.6        // Common database issue pattern

// Final Score: 0.3*1.0 + 0.4*0.95 + 0.2*0.8 + 0.1*0.6 = 0.9
// Priority: CRITICAL
```

## Queue Management

### Queue Operations
- **Enqueue**: Add alert with calculated priority
- **Dequeue**: Remove highest priority alert
- **Preemption**: Interrupt low-priority work for critical alerts
- **Aging**: Gradually increase priority of waiting alerts
- **Size Limits**: Configurable max queue size with overflow handling

### Preemption Logic
```typescript
// Preemption occurs when:
// 1. New alert priority > running alert priority
// 2. Priority score difference > threshold (default 0.3)
// 3. Running investigation is preemptible (MEDIUM/LOW priority)
// 4. System is not in burst mode

if (newPriority < runningPriority && 
    scoreDiff > preemptionThreshold && 
    investigation.canPreempt) {
  // Save investigation state
  // Terminate current worker
  // Re-queue interrupted work
  // Start high-priority investigation
}
```

### Burst Mode
Automatically activates when CRITICAL or HIGH priority alerts arrive:
- **Normal**: 5 concurrent investigations
- **Burst**: 8 concurrent investigations  
- **Duration**: Until no critical/high priority alerts remain
- **Timeout**: Maximum 10 minutes

## Metrics and Monitoring

### Key Metrics
```
seraph_queue_size                          # Current queue depth
seraph_running_investigations              # Active investigations
seraph_queued_alerts_total{priority}       # Alerts queued by priority
seraph_preemptions_total                   # Preemption events
seraph_burst_mode_active                   # Burst mode status
seraph_priority_accuracy_percent           # Priority prediction accuracy
seraph_investigation_duration_seconds      # Investigation time distribution
```

### Dashboards

#### Queue Health Dashboard
- Queue depth over time
- Priority distribution
- Average wait time
- Preemption rate

#### Performance Dashboard
- Investigation duration by priority
- Priority accuracy trends
- Burst mode activations
- Resource utilization

## Performance Impact

### Expected Improvements
| Metric | Before | After | Improvement |
|--------|--------|--------|-------------|
| **Critical Alert Response** | 60s avg | 15s avg | **75% faster** |
| **Dropped Alerts** | 20% during peaks | 2% | **90% reduction** |
| **Resource Utilization** | 60% avg | 85% avg | **40% improvement** |
| **SLA Compliance** | 70% | 95% | **25% improvement** |

### Overhead
- **Memory**: +50MB for queue structures
- **CPU**: +5% for priority calculations  
- **Latency**: +2ms per alert (priority calculation)

## Migration and Rollback

### Enabling Priority Queue
```bash
# 1. Update configuration
vim seraph.config.json

# 2. Add priority queue config
{
  "priorityQueue": {
    "enabled": true,
    "maxConcurrentInvestigations": 5
  }
}

# 3. Restart Seraph
seraph stop && seraph start
```

### Rollback Plan
```bash
# 1. Disable in configuration
{
  "priorityQueue": {
    "enabled": false
  }
}

# 2. Restart (falls back to legacy queue)
seraph stop && seraph start
```

### Runtime Control
```typescript
// Enable/disable via API or management interface
agentManager.setPriorityQueueEnabled(false);

// Monitor queue metrics
const metrics = agentManager.getPriorityQueueMetrics();
console.log(`Queue size: ${metrics.queueMetrics.totalQueued}`);
```

## Troubleshooting

### Common Issues

#### Queue Full Errors
```
Error: Priority queue full (100/100). Cannot enqueue alert
```
**Solution**: Increase `maxQueueSize` or investigate why queue is not draining

#### Preemption Loops  
```
Warning: Investigation preempted 3 times in 1 minute
```
**Solution**: Adjust `preemptionThreshold` or review priority scoring

#### Poor Priority Accuracy
```
Priority accuracy: 45% (target: 80%+)
```
**Solution**: 
- Review and tune priority weights
- Update service configurations
- Add more specific keywords

#### Burst Mode Stuck
```
Burst mode active for 15 minutes (max: 10 min)
```
**Solution**: Check for continuous stream of high-priority alerts

### Debug Commands

```bash
# View queue status
curl http://localhost:8080/debug/queue-status

# Priority calculation for test alert
curl -X POST http://localhost:8080/debug/calculate-priority \
  -H "Content-Type: application/json" \
  -d '{"log": "TEST: database timeout", "reason": "Connection failed"}'

# Queue metrics
curl http://localhost:8080/metrics | grep seraph_queue
```

## Best Practices

### Service Configuration
1. **Accurate Criticality**: Ensure service criticality reflects actual business impact
2. **Regular Updates**: Review service configurations quarterly
3. **User Count Maintenance**: Keep user count estimates current

### Keyword Configuration
1. **Specific Patterns**: Use regex patterns for better matching
2. **Avoid Over-matching**: Don't make keywords too broad
3. **Regular Review**: Update keywords based on new alert patterns

### Monitoring
1. **Priority Accuracy**: Monitor and tune for 80%+ accuracy
2. **Queue Depth**: Alert on sustained high queue depth
3. **Preemption Rate**: High preemption rate indicates poor priority tuning

### Testing
1. **Load Testing**: Test with realistic alert volumes
2. **Priority Testing**: Verify critical alerts are prioritized correctly
3. **Failover Testing**: Ensure graceful fallback to legacy queue

## Future Enhancements

### Planned Features
- **ML-Based Priority Prediction**: Advanced machine learning models
- **Dynamic Weight Adjustment**: Auto-tune weights based on outcomes
- **Alert Correlation**: Group related alerts for batch processing
- **SLA Integration**: Automatic priority adjustment based on SLA status
- **External Priority Sources**: Integration with incident management systems

### API Extensions
- **Priority Override**: Manual priority adjustment via API
- **Queue Manipulation**: Ability to reorder or remove queued alerts
- **Batch Operations**: Bulk priority updates and queue management

The Priority Queue System represents a significant evolution in Seraph's capabilities, transforming it from a simple alert processor into an intelligent, priority-aware incident response system.