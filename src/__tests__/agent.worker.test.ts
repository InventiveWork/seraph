import { SeraphConfig } from '../config';
import { AlerterClient } from '../alerter';
import { createLLMProvider } from '../llm';
import { metrics } from '../metrics';
import { parentPort, isMainThread, workerData } from 'worker_threads';

jest.mock('worker_threads', () => ({
  isMainThread: false,
  parentPort: {
    on: jest.fn(),
  },
  workerData: {
    config: {
      serverApiKey: null,
      llm: {
        provider: 'gemini',
        model: 'gemini-pro',
      },
    },
  },
}));

jest.mock('../alerter');
jest.mock('../llm');
jest.mock('../metrics', () => ({
  metrics: {
    llmAnalysisLatency: {
      startTimer: jest.fn(() => jest.fn()),
    },
    analysisErrors: {
      inc: jest.fn(),
    },
    alertsTriggered: {
      inc: jest.fn(),
    },
  },
}));

describe('Agent Worker', () => {
  const mockAlerterClient = {
    sendAlert: jest.fn(),
  };
  const mockLlmProvider = {
    generate: jest.fn(),
  };

  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.resetModules();

    jest.mock('worker_threads', () => ({
      isMainThread: false,
      parentPort: {
        on: jest.fn(),
        postMessage: jest.fn(),
      },
      workerData: {
        config: {
          serverApiKey: null,
          llm: {
            provider: 'gemini',
            model: 'gemini-pro',
          },
        },
      },
    }));

    jest.mock('../alerter');
    jest.mock('../llm');
    jest.mock('../metrics', () => ({
      metrics: {
        llmAnalysisLatency: {
          startTimer: jest.fn(() => jest.fn()),
        },
        analysisErrors: {
          inc: jest.fn(),
        },
        alertsTriggered: {
          inc: jest.fn(),
        },
      },
    }));

    const { AlerterClient } = require('../alerter');
    const { createLLMProvider } = require('../llm');

    (createLLMProvider as jest.Mock).mockReturnValue(mockLlmProvider);
    (AlerterClient as jest.Mock).mockReturnValue(mockAlerterClient);

    require('../agent');
  });

  afterEach(() => {
    jest.clearAllMocks();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should analyze a log and send an alert if the decision is "alert"', async () => {
    const { parentPort } = require('worker_threads');
    const { metrics } = require('../metrics');
    const log = 'this is an error log';
    const analysis = { decision: 'alert', reason: 'it is an error' };
    mockLlmProvider.generate.mockResolvedValue(JSON.stringify(analysis));

    if (!parentPort) {
      throw new Error('parentPort is null');
    }
    const messageHandler = (parentPort.on as jest.Mock).mock.calls[0][1];
    await messageHandler(log);

    expect(mockLlmProvider.generate).toHaveBeenCalled();
    expect(metrics.alertsTriggered.inc).toHaveBeenCalled();
    expect(mockAlerterClient.sendAlert).toHaveBeenCalledWith({
      source: 'log_analysis',
      type: 'anomaly_detected',
      details: analysis.reason,
      log: log,
    });
  });

  it('should handle errors from the LLM provider', async () => {
    const { parentPort } = require('worker_threads');
    const { metrics } = require('../metrics');
    const log = 'this is a problematic log';
    const error = new Error('LLM failed');
    mockLlmProvider.generate.mockRejectedValue(error);

    if (!parentPort) {
      throw new Error('parentPort is null');
    }
    const messageHandler = (parentPort.on as jest.Mock).mock.calls[0][1];
    await messageHandler(log);

    expect(metrics.analysisErrors.inc).toHaveBeenCalled();
    expect(mockAlerterClient.sendAlert).toHaveBeenCalledWith({
      source: 'log_analysis_error',
      type: 'analysis_failed',
      details: error.message,
      log: log,
    });
  });

  it('should handle malformed JSON from the LLM provider', async () => {
    const { parentPort } = require('worker_threads');
    const { metrics } = require('../metrics');
    const log = 'this is another log';
    mockLlmProvider.generate.mockResolvedValue('this is not json');

    if (!parentPort) {
      throw new Error('parentPort is null');
    }
    const messageHandler = (parentPort.on as jest.Mock).mock.calls[0][1];
    await messageHandler(log);

    expect(metrics.analysisErrors.inc).toHaveBeenCalled();
    expect(mockAlerterClient.sendAlert).toHaveBeenCalled();
  });
});
