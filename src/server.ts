import { IncomingMessage, ServerResponse, createServer } from 'http';
import { Socket, createServer as createNetServer } from 'net';
import { chmodSync, existsSync, promises as fs, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { AgentManager } from './agent-manager';
import { SeraphConfig } from './config';
// Lazy load metrics and chat modules only when needed
import { generateCorrelationId, sanitizeErrorMessage, validateLogEntry } from './validation';

// Memory-efficient request tracking
const requestCounts = new Map<string, number>();

// Buffer pool for reusing memory
const BUFFER_POOL_SIZE = 10;
const bufferPool: Buffer[] = [];
const POOL_BUFFER_SIZE = 1024 * 64; // 64KB buffers

function getPooledBuffer(): Buffer {
  const pooledBuffer = bufferPool.pop();
  return pooledBuffer ?? Buffer.alloc(POOL_BUFFER_SIZE);
}

function returnBufferToPool(buffer: Buffer): void {
  if (bufferPool.length < BUFFER_POOL_SIZE && buffer.length >= POOL_BUFFER_SIZE) {
    // Resize buffer to exact pool size if larger, or skip if smaller
    const poolBuffer = buffer.length === POOL_BUFFER_SIZE ? buffer : buffer.subarray(0, POOL_BUFFER_SIZE);
    poolBuffer.fill(0); // Clear for security
    bufferPool.push(poolBuffer);
  }
}

export function resetRequestCounts() {
  requestCounts.clear();
}

export function startServer(config: SeraphConfig, agentManager: AgentManager) {
  const RATE_LIMIT_WINDOW = config.rateLimit?.window ?? 60000;
  const RATE_LIMIT_MAX_REQUESTS = config.rateLimit?.maxRequests ?? 100;

  const intervalId = setInterval(() => requestCounts.clear(), RATE_LIMIT_WINDOW);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const clientIp = req.socket.remoteAddress;
    const correlationId = generateCorrelationId();

    if (config.verbose) {
      console.log(`[${correlationId}] Received request: ${req.method} ${req.url}`);
    }
    
    // Add correlation ID header to response
    res.setHeader('X-Correlation-ID', correlationId);
    
    // Add security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    
    // Global error handler for the request
    req.on('error', (err: Error) => {
      const sanitizedError = sanitizeErrorMessage(err);
      console.error(`[${correlationId}] Request error:`, sanitizedError);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: 'error', 
          message: 'Internal Server Error',
          correlationId, 
        }));
      }
    });

    // Authentication middleware
    if (config.serverApiKey && req.url !== '/metrics') {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
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
        const requestCount = (requestCounts.get(clientIp) ?? 0) + 1;
        requestCounts.set(clientIp, requestCount);
        if (requestCount > RATE_LIMIT_MAX_REQUESTS) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            status: 'error', 
            message: 'Too Many Requests',
            correlationId, 
          }));
          return;
        }
      }

      const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB
      const chunks: Buffer[] = [];
      let totalSize = 0;
      
      req.on('data', (chunk: Buffer) => {
        if (res.headersSent) {return;}
        
        totalSize += chunk.length;
        if (totalSize > MAX_PAYLOAD_SIZE) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            status: 'error', 
            message: 'Payload Too Large',
            correlationId, 
          }));
          return;
        }
        
        chunks.push(chunk);
      });
      
      req.on('end', () => {
        if (res.headersSent) {return;}
        
        const body = Buffer.concat(chunks).toString('utf8');
        if (config.verbose) {
          console.log(`[${correlationId}] Received request body:`, body);
        }

        if (!body || body.trim() === '') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            status: 'error', 
            message: 'Request body must be a non-empty string',
            correlationId, 
          }));
          return;
        }

        try {
          // Handle concatenated JSON logs from Fluent Bit BEFORE validation
          if (body.includes('"}{"')) {
            // Split concatenated JSON logs and process each one separately
            const logParts = body.split('"}{"').map((part, index, array) => {
              if (index === 0) {return `${part  }"}`;}
              if (index === array.length - 1) {return `{"${  part}`;}
              return `{"${  part  }"}`;
            });
            
            // Filter out incomplete JSON parts with more thorough validation
            const completeParts = logParts.filter(part => {
              const trimmed = part.trim();
              if (!trimmed.startsWith('{') || !trimmed.endsWith('}') || trimmed.length <= 2) {
                return false;
              }
              
              // Additional check for proper JSON structure
              try {
                JSON.parse(trimmed);
                return true;
              } catch (e) {
                return false;
              }
            });
            
            let validPartsProcessed = 0;
            for (const logPart of completeParts) {
              try {
                // Double validation: JSON structure and content validation
                if (!config.disableValidation) {
                  const partValidation = validateLogEntry(logPart);
                  if (!partValidation.valid) {
                    console.warn(`[${correlationId}] Invalid log part: ${partValidation.errors.join(', ')}`);
                    continue;
                  }
                }
                
                agentManager.dispatch(logPart);
                validPartsProcessed++;
              } catch (e) {
                // Skip malformed log parts with more detailed logging
                const errorMsg = e instanceof Error ? e.message : 'Unknown error';
                console.warn(`[${correlationId}] Skipping malformed log part (${errorMsg}):`, logPart.substring(0, 100));
              }
            }
            
            // If no valid parts were processed, return error
            if (validPartsProcessed === 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ 
                status: 'error', 
                message: 'No valid log entries found in concatenated logs',
                correlationId, 
              }));
              return;
            }
          } else {
            // Single log entry - validate first
            if (!config.disableValidation) {
              const validation = validateLogEntry(body);
              if (!validation.valid) {
                console.warn(`[${correlationId}] Invalid log entry: ${validation.errors.join(', ')}`);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                  status: 'error', 
                  message: 'Invalid log entry',
                  errors: validation.errors,
                  correlationId, 
                }));
                return;
              }
            }
            agentManager.dispatch(body);
          }
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            status: 'accepted',
            correlationId, 
          }));
        } catch (error) {
          const sanitizedError = sanitizeErrorMessage(error as Error);
          console.error(`[${correlationId}] Error processing log:`, sanitizedError);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            status: 'error', 
            message: 'Internal server error while processing log',
            correlationId, 
          }));
        }
      });
    } else if (req.url === '/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      
      // Get comprehensive status information
      const statusInfo = {
        status: 'ok',
        startTime: new Date().toISOString(),
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime() * 1000, // in milliseconds
        totalLogs: 0,
        activeInvestigations: 0,
        workers: config.workers,
        port: config.port,
        mcpEnabled: !!config.builtInMcpServer,
        redisConnected: false,
        cacheHitRate: null,
        version: '1.0.21',
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        lastLogTime: null,
        totalInvestigations: 0,
        health: {
          memory: process.memoryUsage().heapUsed / process.memoryUsage().heapTotal < 0.9 ? 'healthy' : 'warning',
          uptime: process.uptime() > 60 ? 'healthy' : 'starting',
          workers: 'running',
        },
      };
      
      res.end(JSON.stringify(statusInfo, null, 2));
    } else if (req.url === '/metrics' && req.method === 'GET') {
      const { register } = await import('./metrics');
      res.setHeader('Content-Type', register.contentType);
      res.end(await register.metrics());
    } else if (req.url === '/chat' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      const MAX_CHAT_PAYLOAD = 10 * 1024; // 10KB for chat messages
      
      req.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_CHAT_PAYLOAD) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            status: 'error', 
            message: 'Chat message too large',
            correlationId, 
          }));
          return;
        }
        chunks.push(chunk);
      });
      
      req.on('end', async () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          
          if (!body) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              status: 'error', 
              message: 'message is required',
              correlationId, 
            }));
            return;
          }
          
          const { message } = JSON.parse(body);
          if (!message || typeof message !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              status: 'error', 
              message: 'message is required and must be a string',
              correlationId, 
            }));
            return;
          }
          
          if (message.length > 1000) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              status: 'error', 
              message: 'message too long (max 1000 characters)',
              correlationId, 
            }));
            return;
          }
          
          const { chat } = await import('./chat');
          const response = await chat(
            message,
            config,
            [], // No MCP tools available in server mode
            agentManager.getRecentLogs(),
          );
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(response);
        } catch (error: unknown) {
          const sanitizedError = sanitizeErrorMessage(error instanceof Error ? error : String(error));
          console.error(`[${correlationId}] Chat error:`, sanitizedError);
          
          if (error instanceof SyntaxError) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              status: 'error',
              message: 'Invalid JSON format',
              correlationId,
            }));
            return;
          }
          
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'error',
            message: 'Internal Server Error',
            correlationId,
          }));
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
  const ipcSocketPath = join(process.cwd(), '.seraph.sock');
  const ipcServer = createNetServer((socket: Socket) => {
    socket.on('data', (data: Buffer) => {
      const message = data.toString();
      if (message === 'get_logs') {
        socket.write(JSON.stringify(agentManager.getRecentLogs()));
      }
    });
  });

  const cleanupSocket = async () => {
    try {
      // Try to remove the socket file directly, handle ENOENT gracefully
      await fs.unlink(ipcSocketPath);
    } catch (error: unknown) {
      // Check if this is an ENOENT error (file doesn't exist) which is expected
      if (error && typeof error === 'object' && 'code' in error && (error as any).code === 'ENOENT') {
        // Silently ignore - socket file doesn't exist, which is expected
        return;
      }
      
      // Log other errors
      console.error('Error removing old IPC socket file:', error);
    }
  };

  cleanupSocket()
    .then(() => {
      ipcServer.listen(ipcSocketPath, async () => {
        try {
          await fs.chmod(ipcSocketPath, 0o600);
          console.log('IPC server started');
        } catch (error) {
          console.error('Error setting permissions on IPC socket file:', error);
        }
      });
    })
    .catch(error => {
      console.error('Failed to cleanup IPC socket, skipping IPC server startup:', error);
      // Don't start IPC server if cleanup failed to avoid EADDRINUSE errors
    });

  let isShuttingDown = false;
  const shutdown = (callback?: () => void) => {
    if (isShuttingDown) {
      if (callback) {callback();}
      return;
    }
    isShuttingDown = true;

    // Clear the rate limit interval immediately on shutdown
    clearInterval(intervalId);

    let closedCount = 0;
    const totalToClose = 2;
    const onClosed = () => {
      closedCount++;
      if (closedCount === totalToClose) {
        cleanupSocket().then(() => {
          if (callback) {callback();}
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
