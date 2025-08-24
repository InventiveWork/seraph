import * as sqlite3 from 'sqlite3';
import { promisify } from 'util';

export interface PooledDatabase {
  get: (sql: string, params?: any) => Promise<any>;
  all: (sql: string, params?: any) => Promise<any[]>;
  run: (sql: string, params?: any) => Promise<{ lastID?: number; changes?: number }>;
  close: () => Promise<void>;
}

export interface ConnectionPoolOptions {
  maxConnections: number;
  idleTimeout: number; // in milliseconds
  acquireTimeout: number; // in milliseconds
}

interface PooledConnection {
  db: sqlite3.Database;
  inUse: boolean;
  lastUsed: number;
  get: (sql: string, params?: any) => Promise<any>;
  all: (sql: string, params?: any) => Promise<any[]>;
  run: (sql: string, params?: any) => Promise<{ lastID?: number; changes?: number }>;
}

export class SQLitePool {
  private connections: PooledConnection[] = [];
  private waitingQueue: {
    resolve: (conn: PooledConnection) => void;
    reject: (error: Error) => void;
    timestamp: number;
  }[] = [];
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  constructor(
    private dbPath: string,
    private options: ConnectionPoolOptions = {
      maxConnections: 5,
      idleTimeout: 30000, // 30 seconds
      acquireTimeout: 10000, // 10 seconds
    },
  ) {
    this.startCleanupTimer();
  }

  private createConnection(): Promise<PooledConnection> {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
        if (err) {
          reject(err);
          return;
        }

        // Configure SQLite for better concurrency and performance
        const configureDb = async () => {
          try {
            await new Promise<void>((res, rej) => {
              db.run('PRAGMA journal_mode=WAL', (walErr) => {
                if (walErr) {rej(walErr);}
                else {res();}
              });
            });

            await new Promise<void>((res, rej) => {
              db.run('PRAGMA synchronous=NORMAL', (syncErr) => {
                if (syncErr) {rej(syncErr);}
                else {res();}
              });
            });

            await new Promise<void>((res, rej) => {
              db.run('PRAGMA busy_timeout=30000', (timeoutErr) => {
                if (timeoutErr) {rej(timeoutErr);}
                else {res();}
              });
            });

            await new Promise<void>((res, rej) => {
              db.run('PRAGMA temp_store=MEMORY', (tempErr) => {
                if (tempErr) {rej(tempErr);}
                else {res();}
              });
            });

            const connection: PooledConnection = {
              db,
              inUse: false,
              lastUsed: Date.now(),
              get: promisify(db.get.bind(db)),
              all: promisify(db.all.bind(db)),
              run: promisify(db.run.bind(db)),
            };

            resolve(connection);
          } catch (configErr) {
            console.warn('Failed to configure SQLite, using defaults:', configErr);
            const connection: PooledConnection = {
              db,
              inUse: false,
              lastUsed: Date.now(),
              get: promisify(db.get.bind(db)),
              all: promisify(db.all.bind(db)),
              run: promisify(db.run.bind(db)),
            };
            resolve(connection);
          }
        };

        configureDb();
      });
    });
  }

  async acquire(): Promise<PooledConnection> {
    // Check if pool is closed
    if (this.isClosed()) {
      throw new Error('Database pool is closed');
    }

    // Check for available connection
    const availableConnection = this.connections.find(conn => !conn.inUse);
    if (availableConnection) {
      availableConnection.inUse = true;
      availableConnection.lastUsed = Date.now();
      return availableConnection;
    }

    // Create new connection if under limit
    if (this.connections.length < this.options.maxConnections) {
      try {
        const newConnection = await this.createConnection();
        newConnection.inUse = true;
        this.connections.push(newConnection);
        return newConnection;
      } catch (error) {
        throw new Error(`Failed to create database connection: ${(error as Error).message}`);
      }
    }

    // Wait for connection to become available
    return new Promise((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | null = null;
      let queueEntry: typeof this.waitingQueue[0] | null = null;

      timeoutHandle = setTimeout(() => {
        // Atomically remove from queue and prevent double resolution
        if (queueEntry) {
          const index = this.waitingQueue.indexOf(queueEntry);
          if (index !== -1) {
            this.waitingQueue.splice(index, 1);
          }
          queueEntry = null;
        }
        timeoutHandle = null;
        reject(new Error('Timeout waiting for database connection'));
      }, this.options.acquireTimeout);

      queueEntry = {
        resolve: (conn) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          queueEntry = null;
          resolve(conn);
        },
        reject: (error) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          queueEntry = null;
          reject(error);
        },
        timestamp: Date.now(),
      };
      
      this.waitingQueue.push(queueEntry);
    });
  }

  release(connection: PooledConnection): void {
    connection.inUse = false;
    connection.lastUsed = Date.now();

    // Serve waiting queue
    const waiting = this.waitingQueue.shift();
    if (waiting) {
      connection.inUse = true;
      waiting.resolve(connection);
    }
  }

  async execute<T>(
    operation: (conn: PooledConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.acquire();
    try {
      const result = await operation(connection);
      return result;
    } finally {
      this.release(connection);
    }
  }

  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleConnections();
    }, this.options.idleTimeout / 2);
  }

  private cleanupIdleConnections(): void {
    const now = Date.now();
    const minConnections = 1; // Keep at least one connection

    for (let i = this.connections.length - 1; i >= minConnections; i--) {
      const conn = this.connections[i];
      if (!conn.inUse && (now - conn.lastUsed) > this.options.idleTimeout) {
        conn.db.close((err) => {
          if (err) {
            console.error('Error closing idle database connection:', err);
          }
        });
        this.connections.splice(i, 1);
      }
    }
  }

  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Reject all waiting requests
    while (this.waitingQueue.length > 0) {
      const waiting = this.waitingQueue.shift();
      if (waiting) {
        waiting.reject(new Error('Database pool is closing'));
      }
    }

    // Close all connections
    const closePromises = this.connections.map(conn => 
      new Promise<void>((resolve, reject) => {
        conn.db.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }),
    );

    await Promise.all(closePromises);
    this.connections = [];
  }

  isClosed(): boolean {
    return this.cleanupInterval === null;
  }

  getStats() {
    return {
      totalConnections: this.connections.length,
      activeConnections: this.connections.filter(c => c.inUse).length,
      idleConnections: this.connections.filter(c => !c.inUse).length,
      waitingRequests: this.waitingQueue.length,
    };
  }
}

// Singleton pattern for global pool
let globalPool: SQLitePool | null = null;

export function getPool(dbPath: string = './reports.db'): SQLitePool {
  if (!globalPool) {
    globalPool = new SQLitePool(dbPath, {
      maxConnections: 5,
      idleTimeout: 30000,
      acquireTimeout: 10000,
    });
  }
  return globalPool;
}

export async function closePool(): Promise<void> {
  if (globalPool) {
    await globalPool.close();
    globalPool = null;
  }
}