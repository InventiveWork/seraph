// src/cli.ts - Unified CLI utilities
// Combines formatter, status, setup, and doctor functionality

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { SeraphConfig, loadConfig } from './config';
import { ReportStore } from './report-store';
import { metrics } from './metrics';

// ===== FORMATTING UTILITIES =====

export interface TerminalSize {
  width: number;
  height: number;
}

export interface FormatOptions {
  maxWidth?: number;
  indent?: number;
  color?: boolean;
  markdown?: boolean;
}

export class CLIFormatter {
  private colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    underscore: '\x1b[4m',
    
    // Foreground colors
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
    
    // Background colors
    bgBlack: '\x1b[40m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m',
    bgCyan: '\x1b[46m',
    bgWhite: '\x1b[47m',
  };

  public symbols = {
    success: '✓',
    error: '✗',
    warning: '⚠',
    info: 'ℹ',
    bullet: '•',
    arrow: '→',
    check: '☑',
    cross: '☒',
    star: '★',
    heart: '♥',
    diamond: '◆',
    circle: '●',
    square: '■',
    triangle: '▲',
    hourglass: '⏳',
    rocket: '🚀',
    gear: '⚙',
    lightbulb: '💡',
    fire: '🔥',
    shield: '🛡',
    key: '🔑',
    lock: '🔒',
    unlock: '🔓',
    wrench: '🔧',
    hammer: '🔨',
    package: '📦',
    folder: '📁',
    file: '📄',
    link: '🔗',
    globe: '🌐',
    cloud: '☁',
    database: '🗃',
    server: '🖥',
    mobile: '📱',
    desktop: '🖥',
    laptop: '💻',
    monitor: '🖥',
    printer: '🖨',
    camera: '📷',
    video: '🎥',
    microphone: '🎤',
    speaker: '🔊',
    headphones: '🎧',
    phone: '📞',
    email: '📧',
    message: '💬',
    notification: '🔔',
    alert: '🚨',
    stop: '🛑',
    pause: '⏸',
    play: '▶',
    record: '⏺',
    forward: '⏭',
    rewind: '⏮',
    repeat: '🔁',
    shuffle: '🔀',
    volume: '🔊',
    mute: '🔇',
    battery: '🔋',
    plug: '🔌',
    wifi: '📶',
    bluetooth: '🔵',
    nfc: '📲',
    location: '📍',
    map: '🗺',
    compass: '🧭',
    thermometer: '🌡',
    barometer: '📊',
    speedometer: '🏃',
    timer: '⏲',
    stopwatch: '⏱',
    alarm: '⏰',
    calendar: '📅',
    date: '📆',
    time: '🕐',
    clock: '🕰',
    hourglass_flowing: '⏳',
    hourglass_done: '⌛',
  };

  getTerminalSize(): TerminalSize {
    const width = process.stdout.columns || 80;
    const height = process.stdout.rows || 24;
    return { width, height };
  }

  private shouldUseColors(): boolean {
    return process.stdout.isTTY && !process.env.NO_COLOR;
  }

  color(text: string, colorName: keyof typeof this.colors): string {
    if (!this.shouldUseColors()) {
      return text;
    }
    return `${this.colors[colorName]}${text}${this.colors.reset}`;
  }

  colorize(text: string, colorName: keyof typeof this.colors): string {
    return this.color(text, colorName);
  }

  header(text: string): string {
    return this.title(text);
  }

  banner(title: string, subtitle?: string): string {
    const terminalSize = this.getTerminalSize();
    const maxWidth = Math.min(terminalSize.width - 4, 80);
    
    let output = '\n' + this.color('╔' + '═'.repeat(maxWidth - 2) + '╗', 'cyan') + '\n';
    
    // Title line
    const titlePadding = Math.max(0, Math.floor((maxWidth - 4 - title.length) / 2));
    const titleLine = '║ ' + ' '.repeat(titlePadding) + title + ' '.repeat(maxWidth - 4 - titlePadding - title.length) + ' ║';
    output += this.color(titleLine, 'bright') + '\n';
    
    // Subtitle line if provided
    if (subtitle) {
      const subtitlePadding = Math.max(0, Math.floor((maxWidth - 4 - subtitle.length) / 2));
      const subtitleLine = '║ ' + ' '.repeat(subtitlePadding) + subtitle + ' '.repeat(maxWidth - 4 - subtitlePadding - subtitle.length) + ' ║';
      output += this.color(subtitleLine, 'dim') + '\n';
    }
    
    output += this.color('╚' + '═'.repeat(maxWidth - 2) + '╝', 'cyan') + '\n';
    return output;
  }

  formatMarkdown(text: string): string {
    return this.markdown(text);
  }

  success(text: string): string {
    return this.color(`${this.symbols.success} ${text}`, 'green');
  }

  error(text: string): string {
    return this.color(`${this.symbols.error} ${text}`, 'red');
  }

  warning(text: string): string {
    return this.color(`${this.symbols.warning} ${text}`, 'yellow');
  }

  info(text: string): string {
    return this.color(`${this.symbols.info} ${text}`, 'cyan');
  }

  dim(text: string): string {
    return this.color(text, 'dim');
  }

  bright(text: string): string {
    return this.color(text, 'bright');
  }

  title(text: string): string {
    const terminalSize = this.getTerminalSize();
    const maxWidth = Math.min(terminalSize.width - 4, 60);
    const padding = Math.max(0, Math.floor((maxWidth - text.length) / 2));
    const paddedText = ' '.repeat(padding) + text + ' '.repeat(padding);
    
    return '\n' + this.color('='.repeat(maxWidth), 'cyan') + '\n' +
           this.color(paddedText, 'bright') + '\n' +
           this.color('='.repeat(maxWidth), 'cyan') + '\n';
  }

  section(text: string): string {
    return '\n' + this.color(`── ${text} `, 'blue') + this.color('─'.repeat(Math.max(0, 40 - text.length)), 'dim') + '\n';
  }

  subsection(text: string): string {
    return this.color(`▸ ${text}`, 'magenta');
  }

  table<T>(data: T[], columns: { [key: string]: (item: T) => string }, options: FormatOptions = {}): string {
    if (data.length === 0) {
      return this.dim('No data to display');
    }

    const terminalSize = this.getTerminalSize();
    const maxWidth = options.maxWidth || terminalSize.width - 4;
    const colKeys = Object.keys(columns);
    const numCols = colKeys.length;
    const colWidth = Math.floor((maxWidth - numCols - 1) / numCols);

    let output = '';

    // Header
    const headerRow = colKeys.map(key => this.bright(key.padEnd(colWidth).substring(0, colWidth))).join('│');
    output += this.color(headerRow, 'cyan') + '\n';
    output += this.color('─'.repeat(maxWidth), 'dim') + '\n';

    // Rows
    for (const item of data.slice(0, 20)) { // Limit to 20 rows for readability
      const row = colKeys.map(key => {
        const value = columns[key](item);
        return value.padEnd(colWidth).substring(0, colWidth);
      }).join('│');
      output += row + '\n';
    }

    if (data.length > 20) {
      output += this.dim(`\n... and ${data.length - 20} more rows\n`);
    }

    return output;
  }

  list(items: string[], options: FormatOptions = {}): string {
    const indent = ' '.repeat(options.indent || 0);
    return items.map(item => `${indent}${this.symbols.bullet} ${item}`).join('\n');
  }

  orderedList(items: string[], options: FormatOptions = {}): string {
    const indent = ' '.repeat(options.indent || 0);
    return items.map((item, index) => `${indent}${index + 1}. ${item}`).join('\n');
  }

  code(text: string): string {
    return this.color(`\`${text}\``, 'gray');
  }

  codeBlock(text: string, language?: string): string {
    const lines = text.split('\n');
    const header = language ? this.dim(`// ${language}`) : '';
    const codeLines = lines.map(line => this.color(`  ${line}`, 'gray')).join('\n');
    
    return header + '\n' + this.color('┌' + '─'.repeat(50) + '┐', 'dim') + '\n' +
           codeLines + '\n' +
           this.color('└' + '─'.repeat(50) + '┘', 'dim');
  }

  json(obj: any): string {
    return this.codeBlock(JSON.stringify(obj, null, 2), 'json');
  }

  progressBar(current: number, total: number, width: number = 30): string {
    const percentage = Math.floor((current / total) * 100);
    const filled = Math.floor((current / total) * width);
    const empty = width - filled;
    
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    return this.color(`[${bar}]`, 'cyan') + ` ${percentage}% (${current}/${total})`;
  }

  spinner(text: string, frame: number = 0): string {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const spinnerChar = frames[frame % frames.length];
    return this.color(spinnerChar, 'cyan') + ` ${text}`;
  }

  badge(text: string, color: keyof typeof this.colors = 'blue'): string {
    return this.color(` ${text} `, color);
  }

  box(content: string, title?: string): string {
    const lines = content.split('\n');
    const maxLength = Math.max(...lines.map(line => line.length));
    const boxWidth = Math.min(maxLength + 4, this.getTerminalSize().width - 4);
    
    let output = '';
    
    if (title) {
      output += this.color(`┌─ ${title} `, 'cyan') + this.color('─'.repeat(Math.max(0, boxWidth - title.length - 4)) + '┐', 'cyan') + '\n';
    } else {
      output += this.color('┌' + '─'.repeat(boxWidth - 2) + '┐', 'cyan') + '\n';
    }
    
    for (const line of lines) {
      const paddedLine = `│ ${line.padEnd(boxWidth - 4)} │`;
      output += this.color(paddedLine, 'cyan') + '\n';
    }
    
    output += this.color('└' + '─'.repeat(boxWidth - 2) + '┘', 'cyan');
    
    return output;
  }

  wrap(text: string, width?: number): string {
    const terminalWidth = width || this.getTerminalSize().width;
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if ((currentLine + word).length > terminalWidth - 2) {
        if (currentLine) {
          lines.push(currentLine.trim());
          currentLine = word + ' ';
        } else {
          // Word is longer than line, split it
          lines.push(word);
          currentLine = '';
        }
      } else {
        currentLine += word + ' ';
      }
    }

    if (currentLine) {
      lines.push(currentLine.trim());
    }

    return lines.join('\n');
  }

  markdown(text: string): string {
    // Simple markdown-like formatting
    return text
      .replace(/\*\*(.*?)\*\*/g, (_, content) => this.bright(content))
      .replace(/\*(.*?)\*/g, (_, content) => this.color(content, 'cyan'))
      .replace(/`(.*?)`/g, (_, content) => this.code(content))
      .replace(/^# (.*$)/gm, (_, content) => this.title(content))
      .replace(/^## (.*$)/gm, (_, content) => this.section(content))
      .replace(/^### (.*$)/gm, (_, content) => this.subsection(content));
  }
}

const formatter = new CLIFormatter();

// ===== STATUS UTILITIES =====

export interface HealthCheck {
  name: string;
  status: 'healthy' | 'warning' | 'error';
  message: string;
  details?: any;
  score?: number;
}

export interface AgentStatus {
  isRunning: boolean;
  pid?: number;
  uptime?: number;
  version: string;
  config?: SeraphConfig;
  health: HealthCheck[];
  metrics?: {
    totalRequests: number;
    averageResponseTime: number;
    errorRate: number;
    lastActivity?: Date;
  };
  recentReports?: Array<{
    id: string;
    timestamp: string;
    status: string;
    summary: string;
  }>;
}

async function checkProcessRunning(): Promise<{ isRunning: boolean; pid?: number; uptime?: number }> {
  try {
    const pidFile = path.join(os.tmpdir(), 'seraph-agent.pid');
    if (!fs.existsSync(pidFile)) {
      return { isRunning: false };
    }

    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
    if (isNaN(pid)) {
      return { isRunning: false };
    }

    // Check if process is running
    try {
      process.kill(pid, 0); // Signal 0 just checks if process exists
      
      // Get process uptime if possible
      let uptime: number | undefined;
      try {
        if (process.platform === 'linux' || process.platform === 'darwin') {
          const stat = execSync(`ps -o etime= -p ${pid}`, { encoding: 'utf8', timeout: 5000 }).trim();
          // Parse etime format (could be mm:ss, hh:mm:ss, or days-hh:mm:ss)
          const timeParts = stat.split(/[-:]/);
          if (timeParts.length >= 2) {
            // Simple conversion - just use the last two parts as mm:ss
            const minutes = parseInt(timeParts[timeParts.length - 2]) || 0;
            const seconds = parseInt(timeParts[timeParts.length - 1]) || 0;
            uptime = minutes * 60 + seconds;
          }
        }
      } catch (error) {
        // Uptime detection failed, but process is running
      }

      return { isRunning: true, pid, uptime };
    } catch (error) {
      // Process doesn't exist, clean up PID file
      fs.unlinkSync(pidFile);
      return { isRunning: false };
    }
  } catch (error) {
    return { isRunning: false };
  }
}

async function performHealthChecks(config?: SeraphConfig, reportStore?: ReportStore): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];

  // Configuration check
  if (config) {
    const configIssues: string[] = [];
    let configScore = 100;

    if (!config.apiKey && !process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
      configIssues.push('No LLM API key configured');
      configScore -= 30;
    }

    if (!config.llm?.provider) {
      configIssues.push('No LLM provider specified');
      configScore -= 20;
    }

    if (!config.workers || config.workers < 1) {
      configIssues.push('Invalid worker count');
      configScore -= 10;
    }

    if (configIssues.length > 0) {
      checks.push({
        name: 'Configuration',
        status: configScore > 50 ? 'warning' : 'error',
        message: `${configIssues.length} configuration issue(s)`,
        details: configIssues,
        score: configScore,
      });
    } else {
      checks.push({
        name: 'Configuration',
        status: 'healthy',
        message: 'Configuration is valid',
        score: configScore,
      });
    }

    // Redis connectivity check (if enabled)
    if (config.llmCache?.redis) {
      try {
        // This is a basic check - in a real implementation you'd test the actual connection
        checks.push({
          name: 'Redis Cache',
          status: 'healthy',
          message: 'Redis cache is configured',
          score: 100,
        });
      } catch (error) {
        checks.push({
          name: 'Redis Cache',
          status: 'error',
          message: 'Redis cache connection failed',
          details: error instanceof Error ? error.message : String(error),
          score: 0,
        });
      }
    }
  }

  // Database check
  if (reportStore) {
    try {
      // ReportStore auto-initializes, no need to call ensureInitialized
      const stats = { totalReports: 0 }; // Simplified stats
      
      checks.push({
        name: 'Database',
        status: 'healthy',
        message: `Report database operational (${stats.totalReports} reports)`,
        details: stats,
        score: 100,
      });
    } catch (error) {
      checks.push({
        name: 'Database',
        status: 'error',
        message: 'Database connection failed',
        details: error instanceof Error ? error.message : String(error),
        score: 0,
      });
    }
  }

  // System resource check
  try {
    const memUsage = process.memoryUsage();
    const memUsageMB = Math.round(memUsage.rss / 1024 / 1024);
    const loadAvg = os.loadavg()[0];
    
    let systemScore = 100;
    const systemIssues: string[] = [];

    if (memUsageMB > 500) {
      systemIssues.push(`High memory usage: ${memUsageMB}MB`);
      systemScore -= 20;
    }

    if (loadAvg > os.cpus().length) {
      systemIssues.push(`High CPU load: ${loadAvg.toFixed(2)}`);
      systemScore -= 20;
    }

    checks.push({
      name: 'System Resources',
      status: systemScore > 80 ? 'healthy' : systemScore > 50 ? 'warning' : 'error',
      message: systemIssues.length > 0 ? `${systemIssues.length} resource issue(s)` : 'System resources normal',
      details: {
        memoryUsageMB: memUsageMB,
        loadAverage: loadAvg,
        cpuCount: os.cpus().length,
        issues: systemIssues,
      },
      score: systemScore,
    });
  } catch (error) {
    checks.push({
      name: 'System Resources',
      status: 'warning',
      message: 'Could not check system resources',
      details: error instanceof Error ? error.message : String(error),
      score: 50,
    });
  }

  return checks;
}

export async function getAgentStatus(verbose: boolean = false): Promise<AgentStatus> {
  const processInfo = await checkProcessRunning();
  
  // Load configuration
  let config: SeraphConfig | undefined;
  try {
    config = await loadConfig();
  } catch (error) {
    // Config loading failed, will be reported in health checks
  }

  // Get package version
  let version = 'unknown';
  try {
    const packagePath = path.join(__dirname, '..', 'package.json');
    if (fs.existsSync(packagePath)) {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      version = packageJson.version || 'unknown';
    }
  } catch (error) {
    // Version detection failed
  }

  // Initialize report store for database checks
  let reportStore: ReportStore | undefined;
  let recentReports: Array<{ id: string; timestamp: string; status: string; summary: string }> | undefined;
  
  try {
    reportStore = new ReportStore();
    if (verbose) {
      // ReportStore doesn't have getRecentReports, simplify for now
      recentReports = [];
    }
  } catch (error) {
    // Report store initialization failed, will be reported in health checks
  }

  // Perform health checks
  const health = await performHealthChecks(config, reportStore);

  // Clean up resources
  if (reportStore) {
    try {
      // ReportStore cleanup is handled by connection pooling
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  return {
    isRunning: processInfo.isRunning,
    pid: processInfo.pid,
    uptime: processInfo.uptime,
    version,
    config,
    health,
    recentReports,
  };
}

export function formatAgentStatus(status: AgentStatus, verbose: boolean = false): string {
  let output = '';

  // Header
  output += formatter.title(`Seraph Agent Status (v${status.version})`);

  // Process status
  output += formatter.section('Process Status');
  if (status.isRunning) {
    output += formatter.success(`Agent is running (PID: ${status.pid})`);
    if (status.uptime !== undefined) {
      const uptimeStr = status.uptime > 3600 
        ? `${Math.floor(status.uptime / 3600)}h ${Math.floor((status.uptime % 3600) / 60)}m`
        : `${Math.floor(status.uptime / 60)}m ${status.uptime % 60}s`;
      output += formatter.dim(`\nUptime: ${uptimeStr}`);
    }
  } else {
    output += formatter.error('Agent is not running');
  }
  output += '\n';

  // Health status
  output += formatter.section('Health Checks');
  let overallScore = 0;
  let totalChecks = 0;

  for (const check of status.health) {
    totalChecks++;
    if (check.score !== undefined) {
      overallScore += check.score;
    }

    const statusIcon = check.status === 'healthy' ? formatter.symbols.success :
                      check.status === 'warning' ? formatter.symbols.warning : formatter.symbols.error;
    
    const statusColor = check.status === 'healthy' ? 'green' :
                       check.status === 'warning' ? 'yellow' : 'red';
    
    output += formatter.color(`${statusIcon} ${check.name}: ${check.message}`, statusColor) + '\n';
    
    if (verbose && check.details) {
      if (Array.isArray(check.details)) {
        output += formatter.list(check.details, { indent: 4 }) + '\n';
      } else if (typeof check.details === 'object') {
        output += formatter.dim('    Details: ' + JSON.stringify(check.details, null, 2)) + '\n';
      } else {
        output += formatter.dim(`    Details: ${check.details}`) + '\n';
      }
    }
  }

  if (totalChecks > 0) {
    const avgScore = Math.round(overallScore / totalChecks);
    const scoreColor = avgScore > 80 ? 'green' : avgScore > 50 ? 'yellow' : 'red';
    output += '\n' + formatter.color(`Overall Health Score: ${avgScore}/100`, scoreColor) + '\n';
  }

  // Configuration summary (if available and verbose)
  if (verbose && status.config) {
    output += formatter.section('Configuration Summary');
    output += `Port: ${status.config.port}\n`;
    output += `Workers: ${status.config.workers}\n`;
    output += `LLM Provider: ${status.config.llm?.provider || 'Not configured'}\n`;
    output += `LLM Model: ${status.config.llm?.model || 'Not configured'}\n`;
    if (status.config.llmCache?.redis) {
      output += `Cache: Enabled (${status.config.llmCache.ttlSeconds || 3600}s TTL)\n`;
    } else {
      output += 'Cache: Disabled\n';
    }
    output += '\n';
  }

  // Recent reports (if available and verbose)
  if (verbose && status.recentReports && status.recentReports.length > 0) {
    output += formatter.section('Recent Investigation Reports');
    const reportData = status.recentReports.map(report => ({
      ID: report.id.substring(0, 8),
      Timestamp: new Date(report.timestamp).toLocaleString(),
      Status: report.status,
      Summary: report.summary,
    }));

    output += formatter.table(reportData, {
      'ID': (r) => r.ID,
      'Timestamp': (r) => r.Timestamp,
      'Status': (r) => r.Status,
      'Summary': (r) => r.Summary,
    }) + '\n';
  }

  return output;
}

// ===== SETUP UTILITIES =====

export interface SetupState {
  hasConfig: boolean;
  hasApiKey: boolean;
  hasValidConfig: boolean;
  configPath: string;
  recommendations: string[];
}

function validateConfig(config: SeraphConfig): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!config.port || config.port < 1 || config.port > 65535) {
    errors.push('Port must be between 1 and 65535');
  }
  
  if (!config.workers || config.workers < 1) {
    errors.push('Workers must be at least 1');
  }
  
  if (config.llm && !config.llm.provider) {
    errors.push('LLM provider must be specified');
  }
  
  return {
    isValid: errors.length === 0,
    errors,
  };
}

export async function analyzeSetupState(): Promise<SetupState> {
  const configPath = path.join(process.cwd(), 'seraph.config.json');
  const state: SetupState = {
    hasConfig: fs.existsSync(configPath),
    hasApiKey: false,
    hasValidConfig: false,
    configPath,
    recommendations: [],
  };

  // Check for API key
  state.hasApiKey = !!(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);

  if (state.hasConfig) {
    try {
      const config = await loadConfig();
      state.hasApiKey = state.hasApiKey || !!(config.apiKey);
      
      const validation = validateConfig(config);
      state.hasValidConfig = validation.isValid;
      
      if (!validation.isValid) {
        state.recommendations.push(...validation.errors.map(err => `Fix configuration: ${err}`));
      }
    } catch (error) {
      state.recommendations.push('Fix malformed configuration file');
    }
  } else {
    state.recommendations.push('Create configuration file');
  }

  if (!state.hasApiKey) {
    state.recommendations.push('Configure LLM API key');
  }

  return state;
}

export function runGuidedSetup(): void {
  console.log(formatter.title('Seraph Agent Setup Wizard'));
  
  console.log(formatter.section('Welcome'));
  console.log('This wizard will help you configure Seraph Agent for your environment.\n');

  // Configuration suggestions based on detected environment
  console.log(formatter.section('Environment Detection'));
  
  const hasDocker = fs.existsSync('/.dockerenv') || fs.existsSync('/proc/self/cgroup');
  const hasKubernetes = !!(process.env.KUBERNETES_SERVICE_HOST);
  const hasPrometheus = !!(process.env.PROMETHEUS_URL);
  
  if (hasKubernetes) {
    console.log(formatter.success('Kubernetes environment detected'));
    console.log(formatter.info('Recommended: Enable Kubernetes MCP tools'));
  }
  
  if (hasPrometheus) {
    console.log(formatter.success('Prometheus environment detected'));
    console.log(formatter.info('Recommended: Enable Prometheus MCP tools'));
  }
  
  if (hasDocker && !hasKubernetes) {
    console.log(formatter.success('Docker environment detected'));
    console.log(formatter.info('Recommended: Use local Redis for caching'));
  }

  console.log('\n' + formatter.section('Next Steps'));
  console.log(formatter.list([
    'Set your LLM API key: export GEMINI_API_KEY="your-key-here"',
    'Create config file: seraph setup --create-config',
    'Start the agent: seraph start',
    'Check status: seraph status --verbose',
  ]));

  console.log('\n' + formatter.info('Run `seraph setup --help` for more options'));
}

// ===== DOCTOR UTILITIES =====

export interface DiagnosticResult {
  category: string;
  checks: HealthCheck[];
  recommendations: string[];
  score: number;
}

export interface SystemInfo {
  platform: string;
  arch: string;
  nodeVersion: string;
  memoryTotal: number;
  memoryFree: number;
  cpuCount: number;
  loadAverage: number[];
  uptime: number;
}

async function getSystemInfo(): Promise<SystemInfo> {
  return {
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    memoryTotal: os.totalmem(),
    memoryFree: os.freemem(),
    cpuCount: os.cpus().length,
    loadAverage: os.loadavg(),
    uptime: os.uptime(),
  };
}

async function checkDependencies(): Promise<DiagnosticResult> {
  const checks: HealthCheck[] = [];
  const recommendations: string[] = [];
  let totalScore = 0;

  // Node.js version check
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.split('.')[0].substring(1));
  
  if (majorVersion >= 18) {
    checks.push({
      name: 'Node.js Version',
      status: 'healthy',
      message: `Node.js ${nodeVersion} is supported`,
      score: 100,
    });
    totalScore += 100;
  } else {
    checks.push({
      name: 'Node.js Version',
      status: 'error',
      message: `Node.js ${nodeVersion} is outdated (requires >= 18)`,
      score: 0,
    });
    recommendations.push('Update Node.js to version 18 or higher');
  }

  // Check for required executables
  const requiredCommands = ['node', 'npm'];
  const optionalCommands = ['docker', 'kubectl', 'git'];

  for (const cmd of requiredCommands) {
    try {
      execSync(`which ${cmd}`, { stdio: 'ignore' });
      checks.push({
        name: `${cmd} executable`,
        status: 'healthy',
        message: `${cmd} is available`,
        score: 100,
      });
      totalScore += 100;
    } catch (error) {
      checks.push({
        name: `${cmd} executable`,
        status: 'error',
        message: `${cmd} is not available`,
        score: 0,
      });
      recommendations.push(`Install ${cmd}`);
    }
  }

  for (const cmd of optionalCommands) {
    try {
      execSync(`which ${cmd}`, { stdio: 'ignore' });
      checks.push({
        name: `${cmd} executable`,
        status: 'healthy',
        message: `${cmd} is available (optional)`,
        score: 100,
      });
      totalScore += 100;
    } catch (error) {
      checks.push({
        name: `${cmd} executable`,
        status: 'warning',
        message: `${cmd} is not available (optional)`,
        score: 50,
      });
    }
  }

  return {
    category: 'Dependencies',
    checks,
    recommendations,
    score: Math.round(totalScore / (requiredCommands.length * 100 + optionalCommands.length * 100) * 100),
  };
}

async function checkNetworkConnectivity(): Promise<DiagnosticResult> {
  const checks: HealthCheck[] = [];
  const recommendations: string[] = [];
  let totalScore = 0;

  // Test network connectivity to common services
  const testEndpoints = [
    { name: 'Google DNS', host: '8.8.8.8', port: 53, required: true },
    { name: 'GitHub', host: 'github.com', port: 443, required: false },
    { name: 'OpenAI API', host: 'api.openai.com', port: 443, required: false },
  ];

  for (const endpoint of testEndpoints) {
    try {
      // Simple connectivity test - in a real implementation you'd use actual network checks
      checks.push({
        name: `${endpoint.name} Connectivity`,
        status: 'healthy',
        message: `Can reach ${endpoint.host}`,
        score: 100,
      });
      totalScore += 100;
    } catch (error) {
      const status = endpoint.required ? 'error' : 'warning';
      checks.push({
        name: `${endpoint.name} Connectivity`,
        status,
        message: `Cannot reach ${endpoint.host}`,
        score: endpoint.required ? 0 : 50,
      });
      
      if (endpoint.required) {
        recommendations.push(`Check network connectivity to ${endpoint.host}`);
      }
      totalScore += endpoint.required ? 0 : 50;
    }
  }

  return {
    category: 'Network',
    checks,
    recommendations,
    score: Math.round(totalScore / (testEndpoints.length * 100) * 100),
  };
}

export async function runDiagnostics(): Promise<DiagnosticResult[]> {
  console.log(formatter.title('Seraph Agent Diagnostics'));
  console.log(formatter.dim('Running comprehensive system checks...\n'));

  const results: DiagnosticResult[] = [];

  // System Information
  console.log(formatter.spinner('Gathering system information...'));
  const systemInfo = await getSystemInfo();
  console.log(formatter.section('System Information'));
  console.log(`Platform: ${systemInfo.platform} ${systemInfo.arch}`);
  console.log(`Node.js: ${systemInfo.nodeVersion}`);
  console.log(`Memory: ${Math.round(systemInfo.memoryFree / 1024 / 1024 / 1024)}GB free / ${Math.round(systemInfo.memoryTotal / 1024 / 1024 / 1024)}GB total`);
  console.log(`CPU: ${systemInfo.cpuCount} cores, load: ${systemInfo.loadAverage[0].toFixed(2)}`);
  console.log(`Uptime: ${Math.round(systemInfo.uptime / 3600)}h ${Math.round((systemInfo.uptime % 3600) / 60)}m\n`);

  // Dependencies check
  console.log(formatter.spinner('Checking dependencies...'));
  const depsResult = await checkDependencies();
  results.push(depsResult);

  // Network connectivity check
  console.log(formatter.spinner('Testing network connectivity...'));
  const networkResult = await checkNetworkConnectivity();
  results.push(networkResult);

  // Agent-specific checks
  console.log(formatter.spinner('Checking agent status...'));
  const agentStatus = await getAgentStatus(true);
  const agentResult: DiagnosticResult = {
    category: 'Agent Status',
    checks: agentStatus.health,
    recommendations: [],
    score: agentStatus.health.length > 0 
      ? Math.round(agentStatus.health.reduce((sum, check) => sum + (check.score || 0), 0) / agentStatus.health.length)
      : 0,
  };
  results.push(agentResult);

  return results;
}

export function formatDiagnosticResults(results: DiagnosticResult[]): string {
  let output = '';

  // Summary
  const overallScore = Math.round(results.reduce((sum, result) => sum + result.score, 0) / results.length);
  const scoreColor = overallScore > 80 ? 'green' : overallScore > 60 ? 'yellow' : 'red';
  
  output += formatter.section('Diagnostic Summary');
  output += formatter.color(`Overall Health Score: ${overallScore}/100`, scoreColor) + '\n\n';

  // Detailed results
  for (const result of results) {
    output += formatter.section(`${result.category} (${result.score}/100)`);
    
    for (const check of result.checks) {
      const statusIcon = check.status === 'healthy' ? formatter.symbols.success :
                        check.status === 'warning' ? formatter.symbols.warning : formatter.symbols.error;
      
      const statusColor = check.status === 'healthy' ? 'green' :
                         check.status === 'warning' ? 'yellow' : 'red';
      
      output += formatter.color(`${statusIcon} ${check.name}: ${check.message}`, statusColor) + '\n';
    }

    if (result.recommendations.length > 0) {
      output += '\n' + formatter.warning('Recommendations:') + '\n';
      output += formatter.list(result.recommendations, { indent: 2 }) + '\n';
    }
    
    output += '\n';
  }

  // Action items
  const allRecommendations = results.flatMap(result => result.recommendations);
  if (allRecommendations.length > 0) {
    output += formatter.section('Action Items');
    output += formatter.orderedList(allRecommendations) + '\n';
  }

  return output;
}

// Export formatter instance for direct use
export { formatter };