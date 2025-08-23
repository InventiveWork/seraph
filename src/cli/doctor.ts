/**
 * Doctor command - comprehensive diagnostics and troubleshooting
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';
import { spawn } from 'child_process';
import { loadConfig } from '../config';
import { ReportStore } from '../report-store';
import { formatter } from './formatter';

export interface DiagnosticResult {
  category: string;
  checks: DiagnosticCheck[];
  summary: {
    passed: number;
    warnings: number;
    failed: number;
  };
}

export interface DiagnosticCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  details?: string[];
  suggestion?: string;
  duration: number;
}

export class DoctorCommand {
  private async runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      
      child.stdout?.on('data', (data) => stdout += data.toString());
      child.stderr?.on('data', (data) => stderr += data.toString());
      
      child.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code || 0 });
      });
      
      child.on('error', (error) => {
        resolve({ stdout: '', stderr: error.message, exitCode: 1 });
      });
      
      // Timeout after 10 seconds
      setTimeout(() => {
        child.kill('SIGTERM');
        resolve({ stdout, stderr: 'Command timed out', exitCode: 124 });
      }, 10000);
    });
  }

  private async checkPort(port: number, timeout: number = 3000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      
      socket.setTimeout(timeout);
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      
      socket.on('error', () => {
        resolve(false);
      });
      
      socket.connect(port, 'localhost');
    });
  }

  private async checkSystemRequirements(): Promise<DiagnosticResult> {
    const checks: DiagnosticCheck[] = [];

    // Node.js version check
    const nodeStart = Date.now();
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.replace('v', '').split('.')[0]);
    
    if (majorVersion >= 18) {
      checks.push({
        name: 'Node.js Version',
        status: 'pass',
        message: `Node.js ${nodeVersion} is supported`,
        duration: Date.now() - nodeStart
      });
    } else {
      checks.push({
        name: 'Node.js Version',
        status: 'fail',
        message: `Node.js ${nodeVersion} is too old`,
        suggestion: 'Please upgrade to Node.js 18 or later',
        duration: Date.now() - nodeStart
      });
    }

    // NPM/Package installation check
    const pkgStart = Date.now();
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    try {
      await fs.promises.access(packageJsonPath);
      const nodeModulesPath = path.join(process.cwd(), 'node_modules');
      await fs.promises.access(nodeModulesPath);
      
      checks.push({
        name: 'Package Installation',
        status: 'pass',
        message: 'All dependencies are installed',
        duration: Date.now() - pkgStart
      });
    } catch {
      checks.push({
        name: 'Package Installation',
        status: 'warn',
        message: 'Dependencies may not be fully installed',
        suggestion: 'Run: npm install',
        duration: Date.now() - pkgStart
      });
    }

    // TypeScript compilation check
    const tsStart = Date.now();
    try {
      await fs.promises.access(path.join(process.cwd(), 'dist'));
      checks.push({
        name: 'TypeScript Compilation',
        status: 'pass',
        message: 'Project is compiled',
        duration: Date.now() - tsStart
      });
    } catch {
      checks.push({
        name: 'TypeScript Compilation',
        status: 'warn',
        message: 'Project needs compilation',
        suggestion: 'Run: npm run build',
        duration: Date.now() - tsStart
      });
    }

    // Git availability check
    const gitStart = Date.now();
    const gitResult = await this.runCommand('git', ['--version']);
    if (gitResult.exitCode === 0) {
      checks.push({
        name: 'Git Availability',
        status: 'pass',
        message: gitResult.stdout.trim(),
        duration: Date.now() - gitStart
      });
    } else {
      checks.push({
        name: 'Git Availability',
        status: 'warn',
        message: 'Git is not available',
        suggestion: 'Install Git for repository integration features',
        duration: Date.now() - gitStart
      });
    }

    return this.summarizeResults('System Requirements', checks);
  }

  private async checkConfiguration(): Promise<DiagnosticResult> {
    const checks: DiagnosticCheck[] = [];

    // Configuration file check
    const configStart = Date.now();
    try {
      const config = await loadConfig();
      checks.push({
        name: 'Configuration File',
        status: 'pass',
        message: 'Configuration loaded successfully',
        duration: Date.now() - configStart
      });

      // LLM provider check
      const llmStart = Date.now();
      if (config.llm?.provider) {
        const envVarName = `${config.llm.provider.toUpperCase()}_API_KEY`;
        const apiKeyExists = !!(process.env[envVarName]);
        
        if (apiKeyExists) {
          checks.push({
            name: 'LLM API Key',
            status: 'pass',
            message: `${config.llm.provider} API key is configured`,
            duration: Date.now() - llmStart
          });
        } else {
          checks.push({
            name: 'LLM API Key',
            status: 'fail',
            message: `${config.llm.provider} API key is missing`,
            suggestion: `Set ${envVarName} environment variable or add to config`,
            duration: Date.now() - llmStart
          });
        }
      } else {
        checks.push({
          name: 'LLM Provider',
          status: 'warn',
          message: 'No LLM provider configured',
          suggestion: 'Run: seraph setup --guided',
          duration: Date.now() - llmStart
        });
      }

      // Port availability check
      const portStart = Date.now();
      const portInUse = await this.checkPort(config.port);
      if (!portInUse) {
        checks.push({
          name: 'Port Availability',
          status: 'pass',
          message: `Port ${config.port} is available`,
          duration: Date.now() - portStart
        });
      } else {
        checks.push({
          name: 'Port Availability',
          status: 'warn',
          message: `Port ${config.port} is in use`,
          suggestion: 'Change port in configuration or stop the service using this port',
          duration: Date.now() - portStart
        });
      }

      // Built-in MCP server configuration
      if (config.builtInMcpServer) {
        const mcpStart = Date.now();
        const issues: string[] = [];
        
        if (config.builtInMcpServer.gitRepoPath) {
          try {
            await fs.promises.access(config.builtInMcpServer.gitRepoPath);
          } catch {
            issues.push(`Git repository path does not exist: ${config.builtInMcpServer.gitRepoPath}`);
          }
        }
        
        if (config.builtInMcpServer.prometheusUrl) {
          // This is just a URL format check
          try {
            new URL(config.builtInMcpServer.prometheusUrl);
          } catch {
            issues.push(`Invalid Prometheus URL: ${config.builtInMcpServer.prometheusUrl}`);
          }
        }
        
        if (issues.length === 0) {
          checks.push({
            name: 'MCP Server Configuration',
            status: 'pass',
            message: 'Built-in MCP server is properly configured',
            duration: Date.now() - mcpStart
          });
        } else {
          checks.push({
            name: 'MCP Server Configuration',
            status: 'warn',
            message: 'Built-in MCP server has configuration issues',
            details: issues,
            duration: Date.now() - mcpStart
          });
        }
      }

      // Redis cache configuration
      if (config.llmCache?.redis) {
        const redisStart = Date.now();
        const redisConnectable = await this.checkPort(config.llmCache.redis.port || 6379);
        
        if (redisConnectable) {
          checks.push({
            name: 'Redis Cache',
            status: 'pass',
            message: 'Redis server is accessible',
            duration: Date.now() - redisStart
          });
        } else {
          checks.push({
            name: 'Redis Cache',
            status: 'warn',
            message: 'Redis server is not accessible',
            suggestion: 'Start Redis server or update configuration',
            duration: Date.now() - redisStart
          });
        }
      }
      
    } catch (error) {
      checks.push({
        name: 'Configuration File',
        status: 'fail',
        message: `Configuration error: ${(error as Error).message}`,
        suggestion: 'Run: seraph setup --guided',
        duration: Date.now() - configStart
      });
    }

    return this.summarizeResults('Configuration', checks);
  }

  private async checkRuntime(): Promise<DiagnosticResult> {
    const checks: DiagnosticCheck[] = [];

    // PID file check
    const pidStart = Date.now();
    const pidFilePath = path.join(process.cwd(), '.seraph.pid');
    try {
      await fs.promises.access(pidFilePath);
      const pidStr = await fs.promises.readFile(pidFilePath, 'utf-8');
      const pid = parseInt(pidStr.trim(), 10);
      
      try {
        process.kill(pid, 0); // Check if process exists
        checks.push({
          name: 'Agent Process',
          status: 'pass',
          message: `Agent is running (PID: ${pid})`,
          duration: Date.now() - pidStart
        });

        // HTTP server check
        const httpStart = Date.now();
        const config = await loadConfig();
        const serverResponsive = await this.checkPort(config.port);
        
        if (serverResponsive) {
          checks.push({
            name: 'HTTP Server',
            status: 'pass',
            message: `Server is responsive on port ${config.port}`,
            duration: Date.now() - httpStart
          });
        } else {
          checks.push({
            name: 'HTTP Server',
            status: 'warn',
            message: 'Server is not responding',
            suggestion: 'Restart the agent',
            duration: Date.now() - httpStart
          });
        }

      } catch {
        checks.push({
          name: 'Agent Process',
          status: 'warn',
          message: 'PID file exists but process is not running',
          suggestion: 'Clean start: seraph stop && seraph start',
          duration: Date.now() - pidStart
        });
      }
    } catch {
      checks.push({
        name: 'Agent Process',
        status: 'fail',
        message: 'Agent is not running',
        suggestion: 'Start the agent: seraph start',
        duration: Date.now() - pidStart
      });
    }

    // Database check
    const dbStart = Date.now();
    try {
      const reportStore = new ReportStore();
      const reports = await reportStore.listReports();
      await reportStore.close();
      
      checks.push({
        name: 'Database',
        status: 'pass',
        message: `Database accessible (${reports.length} reports)`,
        duration: Date.now() - dbStart
      });
    } catch (error) {
      checks.push({
        name: 'Database',
        status: 'fail',
        message: `Database error: ${(error as Error).message}`,
        suggestion: 'Check file permissions and disk space',
        duration: Date.now() - dbStart
      });
    }

    // Memory usage check
    const memStart = Date.now();
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    
    if (heapUsedMB < 100) {
      checks.push({
        name: 'Memory Usage',
        status: 'pass',
        message: `Memory usage is normal (${heapUsedMB}MB)`,
        duration: Date.now() - memStart
      });
    } else if (heapUsedMB < 200) {
      checks.push({
        name: 'Memory Usage',
        status: 'warn',
        message: `Memory usage is elevated (${heapUsedMB}MB)`,
        duration: Date.now() - memStart
      });
    } else {
      checks.push({
        name: 'Memory Usage',
        status: 'fail',
        message: `Memory usage is high (${heapUsedMB}MB)`,
        suggestion: 'Restart the agent to free memory',
        duration: Date.now() - memStart
      });
    }

    return this.summarizeResults('Runtime', checks);
  }

  private async checkConnectivity(): Promise<DiagnosticResult> {
    const checks: DiagnosticCheck[] = [];

    // LLM API connectivity
    const llmStart = Date.now();
    try {
      const config = await loadConfig();
      if (config.llm?.provider) {
        // Test LLM connectivity based on provider
        let testUrl = '';
        switch (config.llm.provider) {
          case 'gemini':
            testUrl = 'https://generativelanguage.googleapis.com';
            break;
          case 'anthropic':
            testUrl = 'https://api.anthropic.com';
            break;
          case 'openai':
            testUrl = 'https://api.openai.com';
            break;
        }

        if (testUrl) {
          const connectivityTest = await this.testHttpConnectivity(testUrl);
          if (connectivityTest) {
            checks.push({
              name: 'LLM API Connectivity',
              status: 'pass',
              message: `${config.llm.provider} API is reachable`,
              duration: Date.now() - llmStart
            });
          } else {
            checks.push({
              name: 'LLM API Connectivity',
              status: 'warn',
              message: `${config.llm.provider} API is not reachable`,
              suggestion: 'Check internet connection and firewall settings',
              duration: Date.now() - llmStart
            });
          }
        }
      }
    } catch (error) {
      checks.push({
        name: 'LLM API Connectivity',
        status: 'fail',
        message: `Connectivity test failed: ${(error as Error).message}`,
        duration: Date.now() - llmStart
      });
    }

    // DNS resolution check
    const dnsStart = Date.now();
    const dnsTest = await this.runCommand('nslookup', ['google.com']);
    if (dnsTest.exitCode === 0) {
      checks.push({
        name: 'DNS Resolution',
        status: 'pass',
        message: 'DNS resolution is working',
        duration: Date.now() - dnsStart
      });
    } else {
      checks.push({
        name: 'DNS Resolution',
        status: 'warn',
        message: 'DNS resolution may have issues',
        suggestion: 'Check DNS settings',
        duration: Date.now() - dnsStart
      });
    }

    return this.summarizeResults('Connectivity', checks);
  }

  private async testHttpConnectivity(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: '/',
        method: 'HEAD',
        timeout: 5000
      };

      const req = http.request(options, (res) => {
        resolve(res.statusCode !== undefined && res.statusCode < 500);
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      
      req.end();
    });
  }

  private summarizeResults(category: string, checks: DiagnosticCheck[]): DiagnosticResult {
    const summary = {
      passed: checks.filter(c => c.status === 'pass').length,
      warnings: checks.filter(c => c.status === 'warn').length,
      failed: checks.filter(c => c.status === 'fail').length
    };

    return { category, checks, summary };
  }

  async execute(): Promise<void> {
    const options = { color: true, markdown: true };

    console.log(formatter.banner('Seraph Diagnostics', 'Comprehensive health check', options));
    console.log();

    const spinner = formatter.spinner('Running diagnostic checks...');
    spinner.start();

    const [systemResults, configResults, runtimeResults, connectivityResults] = await Promise.all([
      this.checkSystemRequirements(),
      this.checkConfiguration(),
      this.checkRuntime(),
      this.checkConnectivity()
    ]);

    spinner.stop();

    const allResults = [systemResults, configResults, runtimeResults, connectivityResults];
    
    // Display results
    for (const result of allResults) {
      const statusText = result.summary.failed > 0 ? 
        formatter.error(`${result.summary.failed} failed`) :
        result.summary.warnings > 0 ?
          formatter.warning(`${result.summary.warnings} warnings`) :
          formatter.success('All checks passed');

      console.log(formatter.section(`${result.category}: ${statusText}`, [], options));

      for (const check of result.checks) {
        const icon = check.status === 'pass' ? 
          formatter.colorize('✓', 'green', options) :
          check.status === 'warn' ?
            formatter.colorize('⚠', 'yellow', options) :
            formatter.colorize('✗', 'red', options);
        
        console.log(`  ${icon} ${check.name}: ${check.message} (${check.duration}ms)`);
        
        if (check.details) {
          check.details.forEach(detail => {
            console.log(`    ${formatter.colorize('→', 'gray', options)} ${detail}`);
          });
        }
        
        if (check.suggestion) {
          console.log(`    ${formatter.colorize('💡', 'blue', options)} ${check.suggestion}`);
        }
      }
      
      console.log();
    }

    // Overall summary
    const totalPassed = allResults.reduce((sum, r) => sum + r.summary.passed, 0);
    const totalWarnings = allResults.reduce((sum, r) => sum + r.summary.warnings, 0);
    const totalFailed = allResults.reduce((sum, r) => sum + r.summary.failed, 0);
    const totalChecks = totalPassed + totalWarnings + totalFailed;

    console.log(formatter.section('Overall Health', [
      `${formatter.colorize(totalPassed.toString(), 'green', options)} checks passed`,
      `${formatter.colorize(totalWarnings.toString(), 'yellow', options)} warnings`,
      `${formatter.colorize(totalFailed.toString(), 'red', options)} failures`,
      `${totalChecks} total checks`
    ], options));

    // Health score
    const healthScore = Math.round((totalPassed / totalChecks) * 100);
    const scoreColor = healthScore >= 90 ? 'green' : healthScore >= 70 ? 'yellow' : 'red';
    
    console.log();
    console.log(`Health Score: ${formatter.colorize(`${healthScore}%`, scoreColor, options)}`);

    // Exit with appropriate code
    process.exit(totalFailed > 0 ? 1 : 0);
  }
}