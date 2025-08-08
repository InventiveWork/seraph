#!/usr/bin/env node

import { Command } from 'commander';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { startServer } from './server';
import { AgentManager } from './agent';
import { loadConfig } from './config';
import { chat } from './chat';
import { mcpManager } from './mcp-manager';

const program = new Command();

program
  .name('seraph-agent')
  .version('1.0.1')
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
    await fs.promises.writeFile(pidFilePath, process.pid.toString());
    console.log(`Log ingestion server started on port ${config.port}`);
    console.log(`Agent manager is running with ${config.workers} workers.`);
    console.log(`PID: ${process.pid}`);
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

      req.on('error', (e) => {
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
  .option('--mcp-server-url <url>', 'Dynamically connect to an MCP server to use its tools.')
  .action(async (message, options) => {
    console.log("Input received by CLI:", message);
    const config = await loadConfig();

    if (options.mcpServerUrl) {
      await mcpManager.initialize(options.mcpServerUrl);
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

      client.on('error', (err) => {
        console.error('Error connecting to Seraph agent IPC server. Is the agent running?');
      });
    } else {
      const response = await chat(message, config, tools);
      console.log(response);
    }
  });

program.parse(process.argv);