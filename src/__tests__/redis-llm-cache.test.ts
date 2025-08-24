// Test Simple Redis LLM cache functionality
import { SimpleRedisCache } from '../memory';

describe('SimpleRedisCache', () => {
  let cache: SimpleRedisCache;

  beforeEach(() => {
    // Initialize cache without Redis for unit tests
    cache = new SimpleRedisCache({
      similarityThreshold: 0.8,
      ttlSeconds: 5,
      // No redis config = no Redis connection
    });
  });

  afterEach(async () => {
    if (cache) {
      await cache.close();
    }
  });

  afterAll(async () => {
    // Ensure all Redis connections are closed
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  test('should handle cache operations without Redis', async () => {
    const prompt = 'ERROR: Database connection failed';
    const response = { text: 'Database error detected', toolCalls: [] };

    // Cache miss initially (no Redis)
    expect(await cache.get(prompt, 100)).toBeNull();

    // Store response (should not throw)
    await cache.set(prompt, response, 100);

    // Should still miss since no Redis
    expect(await cache.get(prompt, 100)).toBeNull();
  });

  test('should handle Redis connection gracefully', async () => {
    // Create cache with invalid Redis config
    const redisCache = new SimpleRedisCache({
      redis: {
        host: 'invalid-host',
        port: 9999, // Invalid port
      },
      similarityThreshold: 0.8,
      ttlSeconds: 5,
    });

    const prompt = 'ERROR: Connection failed';
    const response = { text: 'Error handling test' };

    // Ensure initialization completes (even with failure)
    await redisCache.ensureInitialized();

    // Should gracefully handle connection failure
    await redisCache.set(prompt, response, 100);
    const cached = await redisCache.get(prompt, 100);
    expect(cached).toBeNull(); // No Redis = no cache

    await redisCache.close();
  });

  test('should provide health check information', async () => {
    expect(cache.isHealthy()).toBe(false); // No Redis connection
  });

  test('should provide cache statistics', async () => {
    const stats = await cache.getStats();
    
    expect(stats).toHaveProperty('connected');
    expect(stats).toHaveProperty('size');
    expect(stats.connected).toBe(false);
    expect(stats.size).toBe(0);
  });

  test('should create embeddings for similarity', async () => {
    // Test the embedding creation (internal method test via behavior)
    const prompt1 = 'ERROR: Database connection failed';
    const prompt2 = 'ERROR: Database connection timeout'; // Similar
    const prompt3 = 'INFO: User logged in successfully'; // Different
    
    // Without Redis, we can't test actual similarity, but we can test the cache doesn't break
    expect(await cache.get(prompt1, 100)).toBeNull();
    expect(await cache.get(prompt2, 100)).toBeNull();
    expect(await cache.get(prompt3, 100)).toBeNull();
  });

  test('should handle cleanup operations', async () => {
    // Cleanup should not throw errors without Redis
    await expect(cache.cleanup()).resolves.not.toThrow();
  });
});