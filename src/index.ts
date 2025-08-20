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

const program = new Command();

program
  .name('seraph-agent')
  .version('1.0.14')
  .description('A lightweight, autonomous SRE AI agent.');

program.addHelpText('after', `
Dynamic Tool Integration with MCP:
  Seraph can connect to any server that follows the Model Context Protocol (MCP).
  This allows the agent to dynamically discover and use external tools to answer
  your questions and perform tasks.

  To use this feature, provide the server's URL via the --mcp-server-url option
  when using the 'chat' command.

Example:
  $ seraph chat "What is the current price of Bitcoin?" --mcp-server-url <some-crypto-mcp-server-url>
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
  .action(async () => {
    const config = await loadConfig();
    let retries = 5;

    const tryConnect = () => {
      const options = {
        hostname: 'localhost',
        port: config.port,
        path: '/status',
        method: 'GET',
      };

      const req = http.request(options, (res) => {
        if (res.statusCode === 200) {
          console.log('Seraph agent is running.');
          process.exit(0);
        } else {
          console.log('Seraph agent is not running.');
          process.exit(1);
        }
      });

      req.on('error', () => {
        if (retries > 0) {
          retries--;
          setTimeout(tryConnect, 500);
        } else {
          console.error('Error connecting to Seraph agent: Not running');
          process.exit(1);
        }
      });

      req.end();
    };

    tryConnect();
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
  .action(async () => {
    const reportStore = new ReportStore();
    const reports = await reportStore.listReports();
    console.table(reports);
    await reportStore.close();
  });

reports
  .command('view <incidentId>')
  .description('View a specific report.')
  .action(async (incidentId) => {
    const reportStore = new ReportStore();
    const report = await reportStore.getReport(incidentId);
    if (report) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Report with ID "${incidentId}" not found.`);
    }
    await reportStore.close();
  });

const tools = program.command('tools')
  .description('Manage and view available toolsets.');

tools
  .command('list')
  .description('List all available built-in toolsets.')
  .action(() => {
    console.log('Available toolsets:');
    console.table(mcpServerRegistry);
  });

program.parse(process.argv);