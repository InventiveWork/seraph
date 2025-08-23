import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

// Mock child_process
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  spawn: mockSpawn,
}));

// Import after mocking
import { startMcpServer } from '../mcp-server';
import { SeraphConfig } from '../config';

describe('Kubernetes MCP Tools', () => {
  let server: any;
  let testPort: number;
  let config: SeraphConfig;

  beforeAll(() => {
    // Use a random port to avoid conflicts with other tests
    testPort = 9000 + Math.floor(Math.random() * 1000);
    config = {
      port: testPort,
      workers: 4,
      apiKey: 'test-key',
      serverApiKey: null,
      builtInMcpServer: {
        kubernetesContext: 'test-context',
        kubernetesNamespace: 'test-namespace',
      },
      llm: {
        provider: 'gemini',
      },
    };
  });

  beforeEach(() => {
    jest.clearAllMocks();
    server = startMcpServer(config);
  });

  afterEach((done) => {
    if (server) {
      server.close(done);
    } else {
      done();
    }
  });

  describe('Security Tests', () => {
    it('should block access to secrets', async () => {
      const response = await fetch(`http://localhost:${testPort + 1}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'tools/call',
          params: {
            name: 'k8s_get',
            arguments: { resource: 'secrets' },
          },
          id: 1,
        }),
      });

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error.message).toContain('Blocked potentially unsafe kubectl argument: secrets');
    }, 10000);

    it('should sanitize shell injection attempts', async () => {
      const response = await fetch(`http://localhost:${testPort + 1}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'tools/call',
          params: {
            name: 'k8s_get',
            arguments: { 
              resource: 'pods; rm -rf /',
              namespace: 'test',
            },
          },
          id: 1,
        }),
      });

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error.message).toContain('Resource type \'pods rm -rf \' is not allowed');
    }, 10000);

    it('should block dangerous kubectl arguments', async () => {
      const response = await fetch(`http://localhost:${testPort + 1}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'tools/call',
          params: {
            name: 'k8s_get',
            arguments: { 
              resource: 'pods --kubeconfig=/evil/path',
            },
          },
          id: 1,
        }),
      });

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error.message).toContain('Resource type \'pods --kubeconfig=\' is not allowed');
    }, 10000);
  });

  describe('Tool Functionality Tests', () => {
    it('should handle k8s_get tool correctly', async () => {
      const mockKubectl = {
        stdout: { 
          on: jest.fn((event: string, callback: (data: Buffer) => void) => {
            if (event === 'data') {
              callback(Buffer.from('{"items": [{"metadata": {"name": "test-pod"}}]}'));
            }
          }),
        },
        stderr: { on: jest.fn() },
        on: jest.fn((event: string, callback: (code: number) => void) => {
          if (event === 'close') {
            callback(0); // Success exit code
          }
        }),
      };
      
      mockSpawn.mockReturnValue(mockKubectl);

      const response = await fetch(`http://localhost:${testPort + 1}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'tools/call',
          params: {
            name: 'k8s_get',
            arguments: { resource: 'pods' },
          },
          id: 1,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockSpawn).toHaveBeenCalledWith('kubectl', 
        expect.arrayContaining(['--context', 'test-context', '-n', 'test-namespace', 'get', 'pods', '-o', 'json']),
        expect.any(Object),
      );
    }, 10000);

    it('should handle k8s_logs tool correctly', async () => {
      const mockKubectl = {
        stdout: { 
          on: jest.fn((event: string, callback: (data: Buffer) => void) => {
            if (event === 'data') {
              callback(Buffer.from('2023-01-01 10:00:00 INFO Application started\n2023-01-01 10:00:01 INFO Service ready'));
            }
          }),
        },
        stderr: { on: jest.fn() },
        on: jest.fn((event: string, callback: (code: number) => void) => {
          if (event === 'close') {
            callback(0); // Success exit code
          }
        }),
      };
      
      mockSpawn.mockReturnValue(mockKubectl);

      const response = await fetch(`http://localhost:${testPort + 1}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'tools/call',
          params: {
            name: 'k8s_logs',
            arguments: { 
              pod: 'test-pod',
              since: '5m',
              tail: 100,
            },
          },
          id: 1,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockSpawn).toHaveBeenCalledWith('kubectl', 
        expect.arrayContaining(['logs', 'test-pod', '--since', '5m', '--tail', '100']),
        expect.any(Object),
      );
    }, 10000);

    it('should handle k8s_events tool correctly', async () => {
      const mockKubectl = {
        stdout: { 
          on: jest.fn((event: string, callback: (data: Buffer) => void) => {
            if (event === 'data') {
              callback(Buffer.from('{"items": [{"type": "Warning", "reason": "FailedMount", "message": "Volume mount failed"}]}'));
            }
          }),
        },
        stderr: { on: jest.fn() },
        on: jest.fn((event: string, callback: (code: number) => void) => {
          if (event === 'close') {
            callback(0); // Success exit code
          }
        }),
      };
      
      mockSpawn.mockReturnValue(mockKubectl);

      const response = await fetch(`http://localhost:${testPort + 1}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'tools/call',
          params: {
            name: 'k8s_events',
            arguments: { 
              namespace: 'test',
              since: '10m',
            },
          },
          id: 1,
        }),
      });

      expect(response.status).toBe(200);
    }, 10000);
  });

  describe('Tool Listing', () => {
    it('should list all Kubernetes tools', async () => {
      const response = await fetch(`http://localhost:${testPort + 1}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'tools/list',
          params: {},
          id: 1,
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      const toolNames = data.result.tools.map((tool: any) => tool.name);
      
      expect(toolNames).toContain('k8s_get');
      expect(toolNames).toContain('k8s_describe');
      expect(toolNames).toContain('k8s_logs');
      expect(toolNames).toContain('k8s_events');
      expect(toolNames).toContain('k8s_top');
    }, 10000);
  });
});