import { SeraphConfig } from '../config';
import { metrics } from '../metrics';

// Mock the dependencies at the top level
const mockLlmProvider = {
  generate: jest.fn(),
};
const mockParentPort = {
  postMessage: jest.fn(),
  on: jest.fn(), // Add the 'on' method to the mock
};

jest.mock('../llm', () => ({
  createLLMProvider: () => mockLlmProvider,
}));
jest.mock('worker_threads', () => ({
  isMainThread: false,
  parentPort: mockParentPort,
  workerData: {
    config: {
      llm: { provider: 'test-provider', model: 'test-model' },
    },
  },
}));
jest.mock('../metrics', () => ({
  metrics: {
    llmAnalysisLatency: {
      startTimer: jest.fn(() => jest.fn()),
    },
    alertsTriggered: {
      inc: jest.fn(),
    },
    analysisErrors: {
      inc: jest.fn(),
    },
  },
}));

// Dynamically import the agent file to ensure mocks are applied
let messageHandler: (log: string) => Promise<void>;

describe('Agent Worker', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeAll(() => {
    // The worker code attaches the listener when the module is imported.
    // We need to capture that listener.
    let capturedHandler: (log: string) => Promise<void>;
    
    // Reset the mock before import to capture the new handler
    mockParentPort.on.mockImplementation((event, handler) => {
      if (event === 'message') {
        capturedHandler = handler;
      }
    });

    // Import the module to trigger the worker code
    jest.isolateModules(() => {
      require('../agent.worker');
    });
    
    // @ts-ignore
    messageHandler = capturedHandler;
  });

  beforeEach(() => {
    // Clear mocks before each test
    jest.clearAllMocks();
    // Suppress console.error for all tests in this suite
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore console.error after each test
    consoleErrorSpy.mockRestore();
  });

  it('should analyze a log and send a message if the decision is "alert"', async () => {
    const log = 'this is an error log';
    const analysis = { decision: 'alert', reason: 'it is an error' };
    mockLlmProvider.generate.mockResolvedValue({
      toolCalls: [{ name: 'log_triage', arguments: analysis }]
    });

    await messageHandler(log);

    expect(mockLlmProvider.generate).toHaveBeenCalled();
    expect(metrics.alertsTriggered.inc).toHaveBeenCalled();
    expect(mockParentPort.postMessage).toHaveBeenCalledWith({
      type: 'alert',
      data: {
        log: log,
        reason: analysis.reason,
      },
    });
  });

  it('should not send a message if the decision is "ok"', async () => {
    const log = 'this is a normal log';
    const analysis = { decision: 'ok', reason: 'everything is fine' };
    mockLlmProvider.generate.mockResolvedValue({
      toolCalls: [{ name: 'log_triage', arguments: analysis }]
    });

    await messageHandler(log);

    expect(mockLlmProvider.generate).toHaveBeenCalled();
    expect(metrics.alertsTriggered.inc).not.toHaveBeenCalled();
    expect(mockParentPort.postMessage).not.toHaveBeenCalled();
  });

  it('should handle errors from the LLM provider', async () => {
    const log = 'a log that causes an error';
    mockLlmProvider.generate.mockRejectedValue(new Error('LLM failed'));

    await messageHandler(log);

    expect(mockParentPort.postMessage).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[Worker'), expect.any(String));
  });

  it('should handle malformed JSON from the LLM provider', async () => {
    const log = 'a log that gets a malformed response';
    mockLlmProvider.generate.mockResolvedValue('this is not json');

    await messageHandler(log);

    expect(mockParentPort.postMessage).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});