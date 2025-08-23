
import { SeraphConfig } from './config';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

interface InitialAlert {
  incidentId: string;
  // In a real implementation, this would store a message ID from Slack, a PagerDuty incident key, etc.
  externalId?: string; 
}

export class AlerterClient {
  private alertManagerUrl: string;
  private activeIncidents: Map<string, InitialAlert> = new Map();

  constructor(private config: SeraphConfig) {
    let baseUrl = this.config.alertManager?.url || '';
    if (baseUrl) {
      // Remove trailing slash if present
      if (baseUrl.endsWith('/')) {
        baseUrl = baseUrl.slice(0, -1);
      }
      // Ensure the final URL is correct
      if (baseUrl.endsWith('/api/v2/alerts')) {
        this.alertManagerUrl = baseUrl;
      } else {
        this.alertManagerUrl = `${baseUrl}/api/v2/alerts`;
      }
    } else {
      this.alertManagerUrl = '';
    }
  }

  // Phase 1: Send the initial, simple alert
  public async sendInitialAlert(log: string, reason: string): Promise<InitialAlert> {
    const incidentId = uuidv4();
    const newAlert: InitialAlert = { incidentId };

    console.log(`[AlerterClient] FIRING INITIAL ALERT [${incidentId}] - Reason: ${reason}`);
    
    if (this.alertManagerUrl) {
      const logHash = createHash('sha256').update(log).digest('hex').substring(0, 8);
      const alert = {
        labels: {
          alertname: 'SeraphAnomalyTriage',
          incidentId,
          logHash,
          status: 'firing',
        },
        annotations: {
          summary: `New anomaly detected: ${reason}`,
          description: `Initial analysis of log: "${log.substring(0, 200)}..."`,
        },
      };

      try {
        await this.sendToAlertmanager([alert]);
        console.log(`[AlerterClient] Successfully sent initial alert to Alertmanager for incident ${incidentId}.`);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[AlerterClient] Failed to send initial alert for incident ${incidentId}:`, errorMessage);
      }
    }
    
    this.activeIncidents.set(incidentId, newAlert);
    return newAlert;
  }

  private formatRemediationSteps(steps: string[]): string {
    if (!steps || steps.length === 0) {
      return 'No specific remediation steps provided.';
    }
    
    // Format as numbered markdown list with code blocks for commands
    return steps.map((step, index) => {
      // Detect if step contains commands (kubectl, docker, etc.)
      const hasCommand = /\b(kubectl|docker|systemctl|curl|ssh|cat|grep|ps|kill)\s/.test(step);
      
      if (hasCommand) {
        // Extract and format commands with code blocks
        const formatted = step.replace(
          /(kubectl [^"'\n]+|docker [^"'\n]+|systemctl [^"'\n]+)/g, 
          '`$1`',
        );
        return `${index + 1}. ${formatted}`;
      } else {
        return `${index + 1}. ${step}`;
      }
    }).join('\n\n');
  }

  private formatToolDetails(toolDetails: string): string {
    if (!toolDetails) {
      return 'No tool execution details available.';
    }
    
    // Format tool details with better markdown structure
    const lines = toolDetails.split('\n');
    return lines.map(line => {
      // Add code formatting for tool names and arguments
      return line.replace(
        /(\d{1,2}:\d{2}:\d{2} [AP]M) ([✓✗]) (\w+) (\([^)]+\)): (.+)/,
        '`$1` $2 **$3** $4: `$5`',
      );
    }).join('\n\n');
  }

  private formatMultilineText(text: string): string {
    if (!text) {
      return 'No information available.';
    }
    
    // Preserve line breaks and format for better readability
    return text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n\n');
  }

  private truncateText(text: string, maxLength: number): string {
    if (!text) {
      return 'No information available.';
    }
    
    if (text.length <= maxLength) {
      return text;
    }
    
    return `${text.substring(0, maxLength - 3)  }...`;
  }

  // Phase 2: Send the enriched, detailed analysis as an update
  public async sendEnrichedAnalysis(incidentId: string, finalAnalysis: any, reportId: string, toolUsage?: Array<{tool: string, timestamp: string, args: any, success: boolean, executionTime?: number}>) {
    const incident = this.activeIncidents.get(incidentId);
    if (!incident) {
      console.error(`[AlerterClient] Cannot send enriched analysis for unknown incident ID: ${incidentId}`);
      return;
    }

    console.log(`[AlerterClient] SENDING ENRICHED ANALYSIS for [${incidentId}]`);
    console.log(JSON.stringify(finalAnalysis, null, 2));

    if (this.alertManagerUrl) {
      // Generate tool usage summary
      let toolUsageSummary = 'No tools used';
      let toolDetails = '';
      
      if (toolUsage && toolUsage.length > 0) {
        const successfulTools = toolUsage.filter(t => t.success);
        
        const toolCounts = toolUsage.reduce((acc, usage) => {
          acc[usage.tool] = (acc[usage.tool] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        
        const avgExecutionTime = toolUsage.length > 0 
          ? toolUsage.reduce((acc, usage) => acc + (usage.executionTime || 0), 0) / toolUsage.length 
          : 0;
        
        toolUsageSummary = `${successfulTools.length}/${toolUsage.length} tools succeeded`;
        
        // Create detailed tool timeline
        toolDetails = toolUsage.map(usage => {
          const time = new Date(usage.timestamp).toLocaleTimeString();
          const status = usage.success ? '✓' : '✗';
          const duration = usage.executionTime ? `(${usage.executionTime}ms)` : '';
          const args = JSON.stringify(usage.args).length > 100 ? 
            `${JSON.stringify(usage.args).substring(0, 100)  }...` : 
            JSON.stringify(usage.args);
          return `${time} ${status} ${usage.tool} ${duration}: ${args}`;
        }).join('\n');
        
        // Add tool count summary
        const toolCountSummary = Object.entries(toolCounts)
          .map(([tool, count]) => `${tool}(${count})`)
          .join(', ');
        
        toolUsageSummary += ` | Tools: ${toolCountSummary} | Avg: ${Math.round(avgExecutionTime)}ms`;
      }

      const alert = {
        labels: {
          alertname: 'SeraphAnomalyInvestigationComplete',
          incidentId,
          status: 'firing', // Keep alert active in AlertManager
          toolsUsed: toolUsage ? toolUsage.length.toString() : '0',
          toolSuccessRate: toolUsage && toolUsage.length > 0 ? 
            `${Math.round((toolUsage.filter(t => t.success).length / toolUsage.length) * 100).toString()  }%` : '0%',
        },
        annotations: {
          summary: `Investigation complete for: ${this.truncateText(finalAnalysis.rootCauseAnalysis, 120)}`,
          rootCause: this.formatMultilineText(finalAnalysis.rootCauseAnalysis),
          impact: this.formatMultilineText(finalAnalysis.impactAssessment),
          remediation: this.formatRemediationSteps(finalAnalysis.suggestedRemediation),
          toolUsageSummary,
          toolDetails: this.formatToolDetails(toolDetails),
          reportId: `Report ID: ${reportId}. Use 'seraph reports view ${reportId}' to see the full investigation trace.`,
          disclaimer: 'This is an AI-generated analysis. Always verify the investigation trace before taking action.',
        },
      };
      
      try {
        await this.sendToAlertmanager([alert]);
        console.log(`[AlerterClient] Successfully sent enriched analysis to Alertmanager for incident ${incidentId}.`);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[AlerterClient] Failed to send enriched analysis for incident ${incidentId}:`, errorMessage);
      }
    }

    // Clean up the incident from the active map
    this.activeIncidents.delete(incidentId);
  }

  private async sendToAlertmanager(alerts: any[]) {
    if (!this.alertManagerUrl) {
      throw new Error('Alertmanager URL is not configured.');
    }

    const response = await fetch(this.alertManagerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(alerts),
    });

    if (!response.ok) {
      throw new Error(`Alertmanager returned an error: ${response.statusText} - ${await response.text()}`);
    }
  }

  // Original sendAlert for other system events (e.g., worker crashes)
  public async sendSystemAlert(context: Record<string, any>) {
    console.log('[AlerterClient] Sending system alert:', JSON.stringify(context, null, 2));
    const alert = {
      labels: {
        alertname: 'SeraphSystemEvent',
        source: context.source || 'unknown',
        type: context.type || 'unknown',
      },
      annotations: {
        summary: `System event in ${context.source}`,
        description: context.details || 'No details provided.',
      },
    };
    await this.sendToAlertmanager([alert]);
  }
}
