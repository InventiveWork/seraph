#!/usr/bin/env node

import { Command } from 'commander';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { startServer } from './server';
import { AgentManager } from './agent-manager';
import { loadConfig } from './config';
import { chat } from './chat';
import { mcpManager } from './mcp-manager';
import { ReportStore } from './report-store';
import { mcpServerRegistry } from './mcp-registry';
import { startMcpServer } from './mcp-server';
import { StatusCommand } from './cli/status';
import { SetupWizard } from './cli/setup';
import { DoctorCommand } from './cli/doctor';
import { formatter } from './cli/formatter';

const program = new Command();

program
  .name('seraph-agent')
  .version('1.0.18')
  .description('A lightweight, autonomous SRE AI agent.');

program.addHelpText('after', `
${formatter.colorize('🚀 Quick Start:', 'bright')}
  ${formatter.colorize('seraph setup', 'cyan')}          Run interactive setup wizard
  ${formatter.colorize('seraph start', 'cyan')}          Start the AI SRE agent
  ${formatter.colorize('seraph status --verbose', 'cyan')} Check detailed agent status
  ${formatter.colorize('seraph chat "hello"', 'cyan')}    Chat with your agent

${formatter.colorize('🛡️ Essential Commands:', 'bright')}
  ${formatter.colorize('seraph doctor', 'cyan')}         Run comprehensive diagnostics
  ${formatter.colorize('seraph reports list', 'cyan')}   View investigation reports
  ${formatter.colorize('seraph tools list', 'cyan')}     See available tool integrations

${formatter.colorize('💡 Pro Tips:', 'bright')}
  • Use ${formatter.colorize('--verbose', 'yellow')} flags for detailed output
  • Reports support ${formatter.colorize('--format markdown', 'yellow')} for better readability
  • The agent learns from your infrastructure automatically
  • Redis caching can reduce LLM costs by 40-70%

${formatter.colorize('🔧 Dynamic Tool Integration with MCP:', 'bright')}
  Seraph connects to Model Context Protocol servers for extensible tooling.
  Use ${formatter.colorize('--mcp-server-url', 'yellow')} or ${formatter.colorize('--tools', 'yellow')} flags with the chat command.

${formatter.colorize('Example:', 'bright')}
  ${formatter.colorize('seraph chat "analyze recent errors" --context', 'gray')}
`);


program
  .command('start')
  .description('Start the Seraph agent and log ingestion server.')
  .option('--mcp-server-url <url>', 'Connect to an MCP server to enable dynamic tool usage.')
  .action(async (options) => {
    const pidFilePath = path.join(process.cwd(), '.seraph.pid');
    try {
      await fs.promises.access(pidFilePath);
      console.error('Seraph agent is already running. Please stop it first.');
      process.exit(1);
    } catch (error) {
      // ENOENT means the file doesn't exist, which is what we want.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Error checking for existing PID file:', error);
        process.exit(1);
      }
    }

    console.log('Starting Seraph Agent...');
    if (options.mcpServerUrl) {
      console.log(`MCP server specified. The agent will connect to it when you use the chat command.`);
    }

    const config = await loadConfig();
    const agentManager = new AgentManager(config);
    startServer(config, agentManager);
    startMcpServer(config); // Start the built-in MCP server
    await fs.promises.writeFile(pidFilePath, process.pid.toString());
    console.log(`Log ingestion server started on port ${config.port}`);
    console.log(`Agent manager is running with ${config.workers} workers.`);
    console.log(`PID: ${process.pid}`);

    // Wait for the agent to fully initialize
    await agentManager.waitForInitialization();

    // Clone the repository for Git context during investigations
    if (config.builtInMcpServer?.gitRepoPath && config.builtInMcpServer?.gitRepoUrl) {
      console.log(`Cloning repository from ${config.builtInMcpServer.gitRepoUrl} for Git context...`);
      try {
        const { spawn } = await import('child_process');
        const gitRepoPath = config.builtInMcpServer.gitRepoPath;
        const gitRepoUrl = config.builtInMcpServer.gitRepoUrl;
        const gitClone = spawn('git', [
          'clone',
          gitRepoUrl,
          gitRepoPath
        ], {
          stdio: 'pipe'
        });

        await new Promise<void>((resolve, reject) => {
          let output = '';
          let errorOutput = '';

          gitClone.stdout?.on('data', (data: Buffer) => {
            output += data.toString();
          });

          gitClone.stderr?.on('data', (data: Buffer) => {
            errorOutput += data.toString();
          });

          gitClone.on('close', (code: number | null) => {
            if (code === 0) {
              console.log(`✓ Repository cloned successfully to ${gitRepoPath}`);
              resolve();
            } else {
              // If clone fails (e.g., directory exists), try to update instead
              console.log(`Git clone failed (exit code ${code}), attempting to update existing repository...`);
              const gitPull = spawn('git', ['-C', gitRepoPath, 'pull'], { stdio: 'pipe' });

              gitPull.on('close', (pullCode: number | null) => {
                if (pullCode === 0) {
                  console.log(`✓ Repository updated successfully`);
                  resolve();
                } else {
                  console.warn(`Git operations failed, but continuing with existing repository if available`);
                  resolve();
                }
              });

              gitPull.on('error', (err: Error) => {
                console.warn(`Git pull failed: ${err.message}, continuing anyway`);
                resolve();
              });
            }
          });

          gitClone.on('error', (err: Error) => {
            console.warn(`Git clone failed: ${err.message}, continuing anyway`);
            resolve();
          });
        });
      } catch (error) {
        console.warn(`Failed to clone repository: ${error}. Continuing without Git context.`);
      }
    }

    // Execute startup prompts if they exist
    if (config.startupPrompts && config.startupPrompts.length > 0) {
      console.log('Executing startup prompts as investigations...');
      for (const prompt of config.startupPrompts) {
        console.log(`> ${prompt}`);
        try {
          // Trigger a full investigation for each startup prompt
          const syntheticLog = `Demo investigation request: ${prompt}`;
          const reason = `Startup investigation: ${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}`;
          
          const success = agentManager.triggerInvestigation(syntheticLog, reason);
          if (success) {
            console.log(`Investigation triggered for: ${reason}`);
          } else {
            console.log(`Investigation skipped for: ${reason} (deduplication or queue full)`);
          }
          
          // Add a small delay between investigations to avoid overwhelming the system
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
          console.error(`Error executing startup investigation: "${prompt}"`, error);
        }
      }
      console.log('Finished executing startup investigations.');
    }
  });

program
  .command('status')
  .description('Check the status of the Seraph agent.')
  .option('-v, --verbose', 'Show detailed status information')
  .action(async (options) => {
    const statusCommand = new StatusCommand();
    await statusCommand.execute(options.verbose);
  });

program
  .command('stop')
  .description('Stop the Seraph agent.')
  .action(async () => {
    const pidFilePath = path.join(process.cwd(), '.seraph.pid');
    try {
      await fs.promises.access(pidFilePath);
      const pid = parseInt(await fs.promises.readFile(pidFilePath, 'utf-8'), 10);
      process.kill(pid, 'SIGTERM');
      await fs.promises.unlink(pidFilePath);
      console.log('Seraph agent stopped.');
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        console.error('Seraph agent is not running.');
      } else if (error.code === 'ESRCH') {
        // If the process doesn't exist, just remove the pid file.
        try {
          await fs.promises.unlink(pidFilePath);
          console.log('Cleaned up stale PID file.');
        } catch (unlinkError) {
          console.error('Error removing stale PID file:', unlinkError);
        }
      } else {
        console.error('Error stopping agent:', error);
      }
    }
  });

program
  .command('chat <message>')
  .description('Chat with the Seraph agent.')
  .option('-c, --context', 'Include recent logs as context.')
  .option('--mcp-server-url <url>', 'Dynamically connect to a custom MCP server to use its tools.')
  .option('--tools <names>', 'A comma-separated list of built-in toolsets to use (e.g., "fetch,git").')
  .action(async (message, options) => {
    console.log("Input received by CLI:", message);
    const config = await loadConfig();

    let mcpUrl = options.mcpServerUrl;

    // CLI flags take precedence
    if (options.tools) {
      const toolNames = options.tools.split(',');
      const selectedServer = mcpServerRegistry.find(server => server.name === toolNames[0]);
      if (selectedServer) {
        mcpUrl = selectedServer.url;
        if (toolNames.length > 1) {
          console.warn('Warning: Multiple toolsets are not yet supported. Using the first one found:', selectedServer.name);
        }
      } else {
        console.error(`Error: Toolset "${toolNames[0]}" not found. Use 'seraph tools list' to see available toolsets.`);
        process.exit(1);
      }
    } else if (!mcpUrl && config.defaultMcpServers && config.defaultMcpServers.length > 0) {
      // Use default from config if no CLI flags are provided
      const defaultServerName = config.defaultMcpServers[0];
      const selectedServer = mcpServerRegistry.find(server => server.name === defaultServerName);
      if (selectedServer) {
        mcpUrl = selectedServer.url;
        if (config.defaultMcpServers.length > 1) {
          console.warn('Warning: Multiple default toolsets are not yet supported. Using the first one:', selectedServer.name);
        }
      } else {
        console.error(`Error: Default toolset "${defaultServerName}" from config not found. Use 'seraph tools list' to see available toolsets.`);
        process.exit(1);
      }
    }

    if (mcpUrl) {
      await mcpManager.initialize(mcpUrl);
    }

    const tools = mcpManager.getDynamicTools();

    if (options.context) {
      const ipcSocketPath = path.join(process.cwd(), '.seraph.sock');
      const client = net.createConnection({ path: ipcSocketPath }, () => {
        client.write('get_logs');
      });

      client.on('data', async (data) => {
        const logs = JSON.parse(data.toString());
        const response = await chat(message, config, tools, logs);
        console.log(response);
        client.end();
      });

      client.on('error', () => {
        console.error('Error connecting to Seraph agent IPC server. Is the agent running?');
      });
    } else {
      const response = await chat(message, config, tools);
      console.log(response);
    }
  });

const reports = program.command('reports')
  .description('Manage and view reports.');

reports
  .command('list')
  .description('List all reports.')
  .option('--format <format>', 'Output format: table, json, markdown', 'table')
  .option('--limit <number>', 'Limit number of results', '50')
  .option('--filter <filter>', 'Filter by status: all, resolved, open, acknowledged', 'all')
  .action(async (options) => {
    const reportStore = new ReportStore();
    let reports = await reportStore.listReports();
    
    // Apply filter
    if (options.filter !== 'all') {
      reports = reports.filter(r => r.status === options.filter);
    }
    
    // Apply limit
    const limit = parseInt(options.limit);
    if (limit > 0) {
      reports = reports.slice(0, limit);
    }
    
    const formatOptions = { color: true, markdown: true };
    
    switch (options.format) {
      case 'json':
        console.log(JSON.stringify(reports, null, 2));
        break;
      case 'markdown':
        if (reports.length === 0) {
          console.log(formatter.info('No reports found'));
          break;
        }
        
        console.log(formatter.header('Investigation Reports'));
        console.log();
        
        for (const report of reports) {
          const statusColor = report.status === 'resolved' ? 'green' : 'yellow';
          const status = formatter.colorize(report.status, statusColor, formatOptions);
          const timestamp = new Date(report.timestamp).toLocaleString();
          
          console.log(`## ${report.incidentId}`);
          console.log(`**Status:** ${status}`);
          console.log(`**Timestamp:** ${timestamp}`);
          console.log(`**Reason:** ${report.triageReason || 'N/A'}`);
          console.log();
        }
        break;
      default:
        if (reports.length === 0) {
          console.log(formatter.info('No reports found'));
        } else {
          const headers = ['Incident ID', 'Status', 'Timestamp', 'Reason'];
          const rows = reports.map(r => [
            r.incidentId,
            r.status,
            new Date(r.timestamp).toLocaleString(),
            (r.triageReason || '').substring(0, 50) + ((r.triageReason || '').length > 50 ? '...' : '')
          ]);
          
          console.log(formatter.table(headers, rows, formatOptions));
        }
    }
    
    await reportStore.close();
  });

reports
  .command('view <incidentId>')
  .description('View a specific report.')
  .option('--format <format>', 'Output format: json, markdown, raw', 'markdown')
  .action(async (incidentId, options) => {
    const reportStore = new ReportStore();
    const report = await reportStore.getReport(incidentId);
    
    if (!report) {
      console.log(formatter.error(`Report with ID "${incidentId}" not found.`));
      await reportStore.close();
      return;
    }
    
    const formatOptions = { color: true, markdown: true };
    
    switch (options.format) {
      case 'json':
        console.log(JSON.stringify(report, null, 2));
        break;
      case 'raw':
        console.log(JSON.stringify(report.finalAnalysis, null, 2) || 'No analysis available');
        break;
      default:
        console.log(formatter.banner(`Report: ${report.incidentId}`, undefined, formatOptions));
        console.log();
        
        console.log(formatter.section('Summary', [
          `**Status:** ${report.status}`,
          `**Timestamp:** ${new Date(report.timestamp).toLocaleString()}`,
          `**Reason:** ${report.triageReason || 'N/A'}`,
          `**Log:** ${(report.initialLog || '').substring(0, 100)}${(report.initialLog || '').length > 100 ? '...' : ''}`
        ], formatOptions));
        console.log();
        
        if (report.finalAnalysis) {
          console.log(formatter.section('Analysis', [], formatOptions));
          console.log(formatter.formatMarkdown(JSON.stringify(report.finalAnalysis, null, 2), formatOptions));
          console.log();
        }
        
        if (report.investigationTrace) {
          console.log(formatter.section('Investigation Trace', [JSON.stringify(report.investigationTrace, null, 2)], formatOptions));
          console.log();
        }
    }
    
    await reportStore.close();
  });

const tools = program.command('tools')
  .description('Manage and view available toolsets.');

tools
  .command('list')
  .description('List all available built-in toolsets.')
  .option('--format <format>', 'Output format: table, json, markdown', 'table')
  .action((options) => {
    const formatOptions = { color: true, markdown: true };
    
    switch (options.format) {
      case 'json':
        console.log(JSON.stringify(mcpServerRegistry, null, 2));
        break;
      case 'markdown':
        console.log(formatter.header('Available Toolsets'));
        console.log();
        
        for (const toolset of mcpServerRegistry) {
          console.log(`## ${toolset.name}`);
          console.log(`**Description:** ${toolset.description}`);
          console.log(`**URL:** ${toolset.url}`);
          console.log();
        }
        break;
      default:
        if (mcpServerRegistry.length === 0) {
          console.log(formatter.info('No toolsets available'));
        } else {
          const headers = ['Name', 'Description', 'URL'];
          const rows = mcpServerRegistry.map(t => [t.name, t.description, t.url]);
          console.log(formatter.table(headers, rows, formatOptions));
        }
    }
  });

// Setup wizard command
program
  .command('setup')
  .description('Interactive setup wizard for Seraph configuration.')
  .option('--guided', 'Run the guided setup wizard (default)')
  .action(async () => {
    const setupWizard = new SetupWizard();
    await setupWizard.run();
  });

// Doctor command for diagnostics
program
  .command('doctor')
  .description('Run comprehensive diagnostics and troubleshooting.')
  .action(async () => {
    const doctorCommand = new DoctorCommand();
    await doctorCommand.execute();
  });

// Version command with enhanced output
program
  .command('version')
  .description('Show version information.')
  .action(() => {
    const options = { color: true, markdown: true };
    console.log(formatter.banner('Seraph Agent', `Version ${program.version()}`, options));
    console.log();
    console.log(formatter.section('System Information', [
      `Node.js: ${process.version}`,
      `Platform: ${process.platform} (${process.arch})`,
      `NPM: ${process.env.npm_version || 'Unknown'}`
    ], options));
  });

program.parse(process.argv);