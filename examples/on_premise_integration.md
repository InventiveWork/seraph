# Integrating Seraph in On-Premise Environments

This document provides guidance on how to integrate the Seraph agent in on-premise or hybrid cloud environments.

## Core Challenge

The main challenge in on-premise environments is the diversity of logging solutions. Unlike cloud providers that offer centralized logging services, on-premise setups often use a variety of tools, such as:

-   **Logstash** or **Fluentd** as log aggregators.
-   **Syslog** for network devices and servers.
-   Logs written directly to files on disk.

The key to a successful integration is to create a pipeline that forwards these disparate logs to the Seraph agent.

## Architecture: Centralized Log Aggregation

The most robust approach is to use a centralized log aggregator like **Fluentd** or **Logstash**. These tools are designed to collect logs from various sources, transform them, and forward them to multiple destinations.

### Deployment

1.  **Deploy Seraph**: Run the Seraph agent on a dedicated virtual machine or in a container orchestration platform (like Docker Swarm or a local Kubernetes cluster) within your data center.
2.  **Configure a Log Aggregator**: Set up a log aggregator (e.g., Fluentd) to collect logs from your servers, applications, and network devices.
3.  **Forward Logs to Seraph**: Configure the log aggregator to forward all relevant logs to the Seraph agent's `/logs` HTTP endpoint.

## Use Case: Monitoring a Legacy Monolithic Application

Imagine you are responsible for a critical on-premise monolithic application. The application is old, and its logs are verbose and difficult to parse. You want to detect performance degradation before it impacts users.

### 1. Log Collection with Fluentd

Install a Fluentd agent (`td-agent`) on the server running the legacy application. Configure it to tail the application's log file.

**Fluentd Configuration (`td-agent.conf`):**

```conf
# Tail the application log file
<source>
  @type tail
  path /var/log/legacy-app/app.log
  pos_file /var/log/td-agent/legacy-app.log.pos
  tag legacy.app
  <parse>
    @type none # Send the raw log line to Seraph
  </parse>
</source>

# Forward the logs to the Seraph agent
<match legacy.app>
  @type http
  endpoint http://seraph-agent.internal:8080/logs
  headers {"Authorization": "Bearer your-secret-api-key"}
  <buffer>
    flush_interval 10s
  </buffer>
</match>
```

### 2. Configure Seraph for Performance Analysis

Customize the prompt in your `seraph.yaml` to identify performance-related issues in the unstructured logs.

**Example `seraph.yaml`:**

```yaml
llm:
  provider: openai
  model: gpt-4
  prompt: |
    Analyze the following log entry from a legacy monolithic application. The logs are unstructured and verbose.
    Your task is to identify signs of performance degradation. Look for phrases like "transaction took too long", "database query slow", "thread pool exhausted", or response times that are unusually high (e.g., > 2000ms).
    Respond with only a JSON object with "decision" and "reason" fields.
    "decision" should be "alert" if a performance issue is detected, otherwise "ok".
    "reason" should explain the performance issue you found.

    Log entry:
    {{LOG_ENTRY}}
```

### 3. The Analysis Workflow

1.  The legacy application's performance starts to degrade. A database query that usually takes 50ms now takes 3,500ms. The application logs a line like:
    `INFO: 2023-10-27 10:30:15 - TransactionID: 12345, User: 'test', Action: 'ProcessPayment', Duration: 3500ms`
2.  The Fluentd agent on the server reads this line from the log file.
3.  Fluentd forwards the log entry to the Seraph agent.
4.  A Seraph worker sends the log to the LLM with the performance-focused prompt.
5.  The LLM, despite the unstructured format, identifies the high duration and responds with:
    ```json
    {
      "decision": "alert",
      "reason": "Performance degradation detected. A 'ProcessPayment' action took 3500ms, which is significantly higher than the typical response time."
    }
    ```
6.  Seraph sends an alert to your operations team. They can now investigate the database performance issue before it causes a widespread outage.

## Alternative: Direct Integration with Syslog

For network devices or systems that only support Syslog, you can set up a **Syslog-to-HTTP** bridge. A simple script or a tool like `syslog-ng` can be configured to receive Syslog messages and forward them as HTTP POST requests to Seraph's `/logs` endpoint.
