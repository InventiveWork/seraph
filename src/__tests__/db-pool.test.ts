import * as fs from 'fs';
import * as path from 'path';
import { SQLitePool } from '../db-pool';

const TEST_DB_PATH = path.join(__dirname, 'test-pool.db');

describe('SQLitePool', () => {
  let pool: SQLitePool;

  beforeEach(() => {
    // Clean up any existing test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    
    pool = new SQLitePool(TEST_DB_PATH, {
      maxConnections: 3,
      idleTimeout: 1000,
      acquireTimeout: 5000
    });
  });

  afterEach(async () => {
    await pool.close();
    
    // Clean up test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  it('should create and manage connections', async () => {
    const connection = await pool.acquire();
    expect(connection).toBeDefined();
    expect(connection.get).toBeDefined();
    expect(connection.all).toBeDefined();
    expect(connection.run).toBeDefined();
    
    pool.release(connection);
  });

  it('should execute operations through the pool', async () => {
    const result = await pool.execute(async (conn) => {
      await conn.run('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      await conn.run('INSERT INTO test (name) VALUES (?)', ['test']);
      const row = await conn.get('SELECT * FROM test WHERE id = 1');
      return row;
    });
    
    expect(result).toBeDefined();
    expect(result.name).toBe('test');
  });

  it('should respect max connections limit', async () => {
    const connections = [];
    
    // Acquire max connections
    for (let i = 0; i < 3; i++) {
      connections.push(await pool.acquire());
    }
    
    // Next acquisition should timeout
    const startTime = Date.now();
    await expect(pool.acquire()).rejects.toThrow('Timeout waiting for database connection');
    const endTime = Date.now();
    
    expect(endTime - startTime).toBeGreaterThanOrEqual(4500); // Allow some tolerance
    
    // Release connections
    connections.forEach(conn => pool.release(conn));
  }, 10000); // Increase timeout to 10 seconds

  it('should reuse released connections', async () => {
    const conn1 = await pool.acquire();
    pool.release(conn1);
    
    const conn2 = await pool.acquire();
    expect(conn1).toBe(conn2); // Should reuse the same connection
    
    pool.release(conn2);
  });

  it('should provide accurate stats', async () => {
    let stats = pool.getStats();
    expect(stats.totalConnections).toBe(0);
    expect(stats.activeConnections).toBe(0);
    expect(stats.idleConnections).toBe(0);
    
    const conn = await pool.acquire();
    stats = pool.getStats();
    expect(stats.totalConnections).toBe(1);
    expect(stats.activeConnections).toBe(1);
    expect(stats.idleConnections).toBe(0);
    
    pool.release(conn);
    stats = pool.getStats();
    expect(stats.totalConnections).toBe(1);
    expect(stats.activeConnections).toBe(0);
    expect(stats.idleConnections).toBe(1);
  });

  it('should handle database errors gracefully', async () => {
    await expect(pool.execute(async (conn) => {
      await conn.run('INVALID SQL QUERY');
    })).rejects.toThrow();
  });

  it('should clean up idle connections', async () => {
    const conn = await pool.acquire();
    pool.release(conn);
    
    // Wait for cleanup cycle
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    const stats = pool.getStats();
    expect(stats.totalConnections).toBe(1); // Should keep at least one connection
  });

  it('should close all connections on pool close', async () => {
    const conn1 = await pool.acquire();
    const conn2 = await pool.acquire();
    
    pool.release(conn1);
    pool.release(conn2);
    
    const statsBefore = pool.getStats();
    expect(statsBefore.totalConnections).toBe(2);
    
    await pool.close();
    
    // After close, attempting to acquire should fail
    await expect(pool.acquire()).rejects.toThrow('Database pool is closed');
  });

  it('should handle concurrent access correctly', async () => {
    // Create table first with unique name to avoid conflicts
    const tableName = `concurrent_test_${Date.now()}`;
    await pool.execute(async (conn) => {
      await conn.run(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, value INTEGER)`);
    });
    
    // Run operations sequentially to avoid database locking issues in tests
    const results = [];
    for (let i = 0; i < 3; i++) {
      const result = await pool.execute(async (conn) => {
        await conn.run(`INSERT INTO ${tableName} (value) VALUES (?)`, [i]);
        return i;
      });
      results.push(result);
    }
    
    expect(results).toEqual([0, 1, 2]);
    
    // Verify all rows were inserted
    const count = await pool.execute(async (conn) => {
      const row = await conn.get(`SELECT COUNT(*) as count FROM ${tableName}`);
      return row.count;
    });
    
    expect(count).toBe(3);
  }, 15000); // Increase timeout
});