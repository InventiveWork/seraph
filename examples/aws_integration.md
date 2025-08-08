# Integrating Seraph with AWS

This document provides a guide on how to integrate the Seraph agent with various AWS services for powerful, AI-driven log analysis.

## Architecture Overview

A common architecture for log aggregation in AWS involves the following services:

-   **Amazon CloudWatch Logs**: The central service for collecting logs from various AWS resources, including EC2 instances, Lambda functions, EKS, and more.
-   **AWS Lambda**: A serverless compute service that can be used to process and forward logs.
-   **Amazon S3**: Can be used as a destination for logs for long-term storage and batch analysis.

Seraph can be integrated into this ecosystem to provide real-time, intelligent analysis of your logs.

## Use Case: Analyzing VPC Flow Logs for Security Threats

VPC Flow Logs provide valuable information about the IP traffic going to and from network interfaces in your VPC. Analyzing these logs is crucial for security and network troubleshooting. Seraph can be used to automatically detect suspicious network activity.

### 1. Enable VPC Flow Logs

First, enable VPC Flow Logs for your VPC and configure them to be delivered to a CloudWatch Log Group.

### 2. Set Up the Seraph Agent

Deploy the Seraph agent on an EC2 instance or as a container in an EKS or ECS cluster. Ensure it has network access to receive logs.

### 3. Create a Lambda Function for Log Forwarding

Create a Lambda function that is triggered whenever a new log event is added to your VPC Flow Logs log group in CloudWatch. This function will forward the log data to your Seraph agent.

**Lambda Function Code (Node.js):**

```javascript
const http = require('http');

exports.handler = async (event, context) => {
  const seraphOptions = {
    hostname: 'your-seraph-instance-ip-or-dns',
    port: 8080,
    path: '/logs',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SERAPH_API_KEY}` // If you have an API key configured
    }
  };

  const payload = Buffer.from(event.awslogs.data, 'base64');
  const logEvents = JSON.parse(payload.toString('utf8')).logEvents;

  for (const logEvent of logEvents) {
    const req = http.request(seraphOptions, (res) => {
      console.log(`STATUS: ${res.statusCode}`);
    });

    req.on('error', (e) => {
      console.error(`Problem with request: ${e.message}`);
    });

    // Write the log event as a string to the request body
    req.write(JSON.stringify(logEvent.message));
    req.end();
  }
};
```

### 4. Configure Seraph for Security Analysis

Configure your `seraph.yaml` to focus on security-related patterns in VPC Flow Logs.

**Example `seraph.yaml`:**

```yaml
llm:
  provider: anthropic
  model: claude-3-sonnet
  prompt: |
    Analyze the following VPC Flow Log entry. Your task is to identify suspicious network activity.
    Look for signs of a DDoS attack (a large number of requests from a single IP), port scanning (requests to multiple ports from a single source), or connections to known malicious IP addresses.
    The log format is: <version> <account-id> <interface-id> <srcaddr> <dstaddr> <srcport> <dstport> <protocol> <packets> <bytes> <start> <end> <action> <log-status>.
    Respond with only a JSON object with "decision" and "reason" fields.
    "decision" should be "alert" if suspicious activity is detected, otherwise "ok".

    Log entry:
    {{LOG_ENTRY}}
```

### 5. The Security Analysis Flow

1.  An attacker starts a port scan against one of your EC2 instances.
2.  VPC Flow Logs capture this activity, showing multiple `REJECT` entries from the same source IP to different destination ports.
3.  These logs are sent to CloudWatch Logs, which triggers your Lambda function.
4.  The Lambda function forwards each log entry to your Seraph agent.
5.  A Seraph worker sends the log to the LLM with the security-focused prompt.
6.  The LLM identifies the pattern as a port scan and responds with:
    ```json
    {
      "decision": "alert",
      "reason": "Potential port scan detected from source IP 203.0.113.12. Multiple connection attempts to different ports were rejected in a short period."
    }
    ```
7.  Seraph triggers an alert, notifying your security team. They can then use this information to block the malicious IP address in their security groups or network ACLs.

This same pattern can be applied to other AWS services, such as:
-   **CloudTrail Logs**: Analyze for suspicious API calls.
-   **Application Logs from EC2/ECS/EKS**: Analyze for application-specific errors or performance issues.
-   **Lambda Function Logs**: Monitor for execution errors or performance degradation.
