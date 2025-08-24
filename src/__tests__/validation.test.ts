import { 
  generateCorrelationId, 
  sanitizeErrorMessage, 
  validateApiKey, 
  validateLogEntry,
  validateRegexFilter, 
} from '../validation';

describe('validateLogEntry', () => {
  it('should validate a simple log string', () => {
    const result = validateLogEntry('Simple log message');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should validate a valid JSON log', () => {
    const log = JSON.stringify({
      level: 'error',
      message: 'Test error message',
      timestamp: '2024-01-01T00:00:00Z',
    });
    const result = validateLogEntry(log);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject empty log entries', () => {
    const result = validateLogEntry('');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Log entry must be a non-empty string');
  });

  it('should reject log entries that are too large', () => {
    const largeLog = 'x'.repeat(2 * 1024 * 1024); // 2MB
    const result = validateLogEntry(largeLog);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('exceeds maximum size');
  });

  it('should reject invalid log levels', () => {
    const log = JSON.stringify({
      level: 'invalid_level',
      message: 'Test message',
    });
    const result = validateLogEntry(log);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Invalid log level');
  });

  it('should reject invalid timestamps', () => {
    const log = JSON.stringify({
      level: 'info',
      message: 'Test message',
      timestamp: 'invalid-timestamp',
    });
    const result = validateLogEntry(log);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Invalid timestamp format');
  });

  it('should reject messages that are too long', () => {
    const longMessage = 'x'.repeat(15000);
    const log = JSON.stringify({
      level: 'info',
      message: longMessage,
    });
    const result = validateLogEntry(log);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('exceeds maximum length');
  });

  it('should detect potentially malicious content', () => {
    const maliciousLog = 'Log message with <script>alert("xss")</script>';
    const result = validateLogEntry(maliciousLog);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('potentially malicious content');
  });
});

describe('validateRegexFilter', () => {
  it('should validate a simple regex pattern', () => {
    const result = validateRegexFilter('test.*pattern');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject non-string patterns', () => {
    const result = validateRegexFilter(123 as any);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('must be a string');
  });

  it('should reject invalid regex patterns', () => {
    const result = validateRegexFilter('[invalid regex');
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/Invalid regex pattern|unsafe/);
  });

  it('should reject potentially dangerous regex patterns', () => {
    const result = validateRegexFilter('(a+)+$'); // ReDoS vulnerable pattern
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('unsafe');
  });
});

describe('sanitizeErrorMessage', () => {
  it('should remove API keys from error messages', () => {
    const error = new Error('API call failed with api_key: sk-1234567890abcdef');
    const sanitized = sanitizeErrorMessage(error);
    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).not.toContain('sk-1234567890abcdef');
  });

  it('should remove file paths from error messages', () => {
    const error = new Error('File not found: /home/user/secret/file.txt');
    const sanitized = sanitizeErrorMessage(error);
    expect(sanitized).toContain('[PATH_REDACTED]');
    expect(sanitized).not.toContain('/home/user/secret/file.txt');
  });

  it('should handle string errors', () => {
    const sanitized = sanitizeErrorMessage('Error with token: bearer_xyz123');
    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).not.toContain('bearer_xyz123');
  });

  it('should include stack trace when requested', () => {
    const error = new Error('Test error');
    error.stack = 'Error: Test error\n    at /some/path/file.js:10:5';
    const sanitized = sanitizeErrorMessage(error, true);
    expect(sanitized).toContain('Stack:');
    expect(sanitized).toContain('[PATH_REDACTED]');
  });
});

describe('validateApiKey', () => {
  it('should validate a proper API key', () => {
    const result = validateApiKey('sk-1234567890abcdef1234567890abcdef1234567890abcdef');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject non-string API keys', () => {
    const result = validateApiKey(123 as any);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('must be a string');
  });

  it('should reject short API keys in production', () => {
    const result = validateApiKey('short', true); // Force production mode
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('too short');
  });

  it('should reject long API keys', () => {
    const longKey = 'x'.repeat(250);
    const result = validateApiKey(longKey);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('too long');
  });

  it('should reject placeholder API keys in production', () => {
    const result = validateApiKey('your-api-key', true); // Force production mode
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('placeholder value');
  });
});

describe('generateCorrelationId', () => {
  it('should generate a correlation ID with correct prefix', () => {
    const id = generateCorrelationId();
    expect(id).toMatch(/^req_\d+_[a-z0-9]+$/);
  });

  it('should generate unique correlation IDs', () => {
    const id1 = generateCorrelationId();
    const id2 = generateCorrelationId();
    expect(id1).not.toBe(id2);
  });
});