import { SeraphConfig } from './config';
import fetch from 'node-fetch';

export class AlerterClient {
  private alertManagerUrl: string;

  constructor(private config: SeraphConfig) {
    this.alertManagerUrl = this.config.alertManager?.url || '';
  }

  public async sendAlert(context: Record<string, any>) {
    if (!this.alertManagerUrl) {
      console.error('[AlerterClient] Alertmanager URL is not configured. Cannot send alert.');
      return;
    }

    console.log('[AlerterClient] Sending alert with context:', JSON.stringify(context, null, 2));

    const alert = {
      labels: {
        alertname: 'SeraphAnomalyDetected',
        source: context.source || 'unknown',
        type: context.type || 'unknown',
      },
      annotations: {
        summary: `Anomaly detected in ${context.source}`,
        description: context.details || 'No details provided.',
        log: context.log || 'No log provided.',
      },
    };

    try {
      const response = await (fetch as any)(this.alertManagerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([alert]),
      });

      if (!response.ok) {
        throw new Error(`Alertmanager returned an error: ${response.statusText} - ${await response.text()}`);
      }

      console.log('[AlerterClient] Successfully sent alert to Alertmanager.');

    } catch (error: any) {
      console.error('[AlerterClient] Failed to send alert:', error.message);
    }
  }
}