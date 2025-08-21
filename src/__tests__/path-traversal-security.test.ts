// Security tests for path traversal vulnerabilities
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Import the function we're testing (we'll need to export it from mcp-server.ts)
// For now, we'll test it through the MCP server endpoints

describe('Path Traversal Security Tests', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seraph-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rmdir(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Path Traversal Attack Vectors', () => {
    test('should reject relative path traversal with ../..', async () => {
      const maliciousPath = '../../../etc/passwd';
      
      // Import and test the validation function directly
      const { validateDestinationPath } = await import('../mcp-server');
      
      await expect(validateDestinationPath(maliciousPath))
        .rejects
        .toThrow('Security violation: Path traversal detected');
    });

    test('should reject URL-encoded path traversal', async () => {
      const maliciousPath = '/tmp/%2e%2e%2f%2e%2e%2fetc%2fpasswd';
      
      const { validateDestinationPath } = await import('../mcp-server');
      
      await expect(validateDestinationPath(maliciousPath))
        .rejects
        .toThrow('Security violation: Path traversal detected');
    });

    test('should reject paths outside allowed directories', async () => {
      const maliciousPath = '/etc/passwd';
      
      const { validateDestinationPath } = await import('../mcp-server');
      
      await expect(validateDestinationPath(maliciousPath))
        .rejects
        .toThrow('Security violation: Destination must be within');
    });

    test('should reject access to system directories', async () => {
      const systemPath = '/tmp/systemd/test';
      
      const { validateDestinationPath } = await import('../mcp-server');
      
      await expect(validateDestinationPath(systemPath))
        .rejects
        .toThrow('Security violation: Cannot access protected system directories');
    });

    test('should handle symlink attacks', async () => {
      const symlinkPath = path.join(tempDir, 'malicious-symlink');
      const targetPath = '/etc/passwd';
      
      try {
        await fs.symlink(targetPath, symlinkPath);
        
        const { validateDestinationPath } = await import('../mcp-server');
        
        await expect(validateDestinationPath(symlinkPath))
          .rejects
          .toThrow('Security violation');
      } catch (error) {
        // Skip test if we can't create symlinks (Windows, permissions, etc.)
        if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'ENOENT') {
          console.log('Skipping symlink test due to permissions or platform limitations');
          return;
        }
        throw error;
      }
    });
  });

  describe('Valid Path Acceptance', () => {
    test('should accept valid paths in /tmp', async () => {
      const validPath = '/tmp/seraph-test-clone';
      
      const { validateDestinationPath } = await import('../mcp-server');
      
      const result = await validateDestinationPath(validPath);
      expect(result).toContain('/tmp');
      expect(result).toContain('seraph-test-clone');
    });

    test('should accept valid paths in /var/tmp', async () => {
      const validPath = '/var/tmp/seraph-test-clone';
      
      const { validateDestinationPath } = await import('../mcp-server');
      
      const result = await validateDestinationPath(validPath);
      expect(result).toContain('/var/tmp');
      expect(result).toContain('seraph-test-clone');
    });

    test('should handle relative paths by converting to absolute', async () => {
      // Change to an allowed temp directory first, then use relative path
      const originalCwd = process.cwd();
      const allowedTmpPath = '/tmp';
      
      try {
        process.chdir(allowedTmpPath);
        const relativePath = 'seraph-test-relative';
        
        const { validateDestinationPath } = await import('../mcp-server');
        
        const result = await validateDestinationPath(relativePath);
        // Should resolve to an absolute path within allowed directory
        expect(result).toContain('seraph-test-relative');
        expect(result).toMatch(/\/(private\/)?tmp/);
        expect(path.isAbsolute(result)).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('Edge Cases', () => {
    test('should reject empty paths', async () => {
      const { validateDestinationPath } = await import('../mcp-server');
      
      await expect(validateDestinationPath(''))
        .rejects
        .toThrow('Destination path cannot be empty');
    });

    test('should handle non-existent parent directories securely', async () => {
      // Get the canonical tmp path first
      const canonicalTmp = await fs.realpath('/tmp');
      const nonExistentPath = path.join(canonicalTmp, 'non-existent-parent/child/directory');
      
      const { validateDestinationPath } = await import('../mcp-server');
      
      // Should still validate even if parent doesn't exist
      const result = await validateDestinationPath(nonExistentPath);
      expect(result).toContain(canonicalTmp);
      expect(result).toContain('non-existent-parent');
    });

    test('should handle Windows-style path separators', async () => {
      const windowsStylePath = '/tmp\\..\\..\\etc\\passwd';
      
      const { validateDestinationPath } = await import('../mcp-server');
      
      await expect(validateDestinationPath(windowsStylePath))
        .rejects
        .toThrow('Security violation: Path traversal detected');
    });
  });
});