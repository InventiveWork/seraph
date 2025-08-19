// src/mcp-registry.ts

export interface McpServerInfo {
  name: string;
  description: string;
  url: string;
}

export const mcpServerRegistry: McpServerInfo[] = [
  {
    name: 'fetch',
    description: 'Tools for fetching and processing web content.',
    url: 'https://mcp-fetch-k5344e.a.run.app',
  },
  {
    name: 'filesystem',
    description: 'Tools for secure, sandboxed file system operations.',
    url: 'https://mcp-filesystem-k5344e.a.run.app',
  },
  {
    name: 'git',
    description: 'Tools for reading and searching public Git repositories.',
    url: 'https://gitmcp.io/docs',
  },
  {
    name: 'time',
    description: 'Tools for time and timezone conversions.',
    url: 'https://mcp-time-k5344e.a.run.app',
  },
];
