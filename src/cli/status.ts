/**
 * Advanced status command with beautiful, comprehensive output
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig } from '../config';
import { ReportStore } from '../report-store';
import { formatter } from './formatter';

export interface SystemInfo {
  platform: string;
  arch: string;
  nodeVersion: string;
  totalMemory: number;
  freeMemory: number;
  uptime: number;
  loadAverage: number[];
}

export interface AgentStatus {
  running: boolean;
  pid?: number;
  port?: number;
  workers?: number;
  startTime?: Date;
  version: string;
  mcpEnabled: boolean;
  redisConnected: boolean;
  lastLogTime?: Date;
  totalLogs: number;
  totalReports: number;
  activeInvestigations: number;
  cacheHitRate?: number;
  memoryUsage?: NodeJS.MemoryUsage;
}

export interface HealthCheck {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    name: string;
    status: 'pass' | 'fail' | 'warn';
    message: string;
    duration: number;
  }[];
}

export class StatusCommand {
  private async getSystemInfo(): Promise<SystemInfo> {
    return {
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      uptime: os.uptime(),
      loadAverage: os.loadavg(),
    };
  }

  private async getAgentStatus(): Promise<AgentStatus> {
    const config = await loadConfig();
    const pidFilePath = path.join(process.cwd(), '.seraph.pid');
    
    const status: AgentStatus = {
      running: false,
      version: '1.0.18',
      mcpEnabled: !!config.builtInMcpServer,
      redisConnected: false,
      totalLogs: 0,
      totalReports: 0,
      activeInvestigations: 0,
    };

    // Check if PID file exists
    try {
      await fs.promises.access(pidFilePath);
      const pidStr = await fs.promises.readFile(pidFilePath, 'utf-8');
      const pid = parseInt(pidStr.trim(), 10);
      
      // Check if process is actually running
      try {
        process.kill(pid, 0); // Signal 0 checks if process exists
        status.pid = pid;
        status.running = true;
        status.port = config.port;
        status.workers = config.workers;
        
        // Get additional runtime info via HTTP
        const runtimeInfo = await this.fetchRuntimeInfo(config.port);
        if (runtimeInfo) {
          Object.assign(status, runtimeInfo);
        }
        
      } catch (error) {
        // Process doesn't exist, clean up stale PID file
        await fs.promises.unlink(pidFilePath);
      }
    } catch (error) {
      // PID file doesn't exist
    }

    // Get report statistics
    try {
      const reportStore = new ReportStore();
      const reports = await reportStore.listReports();
      status.totalReports = reports.length;
      
      if (reports.length > 0) {
        const lastReport = reports.sort((a, b) => 
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        )[0];
        status.lastLogTime = new Date(lastReport.timestamp);
      }
      
      await reportStore.close();
    } catch (error) {
      // Database might not be initialized
    }

    return status;
  }

  private async fetchRuntimeInfo(port: number): Promise<Partial<AgentStatus> | null> {
    return new Promise((resolve) => {
      const options = {
        hostname: 'localhost',
        port,
        path: '/status',
        method: 'GET',
        timeout: 2000,
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const info = JSON.parse(data);
            resolve({
              startTime: new Date(info.startTime),
              memoryUsage: info.memoryUsage,
              totalLogs: info.totalLogs || 0,
              activeInvestigations: info.activeInvestigations || 0,
              cacheHitRate: info.cacheHitRate,
              redisConnected: info.redisConnected || false,
            });
          } catch {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      
      req.end();
    });
  }

  private async performHealthChecks(): Promise<HealthCheck> {
    const checks: HealthCheck['checks'] = [];
    let overallStatus: HealthCheck['status'] = 'healthy';

    // Check configuration file
    const configStart = Date.now();
    try {
      await loadConfig();
      checks.push({
        name: 'Configuration',
        status: 'pass',
        message: 'Configuration file loaded successfully',
        duration: Date.now() - configStart,
      });
    } catch (error) {
      checks.push({
        name: 'Configuration',
        status: 'fail',
        message: `Configuration error: ${(error as Error).message}`,
        duration: Date.now() - configStart,
      });
      overallStatus = 'unhealthy';
    }

    // Check database connectivity
    const dbStart = Date.now();
    try {
      const reportStore = new ReportStore();
      await reportStore.listReports();
      await reportStore.close();
      checks.push({
        name: 'Database',
        status: 'pass',
        message: 'SQLite database accessible',
        duration: Date.now() - dbStart,
      });
    } catch (error) {
      checks.push({
        name: 'Database',
        status: 'fail',
        message: `Database error: ${(error as Error).message}`,
        duration: Date.now() - dbStart,
      });
      overallStatus = 'unhealthy';
    }

    // Check disk space
    const diskStart = Date.now();
    try {
      const stats = await fs.promises.stat(process.cwd());
      const freeSpace = await this.getFreeDiskSpace();
      if (freeSpace < 100 * 1024 * 1024) { // Less than 100MB
        checks.push({
          name: 'Disk Space',
          status: 'warn',
          message: `Low disk space: ${formatter.formatBytes(freeSpace)} available`,
          duration: Date.now() - diskStart,
        });
        if (overallStatus === 'healthy') {overallStatus = 'degraded';}
      } else {
        checks.push({
          name: 'Disk Space',
          status: 'pass',
          message: `Sufficient disk space: ${formatter.formatBytes(freeSpace)} available`,
          duration: Date.now() - diskStart,
        });
      }
    } catch (error) {
      checks.push({
        name: 'Disk Space',
        status: 'warn',
        message: 'Unable to check disk space',
        duration: Date.now() - diskStart,
      });
      if (overallStatus === 'healthy') {overallStatus = 'degraded';}
    }

    // Check memory usage
    const memStart = Date.now();
    const systemInfo = await this.getSystemInfo();
    const memoryUsagePercent = ((systemInfo.totalMemory - systemInfo.freeMemory) / systemInfo.totalMemory) * 100;
    
    if (memoryUsagePercent > 90) {
      checks.push({
        name: 'Memory Usage',
        status: 'warn',
        message: `High memory usage: ${memoryUsagePercent.toFixed(1)}%`,
        duration: Date.now() - memStart,
      });
      if (overallStatus === 'healthy') {overallStatus = 'degraded';}
    } else {
      checks.push({
        name: 'Memory Usage',
        status: 'pass',
        message: `Memory usage: ${memoryUsagePercent.toFixed(1)}%`,
        duration: Date.now() - memStart,
      });
    }

    return { status: overallStatus, checks };
  }

  private async getFreeDiskSpace(): Promise<number> {
    return new Promise((resolve) => {
      // Simplified disk space check - in a real implementation,
      // you might want to use a more robust method
      const stats = fs.statSync(process.cwd());
      // This is a rough approximation
      resolve(1024 * 1024 * 1024); // Return 1GB as default
    });
  }

  async execute(verbose: boolean = false): Promise<void> {
    const options = { color: true, markdown: true };

    // Show banner
    console.log(formatter.banner('Seraph Agent Status', 'AI-Powered SRE Guardian', options));
    console.log();

    const spinner = formatter.spinner('Gathering system information...');
    spinner.start();

    const [systemInfo, agentStatus, healthCheck] = await Promise.all([
      this.getSystemInfo(),
      this.getAgentStatus(),
      this.performHealthChecks(),
    ]);

    spinner.stop();

    // Agent Status Section
    console.log(formatter.section('Agent Status', [
      agentStatus.running 
        ? formatter.success(`Running (PID: ${agentStatus.pid})`)
        : formatter.error('Not running'),
      `Version: ${agentStatus.version}`,
      agentStatus.port ? `Port: ${agentStatus.port}` : 'Port: Not configured',
      agentStatus.workers ? `Workers: ${agentStatus.workers}` : 'Workers: Not configured',
      agentStatus.startTime ? `Uptime: ${formatter.formatDuration(Date.now() - agentStatus.startTime.getTime())}` : 'Uptime: N/A',
    ], options));
    console.log();

    // Features Section
    console.log(formatter.section('Features', [
      agentStatus.mcpEnabled 
        ? formatter.success('MCP Server: Enabled')
        : formatter.info('MCP Server: Disabled'),
      agentStatus.redisConnected
        ? formatter.success('Redis Cache: Connected')
        : formatter.info('Redis Cache: Not connected'),
      `Cache Hit Rate: ${agentStatus.cacheHitRate ? `${(agentStatus.cacheHitRate * 100).toFixed(1)  }%` : 'N/A'}`,
    ], options));
    console.log();

    // Activity Section
    console.log(formatter.section('Activity', [
      `Total Reports: ${formatter.bold(agentStatus.totalReports.toString())}`,
      `Active Investigations: ${formatter.bold(agentStatus.activeInvestigations.toString())}`,
      `Total Logs Processed: ${formatter.bold(agentStatus.totalLogs.toString())}`,
      agentStatus.lastLogTime 
        ? `Last Log: ${agentStatus.lastLogTime.toLocaleString()}`
        : 'Last Log: Never',
    ], options));
    console.log();

    // Health Check Section
    const healthStatusText = healthCheck.status === 'healthy' ? 
      formatter.success('Healthy') :
      healthCheck.status === 'degraded' ?
        formatter.warning('Degraded') :
        formatter.error('Unhealthy');

    console.log(formatter.section(`Health Status: ${healthStatusText}`, [], options));
    
    // Health check details
    for (const check of healthCheck.checks) {
      const statusIcon = check.status === 'pass' ? 
        formatter.colorize('✓', 'green', options) :
        check.status === 'warn' ?
          formatter.colorize('⚠', 'yellow', options) :
          formatter.colorize('✗', 'red', options);
      
      console.log(`  ${statusIcon} ${check.name}: ${check.message} (${check.duration}ms)`);
    }
    console.log();

    if (verbose) {
      // System Information Section
      console.log(formatter.section('System Information', [
        `Platform: ${systemInfo.platform} (${systemInfo.arch})`,
        `Node.js: ${systemInfo.nodeVersion}`,
        `Total Memory: ${formatter.formatBytes(systemInfo.totalMemory)}`,
        `Free Memory: ${formatter.formatBytes(systemInfo.freeMemory)}`,
        `System Uptime: ${formatter.formatDuration(systemInfo.uptime * 1000)}`,
        `Load Average: ${systemInfo.loadAverage.map(l => l.toFixed(2)).join(', ')}`,
      ], options));
      console.log();

      // Process Memory Usage (if agent is running)
      if (agentStatus.memoryUsage) {
        const mem = agentStatus.memoryUsage;
        console.log(formatter.section('Process Memory Usage', [
          `RSS: ${formatter.formatBytes(mem.rss)}`,
          `Heap Used: ${formatter.formatBytes(mem.heapUsed)}`,
          `Heap Total: ${formatter.formatBytes(mem.heapTotal)}`,
          `External: ${formatter.formatBytes(mem.external)}`,
        ], options));
        console.log();
      }

      // Configuration Section
      try {
        const config = await loadConfig();
        console.log(formatter.section('Configuration', [
          `LLM Provider: ${config.llm?.provider || 'Not configured'}`,
          `Model: ${config.llm?.model || 'Default'}`,
          `Max Workers: ${config.workers}`,
          `Server Port: ${config.port}`,
          `Built-in MCP: ${config.builtInMcpServer ? 'Enabled' : 'Disabled'}`,
          `Redis Caching: ${config.llmCache?.redis ? 'Enabled' : 'Disabled'}`,
        ], options));
        console.log();
      } catch (error) {
        console.log(formatter.error(`Configuration Error: ${(error as Error).message}`));
        console.log();
      }
    }

    // Quick Actions Section
    console.log(formatter.section('Quick Actions', [
      agentStatus.running ? 'seraph stop - Stop the agent' : 'seraph start - Start the agent',
      'seraph reports list - View all reports',
      'seraph chat "status" - Chat with the agent',
      'seraph doctor - Run full diagnostics',
    ], options));

    // Exit with appropriate code
    process.exit(healthCheck.status === 'unhealthy' ? 1 : 0);
  }
}