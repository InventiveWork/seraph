/**
 * Interactive setup wizard for Seraph
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { formatter } from './formatter';

export interface SetupConfig {
  llm: {
    provider: 'gemini' | 'anthropic' | 'openai';
    model?: string;
    apiKey?: string;
  };
  server: {
    port: number;
    workers: number;
  };
  features: {
    mcpServer: boolean;
    redisCache: boolean;
    gitIntegration: boolean;
    prometheusIntegration: boolean;
  };
  integrations: {
    gitRepoPath?: string;
    gitRepoUrl?: string;
    prometheusUrl?: string;
    redis?: {
      host: string;
      port: number;
      password?: string;
    };
  };
}

export class SetupWizard {
  private rl: readline.Interface;
  private config: Partial<SetupConfig> = {};

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  private async question(prompt: string, defaultValue?: string): Promise<string> {
    const displayPrompt = defaultValue 
      ? `${prompt} ${formatter.colorize(`(${defaultValue})`, 'gray')}: `
      : `${prompt}: `;
    
    return new Promise((resolve) => {
      this.rl.question(displayPrompt, (answer) => {
        resolve(answer.trim() || (defaultValue ?? ''));
      });
    });
  }

  private async confirm(prompt: string, defaultValue: boolean = false): Promise<boolean> {
    const defaultText = defaultValue ? 'Y/n' : 'y/N';
    const answer = await this.question(`${prompt} (${defaultText})`);
    
    if (!answer) {return defaultValue;}
    return answer.toLowerCase().startsWith('y');
  }

  private async select<T extends string>(prompt: string, options: { value: T; label: string; description?: string }[], defaultIndex: number = 0): Promise<T> {
    console.log(`\n${prompt}`);
    
    options.forEach((option, index) => {
      const marker = index === defaultIndex ? formatter.colorize('>', 'cyan') : ' ';
      const label = formatter.bold(option.label);
      const description = option.description ? formatter.colorize(` - ${option.description}`, 'gray') : '';
      console.log(`${marker} ${index + 1}. ${label}${description}`);
    });
    
    while (true) {
      const answer = await this.question(`Select option (1-${options.length})`, (defaultIndex + 1).toString());
      const index = parseInt(answer) - 1;
      
      if (index >= 0 && index < options.length) {
        return options[index].value;
      }
      
      console.log(formatter.error('Invalid selection. Please choose a valid option.'));
    }
  }

  private async detectExistingConfig(): Promise<Partial<SetupConfig>> {
    const detected: Partial<SetupConfig> = {};
    
    // Check for existing config file
    const configPath = path.join(process.cwd(), 'seraph.config.json');
    try {
      const existingConfig = JSON.parse(await fs.promises.readFile(configPath, 'utf-8'));
      console.log(formatter.info('Found existing configuration file'));
      Object.assign(detected, existingConfig);
    } catch {
      // No existing config
    }

    // Detect Git repository
    try {
      await fs.promises.access(path.join(process.cwd(), '.git'));
      detected.integrations = detected.integrations ?? {};
      detected.integrations.gitRepoPath = process.cwd();
      console.log(formatter.success('Git repository detected in current directory'));
    } catch {
      // No git repo
    }

    // Check for common ports
    const commonPorts = [8080, 3000, 8000, 9090];
    for (const port of commonPorts) {
      try {
        const { spawn } = await import('child_process');
        const netstat = spawn('netstat', ['-an'], { stdio: 'pipe' });
        
        await new Promise<void>((resolve) => {
          let output = '';
          netstat.stdout?.on('data', (data) => output += data.toString());
          netstat.on('close', () => {
            if (!output.includes(`:${port}`)) {
              if (!detected.server) {detected.server = { port: 0, workers: 4 };}
              detected.server.port = port;
            }
            resolve();
          });
        });
        
        if (detected.server?.port) {break;}
      } catch {
        // Fallback to default port
        if (!detected.server) {detected.server = { port: 8080, workers: 4 };}
        detected.server.port = 8080;
        break;
      }
    }

    // Check for environment variables
    const apiKeys = {
      gemini: process.env.GEMINI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,
    };

    if (apiKeys.gemini || apiKeys.anthropic || apiKeys.openai) {
      console.log(formatter.success('Found API keys in environment variables'));
      if (!detected.llm) {detected.llm = { provider: 'gemini' };}
      
      if (apiKeys.gemini) {detected.llm.provider = 'gemini';}
      else if (apiKeys.anthropic) {detected.llm.provider = 'anthropic';}
      else if (apiKeys.openai) {detected.llm.provider = 'openai';}
    }

    return detected;
  }

  private async setupLLM(): Promise<void> {
    console.log(formatter.header('LLM Configuration'));
    
    const provider = await this.select('Choose your LLM provider:', [
      { 
        value: 'gemini', 
        label: 'Google Gemini', 
        description: 'Fast, cost-effective, great for most use cases', 
      },
      { 
        value: 'anthropic', 
        label: 'Anthropic Claude', 
        description: 'Excellent reasoning, good for complex analysis', 
      },
      { 
        value: 'openai', 
        label: 'OpenAI GPT', 
        description: 'Well-established, reliable performance', 
      },
    ], 0);

    this.config.llm = { provider };

    // Model selection based on provider
    let modelOptions: { value: string; label: string; description?: string }[] = [];
    
    switch (provider) {
      case 'gemini':
        modelOptions = [
          { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', description: 'Fast and cost-effective' },
          { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', description: 'Higher quality, more expensive' },
        ];
        break;
      case 'anthropic':
        modelOptions = [
          { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku', description: 'Fast and efficient' },
          { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', description: 'Balanced performance' },
        ];
        break;
      case 'openai':
        modelOptions = [
          { value: 'gpt-4o-mini', label: 'GPT-4O Mini', description: 'Cost-effective' },
          { value: 'gpt-4o', label: 'GPT-4O', description: 'Higher performance' },
        ];
        break;
    }

    if (modelOptions.length > 0) {
      this.config.llm.model = await this.select('Choose the model:', modelOptions, 0);
    }

    // API Key handling
    const envVarName = `${provider.toUpperCase()}_API_KEY`;
    const existingKey = process.env[envVarName];
    
    if (existingKey) {
      console.log(formatter.success(`Using existing ${envVarName} from environment`));
    } else {
      const enterKey = await this.confirm('Do you want to enter your API key now? (It will be stored in the config file)');
      if (enterKey) {
        const apiKey = await this.question(`Enter your ${provider} API key`);
        if (apiKey) {
          this.config.llm.apiKey = apiKey;
        }
      } else {
        console.log(formatter.info(`Remember to set the ${envVarName} environment variable`));
      }
    }
  }

  private async setupServer(): Promise<void> {
    console.log(formatter.header('Server Configuration'));
    
    const defaultPort = this.config.server?.port ?? 8080;
    const portStr = await this.question('Server port', defaultPort.toString());
    const port = parseInt(portStr) || defaultPort;
    
    const workersStr = await this.question('Number of analysis workers', '4');
    const workers = parseInt(workersStr) ?? 4;
    
    this.config.server = { port, workers };
  }

  private async setupFeatures(): Promise<void> {
    console.log(formatter.header('Feature Configuration'));
    
    this.config.features = {
      mcpServer: await this.confirm('Enable built-in MCP server for tool integrations?', true),
      redisCache: await this.confirm('Enable Redis caching to reduce LLM costs?', false),
      gitIntegration: await this.confirm('Enable Git integration for code analysis?', true),
      prometheusIntegration: await this.confirm('Enable Prometheus integration?', false),
    };
  }

  private async setupIntegrations(): Promise<void> {
    console.log(formatter.header('Integration Configuration'));
    
    this.config.integrations = {};

    if (this.config.features?.gitIntegration) {
      console.log(formatter.info('Git Integration Setup'));
      
      const defaultPath = this.config.integrations?.gitRepoPath || process.cwd();
      const gitRepoPath = await this.question('Path to Git repository', defaultPath);
      
      const includeRemote = await this.confirm('Include remote repository URL for cloning?');
      let gitRepoUrl;
      if (includeRemote) {
        gitRepoUrl = await this.question('Git repository URL (https://...)');
      }
      
      this.config.integrations.gitRepoPath = gitRepoPath;
      if (gitRepoUrl) {
        this.config.integrations.gitRepoUrl = gitRepoUrl;
      }
    }

    if (this.config.features?.prometheusIntegration) {
      console.log(formatter.info('Prometheus Integration Setup'));
      const prometheusUrl = await this.question('Prometheus server URL', 'http://localhost:9090');
      this.config.integrations.prometheusUrl = prometheusUrl;
    }

    if (this.config.features?.redisCache) {
      console.log(formatter.info('Redis Cache Setup'));
      const host = await this.question('Redis host', 'localhost');
      const portStr = await this.question('Redis port', '6379');
      const password = await this.question('Redis password (leave empty if none)');
      
      this.config.integrations.redis = {
        host,
        port: parseInt(portStr) ?? 6379,
      };
      
      if (password) {
        this.config.integrations.redis.password = password;
      }
    }
  }

  private async generateConfig(): Promise<string> {
    const finalConfig: any = {
      llm: {
        provider: this.config.llm?.provider ?? 'gemini',
        ...(this.config.llm?.model && { model: this.config.llm.model }),
        ...(this.config.llm?.apiKey && { apiKey: this.config.llm.apiKey }),
      },
      port: this.config.server?.port ?? 8080,
      workers: this.config.server?.workers ?? 4,
    };

    if (this.config.features && this.config.features.mcpServer && this.config.integrations && (this.config.integrations.gitRepoPath || this.config.integrations.prometheusUrl)) {
      finalConfig.builtInMcpServer = {};
      
      if (this.config.integrations.gitRepoPath) {
        finalConfig.builtInMcpServer.gitRepoPath = this.config.integrations.gitRepoPath;
      }
      
      if (this.config.integrations.gitRepoUrl) {
        finalConfig.builtInMcpServer.gitRepoUrl = this.config.integrations.gitRepoUrl;
      }
      
      if (this.config.integrations.prometheusUrl) {
        finalConfig.builtInMcpServer.prometheusUrl = this.config.integrations.prometheusUrl;
      }
    }

    if (this.config.features && this.config.features.redisCache && this.config.integrations?.redis) {
      finalConfig.llmCache = {
        redis: this.config.integrations.redis,
        similarityThreshold: 0.85,
        ttlSeconds: 3600,
      };
    }

    return JSON.stringify(finalConfig, null, 2);
  }

  async run(): Promise<void> {
    const options = { color: true, markdown: true };
    
    console.log(formatter.banner('Seraph Setup Wizard', 'Configure your AI SRE agent', options));
    console.log();
    
    console.log(formatter.info('This wizard will help you configure Seraph for your environment.'));
    console.log();

    // Auto-detection
    const spinner = formatter.spinner('Detecting existing configuration...');
    spinner.start();
    
    const detected = await this.detectExistingConfig();
    Object.assign(this.config, detected);
    
    spinner.stop();

    if (Object.keys(detected).length > 0) {
      console.log(formatter.success('Auto-detected some configuration settings'));
      const useDetected = await this.confirm('Use auto-detected settings as defaults?', true);
      if (!useDetected) {
        this.config = {};
      }
    }

    // Configuration steps
    await this.setupLLM();
    await this.setupServer();
    await this.setupFeatures();
    await this.setupIntegrations();

    // Generate and preview config
    console.log(formatter.header('Configuration Summary'));
    
    const configJson = await this.generateConfig();
    console.log('Generated configuration:');
    console.log(formatter.colorize(configJson, 'cyan', options));
    console.log();

    // Confirmation and save
    const saveConfig = await this.confirm('Save this configuration?', true);
    
    if (saveConfig) {
      const configPath = path.join(process.cwd(), 'seraph.config.json');
      await fs.promises.writeFile(configPath, configJson, 'utf-8');
      
      console.log(formatter.success(`Configuration saved to ${configPath}`));
      console.log();
      
      // Next steps
      console.log(formatter.section('Next Steps', [
        'seraph start - Start the agent with your new configuration',
        'seraph status --verbose - Check detailed agent status',
        'seraph chat "Hello" - Test the agent chat functionality',
      ], options));

      // Environment variable reminder
      if (!this.config.llm?.apiKey) {
        const envVar = `${this.config.llm?.provider?.toUpperCase()}_API_KEY`;
        console.log();
        console.log(formatter.warning(`Don't forget to set your ${envVar} environment variable!`));
        console.log(formatter.info(`export ${envVar}="your-api-key-here"`));
      }
    } else {
      console.log(formatter.info('Configuration not saved. You can run this wizard again anytime.'));
    }

    this.rl.close();
  }
}