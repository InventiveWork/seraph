import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { AgentManager } from './agent';
import { SeraphConfig } from './config';
import { register } from './metrics';
import * as chat from './chat';

let requestCounts = new Map<string, number>();

export function resetRequestCounts() {
  requestCounts.clear();
}

export function startServer(config: SeraphConfig, agentManager: AgentManager) {
  const RATE_LIMIT_WINDOW = config.rateLimit?.window || 60000;
  const RATE_LIMIT_MAX_REQUESTS = config.rateLimit?.maxRequests || 100;

  const intervalId = setInterval(() => requestCounts.clear(), RATE_LIMIT_WINDOW);

  const server = http.createServer(async (req, res) => {
    const clientIp = req.socket.remoteAddress;
    
    // Global error handler for the request
    req.on('error', (err) => {
      console.error('Request error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Internal Server Error' }));
      }
    });

    // Authentication middleware
    if (config.serverApiKey && req.url !== '/metrics') {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Unauthorized' }));
        return;
      }
      const token = authHeader.substring(7);
      if (token !== config.serverApiKey) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Forbidden' }));
        return;
      }
    }

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
          res.end(JSON.stringify({ status: 'error', message: 'Request body must be a non-empty string.' }));
          return;
        }
        
        try {
          // A simple check to see if it could be JSON
          if (body.startsWith('{') || body.startsWith('[')) {
            JSON.parse(body);
          }
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Invalid JSON format in log.' }));
          return;
        }

        try {
          agentManager.dispatch(body);
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'accepted' }));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Internal server error while processing log.' }));
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
            [], // No MCP tools available in server mode
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

  const cleanupSocket = async () => {
    try {
      await fs.promises.access(ipcSocketPath);
      await fs.promises.unlink(ipcSocketPath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.error('Error removing old IPC socket file:', error);
      }
    }
  };

  cleanupSocket().then(() => {
    ipcServer.listen(ipcSocketPath, async () => {
      try {
        await fs.promises.chmod(ipcSocketPath, 0o600);
        console.log('IPC server started');
      } catch (error) {
        console.error('Error setting permissions on IPC socket file:', error);
      }
    });
  });

  let isShuttingDown = false;
  const shutdown = (callback?: () => void) => {
    if (isShuttingDown) {
      if (callback) callback();
      return;
    }
    isShuttingDown = true;

    let closedCount = 0;
    const totalToClose = 2;
    const onClosed = () => {
      closedCount++;
      if (closedCount === totalToClose) {
        clearInterval(intervalId); // Clear the rate limit interval
        cleanupSocket().then(() => {
          if (callback) callback();
        });
      }
    };

    server.close(() => {
      onClosed();
    });

    ipcServer.close(() => {
      onClosed();
    });
  };

  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());

  return { server, shutdown };
}
