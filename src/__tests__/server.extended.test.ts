import * as http from 'http';
import request from 'supertest';
import { startServer, resetRequestCounts } from '../server';
import { AgentManager } from '../agent';
import { SeraphConfig } from '../config';
import * as chat from '../chat';

jest.mock('../agent');
jest.mock('../chat', () => ({
  chat: jest.fn(),
}));

describe('Server', () => {
  let server: http.Server;
  let shutdown: (callback?: () => void) => void;
  let agentManager: AgentManager;
  let config: SeraphConfig;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers(); // Ensure fake timers are used before server starts
    resetRequestCounts(); // Reset rate limit counts before each test
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    agentManager = new AgentManager({} as SeraphConfig);
    agentManager.dispatch = jest.fn();
    agentManager.getRecentLogs = jest.fn(() => ['log1', 'log2']);
    config = {
      port: 8082,
      workers: 4,
      apiKey: 'test-key',
      serverApiKey: null,
    };
    const serverControl = startServer(config, agentManager);
    server = serverControl.server;
    shutdown = serverControl.shutdown;
  });

  afterEach((done) => {
    consoleLogSpy.mockRestore();
    shutdown(() => {
      jest.clearAllTimers(); // Clear any remaining timers
      jest.useRealTimers(); // Ensure real timers are restored
      done();
    });
  });

  it('should respond with 400 on /logs POST with no body', async () => {
    const response = await request(server).post('/logs').send('');
    expect(response.status).toBe(400);
    expect(response.body.message).toBe(
      'Request body must be a non-empty string.',
    );
  });

  it('should respond with 429 on /logs POST when rate limit is exceeded', async () => {
    const agent = request(server);
    const promises = [];
    for (let i = 0; i < 101; i++) {
      promises.push(agent.post('/logs').send('test log'));
    }
    const responses = await Promise.all(promises);
    const lastResponse = responses[responses.length - 1];
    expect(lastResponse.status).toBe(429);
  });

  it('should respond with 413 on /logs POST when payload is too large', async () => {
    const largePayload = 'a'.repeat(1024 * 1024 + 1);
    const response = await request(server).post('/logs').send(largePayload);
    expect(response.status).toBe(413);
  });

  it('should respond with 404 on unknown endpoint', async () => {
    const response = await request(server).get('/unknown');
    expect(response.status).toBe(404);
  });

  it('should respond with 200 on /chat POST', async () => {
    (chat.chat as jest.Mock).mockResolvedValue('chat response');
    const response = await request(server)
      .post('/chat')
      .send({ message: 'hello' });
    expect(response.status).toBe(200);
    expect(response.text).toBe('chat response');
  });

  it('should respond with 400 on /chat POST with no message', async () => {
    const response = await request(server).post('/chat').send({});
    expect(response.status).toBe(400);
  });

  it('should respond with 400 on /chat POST with empty body', async () => {
    const response = await request(server).post('/chat').send('');
    expect(response.status).toBe(400);
    expect(response.body.message).toBe('message is required');
  });

  it('should respond with 400 on /chat POST with invalid JSON', async () => {
    const response = await request(server)
      .post('/chat')
      .set('Content-Type', 'application/json')
      .send('{"message": "hello"');
    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Invalid JSON format');
  });

  it('should respond with 500 on /chat POST when chat fails', async () => {
    (chat.chat as jest.Mock).mockRejectedValue(new Error('chat failed'));
    const response = await request(server)
      .post('/chat')
      .send({ message: 'hello' });
    expect(response.status).toBe(500);
  });
});
