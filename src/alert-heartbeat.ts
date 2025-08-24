import { AlerterClient } from './alerter';
import fetch from 'node-fetch';

export interface ActiveAlert {
  incidentId: string;
  alertname: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  lastSent: Date;
  resolved: boolean;
}

export class AlertHeartbeatManager {
  private activeAlerts: Map<string, ActiveAlert> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private alertManagerUrl: string;
  
  constructor(
    alertManagerUrl: string,
    private heartbeatIntervalMs: number = 30000 // Default 30 seconds
  ) {
    this.alertManagerUrl = alertManagerUrl;
  }

  /**
   * Start the heartbeat manager to keep alerts active
   */
  start(): void {
    if (this.heartbeatInterval) {
      return; // Already running
    }

    console.log(`[AlertHeartbeat] Starting heartbeat manager (interval: ${this.heartbeatIntervalMs}ms)`);
    
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeats();
    }, this.heartbeatIntervalMs);
  }

  /**
   * Stop the heartbeat manager
   */
  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log('[AlertHeartbeat] Heartbeat manager stopped');
    }
  }

  /**
   * Register an alert to keep active
   */
  registerAlert(
    incidentId: string,
    alertname: string,
    labels: Record<string, string>,
    annotations: Record<string, string>
  ): void {
    this.activeAlerts.set(incidentId, {
      incidentId,
      alertname,
      labels,
      annotations,
      lastSent: new Date(),
      resolved: false,
    });
    
    console.log(`[AlertHeartbeat] Registered alert ${incidentId} for heartbeat`);
  }

  /**
   * Mark an alert as resolved and stop sending heartbeats
   */
  resolveAlert(incidentId: string): void {
    const alert = this.activeAlerts.get(incidentId);
    if (alert) {
      alert.resolved = true;
      // Send final resolved alert
      this.sendResolvedAlert(alert);
      // Remove from active alerts
      this.activeAlerts.delete(incidentId);
      console.log(`[AlertHeartbeat] Resolved alert ${incidentId}`);
    }
  }

  /**
   * Send heartbeats for all active alerts
   */
  private async sendHeartbeats(): Promise<void> {
    const alertsToSend: any[] = [];
    const now = new Date();

    for (const [incidentId, alert] of this.activeAlerts) {
      if (!alert.resolved) {
        // Set endsAt to 5 minutes in the future to keep alert active
        const endsAt = new Date(now.getTime() + 5 * 60 * 1000);
        
        alertsToSend.push({
          labels: {
            ...alert.labels,
            alertname: alert.alertname,
            incidentId: alert.incidentId,
            status: 'firing',
          },
          annotations: {
            ...alert.annotations,
            lastHeartbeat: now.toISOString(),
          },
          startsAt: alert.lastSent.toISOString(),
          endsAt: endsAt.toISOString(),
        });

        alert.lastSent = now;
      }
    }

    if (alertsToSend.length > 0) {
      try {
        await this.sendToAlertmanager(alertsToSend);
        console.log(`[AlertHeartbeat] Sent heartbeat for ${alertsToSend.length} active alerts`);
      } catch (error) {
        console.error('[AlertHeartbeat] Failed to send heartbeats:', error);
      }
    }
  }

  /**
   * Send a resolved alert to Alertmanager
   */
  private async sendResolvedAlert(alert: ActiveAlert): Promise<void> {
    const now = new Date();
    
    try {
      await this.sendToAlertmanager([{
        labels: {
          ...alert.labels,
          alertname: alert.alertname,
          incidentId: alert.incidentId,
          status: 'resolved',
        },
        annotations: {
          ...alert.annotations,
          resolvedAt: now.toISOString(),
        },
        startsAt: alert.lastSent.toISOString(),
        endsAt: now.toISOString(), // Set endsAt to now to mark as resolved
      }]);
      
      console.log(`[AlertHeartbeat] Sent resolved status for alert ${alert.incidentId}`);
    } catch (error) {
      console.error(`[AlertHeartbeat] Failed to send resolved status for ${alert.incidentId}:`, error);
    }
  }

  /**
   * Send alerts to Alertmanager
   */
  private async sendToAlertmanager(alerts: any[]): Promise<void> {
    if (!this.alertManagerUrl) {
      throw new Error('Alertmanager URL is not configured');
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

  /**
   * Get current active alerts
   */
  getActiveAlerts(): ActiveAlert[] {
    return Array.from(this.activeAlerts.values()).filter(a => !a.resolved);
  }
}