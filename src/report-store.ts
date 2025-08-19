import { gzipSync, gunzipSync } from 'zlib';
import { v4 as uuidv4 } from 'uuid';
import { getPool, SQLitePool } from './db-pool';
import { sanitizeErrorMessage } from './validation';

export interface Report {
  incidentId: string;
  timestamp: string;
  initialLog: string;
  triageReason: string;
  investigationTrace: any;
  finalAnalysis: any;
  status: 'open' | 'acknowledged' | 'resolved';
}

export class ReportStore {
  private pool: SQLitePool;
  private isInitialized: boolean = false;

  constructor(dbPath: string = 'reports.db') {
    this.pool = getPool(dbPath);
    this.init();
  }

  private async init(): Promise<void> {
    if (this.isInitialized) return;
    
    try {
      await this.pool.execute(async (conn) => {
        const sql = `
          CREATE TABLE IF NOT EXISTS reports (
            incidentId TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            initialLog TEXT NOT NULL,
            triageReason TEXT,
            investigationTrace BLOB,
            finalAnalysis BLOB,
            status TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `;
        await conn.run(sql);
        
        // Create index for better query performance
        await conn.run(`
          CREATE INDEX IF NOT EXISTS idx_reports_timestamp 
          ON reports(timestamp);
        `);
        
        await conn.run(`
          CREATE INDEX IF NOT EXISTS idx_reports_status 
          ON reports(status);
        `);
      });
      
      this.isInitialized = true;
      console.log('ReportStore initialized successfully with connection pooling');
    } catch (error) {
      const sanitizedError = sanitizeErrorMessage(error as Error);
      console.error('Error initializing ReportStore:', sanitizedError);
      throw error;
    }
  }

  public async saveReport(report: Omit<Report, 'incidentId' | 'timestamp' | 'status'>): Promise<Report> {
    await this.init(); // Ensure initialized
    
    try {
      const newReport: Report = {
        ...report,
        incidentId: uuidv4(),
        timestamp: new Date().toISOString(),
        status: 'open',
      };

      const compressedTrace = gzipSync(JSON.stringify(newReport.investigationTrace));
      const compressedAnalysis = gzipSync(JSON.stringify(newReport.finalAnalysis));

      await this.pool.execute(async (conn) => {
        const sql = `
          INSERT INTO reports (incidentId, timestamp, initialLog, triageReason, investigationTrace, finalAnalysis, status)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `;

        await conn.run(sql, [
          newReport.incidentId,
          newReport.timestamp,
          newReport.initialLog,
          newReport.triageReason,
          compressedTrace,
          compressedAnalysis,
          newReport.status,
        ]);
      });

      return newReport;
    } catch (error) {
      const sanitizedError = sanitizeErrorMessage(error as Error);
      console.error('Error saving report:', sanitizedError);
      throw new Error(`Failed to save report: ${sanitizedError}`);
    }
  }

  public async listReports(): Promise<Omit<Report, 'investigationTrace' | 'finalAnalysis'>[]> {
    await this.init(); // Ensure initialized
    
    try {
      return await this.pool.execute(async (conn) => {
        const sql = 'SELECT incidentId, timestamp, initialLog, triageReason, status FROM reports ORDER BY timestamp DESC LIMIT 100';
        const rows = await conn.all(sql, []);
        return rows;
      });
    } catch (error) {
      const sanitizedError = sanitizeErrorMessage(error as Error);
      console.error('Error listing reports:', sanitizedError);
      throw new Error(`Failed to list reports: ${sanitizedError}`);
    }
  }

  public async getReport(incidentId: string): Promise<Report | null> {
    await this.init(); // Ensure initialized
    
    try {
      return await this.pool.execute(async (conn) => {
        const sql = 'SELECT * FROM reports WHERE incidentId = ?';
        const row = await conn.get(sql, [incidentId]);
        
        if (row) {
          const report: Report = {
            ...row,
            investigationTrace: JSON.parse(gunzipSync(row.investigationTrace).toString()),
            finalAnalysis: JSON.parse(gunzipSync(row.finalAnalysis).toString()),
          };
          return report;
        }
        
        return null;
      });
    } catch (error) {
      const sanitizedError = sanitizeErrorMessage(error as Error);
      console.error('Error getting report:', sanitizedError);
      throw new Error(`Failed to get report: ${sanitizedError}`);
    }
  }

  public async pruneOldReports(days: number): Promise<void> {
    await this.init(); // Ensure initialized
    
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);
      const cutoffIsoString = cutoffDate.toISOString();

      const result = await this.pool.execute(async (conn) => {
        const sql = 'DELETE FROM reports WHERE timestamp < ?';
        return await conn.run(sql, [cutoffIsoString]);
      });

      console.log(`Successfully pruned ${result.changes || 0} reports older than ${days} days.`);
    } catch (error) {
      const sanitizedError = sanitizeErrorMessage(error as Error);
      console.error('Error pruning old reports:', sanitizedError);
    }
  }

  public async close(): Promise<void> {
    try {
      await this.pool.close();
      console.log('Database connection pool closed.');
    } catch (error) {
      const sanitizedError = sanitizeErrorMessage(error as Error);
      console.error('Error closing database pool:', sanitizedError);
      throw error;
    }
  }

  public getPoolStats() {
    return this.pool.getStats();
  }
}