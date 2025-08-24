import { AgentManager } from '../agent-manager';
import { SeraphConfig } from '../config';
import { metrics } from '../metrics';

// Mock dependencies
jest.mock('../report-store');
jest.mock('../mcp-server', () => ({
  mcpManager: {
    initialize: jest.fn().mockResolvedValue(undefined),
    getDynamicTools: jest.fn().mockReturnValue([]),
  },
}));
jest.mock('worker_threads', () => ({
  isMainThread: true,
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    postMessage: jest.fn(),
    terminate: jest.fn(),
  })),
}));

describe('AgentManager', () => {
  let config: SeraphConfig;
  let agentManager: AgentManager;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  // Use fake timers to control setTimeout
  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(async () => {
    // Suppress console output
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    config = {
      port: 8080,
      workers: 4, // 2 triage, 2 investigation
      apiKey: 'test-key',
      serverApiKey: null,
      preFilters: ['debug', 'info'],
    };
    agentManager = new AgentManager(config);
    // Wait for the async initialization to complete
    await agentManager.waitForInitialization();
  });

  afterEach(() => {
    agentManager.shutdown();
    jest.clearAllMocks();
    // Restore console output
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should initialize triage and investigation workers', () => {
    expect(agentManager['triageWorkers']).toHaveLength(2);
    expect(agentManager['investigationWorkers']).toHaveLength(2);
  });

  it('should dispatch a log to a triage worker', () => {
    const log = 'this is a test log';
    agentManager.dispatch(log);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(agentManager['triageWorkers'][0].postMessage).toHaveBeenCalledWith(log);
  });

  it('should skip a log that matches a pre-filter', () => {
    const log = 'this is a debug log';
    const logsSkippedSpy = jest.spyOn(metrics.logsSkipped, 'inc');
    agentManager.dispatch(log);
    agentManager['triageWorkers'].forEach(worker => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(worker.postMessage).not.toHaveBeenCalled();
    });
    expect(logsSkippedSpy).toHaveBeenCalled();
  });

  it('should store and rotate recent logs correctly by count', () => {
    for (let i = 0; i < 110; i++) {
      agentManager.dispatch(`log ${i}`);
    }
    const recentLogs = agentManager.getRecentLogs();
    expect(recentLogs).toHaveLength(100);
    expect(recentLogs[0]).toBe('log 10');
  });

  it('should shutdown all workers and close the report store', () => {
    const triageWorker = agentManager['triageWorkers'][0];
    const investigationWorker = agentManager['investigationWorkers'][0];
    const terminateSpyTriage = jest.spyOn(triageWorker, 'terminate');
    const terminateSpyInvestigation = jest.spyOn(investigationWorker, 'terminate');
    const reportStoreCloseSpy = jest.spyOn(agentManager['reportStore'], 'close');
    
    agentManager.shutdown();
    
    expect(terminateSpyTriage).toHaveBeenCalled();
    expect(terminateSpyInvestigation).toHaveBeenCalled();
    expect(reportStoreCloseSpy).toHaveBeenCalled();
  });
});
