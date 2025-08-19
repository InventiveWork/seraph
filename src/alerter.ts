
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
          incidentId: incidentId,
          logHash: logHash,
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
      } catch (error: any) {
        console.error(`[AlerterClient] Failed to send initial alert for incident ${incidentId}:`, error.message);
      }
    }
    
    this.activeIncidents.set(incidentId, newAlert);
    return newAlert;
  }

  // Phase 2: Send the enriched, detailed analysis as an update
  public async sendEnrichedAnalysis(incidentId: string, finalAnalysis: any, reportId: string) {
    const incident = this.activeIncidents.get(incidentId);
    if (!incident) {
      console.error(`[AlerterClient] Cannot send enriched analysis for unknown incident ID: ${incidentId}`);
      return;
    }

    console.log(`[AlerterClient] SENDING ENRICHED ANALYSIS for [${incidentId}]`);
    console.log(JSON.stringify(finalAnalysis, null, 2));

    if (this.alertManagerUrl) {
      const alert = {
        labels: {
          alertname: 'SeraphAnomalyInvestigationComplete',
          incidentId: incidentId,
          status: 'resolved', // Or could be 'firing' if it's just an update
        },
        annotations: {
          summary: `Investigation complete for: ${finalAnalysis.rootCauseAnalysis}`,
          impact: finalAnalysis.impactAssessment,
          remediation: finalAnalysis.suggestedRemediation.join(' | '),
          reportId: `Report ID: ${reportId}. Use 'seraph reports view ${reportId}' to see the full investigation trace.`,
          disclaimer: 'This is an AI-generated analysis. Always verify the investigation trace before taking action.',
        },
      };
      
      try {
        await this.sendToAlertmanager([alert]);
        console.log(`[AlerterClient] Successfully sent enriched analysis to Alertmanager for incident ${incidentId}.`);
      } catch (error: any) {
        console.error(`[AlerterClient] Failed to send enriched analysis for incident ${incidentId}:`, error.message);
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
