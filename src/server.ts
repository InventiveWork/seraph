import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { AgentManager } from './agent';
import { SeraphConfig } from './config';
import { register } from './metrics';
import * as chat from './chat';

const requestCounts = new Map<string, number>();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100; // Max requests per window

export function startServer(config: SeraphConfig, agentManager: AgentManager) {
  setInterval(() => requestCounts.clear(), RATE_LIMIT_WINDOW);

  const server = http.createServer(async (req, res) => {
    const clientIp = req.socket.remoteAddress;

    if (req.url === '/logs' && req.method === 'POST') {
      if (clientIp) {
        const requestCount = (requestCounts.get(clientIp) || 0) + 1;
        requestCounts.set(clientIp, requestCount);
        if (requestCount > RATE_LIMIT_MAX_REQUESTS) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Too Many Requests' }));
          return;
        }
      }

      const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB
      let body = '';
      req.on('data', chunk => {
        if (res.headersSent) return;
        body += chunk.toString();
        if (body.length > MAX_PAYLOAD_SIZE) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Payload Too Large' }));
        }
      });
      req.on('end', () => {
        if (res.headersSent) return;
        if (typeof body !== 'string' || body.trim() === '') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Invalid log format. Log must be a non-empty string.' }));
          return;
        }
        
        try {
          agentManager.dispatch(body);
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'accepted' }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Invalid log format.' }));
        }
      });
    } else if (req.url === '/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else if (req.url === '/metrics' && req.method === 'GET') {
      res.setHeader('Content-Type', register.contentType);
      res.end(await register.metrics());
    } else if (req.url === '/chat' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          if (!body) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: 'message is required' }));
            return;
          }
          const { message } = JSON.parse(body);
          if (!message) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: 'message is required' }));
            return;
          }
          const response = await chat.chat(
            message,
            config,
            agentManager.getRecentLogs(),
          );
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(response);
        } catch (error: any) {
          if (error instanceof SyntaxError) {
            res.writeHead(400, {
              'Content-Type': 'application/json',
            });
            res.end(
              JSON.stringify({
                status: 'error',
                message: 'Invalid JSON format',
              }),
            );
            return;
          }
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'error',
              message: 'Internal Server Error',
            }),
          );
        }
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: 'Not Found' }));
    }
  });

  server.listen(config.port, () => {
    // The listening message is now in index.ts to avoid duplication
  });

  // IPC server
  const ipcSocketPath = path.join(process.cwd(), '.seraph.sock');
  const ipcServer = net.createServer((socket) => {
    socket.on('data', (data) => {
      const message = data.toString();
      if (message === 'get_logs') {
        socket.write(JSON.stringify(agentManager.getRecentLogs()));
      }
    });
  });

  // Clean up old socket file
  if (fs.existsSync(ipcSocketPath)) {
    fs.unlinkSync(ipcSocketPath);
  }

  ipcServer.listen(ipcSocketPath, () => {
    console.log('IPC server started');
  });

  // Graceful shutdown
  let isShuttingDown = false;
  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('Shutting down gracefully...');
    
    server.close(() => {
      console.log('HTTP server closed.');
    });

    ipcServer.close(() => {
      console.log('IPC server closed.');
      if (fs.existsSync(ipcSocketPath)) {
        fs.unlinkSync(ipcSocketPath);
        console.log('IPC socket file removed.');
      }
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown); // Also handle Ctrl+C

  return server;
}