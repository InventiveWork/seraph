import * as http from 'http';
import request from 'supertest';
import { startServer } from '../server';
import { AgentManager } from '../agent';
import { SeraphConfig } from '../config';

jest.mock('../agent');

describe('Server', () => {
  let server: http.Server;
  let shutdown: (callback?: () => void) => void;
  let agentManager: AgentManager;
  let config: SeraphConfig;

  beforeEach(() => {
    jest.resetModules();
    agentManager = new AgentManager({} as SeraphConfig);
    agentManager.dispatch = jest.fn();
    config = {
      port: 8081,
      workers: 4,
      apiKey: 'test-key',
      serverApiKey: null,
    };
    const serverControl = startServer(config, agentManager);
    server = serverControl.server;
    shutdown = serverControl.shutdown;
  });

  afterEach((done) => {
    shutdown(done);
  });

  it('should respond with 202 on /logs POST', async () => {
    const response = await request(server)
      .post('/logs')
      .send('test log');
    expect(response.status).toBe(202);
    expect(agentManager.dispatch).toHaveBeenCalledWith('test log');
  });

  it('should respond with 200 on /status GET', async () => {
    const response = await request(server).get('/status');
    expect(response.status).toBe(200);
  });

  it('should respond with 200 on /metrics GET', async () => {
    const response = await request(server).get('/metrics');
    expect(response.status).toBe(200);
  });
});
