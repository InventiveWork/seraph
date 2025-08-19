
import { AgentManager } from '../agent-manager';
import { SeraphConfig, loadConfig } from '../config';
import { AlerterClient } from '../alerter';
import { ReportStore } from '../report-store';
import { startMcpServer } from '../mcp-server';
import * as http from 'http';

// Mock the alerter and report store to intercept their calls
jest.mock('../alerter');
jest.mock('../report-store');

// Set a longer timeout for this test suite as it makes a real network call
jest.setTimeout(30000);

// Conditionally skip this test suite if the API key is not available.
const hasApiKey = process.env.GEMINI_API_KEY;
const describeIf = hasApiKey ? describe : describe.skip;

describeIf('End-to-End Test with Real Gemini API', () => {
  let agentManager: AgentManager;
  let config: SeraphConfig;
  let mcpServer: http.Server;
  const mockAlerterClient = new (AlerterClient as jest.Mock<AlerterClient>)();
  const mockReportStore = new (ReportStore as jest.Mock<ReportStore>)();

  beforeAll(async () => {
    config = await loadConfig();
    config.workers = 2; // 1 triage, 1 investigation
    config.preFilters = ['level=warn'];
    config.builtInMcpServer = { gitRepoPath: '/tmp/seraph-test-repo' }; // Dummy path for tests

    (AlerterClient as jest.Mock).mockImplementation(() => mockAlerterClient);
    (ReportStore as jest.Mock).mockImplementation(() => mockReportStore);
    
    // Start the real MCP server
    mcpServer = startMcpServer(config);
    
    agentManager = new AgentManager(config);
    await agentManager.waitForInitialization();
  });

  afterAll((done) => {
    if (agentManager) {
      agentManager.shutdown();
    }
    if (mcpServer) {
      mcpServer.close(() => {
        done();
      });
    } else {
      done();
    }
  });

  it('should process a batch of logs, identify the anomaly, and trigger the full investigation workflow', async () => {
    const fluentBitLogBatch = [
      [1678886400, { "log": "level=info msg=\"User logged in successfully\" user_id=123" }],
      [1678886401, { "log": "level=info msg=\"Data processed\" record_count=1000" }],
      [1678886402, { "log": "level=error msg=\"FATAL: Database connection failed: timeout expired\"" }],
    ];

    const initialAlertPromise = Promise.resolve({ incidentId: 'mock-incident-id' });
    (mockAlerterClient.sendInitialAlert as jest.Mock).mockReturnValue(initialAlertPromise);
    (mockReportStore.saveReport as jest.Mock).mockResolvedValue({ incidentId: 'mock-incident-id' } as any);

    // Dispatch logs
    for (const logEntry of fluentBitLogBatch) {
      agentManager.dispatch(JSON.stringify(logEntry[1]));
    }

    // Give the agent time to process
    await new Promise(resolve => setTimeout(resolve, 25000));

    // --- Verification ---
    expect(mockAlerterClient.sendInitialAlert).toHaveBeenCalledTimes(1);
    expect(mockAlerterClient.sendInitialAlert).toHaveBeenCalledWith(
      expect.stringContaining('FATAL: Database connection failed'),
      expect.any(String)
    );

    expect(mockReportStore.saveReport).toHaveBeenCalledTimes(1);
    const savedReport = (mockReportStore.saveReport as jest.Mock).mock.calls[0][0];
    
    expect(savedReport.initialLog).toContain('FATAL: Database connection failed');
    expect(savedReport.finalAnalysis.rootCauseAnalysis).toBeDefined();
    
    expect(mockAlerterClient.sendEnrichedAnalysis).toHaveBeenCalledTimes(1);
  });
});
