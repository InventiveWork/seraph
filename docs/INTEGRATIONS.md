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

## Inter-Agent Communication for Mitigation

One of Seraph's core features is its ability to request help from other, more specialized AI agents to perform mitigation actions, such as proposing a code fix.

This is handled by the **MitigationClient**.

### How it Works

1.  **Anomaly Detection**: A Seraph worker detects an anomaly in a log stream.
2.  **Context Assembly**: The worker assembles a context object, including the log data and the reason for the anomaly detection.
3.  **Mitigation Request**: The worker calls the `MitigationClient`, which sends the context to a configured external AI agent.
4.  **Receiving a Suggestion**: The client can then receive a suggestion from the external agent (e.g., a code patch, a configuration change).

### Configuring the MitigationClient

The `MitigationClient` is configured in your `seraph.config.json` file. The most important setting is the `mitigationAgentApiKey`.

```json
{
  "mitigationAgentApiKey": "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

### Integrating with Gemini for Code Modifications

To integrate with a powerful code generation model like Google's Gemini, you would modify the `MitigationClient` in `src/mitigation.ts` to call the Gemini API.

The key is to structure the request with a clear, actionable prompt and rich context. This might follow a protocol like the **Model Context Protocol (MCP)**, which is an emerging standard for this kind of interaction.

Here is a conceptual example of how you might modify `src/mitigation.ts`:

```typescript
// Inside the requestMitigation method in src/mitigation.ts

const geminiApiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';
const apiKey = this.config.mitigationAgentApiKey;

const prompt = `
  SRE Mitigation Request:
  An anomaly was detected in our system logs.
  Based on the following context, please provide a code patch to fix the issue.

  Context: ${JSON.stringify(context, null, 2)}

  Please return ONLY the code patch in a .diff format.
`;

try {
  const response = await fetch(`${geminiApiUrl}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    }),
  });

  const result = await response.json();
  const patch = result.candidates[0].content.parts[0].text;
  
  console.log('[MitigationClient] Received patch from Gemini:', patch);
  // Next, you could automate applying this patch or creating a pull request.

} catch (error) {
  console.error('[MitigationClient] Error calling Gemini API:', error);
}
```

This example demonstrates how you can extend Seraph to turn insights from logs into automated actions, making it a powerful SRE automation platform.

## Sending Seraph Anomalies to Alertmanager

You can configure Seraph to send the anomalies it detects directly to Prometheus Alertmanager.

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


