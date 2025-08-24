import { AlerterClient } from '../alerter';
import { SeraphConfig } from '../config';
import fetch from 'node-fetch';

jest.mock('node-fetch', () => jest.fn());
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }));

const { Response } = jest.requireActual('node-fetch');

describe('AlerterClient', () => {
  const mockFetch = fetch as unknown as jest.Mock;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  const alerterInstances: AlerterClient[] = [];

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Clean up all alerter instances to prevent open handles
    alerterInstances.forEach(alerter => {
      try {
        alerter.stop();
      } catch (e) {
        // Ignore cleanup errors
      }
    });
    alerterInstances.length = 0;
    
    jest.clearAllMocks();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  const baseConfig: SeraphConfig = {
    port: 8080,
    workers: 1,
    apiKey: 'test-key',
    serverApiKey: null,
    alertManager: {
      url: 'http://fake-alertmanager:9093/api/v2/alerts',
    },
  };

  it('should send an initial alert', async () => {
    const alerter = new AlerterClient(baseConfig);
    alerterInstances.push(alerter);
    mockFetch.mockResolvedValue(new Response('OK', { status: 200 }));

    await alerter.sendInitialAlert('test log', 'test reason');

    expect(mockFetch).toHaveBeenCalledWith(baseConfig.alertManager?.url, expect.any(Object));
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)[0];
    expect(body.labels.alertname).toBe('SeraphAnomalyTriage');
    expect(body.labels.incidentId).toBe('mock-uuid');
  });

  it('should send a system alert to the configured Alertmanager URL', async () => {
    const alerter = new AlerterClient(baseConfig);
    alerterInstances.push(alerter);
    const context = {
      source: 'test-source',
      type: 'test-type',
      details: 'This is a test alert',
    };

    mockFetch.mockResolvedValue(new Response('OK', { status: 200 }));

    await alerter.sendSystemAlert(context);

    expect(mockFetch).toHaveBeenCalledWith(baseConfig.alertManager?.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        {
          labels: {
            alertname: 'SeraphSystemEvent',
            source: 'test-source',
            type: 'test-type',
          },
          annotations: {
            summary: 'System event in test-source',
            description: 'This is a test alert',
          },
        },
      ]),
    });
  });

  it('should not send an alert if the Alertmanager URL is not configured', async () => {
    const configWithoutUrl: SeraphConfig = { ...baseConfig, alertManager: { url: '' } };
    const alerter = new AlerterClient(configWithoutUrl);
    alerterInstances.push(alerter);
    
    // We expect this to log an error, but not throw, so we can't await a rejection.
    // Instead we check that fetch was not called.
    await alerter.sendInitialAlert('test log', 'test reason');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled(); // It should not error, just log
  });


  it('should handle network errors when sending an alert', async () => {
    const alerter = new AlerterClient(baseConfig);
    alerterInstances.push(alerter);
    mockFetch.mockRejectedValue(new Error('Network error'));

    await alerter.sendInitialAlert('test log', 'test reason');

    expect(mockFetch).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to send initial alert'), expect.any(String));
  });

  it('should handle non-ok responses from Alertmanager', async () => {
    const alerter = new AlerterClient(baseConfig);
    alerterInstances.push(alerter);
    mockFetch.mockResolvedValue(new Response('Internal Server Error', { status: 500 }));

    await alerter.sendInitialAlert('test log', 'test reason');

    expect(mockFetch).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to send initial alert'), expect.any(String));
  });
});