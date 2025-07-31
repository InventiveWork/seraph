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

## Dynamic Tool Integration with MCP

Seraph now supports the **Model Context Protocol (MCP)**, allowing it to dynamically connect to and use external tools from any MCP-compliant server. This "plug and play" functionality makes the agent highly extensible and adaptable to new tasks without requiring any code changes.

### How It Works

1.  **Dynamic Discovery**: When you start the agent with a specified MCP server, it connects to the server and automatically discovers the list of available tools.
2.  **Intelligent Tool Selection**: The agent's underlying LLM is informed of the available tools and their descriptions. When you chat with the agent, the LLM intelligently decides which tool (if any) is best suited to fulfill your request.
3.  **Seamless Execution**: The agent then executes the chosen tool and uses its output to formulate a response.

This architecture allows you to easily expand the agent's capabilities by simply pointing it to a new MCP server.

### Using MCP Tools

To connect to an MCP server, use the `--mcp-server-url` option with the `chat` command:

```bash
seraph chat "What's the weather in London?" --mcp-server-url https://mcp.praison.ai
```

The agent will connect to the specified server, discover its tools (like a weather tool), and use them to answer your question.

**Security Warning:** Only connect to MCP servers that you trust. A malicious MCP server could provide tools that could harm your system or exfiltrate data.

## Autonomous Log Analysis and Alerting

Seraph's core feature is its ability to autonomously analyze logs and trigger alerts. When a log is ingested, it is passed to a worker thread, which then sends it to the configured LLM provider for analysis.

The agent uses a prompt that asks the model to determine if the log entry requires an alert. The model responds with a JSON object containing a `decision` ("alert" or "ok") and a `reason`.

If the decision is "alert", the agent will print an alert to the console. In a production environment, this could be configured to trigger a webhook to a service like Slack or PagerDuty.

**Example Alert:**

If you send a log like this:
`"level":"error","message":"Database connection failed: timeout expired"`

The agent will output:
`[Worker 12345] Anomaly detected! Reason: The log indicates a critical database connection failure.`

This allows for proactive monitoring and response to issues as they happen.

## Setup and Installation

Seraph is distributed as an `npm` package. You can install it globally to use the CLI anywhere on your system.

```bash
npm install -g seraph-agent
```

Alternatively, you can add it as a dependency to your project:

```bash
npm install seraph-agent
```

## Configuration

Seraph can be configured via a `seraph.config.json` file or by using environment variables.

### `seraph.config.json`

Create a file named `seraph.config.json` in your project directory.

```json
{
  "port": 8080,
  "workers": 4,
  "apiKey": "YOUR_API_KEY",
  "llm": {
    "provider": "gemini",
    "model": "gemini-1.5-pro-latest"
  },
  "alertManager": {
    "url": "http://localhost:9093/api/v2/alerts"
  },
  "preFilters": [
    "level":"debug",
    "status":"(200|204)"
  ]
}
```

-   `port`: The port for the log ingestion server.
-   `workers`: The number of worker threads for log analysis.
-   `apiKey`: The API key for the selected LLM provider.
-   `serverApiKey`: An API key to secure the server endpoints. If set, requests must include an `Authorization: Bearer <key>` header.
-   `llm`: The LLM provider and model to use.
-   `alertManager`: The URL for the Alertmanager instance.
-   `preFilters`: An array of regular expressions to filter logs before analysis.
-   `rateLimit`: Configuration for the request rate limiter.
    -   `window`: The time window in milliseconds.
    -   `maxRequests`: The maximum number of requests per window.
-   `recentLogsMaxSizeMb`: The maximum size of the recent logs buffer in megabytes.

The `apiKey` can be set in the `seraph.config.json` file. However, it's recommended to use environment variables for API keys, as they take precedence over the configuration file.

### Pre-filtering Logs

To improve efficiency and reduce costs, you can pre-filter logs to exclude entries that are unlikely to be anomalous. The `preFilters` option in `seraph.config.json` accepts an array of regular expression strings. If a log entry matches any of these expressions, it will be skipped and not sent to the LLM for analysis.

**Example:**
The following configuration will skip any log containing `level":"debug"` or a status of 200 or 204:
```json
"preFilters": [
  "level":"debug",
  "status":"(200|204)"
]
```

### Environment Variables


You can also configure the agent using environment variables.

-   `GEMINI_API_KEY`: Your Gemini API key.
-   `ANTHROPIC_API_KEY`: Your Anthropic API key.
-   `OPENAI_API_KEY`: Your OpenAI API key.

The `seraph.config.json` file will take precedence over environment variables.

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

### `seraph status`

Checks the status of the agent.

### `seraph stop`

Stops the agent and all workers.

### `seraph chat <message>`

Chat with the Seraph agent. Requires a configured LLM provider and API key.

**Options:**
- `-c, --context`: Include the last 100 logs as context for the chat. This allows you to ask questions like `"summarize the recent errors"`.
- `--mcp-server-url <url>`: Connect to an MCP server to use its tools.


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
