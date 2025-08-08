# Integrating Seraph with Kubernetes

This document outlines how to integrate the Seraph agent into a Kubernetes environment for real-time log analysis and anomaly detection.

## Deployment Strategy

The most effective way to deploy Seraph in Kubernetes is as a **DaemonSet**. This ensures that a Seraph agent runs on every node in your cluster, allowing it to collect logs from all pods running on that node.

Alternatively, for a more centralized approach, you can deploy it as a **Deployment** that receives logs from a cluster-wide logging agent like Fluentd or Logstash.

The project includes a pre-configured **Helm chart** in the `helm/` directory to simplify this deployment process.

## Use Case: Proactive Pod Failure Detection

Imagine you have a critical application running in your Kubernetes cluster. This application sometimes fails due to memory leaks that are hard to track. Seraph can be used to proactively detect these issues before they cause a major outage.

### 1. Configure Log Ingestion

First, configure your applications to output logs in a structured format (like JSON) to `stdout` and `stderr`. Kubernetes will automatically collect these logs.

Next, you need to forward these logs to Seraph. If you are using the Helm chart, it can be configured to automatically scrape logs from all pods. If you are using a logging agent like Fluentd, you would configure it to forward logs to the Seraph service's `/logs` endpoint.

**Fluentd Configuration Example (`fluent.conf`):**

```conf
<source>
  @type forward
  port 24224
  bind 0.0.0.0
</source>

<match **>
  @type http
  endpoint http://seraph-service.default.svc.cluster.local:8080/logs
  open_timeout 2
  <format>
    @type json
  </format>
  <buffer>
    @type memory
    flush_interval 1s
  </buffer>
</match>
```

### 2. Define Seraph's Analysis Prompt

You would configure Seraph's LLM prompt (in your `seraph.yaml` or a ConfigMap) to be highly specific about what to look for.

**Example `seraph.yaml` ConfigMap:**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: seraph-config
data:
  seraph.yaml: |
    workers: 4
    llm:
      provider: openai
      model: gpt-4
      prompt: |
        Analyze the following log from a Kubernetes pod. The log is from a critical e-commerce application.
        Your primary task is to identify any indication of memory leaks, out-of-memory (OOM) errors, or repeated crashes.
        Look for patterns like "heap size increasing", "memory usage high", or crash loops indicated by repeated startup messages.
        Respond with only a JSON object with "decision" and "reason" fields.
        "decision" should be "alert" if an anomaly is found, otherwise "ok".

        Log entry:
        {{LOG_ENTRY}}
    alerter:
      # Configuration for Slack, PagerDuty, etc.
```

### 3. Set Up Alerting

Configure Seraph's alerter to send notifications to your team's communication channels (e.g., Slack, PagerDuty).

### 4. The Flow in Action

1.  Your application pod starts experiencing a memory leak. The logs show gradually increasing memory usage warnings.
2.  Fluentd collects these logs and forwards them to the Seraph service.
3.  A Seraph worker receives the log. It sends the log to the configured LLM with the specialized prompt.
4.  The LLM, guided by the prompt, recognizes the memory leak pattern and responds with:
    ```json
    {
      "decision": "alert",
      "reason": "Detected a potential memory leak. The log shows steadily increasing heap size over the last 5 minutes."
    }
    ```
5.  Seraph receives this decision and triggers an alert through the configured alerter.
6.  Your SRE team receives a Slack notification with the details of the potential memory leak, including the problematic log entry, long before the pod crashes. This allows them to investigate and resolve the issue proactively.

## Using the Helm Chart

To deploy Seraph using the provided Helm chart:

```bash
helm install seraph ./helm --values ./helm/values.yaml
```

You can customize the `values.yaml` file to specify your configuration, including the LLM provider, API keys, and resource limits.
