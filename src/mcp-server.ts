// src/mcp-server.ts

import * as http from 'http';
import { execFile } from 'child_process';
import { SeraphConfig } from './config';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface McpTool {
  name: string;
  description: string;
  schema: any;
}

// --- Tool Implementations ---

function handleGitLog(args: any, config: SeraphConfig): Promise<any> {
  const repoPath = config.builtInMcpServer?.gitRepoPath || args.repoPath;
  if (!repoPath) {
    throw new Error("gitRepoPath is not configured in seraph.config.json and was not provided in the tool arguments.");
  }
  const maxCount = args.maxCount || 10;
  
  // Using execFile to prevent command injection
  const gitArgs = ['-C', repoPath, 'log', `--max-count=${maxCount}`, "--pretty=format:%h - %an, %ar : %s"];
  
  return new Promise((resolve, reject) => {
    execFile('git', gitArgs, (error: Error | null, stdout: string, stderr: string) => {
      if (error) {
        return reject(new Error(stderr));
      }
      resolve({ log: stdout.split('\n') });
    });
  });
}

// Security function to validate destination paths
function validateDestinationPath(destination: string): string {
  if (!destination) {
    throw new Error("Destination path cannot be empty");
  }

  // Resolve to absolute path and normalize
  const resolvedPath = path.resolve(destination);
  
  // Security checks
  const allowedPrefixes = ['/tmp/', '/var/tmp/'];
  const isAllowed = allowedPrefixes.some(prefix => resolvedPath.startsWith(prefix));
  
  if (!isAllowed) {
    throw new Error(`Security violation: Destination must be within ${allowedPrefixes.join(' or ')}. Got: ${resolvedPath}`);
  }
  
  // Check for path traversal attempts
  if (resolvedPath.includes('..') || resolvedPath.includes('./') || resolvedPath.includes('.\\')) {
    throw new Error("Security violation: Path traversal detected in destination");
  }
  
  // Ensure we're not overwriting system directories
  const systemPaths = ['/tmp/systemd', '/tmp/.X11-unix', '/var/tmp/systemd'];
  if (systemPaths.some(sysPath => resolvedPath.startsWith(sysPath))) {
    throw new Error("Security violation: Cannot overwrite system temporary directories");
  }

  return resolvedPath;
}

async function handleGitClone(args: any, config: SeraphConfig): Promise<any> {
  const { repoUrl, destination } = args;
  if (!repoUrl) {
    throw new Error("repoUrl is a required argument.");
  }

  // Determine clone destination
  let cloneDir: string;
  if (destination) {
    // Use validated custom destination
    cloneDir = validateDestinationPath(destination);
    
    // Create directory if it doesn't exist
    try {
      await fs.mkdir(cloneDir, { recursive: true });
    } catch (error) {
      throw new Error(`Failed to create destination directory ${cloneDir}: ${(error as Error).message}`);
    }
  } else {
    // Use secure temporary directory (original behavior)
    cloneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seraph-clone-'));
  }
  const githubToken = process.env.GITHUB_TOKEN;

  let authenticatedUrl = repoUrl;
  if (githubToken && repoUrl.includes('github.com')) {
    try {
      const url = new URL(repoUrl);
      url.username = 'x-access-token';
      url.password = githubToken.trim();
      authenticatedUrl = url.toString();
    } catch (e) {
      // Ignore URL parsing errors for non-standard git URLs
    }
  }

  // Using execFile to prevent command injection. Cloning into the validated directory.
  const gitArgs = ['clone', authenticatedUrl, cloneDir];

  return new Promise((resolve) => {
    execFile('git', gitArgs, { timeout: 60000 }, (error, _stdout, stderr) => { // Added 60s timeout
      if (error) {
        let sanitizedError = stderr || error.message;
        if (githubToken) {
          sanitizedError = sanitizedError.replace(new RegExp(githubToken, 'g'), 'REDACTED_TOKEN');
        }
        // Clean up the directory on failure only if it was a temp directory
        if (!destination) {
          fs.rm(cloneDir, { recursive: true, force: true });
        }
        resolve({
          success: false,
          clonePath: cloneDir,
          error: sanitizedError,
        });
      } else {
        resolve({
          success: true,
          clonePath: cloneDir,
          result: `Successfully cloned ${repoUrl} to: ${cloneDir}`,
        });
      }
    });
  });
}

// --- MCP Server Core ---

const BUILT_IN_TOOLS: McpTool[] = [
  {
    name: 'git_log',
    description: 'Gets the most recent commit logs from a specified Git repository.',
    schema: {
      type: 'object',
      properties: {
        repoPath: { type: 'string', description: 'The local filesystem path to the Git repository.' },
        maxCount: { type: 'number', description: 'The number of commits to return.' },
      },
      required: [], // repoPath can be provided by config
    },
  },
  {
    name: 'git_clone',
    description: 'Clones a public Git repository into a secure directory for analysis. Supports private GitHub repos via GITHUB_TOKEN env var. If no destination is provided, uses a secure temporary directory.',
    schema: {
      type: 'object',
      properties: {
        repoUrl: { type: 'string', description: 'The URL of the Git repository to clone.' },
        destination: { 
          type: 'string', 
          description: 'Optional: Secure destination path. Must be within /tmp/ or /var/tmp/ for security. If not provided, uses a secure temporary directory.' 
        },
      },
      required: ['repoUrl'],
    },
  },
];


// --- Tool Routing and Registration ---

type ToolHandler = (args: any, config: SeraphConfig) => Promise<any>;
const toolHandlers = new Map<string, ToolHandler>();

toolHandlers.set('git_log', handleGitLog);
toolHandlers.set('git_clone', handleGitClone);

// MCP Protocol Handlers
toolHandlers.set('initialize', async (args: any) => {
  const clientProtocolVersion = args?.protocolVersion || '1.0';
  return {
    protocolVersion: clientProtocolVersion,
    serverInfo: { name: 'Seraph Built-in MCP Server', version: '1.0.0' },
    capabilities: {
      tools: BUILT_IN_TOOLS.reduce((acc, tool) => {
        acc[tool.name] = { description: tool.description };
        return acc;
      }, {} as Record<string, { description: string }>),
    },
  };
});

toolHandlers.set('notifications/initialized', async () => ({}));

toolHandlers.set('tools/list', async () => ({
  tools: BUILT_IN_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.schema,
  })),
}));


async function callTool(toolName: string, args: any, config: SeraphConfig): Promise<any> {
  const handler = toolHandlers.get(toolName);
  if (handler) {
    return handler(args, config);
  }
  throw new Error(`Tool not found: ${toolName}`);
}

export function startMcpServer(config: SeraphConfig) {
  const mcpPort = (config.port || 8080) + 1;

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.url !== '/mcp') {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }
    
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        let id = null;
        try {
          const { method, params, id: reqId } = JSON.parse(body);
          id = reqId;

          const toolName = method === 'tools/call' ? params.name : method;
          const toolArgs = method === 'tools/call' ? params.arguments : params;
          
          const result = await callTool(toolName, toolArgs, config);
          res.statusCode = 200;
          res.end(JSON.stringify({ result, jsonrpc: '2.0', id }));
        } catch (error: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: { message: error.message }, jsonrpc: '2.0', id }));
        }
      });
      return;
    }
    
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
  });

  server.listen(mcpPort, () => {
    console.log(`Built-in MCP Server listening on http://localhost:${mcpPort}/mcp`);
  });

  return server;
}
