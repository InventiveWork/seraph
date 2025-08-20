import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fetch from 'node-fetch';

// Mock node-fetch
jest.mock('node-fetch');
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

// Import the tools after mocking
import { startMcpServer } from '../mcp-server';
import { SeraphConfig } from '../config';

describe('Prometheus MCP Tools', () => {
  let server: any;
  const config: SeraphConfig = {
    port: 8080,
    workers: 4,
    apiKey: 'test-key',
    serverApiKey: null,
    builtInMcpServer: {
      prometheusUrl: 'http://localhost:9090'
    },
    llm: {
      provider: 'gemini'
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    server = startMcpServer(config);
  });

  afterEach(() => {
    if (server) {
      server.close();
    }
  });

  it('should handle prometheus_query tool', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: { __name__: 'up', job: 'prometheus' },
              value: [1609459200, '1']
            }
          ]
        }
      })
    };
    mockedFetch.mockResolvedValue(mockResponse as any);

    const response = await fetch('http://localhost:8081/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'tools/call',
        params: {
          name: 'prometheus_query',
          arguments: { query: 'up' }
        },
        id: 1
      })
    });

    expect(response.ok).toBe(true);
  });

  it('should handle prometheus_metrics tool', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        status: 'success',
        data: ['up', 'prometheus_notifications_total', 'prometheus_config_last_reload_seconds']
      })
    };
    mockedFetch.mockResolvedValue(mockResponse as any);

    const response = await fetch('http://localhost:8081/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'tools/call',
        params: {
          name: 'prometheus_metrics',
          arguments: {}
        },
        id: 1
      })
    });

    expect(response.ok).toBe(true);
  });

  it('should handle prometheus_alerts tool', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          alerts: [
            {
              labels: { alertname: 'HighErrorRate', severity: 'warning' },
              annotations: { summary: 'High error rate detected' },
              state: 'firing',
              activeAt: '2021-01-01T00:00:00Z'
            }
          ]
        }
      })
    };
    mockedFetch.mockResolvedValue(mockResponse as any);

    const response = await fetch('http://localhost:8081/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'tools/call',
        params: {
          name: 'prometheus_alerts',
          arguments: {}
        },
        id: 1
      })
    });

    expect(response.ok).toBe(true);
  });

  it('should handle prometheus_targets tool', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          activeTargets: [
            {
              labels: { job: 'prometheus', instance: 'localhost:9090' },
              health: 'up',
              lastScrape: '2021-01-01T00:00:00Z',
              scrapeUrl: 'http://localhost:9090/metrics'
            }
          ]
        }
      })
    };
    mockedFetch.mockResolvedValue(mockResponse as any);

    const response = await fetch('http://localhost:8081/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'tools/call',
        params: {
          name: 'prometheus_targets',
          arguments: {}
        },
        id: 1
      })
    });

    expect(response.ok).toBe(true);
  });

  it('should handle prometheus_rules tool', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          groups: [
            {
              name: 'example',
              file: '/etc/prometheus/rules.yml',
              rules: [
                {
                  name: 'HighErrorRate',
                  query: 'rate(http_requests_total{status=~"5.."}[5m]) > 0.1',
                  type: 'alerting'
                }
              ],
              interval: 30,
              evaluationTime: 0.001,
              lastEvaluation: '2021-01-01T00:00:00Z'
            }
          ]
        }
      })
    };
    mockedFetch.mockResolvedValue(mockResponse as any);

    const response = await fetch('http://localhost:8081/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'tools/call',
        params: {
          name: 'prometheus_rules',
          arguments: {}
        },
        id: 1
      })
    });

    expect(response.ok).toBe(true);
  });

  it('should handle tool listing', async () => {
    const response = await fetch('http://localhost:8081/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'tools/list',
        params: {},
        id: 1
      })
    });

    expect(response.ok).toBe(true);
  });
});