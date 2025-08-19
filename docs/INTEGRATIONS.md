# Integration Guide

Seraph is designed to be a component in a larger observability and automation ecosystem. This guide explains how to integrate it with other tools.

## Configuring Log Forwarders

Seraph accepts logs via an HTTP endpoint. You can configure any modern log forwarder to send logs to the Seraph agent. The agent expects a `POST` request to the `/logs` endpoint.

### Example: Fluentd

In your `fluentd.conf`, you can use the `http_ext` output plugin to forward logs.

```xml
<match your.app.logs>
  @type http_ext
  endpoint_url http://localhost:8080/logs
  http_method post
  serializer json
  <format>
    @type json
  </format>
</match>
```

### Example: Vector

In your `vector.toml`, you can configure an `http` sink.

```toml
[sinks.seraph]
type = "http"
inputs = ["my_source"]
uri = "http://localhost:8080/logs"
method = "post"
encoding.codec = "json"
```

## Monitoring with Prometheus

The Seraph agent exposes a `/metrics` endpoint for Prometheus scraping.

**Example `prometheus.yml` scrape configuration:**

```yaml
scrape_configs:
  - job_name: 'seraph-agent'
    static_configs:
      - targets: ['localhost:8080']
```

## Automated Investigation and Root Cause Analysis

When Seraph detects an anomaly, it can trigger a deeper investigation to find the root cause. This is handled by the **InvestigationWorker**.

### How it Works

1.  **Anomaly Detection**: A Seraph triage worker detects an anomaly in a log stream.
2.  **Investigation Dispatch**: The `AgentManager` dispatches the alert to an `InvestigationWorker`.
3.  **Root Cause Analysis**: The worker uses a ReAct-style loop, leveraging a suite of tools to gather more context and perform a root cause analysis.
4.  **Reporting**: The findings of the investigation are saved as a report in a local SQLite database.

This automated investigation process allows Seraph to go beyond simple anomaly detection and provide actionable insights into the root cause of problems.

## Sending Seraph Anomalies to Alertmanager

You can configure Seraph to send the anomalies it detects directly to Prometheus Alertmanager.

## Dynamic Tool Integration with Model Context Protocol (MCP)

Seraph can be extended with "tools" from external servers that follow the **Model Context Protocol (MCP)**. This allows the agent to perform a huge variety of tasks, from fetching web pages to interacting with version control systems.

### Seraph's Built-in Tool Server

Seraph includes a built-in MCP server that starts automatically on the next available port (e.g., 8081 if the main server is on 8080). This server provides powerful SRE-focused tools out of the box.

-   **`git_log`**: Reads the commit history of a local Git repository. Requires `builtInMcpServer.gitRepoPath` to be set in your `seraph.config.json`.
-   **`git_clone`**: Clones a Git repository into a secure directory for analysis. Supports both automatic temporary directories and custom destinations within secure paths.

#### **Enhanced `git_clone` Tool Features**
The `git_clone` tool now supports enhanced destination control while maintaining security:

**Usage Examples:**
- `"clone https://github.com/user/repo.git"` - Uses secure temporary directory (original behavior)
- `"clone https://github.com/user/repo.git to /tmp/analysis"` - Uses custom secure destination
- `"clone the repo https://github.com/user/repo.git into /var/tmp/project"` - Alternative syntax

**Security Features:**
- **Path Validation**: Custom destinations restricted to `/tmp/` and `/var/tmp/` directories only
- **Path Traversal Protection**: Blocks `../`, `./`, and other traversal attempts
- **System Directory Protection**: Prevents overwriting system temporary directories
- **Absolute Path Resolution**: All paths normalized and validated before use

#### **SECURITY CONSIDERATIONS**
- **Execution Environment**: Clones into validated secure directories with comprehensive path checking
- **Malicious Repositories**: A malicious actor could potentially trick the agent into cloning harmful content or large files
- **Resource Usage**: Cloning large repositories can consume significant disk space and network bandwidth
- **Custom Destinations**: Only `/tmp/` and `/var/tmp/` paths allowed to prevent system compromise
- **Recommendation**: Use in properly sandboxed environments (Docker containers) with limited resources and permissions

### How It Works

When you provide Seraph with an MCP server, it connects to that server and asks for a "manifest" of the tools it provides. This manifest tells the agent what the tools are called, what they do, and what arguments they need. When you chat with the agent, it uses its intelligence to decide which tool is appropriate for your request and then invokes it.

### Using MCP Tools

There are two ways to enable MCP tools for the agent:

#### 1. Using Built-in Toolsets

Seraph comes with a pre-configured list of high-quality, public MCP servers, which we call "toolsets". This is the easiest way to get started.

**To list the available toolsets, run:**
```bash
seraph tools list
```

**To use a toolset in a chat, use the `--tools` flag:**
```bash
# This command gives the agent the 'time' toolset for this one chat session.
seraph chat "What time is it in London?" --tools time
```

#### 2. Connecting to a Custom Server

You can connect to any MCP-compliant server, such as one you are developing locally or a private server within your organization, using the `--mcp-server-url` flag.

```bash
seraph chat "Get the status of the main branch" --mcp-server-url http://localhost:3001
```

### Setting Default Tools

If you have a set of trusted tools you want the agent to use all the time, you can configure them in your `seraph.config.json` file using the `defaultMcpServers` key. The agent will then have access to these tools in every chat session.

**Example `seraph.config.json`:**
```json
{
  "port": 8080,
  "llm": {
    "provider": "gemini"
  },
  "defaultMcpServers": ["fetch", "time"]
}
```
*Note: CLI flags like `--tools` and `--mcp-server-url` will always override the default settings for a single command.*

### Available MCP Servers

The MCP community is growing rapidly. Below is a list of known public MCP servers that you can connect to.

**Security Warning:** The "Official" and "Reference" servers are maintained by the MCP team. Community servers are built by third parties. Always be cautious and only connect to servers that you trust, as a malicious server could expose your system to risks.

#### Reference Servers
*   **Everything** - Reference / test server with prompts, resources, and tools.
*   **Fetch** - Web content fetching and conversion for efficient LLM usage.
*   **Filesystem** - Secure file operations with configurable access controls.
*   **Git** - Tools to read, search, and manipulate Git repositories.
*   **Memory** - Knowledge graph-based persistent memory system.
*   **Sequential Thinking** - Dynamic and reflective problem-solving through thought sequences.
*   **Time** - Time and timezone conversion capabilities.

#### Official and Community Servers
This is a curated list of servers relevant to SRE, DevOps, and infrastructure management. For the most up-to-date and complete list, please visit the [MCP Servers GitHub Repository](https://github.com/modelcontextprotocol/servers).

**Cloud & IaaS/PaaS:**
*   AWS
*   Alibaba Cloud
*   Azure
*   Cloudflare
*   DigitalOcean
*   Firebase
*   Heroku
*   Netlify
*   Vercel

**Databases & Data Stores:**
*   Aiven
*   Astra DB (Cassandra)
*   Chroma
*   ClickHouse
*   Confluent (Kafka)
*   Couchbase
*   Elasticsearch
*   Kafka
*   MariaDB
*   MongoDB
*   MySQL
*   Neo4j
*   Pinecone
*   PostgreSQL
*   Qdrant
*   Redis
*   Snowflake
*   Supabase

**CI/CD & Version Control:**
*   Atlassian (Jira, Confluence)
*   CircleCI
*   Docker
*   Gitea
*   GitHub
*   Helm
*   Jenkins
*   Jira
*   Kubernetes
*   Terraform

**Observability & Monitoring:**
*   AgentOps
*   Axiom
*   Datadog
*   Grafana
*   PagerDuty
*   Prometheus
*   Sentry

**Communication & ChatOps:**
*   Discord
*   Gmail
*   Slack
*   Telegram
*   Twilio

**Productivity & Project Management:**
*   Archbee (Documentation)
*   Asana
*   Linear
*   Notion
*   Trello
*   Zapier


---


### Configuration

In your `seraph.config.json`, add the `alertManager` configuration block:

```json
{
  "alertManager": {
    "url": "http://<alertmanager-host>:<port>/api/v2/alerts"
  }
}
```

-   Replace `<alertmanager-host>` and `<port>` with the address of your Alertmanager instance (e.g., `localhost:9093`).

When an anomaly is detected, Seraph will send a POST request to this URL with the following payload:

```json
[
  {
    "labels": {
      "alertname": "SeraphAnomalyDetected",
      "source": "log_analysis",
      "type": "anomaly_detected"
    },
    "annotations": {
      "summary": "Anomaly detected by Seraph",
      "description": "<The reason provided by the LLM>",
      "log": "<The original log entry>"
    }
  }
]
```

This allows you to manage and route alerts detected by Seraph using your existing Alertmanager setup.


