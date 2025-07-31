import * as http from 'http';
import request from 'supertest';
import { startServer } from '../server';
import { AgentManager } from '../agent';
import { SeraphConfig } from '../config';
import * as net from 'net';

jest.mock('../agent');
jest.mock('net', () => ({
  createServer: jest.fn(() => ({
    listen: jest.fn((path, callback) => callback()),
    on: jest.fn(),
    close: jest.fn((callback) => callback()),
  })),
}));

describe('Server', () => {
  let server: http.Server;
  let agentManager: AgentManager;
  let config: SeraphConfig;

  beforeEach(() => {
    agentManager = new AgentManager({} as SeraphConfig);
    agentManager.dispatch = jest.fn();
    config = {
      port: 8080,
      workers: 4,
      apiKey: 'test-key',
    };
    server = startServer(config, agentManager);
  });

  afterEach((done) => {
    server.close(done);
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
