/**
 * Beautiful CLI output formatting utilities
 * Handles responsive design, colors, and markdown-like formatting
 */

import * as fs from 'fs';

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

  private symbols = {
    success: '✓',
    error: '✗',
    warning: '⚠',
    info: 'ℹ',
    arrow: '→',
    bullet: '•',
    line: '─',
    corner: '└',
    pipe: '│',
    cross: '┼',
    checkmark: '✓',
    clock: '🕐',
    rocket: '🚀',
    shield: '🛡️',
    gear: '⚙️',
    chart: '📊',
    alert: '🚨',
    magnifying: '🔍',
    cpu: '💻',
    memory: '🧠',
    network: '🌐',
    database: '💾'
  };

  private supportsTrueColor(): boolean {
    return process.env.COLORTERM === 'truecolor' || 
           process.env.TERM_PROGRAM === 'iTerm.app' ||
           process.env.TERM_PROGRAM === 'vscode';
  }

  private supportsColor(): boolean {
    return process.stdout.isTTY && 
           process.env.FORCE_COLOR !== '0' &&
           (!!process.env.FORCE_COLOR || 
            (process.env.TERM !== 'dumb' &&
            process.platform !== 'win32'));
  }

  getTerminalSize(): TerminalSize {
    return {
      width: process.stdout.columns || 80,
      height: process.stdout.rows || 24
    };
  }

  colorize(text: string, color: keyof typeof this.colors, options: FormatOptions = {}): string {
    if (!options.color && !this.supportsColor()) {
      return text;
    }
    return `${this.colors[color]}${text}${this.colors.reset}`;
  }

  bold(text: string, options: FormatOptions = {}): string {
    return this.colorize(text, 'bright', options);
  }

  success(text: string, options: FormatOptions = {}): string {
    const symbol = this.symbols.success;
    return this.colorize(`${symbol} ${text}`, 'green', options);
  }

  error(text: string, options: FormatOptions = {}): string {
    const symbol = this.symbols.error;
    return this.colorize(`${symbol} ${text}`, 'red', options);
  }

  warning(text: string, options: FormatOptions = {}): string {
    const symbol = this.symbols.warning;
    return this.colorize(`${symbol} ${text}`, 'yellow', options);
  }

  info(text: string, options: FormatOptions = {}): string {
    const symbol = this.symbols.info;
    return this.colorize(`${symbol} ${text}`, 'blue', options);
  }

  header(text: string, options: FormatOptions = {}): string {
    const { width } = this.getTerminalSize();
    const maxWidth = options.maxWidth || width;
    const line = this.symbols.line.repeat(Math.min(text.length + 4, maxWidth));
    
    return [
      this.colorize(line, 'cyan', options),
      this.colorize(`  ${text}  `, 'bright', options),
      this.colorize(line, 'cyan', options)
    ].join('\n');
  }

  section(title: string, content: string[], options: FormatOptions = {}): string {
    const titleFormatted = this.colorize(`${this.symbols.rocket} ${title}`, 'bright', options);
    const contentFormatted = content.map(line => 
      `  ${this.symbols.bullet} ${line}`
    ).join('\n');
    
    return `${titleFormatted}\n${contentFormatted}`;
  }

  table(headers: string[], rows: string[][], options: FormatOptions = {}): string {
    const { width } = this.getTerminalSize();
    const maxWidth = options.maxWidth || width - 4;
    
    if (headers.length === 0 || rows.length === 0) {
      return this.info('No data to display');
    }

    // Calculate column widths
    const colWidths = headers.map((header, i) => {
      const maxDataWidth = Math.max(...rows.map(row => (row[i] || '').length));
      return Math.min(Math.max(header.length, maxDataWidth), Math.floor(maxWidth / headers.length));
    });

    // Format header
    const headerRow = headers.map((header, i) => 
      header.padEnd(colWidths[i]).substring(0, colWidths[i])
    ).join(' │ ');
    
    const separator = colWidths.map(w => this.symbols.line.repeat(w)).join('─┼─');
    
    // Format rows
    const dataRows = rows.map(row => 
      headers.map((_, i) => 
        (row[i] || '').padEnd(colWidths[i]).substring(0, colWidths[i])
      ).join(' │ ')
    );

    return [
      this.colorize(`┌─${separator}─┐`, 'gray', options),
      this.colorize(`│ ${headerRow} │`, 'bright', options),
      this.colorize(`├─${separator}─┤`, 'gray', options),
      ...dataRows.map(row => `│ ${row} │`),
      this.colorize(`└─${separator}─┘`, 'gray', options)
    ].join('\n');
  }

  progressBar(current: number, total: number, options: FormatOptions = {}): string {
    const { width } = this.getTerminalSize();
    const barWidth = Math.min(40, width - 20);
    const percentage = Math.round((current / total) * 100);
    const filled = Math.round((current / total) * barWidth);
    const empty = barWidth - filled;
    
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    return this.colorize(`[${bar}] ${percentage}%`, 'cyan', options);
  }

  formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  }

  formatMarkdown(text: string, options: FormatOptions = {}): string {
    if (!options.markdown) return text;

    return text
      // Bold
      .replace(/\*\*(.*?)\*\*/g, (_, content) => this.bold(content, options))
      // Code blocks
      .replace(/```(.*?)```/gs, (_, code) => 
        this.colorize(`\n┌─ Code ──\n│ ${code.split('\n').join('\n│ ')}\n└─────────\n`, 'gray', options)
      )
      // Inline code
      .replace(/`([^`]+)`/g, (_, code) => this.colorize(code, 'cyan', options))
      // Headers
      .replace(/^### (.*$)/gm, (_, title) => this.colorize(`${this.symbols.arrow} ${title}`, 'yellow', options))
      .replace(/^## (.*$)/gm, (_, title) => this.colorize(`${this.symbols.rocket} ${title}`, 'magenta', options))
      .replace(/^# (.*$)/gm, (_, title) => this.header(title, options))
      // Lists
      .replace(/^- (.*$)/gm, (_, item) => `  ${this.symbols.bullet} ${item}`)
      // Links (remove markdown syntax, keep text)
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  }

  wrap(text: string, options: FormatOptions = {}): string {
    const { width } = this.getTerminalSize();
    const maxWidth = options.maxWidth || width - (options.indent || 0);
    const indent = ' '.repeat(options.indent || 0);
    
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = indent;
    
    for (const word of words) {
      if (currentLine.length + word.length + 1 > maxWidth) {
        lines.push(currentLine);
        currentLine = indent + word;
      } else {
        currentLine += (currentLine === indent ? '' : ' ') + word;
      }
    }
    
    if (currentLine.trim()) {
      lines.push(currentLine);
    }
    
    return lines.join('\n');
  }

  banner(title: string, subtitle?: string, options: FormatOptions = {}): string {
    const { width } = this.getTerminalSize();
    const maxWidth = Math.min(options.maxWidth || width, 80);
    
    const titleLength = title.length;
    const subtitleLength = subtitle ? subtitle.length : 0;
    const contentWidth = Math.max(titleLength, subtitleLength) + 4;
    const bannerWidth = Math.min(Math.max(contentWidth, 40), maxWidth);
    
    const topBorder = '┌' + '─'.repeat(bannerWidth - 2) + '┐';
    const bottomBorder = '└' + '─'.repeat(bannerWidth - 2) + '┘';
    
    const centerText = (text: string) => {
      const padding = Math.max(0, bannerWidth - 2 - text.length);
      const leftPad = Math.floor(padding / 2);
      const rightPad = padding - leftPad;
      return '│' + ' '.repeat(leftPad) + text + ' '.repeat(rightPad) + '│';
    };
    
    const lines = [
      this.colorize(topBorder, 'cyan', options),
      this.colorize(centerText(''), 'cyan', options),
      this.colorize(centerText(this.bold(title, options)), 'cyan', options)
    ];
    
    if (subtitle) {
      lines.push(this.colorize(centerText(subtitle), 'cyan', options));
    }
    
    lines.push(
      this.colorize(centerText(''), 'cyan', options),
      this.colorize(bottomBorder, 'cyan', options)
    );
    
    return lines.join('\n');
  }

  spinner(text: string): { start: () => void; stop: (finalText?: string) => void } {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let current = 0;
    let interval: NodeJS.Timeout;
    
    return {
      start: () => {
        process.stdout.write('\x1b[?25l'); // Hide cursor
        interval = setInterval(() => {
          const frame = frames[current % frames.length];
          process.stdout.write(`\r${this.colorize(frame, 'cyan')} ${text}`);
          current++;
        }, 80);
      },
      stop: (finalText?: string) => {
        if (interval) clearInterval(interval);
        process.stdout.write('\r\x1b[K'); // Clear line
        process.stdout.write('\x1b[?25h'); // Show cursor
        if (finalText) {
          console.log(finalText);
        }
      }
    };
  }
}

export const formatter = new CLIFormatter();