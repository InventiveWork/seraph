import { AgentManager } from '../agent';
import { SeraphConfig } from '../config';
import { metrics } from '../metrics';

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

  beforeEach(() => {
    config = {
      port: 8080,
      workers: 2,
      apiKey: 'test-key',
      preFilters: ['debug', 'info'],
    };
  });

  it('should initialize workers', () => {
    const agentManager = new AgentManager(config);
    expect(agentManager['workers']).toHaveLength(2);
  });

  it('should dispatch a log to a worker', () => {
    const agentManager = new AgentManager(config);
    const log = 'this is a test log';
    agentManager.dispatch(log);
    expect(agentManager['workers'][0].postMessage).toHaveBeenCalledWith(log);
  });

  it('should skip a log that matches a pre-filter', () => {
    const agentManager = new AgentManager(config);
    const log = 'this is a debug log';
    const logsSkippedSpy = jest.spyOn(metrics.logsSkipped, 'inc');
    agentManager.dispatch(log);
    expect(agentManager['workers'][0].postMessage).not.toHaveBeenCalled();
    expect(logsSkippedSpy).toHaveBeenCalled();
  });

  it('should handle invalid regex in pre-filters', () => {
    config.preFilters = ['('];
    const agentManager = new AgentManager(config);
    const log = 'this is a test log';
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    agentManager.dispatch(log);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid regex in preFilters'), expect.any(String));
    errorSpy.mockRestore();
  });

  it('should store recent logs', () => {
    const agentManager = new AgentManager(config);
    for (let i = 0; i < 110; i++) {
      agentManager.dispatch(`log ${i}`);
    }
    const recentLogs = agentManager.getRecentLogs();
    expect(recentLogs).toHaveLength(100);
    expect(recentLogs[0]).toBe('log 10');
  });

  it('should shutdown all workers', () => {
    const agentManager = new AgentManager(config);
    agentManager.shutdown();
    expect(agentManager['workers'][0].terminate).toHaveBeenCalled();
    expect(agentManager['workers'][1].terminate).toHaveBeenCalled();
  });
});
