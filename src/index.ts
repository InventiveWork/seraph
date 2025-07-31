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

const program = new Command();

program
  .name('seraph-agent')
  .version('1.0.1')
  .description('A lightweight, autonomous SRE AI agent.');

program
  .command('start')
  .description('Start the Seraph agent and log ingestion server.')
  .action(async () => {
    const pidFilePath = path.join(process.cwd(), '.seraph.pid');
    if (fs.existsSync(pidFilePath)) {
      console.error('Seraph agent is already running. Please stop it first.');
      process.exit(1);
    }

    console.log('Starting Seraph Agent...');
    const config = loadConfig();
    const agentManager = new AgentManager(config);
    startServer(config, agentManager);
    fs.writeFileSync(pidFilePath, process.pid.toString());
    console.log(`Log ingestion server started on port ${config.port}`);
    console.log(`Agent manager is running with ${config.workers} workers.`);
    console.log(`PID: ${process.pid}`);
  });

program
  .command('status')
  .description('Check the status of the Seraph agent.')
  .action(() => {
    const config = loadConfig();
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
  .action(() => {
    const pidFilePath = path.join(process.cwd(), '.seraph.pid');
    if (!fs.existsSync(pidFilePath)) {
      console.error('Seraph agent is not running.');
      process.exit(1);
    }

    try {
      const pid = parseInt(fs.readFileSync(pidFilePath, 'utf-8'), 10);
      process.kill(pid, 'SIGTERM');
      fs.unlinkSync(pidFilePath);
      console.log('Seraph agent stopped.');
    } catch (error: any) {
      console.error('Error stopping agent:', error);
      // If the process doesn't exist, just remove the pid file.
      if (error.code === 'ESRCH') {
        fs.unlinkSync(pidFilePath);
        console.log('Cleaned up stale PID file.');
      }
    }
  });

program
  .command('chat <message>')
  .description('Chat with the Seraph agent.')
  .option('-c, --context', 'Include recent logs as context.')
  .action((message, options) => {
    const config = loadConfig();

    if (options.context) {
      const ipcSocketPath = path.join(process.cwd(), '.seraph.sock');
      const client = net.createConnection({ path: ipcSocketPath }, () => {
        client.write('get_logs');
      });

      client.on('data', (data) => {
        const logs = JSON.parse(data.toString());
        chat(message, config, logs);
        client.end();
      });

      client.on('error', (err) => {
        console.error('Error connecting to Seraph agent IPC server. Is the agent running?');
      });
    } else {
      chat(message, config);
    }
  });

program.parse(process.argv);
