// src/mcp-server.ts

import * as http from 'http';
import { execFile, spawn } from 'child_process';
import { SeraphConfig } from './config';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import fetch from 'node-fetch';

export interface McpTool {
  name: string;
  description: string;
  schema: any;
}

// --- Tool Implementations ---

function handleGitLog(args: any, config: SeraphConfig): Promise<any> {
  const repoPath = config.builtInMcpServer?.gitRepoPath ?? args.repoPath;
  if (!repoPath) {
    throw new Error('gitRepoPath is not configured in seraph.config.json and was not provided in the tool arguments.');
  }
  const maxCount = args.maxCount ?? 10;
  
  // Using execFile to prevent command injection
  const gitArgs = ['-C', repoPath, 'log', `--max-count=${maxCount}`, '--pretty=format:%h - %an, %ar : %s'];
  
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
export async function validateDestinationPath(destination: string): Promise<string> {
  if (!destination) {
    throw new Error('Destination path cannot be empty');
  }

  // Check for path traversal BEFORE resolving (but allow safe relative paths)
  if (destination.includes('..') || destination.includes('.\\') || 
      destination.includes('%2e%2e') || destination.includes('%2f') || destination.includes('%5c')) {
    throw new Error('Security violation: Path traversal detected in destination');
  }
  
  // Reject patterns that could be used for traversal
  if (destination.match(/\/\.\//g) || destination.match(/\\\.\\.\//) || destination.includes('../')) {
    throw new Error('Security violation: Path traversal detected in destination');
  }

  // Normalize and resolve to absolute path
  const resolvedPath = path.resolve(destination);
  
  // Define allowed base directories (canonical paths)
  let allowedBaseDirs: string[];
  try {
    allowedBaseDirs = [
      await fs.realpath('/tmp'),
      await fs.realpath('/var/tmp'),
    ];
  } catch {
    // Fallback if realpath fails
    allowedBaseDirs = ['/tmp', '/var/tmp'];
  }
  
  let canonicalPath: string;
  try {
    // Try to resolve the full path including any symlinks
    canonicalPath = await fs.realpath(resolvedPath);
  } catch {
    // If the full path doesn't exist, try to resolve the parent directory
    try {
      const parentDir = path.dirname(resolvedPath);
      const canonicalParent = await fs.realpath(parentDir);
      canonicalPath = path.join(canonicalParent, path.basename(resolvedPath));
      
      // If this is a symlink, we need to check what it points to
      try {
        const symlinkTarget = await fs.readlink(resolvedPath);
        // If it's an absolute symlink, resolve it
        if (path.isAbsolute(symlinkTarget)) {
          canonicalPath = await fs.realpath(symlinkTarget);
        } else {
          // Relative symlink - resolve relative to the symlink's directory
          const absoluteTarget = path.resolve(canonicalParent, symlinkTarget);
          try {
            canonicalPath = await fs.realpath(absoluteTarget);
          } catch {
            // Target doesn't exist, but validate the target path anyway
            canonicalPath = absoluteTarget;
          }
        }
      } catch {
        // Not a symlink or can't read link, use the canonical parent + basename
        canonicalPath = path.join(canonicalParent, path.basename(resolvedPath));
      }
    } catch {
      // Parent doesn't exist either, validate against resolved path
      canonicalPath = resolvedPath;
    }
  }
  
  // Additional protection against system directories BEFORE allowlist check
  const protectedPaths = [
    '/tmp/systemd',
    '/tmp/.X11-unix', 
    '/var/tmp/systemd',
    '/tmp/.ICE-unix',
    '/tmp/.Test-unix',
  ];
  
  for (const protectedPath of protectedPaths) {
    if (canonicalPath.startsWith(protectedPath) || resolvedPath.startsWith(protectedPath)) {
      throw new Error('Security violation: Cannot access protected system directories');
    }
  }
  
  // Check if either the resolved path or canonical path is within allowed directories
  const isPathAllowed = (pathToCheck: string): boolean => {
    return allowedBaseDirs.some(allowedDir => {
      // Normalize both paths for comparison
      const normalizedAllowed = allowedDir.endsWith(path.sep) ? allowedDir : allowedDir + path.sep;
      const normalizedPath = pathToCheck.endsWith(path.sep) ? pathToCheck : pathToCheck + path.sep;
      
      return pathToCheck.startsWith(normalizedAllowed) || 
             pathToCheck === allowedDir ||
             normalizedPath.startsWith(normalizedAllowed);
    });
  };
  
  const isAllowed = isPathAllowed(canonicalPath) || isPathAllowed(resolvedPath);
  
  if (!isAllowed) {
    throw new Error(`Security violation: Destination must be within ${allowedBaseDirs.join(' or ')}. Got: ${canonicalPath}`);
  }

  // Ensure the final path doesn't escape allowed directories through symlinks
  if (canonicalPath !== resolvedPath) {
    // Additional check: ensure symlink target is still within allowed dirs
    const symlinkAllowed = allowedBaseDirs.some(allowedDir => 
      canonicalPath.startsWith(allowedDir),
    );
    if (!symlinkAllowed) {
      throw new Error('Security violation: Symlink target outside allowed directories');
    }
  }

  return canonicalPath;
}

async function handleGitClone(args: any, _config: SeraphConfig): Promise<any> {
  const { repoUrl, destination } = args;
  if (!repoUrl) {
    throw new Error('repoUrl is a required argument.');
  }

  // Determine clone destination
  let cloneDir: string;
  if (destination) {
    // Use validated custom destination
    cloneDir = await validateDestinationPath(destination);
    
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
    } catch {
      // Ignore URL parsing errors for non-standard git URLs
    }
  }

  // Using execFile to prevent command injection. Cloning into the validated directory.
  const gitArgs = ['clone', authenticatedUrl, cloneDir];

  return new Promise((resolve) => {
    execFile('git', gitArgs, { timeout: 60000 }, (error, _stdout, stderr) => { // Added 60s timeout
      if (error) {
        let sanitizedError = stderr ?? error.message;
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

// --- Prometheus Tool Implementations ---

async function handlePrometheusQuery(args: any, config: SeraphConfig): Promise<any> {
  const prometheusUrl = config.builtInMcpServer?.prometheusUrl ?? args.prometheusUrl ?? 'http://localhost:9090';
  const { query, time, start, end, step } = args;
  
  if (!query) {
    throw new Error('query is a required argument for Prometheus queries.');
  }

  try {
    let url: string;
    const params = new URLSearchParams();
    params.append('query', query);

    if (start && end) {
      // Range query
      url = `${prometheusUrl}/api/v1/query_range`;
      params.append('start', start);
      params.append('end', end);
      if (step) {params.append('step', step);}
    } else {
      // Instant query
      url = `${prometheusUrl}/api/v1/query`;
      if (time) {params.append('time', time);}
    }

    const response = await fetch(`${url}?${params.toString()}`);
    
    if (!response.ok) {
      throw new Error(`Prometheus API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    if (data.status !== 'success') {
      throw new Error(`Prometheus query failed: ${data.error ?? 'Unknown error'}`);
    }

    return {
      query,
      resultType: data.data.resultType,
      result: data.data.result,
      metrics: data.data.result.length ?? 0,
      queryTime: data.data.result.length > 0 ? 'success' : 'no_data',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to query Prometheus: ${errorMessage}`);
  }
}

async function handlePrometheusMetrics(args: any, config: SeraphConfig): Promise<any> {
  const prometheusUrl = config.builtInMcpServer?.prometheusUrl ?? args.prometheusUrl ?? 'http://localhost:9090';
  const { match } = args;

  try {
    let url = `${prometheusUrl}/api/v1/label/__name__/values`;
    if (match) {
      url += `?match[]=${encodeURIComponent(match)}`;
    }

    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Prometheus API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    if (data.status !== 'success') {
      throw new Error(`Failed to fetch metrics: ${data.error ?? 'Unknown error'}`);
    }

    return {
      metrics: data.data,
      count: data.data.length,
      filtered: !!match,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to fetch Prometheus metrics: ${errorMessage}`);
  }
}

async function handlePrometheusAlerts(args: any, config: SeraphConfig): Promise<any> {
  const prometheusUrl = config.builtInMcpServer?.prometheusUrl ?? args.prometheusUrl ?? 'http://localhost:9090';

  try {
    const response = await fetch(`${prometheusUrl}/api/v1/alerts`);
    
    if (!response.ok) {
      throw new Error(`Prometheus API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    if (data.status !== 'success') {
      throw new Error(`Failed to fetch alerts: ${data.error ?? 'Unknown error'}`);
    }

    const alerts = data.data.alerts ?? [];
    const activeAlerts = alerts.filter((alert: any) => alert.state === 'firing');
    const pendingAlerts = alerts.filter((alert: any) => alert.state === 'pending');

    return {
      total: alerts.length,
      active: activeAlerts.length,
      pending: pendingAlerts.length,
      alerts: alerts.map((alert: any) => ({
        name: alert.labels?.alertname ?? 'Unknown',
        state: alert.state,
        severity: alert.labels?.severity ?? 'unknown',
        summary: alert.annotations?.summary ?? '',
        description: alert.annotations?.description ?? '',
        activeAt: alert.activeAt,
        labels: alert.labels,
        annotations: alert.annotations,
      })),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to fetch Prometheus alerts: ${errorMessage}`);
  }
}

async function handlePrometheusTargets(args: any, config: SeraphConfig): Promise<any> {
  const prometheusUrl = config.builtInMcpServer?.prometheusUrl ?? args.prometheusUrl ?? 'http://localhost:9090';

  try {
    const response = await fetch(`${prometheusUrl}/api/v1/targets`);
    
    if (!response.ok) {
      throw new Error(`Prometheus API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    if (data.status !== 'success') {
      throw new Error(`Failed to fetch targets: ${data.error ?? 'Unknown error'}`);
    }

    const targets = data.data.activeTargets ?? [];
    const healthyTargets = targets.filter((target: any) => target.health === 'up');
    const unhealthyTargets = targets.filter((target: any) => target.health === 'down');

    return {
      total: targets.length,
      healthy: healthyTargets.length,
      unhealthy: unhealthyTargets.length,
      targets: targets.map((target: any) => ({
        job: target.labels?.job ?? 'unknown',
        instance: target.labels?.instance ?? 'unknown',
        health: target.health,
        lastError: target.lastError ?? '',
        lastScrape: target.lastScrape,
        scrapeUrl: target.scrapeUrl,
        labels: target.labels,
      })),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to fetch Prometheus targets: ${errorMessage}`);
  }
}

async function handlePrometheusRules(args: any, config: SeraphConfig): Promise<any> {
  const prometheusUrl = config.builtInMcpServer?.prometheusUrl ?? args.prometheusUrl ?? 'http://localhost:9090';

  try {
    const response = await fetch(`${prometheusUrl}/api/v1/rules`);
    
    if (!response.ok) {
      throw new Error(`Prometheus API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    if (data.status !== 'success') {
      throw new Error(`Failed to fetch rules: ${data.error ?? 'Unknown error'}`);
    }

    const groups = data.data.groups ?? [];
    let totalRules = 0;
    let firingRules = 0;

    const processedGroups = groups.map((group: any) => {
      const rules = group.rules ?? [];
      totalRules += rules.length;
      
      const groupFiring = rules.filter((rule: any) => 
        rule.alerts?.some((alert: any) => alert.state === 'firing'),
      ).length;
      
      firingRules += groupFiring;

      return {
        name: group.name,
        file: group.file,
        interval: group.interval,
        rules: rules.length,
        firing: groupFiring,
        evaluationTime: group.evaluationTime,
        lastEvaluation: group.lastEvaluation,
      };
    });

    return {
      totalGroups: groups.length,
      totalRules,
      firingRules,
      groups: processedGroups,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to fetch Prometheus rules: ${errorMessage}`);
  }
}

// --- Kubernetes Tool Implementations ---

// Security: Allowed kubectl commands for read-only investigation
const ALLOWED_KUBECTL_COMMANDS = [
  'get', 'describe', 'logs', 'top', 'explain',
];

// Security: Allowed resource types for investigation
const ALLOWED_K8S_RESOURCES = [
  'pods', 'services', 'deployments', 'replicasets', 'daemonsets', 'statefulsets',
  'nodes', 'events', 'configmaps', 'persistentvolumes', 'persistentvolumeclaims',
  'ingress', 'networkpolicies', 'jobs', 'cronjobs', 'endpoints', 'namespaces',
];

// Security: Blocked resource types that may contain sensitive data
const BLOCKED_K8S_RESOURCES = [
  'secrets', 'serviceaccounts',
];

function sanitizeKubectlArgs(args: string[]): string[] {
  const sanitized: string[] = [];
  
  for (const arg of args) {
    // Remove any shell metacharacters and command injection attempts
    const clean = arg.replace(/[;&|`$(){}[\]<>'"\\]/g, '').trim();
    
    // Skip empty args after sanitization
    if (clean.length === 0) {continue;}
    
    // Block dangerous flags and options
    if (clean.startsWith('--kubeconfig') || 
        clean.startsWith('--token') ||
        clean.startsWith('--certificate') ||
        clean.startsWith('--key') ||
        clean.includes('secret') ||
        clean.includes('password') ||
        clean.includes('token')) {
      throw new Error(`Blocked potentially unsafe kubectl argument: ${arg}`);
    }
    
    sanitized.push(clean);
  }
  
  return sanitized;
}

function validateKubectlCommand(command: string, resource?: string): void {
  if (!ALLOWED_KUBECTL_COMMANDS.includes(command)) {
    throw new Error(`kubectl command '${command}' is not allowed. Allowed commands: ${ALLOWED_KUBECTL_COMMANDS.join(', ')}`);
  }
  
  if (resource) {
    const resourceType = resource.split('/')[0].toLowerCase();
    
    if (BLOCKED_K8S_RESOURCES.includes(resourceType)) {
      throw new Error(`Access to '${resourceType}' resources is blocked for security reasons`);
    }
    
    if (!ALLOWED_K8S_RESOURCES.includes(resourceType)) {
      throw new Error(`Resource type '${resourceType}' is not allowed. Allowed types: ${ALLOWED_K8S_RESOURCES.join(', ')}`);
    }
  }
}

async function executeKubectl(args: string[], config: SeraphConfig): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      // Sanitize all arguments
      const sanitizedArgs = sanitizeKubectlArgs(args);
      
      // Validate the command and resource if present
      if (sanitizedArgs.length > 0) {
        const command = sanitizedArgs[0];
        
        // For some commands, the second argument is a resource type
        // For others (like logs), it's a specific resource name
        let resourceToValidate = undefined;
        if (sanitizedArgs.length > 1) {
          const secondArg = sanitizedArgs[1];
          
          // For kubectl logs, the second argument is a pod name, not a resource type
          if (command === 'logs') {
            // Don't validate pod names as resource types
            resourceToValidate = undefined;
          } else {
            // For other commands, validate the resource type
            resourceToValidate = secondArg;
          }
        }
        
        validateKubectlCommand(command, resourceToValidate);
      }
      
      // Add context and namespace if configured
      const kubectlArgs: string[] = [];
      
      if (config.builtInMcpServer?.kubernetesContext) {
        kubectlArgs.push('--context', config.builtInMcpServer.kubernetesContext);
      }
      
      if (config.builtInMcpServer?.kubernetesNamespace && !sanitizedArgs.includes('-n') && !sanitizedArgs.includes('--namespace')) {
        kubectlArgs.push('-n', config.builtInMcpServer.kubernetesNamespace);
      }
      
      kubectlArgs.push(...sanitizedArgs);
      
      // Execute kubectl with sanitized arguments
      const kubectl = spawn('kubectl', kubectlArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000, // 30 second timeout
      });
      
      let stdout = '';
      let stderr = '';
      
      kubectl.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      kubectl.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      kubectl.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`kubectl command failed: ${stderr ?? 'Unknown error'}`));
        }
      });
      
      kubectl.on('error', (error) => {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        reject(new Error(`Failed to execute kubectl: ${errorMessage}`));
      });
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      reject(new Error(`kubectl validation failed: ${errorMessage}`));
    }
  });
}

async function handleKubectlGet(args: any, config: SeraphConfig): Promise<any> {
  const { resource, namespace, selector, output = 'json' } = args;
  
  if (!resource) {
    throw new Error('resource is a required argument for kubectl get');
  }
  
  const kubectlArgs = ['get', resource];
  
  if (namespace) {
    kubectlArgs.push('-n', namespace);
  }
  
  if (selector) {
    kubectlArgs.push('-l', selector);
  }
  
  if (output === 'json' || output === 'yaml') {
    kubectlArgs.push('-o', output);
  }
  
  try {
    const result = await executeKubectl(kubectlArgs, config);
    
    return {
      command: `kubectl ${kubectlArgs.join(' ')}`,
      resource,
      namespace: namespace ?? config.builtInMcpServer?.kubernetesNamespace ?? 'default',
      output: output === 'json' ? JSON.parse(result) : result,
      raw: result,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`kubectl get failed: ${errorMessage}`);
  }
}

async function handleKubectlDescribe(args: any, config: SeraphConfig): Promise<any> {
  const { resource, name, namespace } = args;
  
  if (!resource) {
    throw new Error('resource is a required argument for kubectl describe');
  }
  
  const kubectlArgs = ['describe', resource];
  
  if (name) {
    kubectlArgs.push(name);
  }
  
  if (namespace) {
    kubectlArgs.push('-n', namespace);
  }
  
  try {
    const result = await executeKubectl(kubectlArgs, config);
    
    return {
      command: `kubectl ${kubectlArgs.join(' ')}`,
      resource,
      name: name ?? 'all',
      namespace: namespace ?? config.builtInMcpServer?.kubernetesNamespace ?? 'default',
      description: result,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`kubectl describe failed: ${errorMessage}`);
  }
}

async function handleKubectlLogs(args: any, config: SeraphConfig): Promise<any> {
  const { pod, namespace, container, previous = false, since, tail } = args;
  
  if (!pod) {
    throw new Error('pod is a required argument for kubectl logs');
  }
  
  const kubectlArgs = ['logs', pod];
  
  if (namespace) {
    kubectlArgs.push('-n', namespace);
  }
  
  if (container) {
    kubectlArgs.push('-c', container);
  }
  
  if (previous) {
    kubectlArgs.push('--previous');
  }
  
  if (since) {
    kubectlArgs.push('--since', since);
  }
  
  if (tail) {
    kubectlArgs.push('--tail', tail.toString());
  }
  
  try {
    const result = await executeKubectl(kubectlArgs, config);
    
    return {
      command: `kubectl ${kubectlArgs.join(' ')}`,
      pod,
      namespace: namespace ?? config.builtInMcpServer?.kubernetesNamespace ?? 'default',
      container: container ?? 'default',
      logs: result,
      lineCount: result.split('\n').length,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`kubectl logs failed: ${errorMessage}`);
  }
}

async function handleKubectlEvents(args: any, config: SeraphConfig): Promise<any> {
  const { namespace, fieldSelector, since } = args;
  
  const kubectlArgs = ['get', 'events'];
  
  if (namespace) {
    kubectlArgs.push('-n', namespace);
  }
  
  if (fieldSelector) {
    kubectlArgs.push('--field-selector', fieldSelector);
  }
  
  kubectlArgs.push('--sort-by', '.lastTimestamp');
  
  if (since) {
    // Convert since to field selector for events
    const sinceDate = new Date(Date.now() - parseDuration(since));
    kubectlArgs.push('--field-selector', `firstTimestamp>${sinceDate.toISOString()}`);
  }
  
  kubectlArgs.push('-o', 'json');
  
  try {
    const result = await executeKubectl(kubectlArgs, config);
    const events = JSON.parse(result);
    
    return {
      command: `kubectl ${kubectlArgs.join(' ')}`,
      namespace: namespace ?? config.builtInMcpServer?.kubernetesNamespace ?? 'default',
      eventCount: events.items?.length ?? 0,
      events: events.items ?? [],
      fieldSelector,
      since,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`kubectl get events failed: ${errorMessage}`);
  }
}

async function handleKubectlTop(args: any, config: SeraphConfig): Promise<any> {
  const { resource, namespace, selector } = args;
  
  if (!resource || !['nodes', 'pods'].includes(resource)) {
    throw new Error("resource must be 'nodes' or 'pods' for kubectl top");
  }
  
  const kubectlArgs = ['top', resource];
  
  if (resource === 'pods' && namespace) {
    kubectlArgs.push('-n', namespace);
  }
  
  if (selector) {
    kubectlArgs.push('-l', selector);
  }
  
  try {
    const result = await executeKubectl(kubectlArgs, config);
    
    return {
      command: `kubectl ${kubectlArgs.join(' ')}`,
      resource,
      namespace: namespace ?? config.builtInMcpServer?.kubernetesNamespace ?? 'default',
      usage: result,
      selector,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`kubectl top failed: ${errorMessage}`);
  }
}

// Helper function to parse duration strings like "5m", "1h", "30s"
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([smh])$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}. Use format like "5m", "1h", "30s"`);
  }
  
  const value = parseInt(match[1]);
  const unit = match[2];
  
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    default: throw new Error(`Invalid duration unit: ${unit}`);
  }
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
          description: 'Optional: Secure destination path. Must be within /tmp/ or /var/tmp/ for security. If not provided, uses a secure temporary directory.', 
        },
      },
      required: ['repoUrl'],
    },
  },
  {
    name: 'prometheus_query',
    description: 'Execute PromQL queries against Prometheus. Supports both instant and range queries for metrics analysis.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The PromQL query to execute.' },
        time: { type: 'string', description: 'Evaluation timestamp for instant queries (RFC3339 or Unix timestamp).' },
        start: { type: 'string', description: 'Start timestamp for range queries (RFC3339 or Unix timestamp).' },
        end: { type: 'string', description: 'End timestamp for range queries (RFC3339 or Unix timestamp).' },
        step: { type: 'string', description: 'Query resolution step width for range queries (e.g., "15s", "1m").' },
        prometheusUrl: { type: 'string', description: 'Override Prometheus URL (optional, uses config default).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'prometheus_metrics',
    description: 'List all available metrics in Prometheus, with optional filtering.',
    schema: {
      type: 'object',
      properties: {
        match: { type: 'string', description: 'Optional metric matcher pattern to filter results.' },
        prometheusUrl: { type: 'string', description: 'Override Prometheus URL (optional, uses config default).' },
      },
      required: [],
    },
  },
  {
    name: 'prometheus_alerts',
    description: 'Get current alert status from Prometheus, including active and pending alerts.',
    schema: {
      type: 'object',
      properties: {
        prometheusUrl: { type: 'string', description: 'Override Prometheus URL (optional, uses config default).' },
      },
      required: [],
    },
  },
  {
    name: 'prometheus_targets',
    description: 'Get the status of all Prometheus scrape targets, including health and error information.',
    schema: {
      type: 'object',
      properties: {
        prometheusUrl: { type: 'string', description: 'Override Prometheus URL (optional, uses config default).' },
      },
      required: [],
    },
  },
  {
    name: 'prometheus_rules',
    description: 'Get information about Prometheus recording and alerting rules, including evaluation status.',
    schema: {
      type: 'object',
      properties: {
        prometheusUrl: { type: 'string', description: 'Override Prometheus URL (optional, uses config default).' },
      },
      required: [],
    },
  },
  {
    name: 'k8s_get',
    description: 'Get Kubernetes resources for investigation. Supports pods, services, deployments, etc.',
    schema: {
      type: 'object',
      properties: {
        resource: { type: 'string', description: 'Resource type (e.g., pods, services, deployments).' },
        namespace: { type: 'string', description: 'Kubernetes namespace (optional).' },
        selector: { type: 'string', description: 'Label selector (optional, e.g., "app=nginx").' },
        output: { type: 'string', enum: ['json', 'yaml', 'wide'], description: 'Output format (default: json).' },
      },
      required: ['resource'],
    },
  },
  {
    name: 'k8s_describe',
    description: 'Describe Kubernetes resources for detailed investigation.',
    schema: {
      type: 'object',
      properties: {
        resource: { type: 'string', description: 'Resource type (e.g., pod, service, deployment).' },
        name: { type: 'string', description: 'Resource name (optional, describes all if not specified).' },
        namespace: { type: 'string', description: 'Kubernetes namespace (optional).' },
      },
      required: ['resource'],
    },
  },
  {
    name: 'k8s_logs',
    description: 'Get logs from Kubernetes pods for investigation.',
    schema: {
      type: 'object',
      properties: {
        pod: { type: 'string', description: 'Pod name to get logs from.' },
        namespace: { type: 'string', description: 'Kubernetes namespace (optional).' },
        container: { type: 'string', description: 'Container name within the pod (optional).' },
        previous: { type: 'boolean', description: 'Get logs from previous container instance (default: false).' },
        since: { type: 'string', description: 'Show logs since duration (e.g., "5m", "1h").' },
        tail: { type: 'number', description: 'Number of lines to show from the end of logs.' },
      },
      required: ['pod'],
    },
  },
  {
    name: 'k8s_events',
    description: 'Get Kubernetes events for incident investigation.',
    schema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Kubernetes namespace (optional, all namespaces if not specified).' },
        fieldSelector: { type: 'string', description: 'Field selector for filtering events (optional).' },
        since: { type: 'string', description: 'Show events since duration (e.g., "5m", "1h").' },
      },
      required: [],
    },
  },
  {
    name: 'k8s_top',
    description: 'Get resource usage statistics for nodes or pods.',
    schema: {
      type: 'object',
      properties: {
        resource: { type: 'string', enum: ['nodes', 'pods'], description: 'Resource type to get usage for.' },
        namespace: { type: 'string', description: 'Kubernetes namespace (for pods only).' },
        selector: { type: 'string', description: 'Label selector (optional).' },
      },
      required: ['resource'],
    },
  },
];


// --- Tool Routing and Registration ---

type ToolHandler = (args: any, config: SeraphConfig) => Promise<any>;
const toolHandlers = new Map<string, ToolHandler>();

toolHandlers.set('git_log', handleGitLog);
toolHandlers.set('git_clone', handleGitClone);
toolHandlers.set('prometheus_query', handlePrometheusQuery);
toolHandlers.set('prometheus_metrics', handlePrometheusMetrics);
toolHandlers.set('prometheus_alerts', handlePrometheusAlerts);
toolHandlers.set('prometheus_targets', handlePrometheusTargets);
toolHandlers.set('prometheus_rules', handlePrometheusRules);
toolHandlers.set('k8s_get', handleKubectlGet);
toolHandlers.set('k8s_describe', handleKubectlDescribe);
toolHandlers.set('k8s_logs', handleKubectlLogs);
toolHandlers.set('k8s_events', handleKubectlEvents);
toolHandlers.set('k8s_top', handleKubectlTop);

// MCP Protocol Handlers
toolHandlers.set('initialize', async (args: any) => {
  const clientProtocolVersion = args?.protocolVersion ?? '1.0';
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
  const mcpPort = (config.port ?? 8080) + 1;

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
        } catch (error) {
          res.statusCode = 500;
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          res.end(JSON.stringify({ error: { message: errorMessage }, jsonrpc: '2.0', id }));
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
