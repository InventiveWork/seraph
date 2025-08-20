# Seraph Agent

**Seraph is an extremely lightweight, SRE autonomous AI agent designed for seamless integration with common observability tasks.**

It is highly scalable, capable of independent asynchronous analysis, and possesses the ability to integrate with other AI agents for automated mitigation and code modifications.

## Key Features

-   **Log Ingestion**: Integrates with log forwarders like Fluentd, Logstash, and Vector via HTTP.
-   **Autonomous Log Analysis**: Uses a configurable LLM provider (Gemini, Anthropic, OpenAI) to analyze logs in real-time, detect anomalies, and trigger alerts.
-   **Context-Aware Chat**: Chat with the agent about recent logs to gain insights and summaries.
-   **Scalable & Autonomous**: Manages multiple asynchronous agent workers for parallel log analysis.
-   **Automated Mitigation**: Can be configured to call out to other AI agents for automated mitigation and code modification proposals.
-   **CLI Control**: A simple and powerful Command Line Interface for managing the agent's lifecycle.
-   **Easy to Deploy**: Can be deployed locally, on-premise, or in any cloud environment.
-   **Extremely Lightweight**: Built with performance in mind to minimize resource consumption.
-   **Integrations**: Supports integrations with log forwarders, LLM providers, and monitoring tools.

## Built-in SRE Tooling

Seraph now comes with a built-in Model Context Protocol (MCP) server that provides essential SRE tools out-of-the-box. When you start the Seraph agent, it automatically starts a second server on the next available port (e.g., `8081`) that provides these tools to the agent for its investigations.

### Included Tools

-   **Git**: The agent can analyze the Git repository where your application's source code is located. It can read commit logs to correlate a production error with a recent code change.

-   **Prometheus**: The agent can query your Prometheus instance to investigate metrics, alerts, targets, and rules. This enables correlation of log anomalies with system metrics and infrastructure health.

### Configuration

To use the built-in tools, configure them in your `seraph.config.json`:

```json
{
  "builtInMcpServer": {
    "gitRepoPath": "/path/to/your/local/git/repo",
    "prometheusUrl": "http://localhost:9090"
  }
}
```

With this configuration, the agent will automatically have access to:
- `git_log` and `git_clone` tools for code analysis
- `prometheus_query` for custom PromQL queries
- `prometheus_metrics` to explore available metrics
- `prometheus_alerts` to check current alert status
- `prometheus_targets` to verify scrape target health
- `prometheus_rules` to inspect alerting and recording rules

## Dynamic Tool Integration with MCP

Seraph now supports the **Model Context Protocol (MCP)**, allowing it to dynamically connect to and use external tools from any MCP-compliant server. This "plug and play" functionality makes the agent highly extensible and adaptable to new tasks without requiring any code changes.

### How It Works

1.  **Dynamic Discovery**: When you start the agent with a specified MCP server, it connects to the server and automatically discovers the list of available tools.
2.  **Intelligent Tool Selection**: The agent's underlying LLM is informed of the available tools and their descriptions. When you chat with the agent, the LLM intelligently decides which tool (if any) is best suited to fulfill your request.
3.  **Seamless Execution**: The agent then executes the chosen tool and uses its output to formulate a response.

This architecture allows you to easily expand the agent's capabilities by simply pointing it to a new MCP server.

### Using MCP Tools

There are two ways to connect Seraph to MCP servers:

1.  **Custom Server**: You can connect to any MCP-compliant server using the `--mcp-server-url` flag. This is useful for development or for connecting to private, custom tool servers.

    ```bash
    seraph chat "What's the weather in London?" --mcp-server-url https://some-weather-mcp-server.com
    ```

2.  **Built-in Toolsets**: Seraph comes with a curated list of high-quality, pre-configured MCP servers that you can easily use with the `--tools` flag.

    ```bash
    seraph chat "What is the current time in Tokyo?" --tools time
    ```

    To see the list of all available built-in toolsets, run:
    ```bash
    seraph tools list
    ```

**Security Warning:** Only connect to MCP servers that you trust. A malicious MCP server could provide tools that could harm your system or exfiltrate data.

## Autonomous Log Analysis and Investigation

Seraph's core feature is its ability to autonomously analyze logs and perform root cause analysis. The process involves two stages:

1.  **Triage**: When a log is ingested, it is passed to a triage worker. This worker makes a quick decision on whether the log requires further attention. The model responds with a `decision` ("alert" or "ok") and a brief `reason`.

2.  **Investigation**: If the decision is "alert", the log is passed to an investigation worker. This worker uses a ReAct-style loop to conduct a detailed root cause analysis. It can use a variety of tools (like the built-in Git tool) to gather more context.

3.  **Reporting**: The findings of the investigation, including the root cause analysis, impact assessment, and suggested remediation steps, are saved to a local SQLite database.

This multi-stage process allows Seraph to quickly filter through a high volume of logs and perform deep analysis only when necessary, making it both efficient and powerful.

## Setup and Installation

Seraph is distributed as an `npm` package. You can install it globally to use the CLI anywhere on your system.

```bash
npm install -g seraph-agent
```

**Note on Native Addons**: The agent uses the `sqlite3` package to store investigation reports, which is a native Node.js addon. If you encounter installation issues, you may need to install the necessary build tools for your operating system. Please see the "Troubleshooting" section for more details.

Alternatively, you can add it as a dependency to your project:

```bash
npm install seraph-agent
```

## Configuration

Seraph is configured via a `seraph.config.json` file in your project root. Environment variables can also be used and will override settings in the file.

For a detailed explanation of all available options, please see the well-commented example configuration file:
[`config.example.json`](./config.example.json)

### Environment Variables

The primary LLM API key is configured via environment variables.

-   `GEMINI_API_KEY`: Your Gemini API key.
-   `ANTHROPIC_API_KEY`: Your Anthropic API key.
-   `OPENAI_API_KEY`: Your OpenAI API key.

## Troubleshooting

### `sqlite3` Native Addon Installation Issues

The agent uses the `sqlite3` package to store investigation reports, which is a native Node.js addon. If you encounter errors during `npm install` related to `node-gyp` or `sqlite3`, it likely means you are missing the necessary build tools for your operating system.

-   **Windows**:
    ```bash
    npm install --global windows-build-tools
    ```
-   **macOS**:
    - Install the Xcode Command Line Tools: `xcode-select --install`
-   **Debian/Ubuntu**:
    ```bash
    sudo apt-get install -y build-essential
    ```

For more detailed instructions, please refer to the [`node-gyp` installation guide](https://github.com/nodejs/node-gyp#installation).

## Integrations

Seraph is designed to be a component in a larger observability and automation ecosystem. It supports integrations with log forwarders, LLM providers, monitoring tools, and alert managers.

For a detailed guide on integrating with tools like Fluentd, Vector, and Alertmanager, or for information on inter-agent communication, please see the [Integration Guide](docs/INTEGRATIONS.md).

### LLM Providers

You can choose from the following LLM providers:

-   `gemini` (default)
-   `anthropic`
-   `openai`

You can also specify a model for the selected provider. If no model is specified, a default will be used.

## Quick Start

1.  **Configure your API Key**:
    Set the environment variable for your chosen provider:
    ```bash
    # For Gemini
    export GEMINI_API_KEY="YOUR_GEMINI_API_KEY"

    # For Anthropic
    export ANTHROPIC_API_KEY="YOUR_ANTHROPIC_API_KEY"

    # For OpenAI
    export OPENAI_API_KEY="YOUR_OPENAI_API_KEY"
    ```
    Alternatively, you can create a `seraph.config.json` file as described above.

2.  **Start the agent**:
    If you installed it globally, you can run:

    ```bash
    seraph start
    ```

    This will start the log ingestion server on port `8080` and spin up `4` analysis workers.

## CLI Usage

The Seraph agent is controlled via the `seraph` command.

### `seraph start`

Starts the agent and the log ingestion server.

**Options:**
- `--mcp-server-url <url>`: Connect to an MCP server to enable dynamic tool usage.
- `--tools <names>`: A comma-separated list of built-in toolsets to use (e.g., "fetch,git").

### `seraph status`

Checks the status of the agent.

### `seraph stop`

Stops the agent and all workers.

### `seraph chat <message>`

Chat with the Seraph agent. Requires a configured LLM provider and API key.

**Options:**
- `-c, --context`: Include the last 100 logs as context for the chat. This allows you to ask questions like `"summarize the recent errors"`.
- `--mcp-server-url <url>`: Connect to a custom MCP server to use its tools.
- `--tools <names>`: A comma-separated list of built-in toolsets to use (e.g., "fetch,git").

### `seraph tools list`

Lists all available built-in toolsets.


## Running with Docker

You can also run the Seraph agent in a Docker container for easy deployment.

1.  **Build the Docker image**:
    ```bash
    docker build -t seraph-agent .
    ```

2.  **Run the Docker container**:

    You can configure the agent inside the container using environment variables.

    *Example for Gemini:*
    ```bash
    docker run -d -p 8080:8080 \
      -e GEMINI_API_KEY="YOUR_GEMINI_API_KEY" \
      --name seraph-agent seraph-agent
    ```

    *Example for Anthropic:*
    ```bash
    docker run -d -p 8080:8080 \
      -e ANTHROPIC_API_KEY="YOUR_ANTHROPIC_API_KEY" \
      --name seraph-agent seraph-agent
    ```

    Alternatively, you can mount a `seraph.config.json` file to configure the container, which is useful if you want to specify a provider and model.

    ```bash
    docker run -d -p 8080:8080 \
      -v $(pwd)/seraph.config.json:/usr/src/app/seraph.config.json \
      --name seraph-agent seraph-agent
    ```

3.  **Interact with the agent**:

    You can then interact with the agent using the `docker exec` command:

    ```bash
    docker exec -it seraph-agent node dist/index.js status
    docker exec -it seraph-agent node dist/index.js chat "hello"
    docker exec -it seraph-agent node dist/index.js chat --context "any recent errors?"
    ```

4.  **Check the logs or stop the agent**:

    ```bash
    docker logs -f seraph-agent
    docker stop seraph-agent
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

---

*For more detailed documentation on deployment and integrations, please see the `docs` directory.*

## Deploying with Helm

A Helm chart is provided for easy deployment to Kubernetes.

1.  **Prerequisites**:
    -   A running Kubernetes cluster (e.g., Minikube, Docker Desktop).
    -   `helm` command-line tool installed.

2.  **Configure API Keys**:
    The Helm chart uses environment variables for API keys. You can set these in the `helm/values.yaml` file or by using the `--set` flag during installation.

    *Example `helm/values.yaml` modification:*
    ```yaml
    env:
      GEMINI_API_KEY: "YOUR_GEMINI_API_KEY"
    ```

3.  **Install the Chart**:
    From the root of the project, run the following command:

    ```bash
    helm install my-seraph-release ./helm \
      --set env.GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
    ```

    This will deploy the Seraph agent to your Kubernetes cluster.

4.  **Accessing the Agent**:
    By default, the service is of type `ClusterIP`. To access it from your local machine, you can use `kubectl port-forward`:

    ```bash
    kubectl port-forward svc/my-seraph-release-seraph 8080:8080
    ```

    You can then send logs to `http://localhost:8080/logs`.

5.  **Uninstalling the Chart**:
    To remove the deployment, run:

    ```bash
    helm uninstall my-seraph-release
    ```

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.
