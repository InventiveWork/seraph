import { AlerterClient } from '../alerter';
import { SeraphConfig } from '../config';
import fetch from 'node-fetch';

jest.mock('node-fetch', () => jest.fn());

const { Response } = jest.requireActual('node-fetch');

describe('AlerterClient', () => {
  const mockFetch = fetch as unknown as jest.Mock;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllMocks();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should send an alert to the configured Alertmanager URL', async () => {
    const config: SeraphConfig = {
      port: 8080,
      workers: 1,
      apiKey: 'test-key',
      serverApiKey: null,
      alertManager: {
        url: 'http://fake-alertmanager:9093/api/v2/alerts',
      },
    };
    const alerter = new AlerterClient(config);
    const context = {
      source: 'test-source',
      type: 'test-type',
      details: 'This is a test alert',
      log: 'test log entry',
    };

    mockFetch.mockResolvedValue(new Response('OK', { status: 200 }));

    await alerter.sendAlert(context);

    expect(mockFetch).toHaveBeenCalledWith(config.alertManager?.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        {
          labels: {
            alertname: 'SeraphAnomalyDetected',
            source: 'test-source',
            type: 'test-type',
          },
          annotations: {
            summary: 'Anomaly detected in test-source',
            description: 'This is a test alert',
            log: 'test log entry',
          },
        },
      ]),
    });
  });

  it('should not send an alert if the Alertmanager URL is not configured', async () => {
    const config: SeraphConfig = {
      port: 8080,
      workers: 1,
      apiKey: 'test-key',
      serverApiKey: null,
    };
    const alerter = new AlerterClient(config);
    const context = {
      source: 'test-source',
      type: 'test-type',
      details: 'This is a test alert',
      log: 'test log entry',
    };

    await alerter.sendAlert(context);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should handle errors when sending an alert', async () => {
    const config: SeraphConfig = {
      port: 8080,
      workers: 1,
      apiKey: 'test-key',
      serverApiKey: null,
      alertManager: {
        url: 'http://fake-alertmanager:9093/api/v2/alerts',
      },
    };
    const alerter = new AlerterClient(config);
    const context = {
      source: 'test-source',
      type: 'test-type',
      details: 'This is a test alert',
      log: 'test log entry',
    };

    mockFetch.mockRejectedValue(new Error('Network error'));

    await alerter.sendAlert(context);

    expect(mockFetch).toHaveBeenCalled();
  });

  it('should handle non-ok responses from Alertmanager', async () => {
    const config: SeraphConfig = {
      port: 8080,
      workers: 1,
      apiKey: 'test-key',
      serverApiKey: null,
      alertManager: {
        url: 'http://fake-alertmanager:9093/api/v2/alerts',
      },
    };
    const alerter = new AlerterClient(config);
    const context = {
      source: 'test-source',
      type: 'test-type',
      details: 'This is a test alert',
      log: 'test log entry',
    };

    mockFetch.mockResolvedValue(new Response('Internal Server Error', { status: 500 }));

    await alerter.sendAlert(context);

    expect(mockFetch).toHaveBeenCalled();
  });
});
