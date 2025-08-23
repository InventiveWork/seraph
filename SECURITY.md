# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.17+ | ✅ Security Fixed  |
| 1.0.14  | ❌ Path Traversal  |
| < 1.0.14| ❌ Not Supported   |

## Security Vulnerabilities

### Fixed in v1.0.15

#### CVE-2024-SERAPH-001: Path Traversal Vulnerability in MCP Git Clone

**Severity:** High  
**CVSS Score:** 7.5  
**Affected Versions:** ≤ 1.0.14  
**Fixed in:** 1.0.15 (continued in 1.0.17)

**Description:**
The `validateDestinationPath` function in `src/mcp-server.ts` contained insufficient path validation that could allow path traversal attacks. Attackers could potentially access files outside the intended `/tmp` and `/var/tmp` directories through various techniques including:

- Relative path traversal (`../../../etc/passwd`)
- URL-encoded traversal (`%2e%2e%2f`)  
- Symlink attacks
- Platform-specific path bypasses

**Impact:**
- Unauthorized file system access
- Potential information disclosure
- System compromise through arbitrary file access

**Mitigation:**
Update to version 1.0.17 or later. The fix includes:

1. **Pre-resolution validation** - Path traversal patterns are checked before path resolution
2. **Canonical path verification** - Uses `fs.realpath()` to resolve symlinks and verify final paths
3. **Allowlist enforcement** - Strict verification that paths remain within `/tmp` and `/var/tmp`
4. **System directory protection** - Additional protection for critical system directories
5. **Comprehensive test coverage** - 11 security test cases covering various attack vectors

## Security Features

### Input Validation
- Comprehensive log entry validation with size limits
- Suspicious pattern detection for injection attempts
- Safe regex validation to prevent ReDoS attacks
- JSON structure validation with type checking

### Authentication & Authorization
- Bearer token authentication for API endpoints
- Configurable API key validation
- Rate limiting with memory-efficient per-IP tracking
- Optional authentication bypass for metrics endpoint

### Network Security
- Security headers (CSP, HSTS, XSS Protection, CSRF)
- Request payload size limits (1MB for logs, 10KB for chat)
- Connection timeout and rate limiting
- IPC socket permissions (0o600)

### Command Injection Prevention
- Parameterized command execution using `execFile()`
- Input sanitization for all external tool calls
- Whitelist-based approach for kubectl commands
- Tool argument type validation

### Error Handling Security
- Automatic sanitization of error messages
- Path redaction in error responses
- Generic error responses to prevent information leakage
- Comprehensive correlation ID tracking for auditing

### Memory Security
- Buffer pooling with security clearing
- Bounded collections to prevent memory leaks
- Worker thread isolation for sandboxed execution
- Proper cleanup of sensitive data structures

## Reporting Security Vulnerabilities

If you discover a security vulnerability, please report it responsibly:

1. **DO NOT** open a public GitHub issue
2. Email security reports to: security@inventivework.com
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Suggested remediation (if any)

### Response Timeline
- **24 hours**: Initial acknowledgment
- **72 hours**: Vulnerability assessment and classification
- **7 days**: Security patch development (for confirmed vulnerabilities)
- **14 days**: Public disclosure (after patch release)

## Security Best Practices

### Deployment Security
- Use dedicated service accounts with minimal privileges
- Enable audit logging for all agent actions
- Configure network firewalls to restrict access
- Use secure credential management (environment variables)
- Regular security updates and dependency scanning

### Configuration Security
- Rotate API keys regularly
- Use strong API keys (avoid placeholder values)
- Enable authentication for production deployments
- Configure appropriate rate limits
- Monitor logs for suspicious activity

### Network Security
- Deploy behind reverse proxy with TLS termination
- Use network segmentation for agent infrastructure
- Configure appropriate DNS and firewall rules
- Monitor network traffic for anomalies

### Operational Security
- Regular backup of investigation reports database
- Monitor disk usage and log retention
- Implement log rotation and archival
- Use monitoring and alerting for security events

## Security Testing

The codebase includes comprehensive security tests:

- **Path Traversal Protection**: 11 test cases covering various attack vectors
- **Input Validation**: Tests for malicious content detection
- **Authentication**: API key and token validation tests
- **Error Handling**: Information leakage prevention tests
- **Performance**: ReDoS attack prevention tests

Run security tests with:
```bash
npm test -- --testPathPattern=security
npm test -- --testPathPattern=path-traversal
npm test -- --testPathPattern=validation
```

## Compliance & Standards

Seraph follows security best practices from:
- OWASP Application Security Guidelines
- NIST Cybersecurity Framework
- CIS Controls for secure software development
- SANS Secure Coding Practices

## Security Architecture

### Multi-Layer Defense
1. **Network Layer**: TLS, firewalls, rate limiting
2. **Application Layer**: Input validation, authentication, authorization
3. **Process Layer**: Worker isolation, sandboxing, resource limits
4. **Data Layer**: Encryption at rest, secure credential management

### Threat Model
Primary threats mitigated:
- Path traversal and directory escapes
- Command injection through tool parameters
- Information disclosure through error messages
- Denial of service through resource exhaustion
- Credential exposure and privilege escalation

## Changelog

### v1.0.17 (Latest Release)
- **DOCUMENTATION**: Comprehensive documentation updates and alignment
- **MAINTENANCE**: Version consistency across all components
- **ENHANCEMENT**: All features from v1.0.16 maintained

### v1.0.16 (Previous Release)
- **ENHANCEMENT**: Superior CLI experience with beautiful terminal UI
- **ENHANCEMENT**: Interactive setup wizard with auto-detection
- **ENHANCEMENT**: Comprehensive diagnostics with `seraph doctor`
- **ENHANCEMENT**: Enhanced status reporting with health checks
- **ENHANCEMENT**: Multiple output formats (table, JSON, markdown)
- **ENHANCEMENT**: Redis caching integration for cost optimization
- **FEATURE**: Priority queue system for intelligent investigation scheduling
- **FEATURE**: Advanced memory management architecture
- **SECURITY**: Continued security hardening from v1.0.15

### v1.0.15 (Security Release)
- **SECURITY**: Fixed path traversal vulnerability in git clone functionality
- **SECURITY**: Enhanced path validation with canonical path checking
- **SECURITY**: Added comprehensive security test suite
- **SECURITY**: Improved system directory protection

### v1.0.14 and earlier
- Various security improvements (see individual release notes)
- Input validation enhancements
- Rate limiting implementation
- Authentication framework

---

For questions about this security policy, contact: security@inventivework.com