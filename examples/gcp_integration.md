# Integrating Seraph with Google Cloud Platform (GCP)

This document describes how to integrate the Seraph agent with Google Cloud Platform (GCP) services for advanced log analysis.

## GCP Logging Architecture

GCP's centralized logging solution is **Cloud Logging** (formerly Stackdriver). It collects logs from various GCP services, including:

-   **Google Compute Engine (GCE)**
-   **Google Kubernetes Engine (GKE)**
-   **Cloud Functions**
-   **Cloud Run**

The key to integrating Seraph is to create a mechanism to forward logs from Cloud Logging to the Seraph agent. This is typically done using **Log Sinks** and **Cloud Pub/Sub**.

## Use Case: Real-time Error Analysis in a Serverless Application

Consider a serverless application built with **Cloud Functions** and **Cloud Run**. When an error occurs, you want to get an intelligent, context-aware alert rather than just a raw stack trace.

### 1. Deploy the Seraph Agent

Deploy the Seraph agent on a GCE instance or as a service in a GKE cluster. Make sure it's accessible within your VPC.

### 2. Create a Pub/Sub Topic

Create a Cloud Pub/Sub topic that will be used to stream logs from Cloud Logging.

```bash
gcloud pubsub topics create seraph-log-stream
```

### 3. Create a Log Sink

Create a log sink in Cloud Logging to export logs to the Pub/Sub topic you just created. You can apply a filter to only send logs of a certain severity (e.g., `severity>=ERROR`).

```bash
gcloud logging sinks create seraph-error-sink \
  pubsub.googleapis.com/projects/your-gcp-project/topics/seraph-log-stream \
  --log-filter="severity>=ERROR"
```

### 4. Create a Cloud Function for Log Forwarding

Create a Cloud Function that is triggered by messages published to the `seraph-log-stream` Pub/Sub topic. This function will be responsible for sending the logs to the Seraph agent.

**Cloud Function Code (Python):**

```python
import base64
import json
import os
import http.client

def forward_log_to_seraph(event, context):
    """Triggered by a message on a Pub/Sub topic."""
    log_entry = json.loads(base64.b64decode(event['data']).decode('utf-8'))
    
    seraph_host = os.environ.get('SERAPH_HOST')
    seraph_port = os.environ.get('SERAPH_PORT', 8080)
    seraph_api_key = os.environ.get('SERAPH_API_KEY')

    conn = http.client.HTTPConnection(seraph_host, seraph_port)
    
    headers = {
        'Content-Type': 'application/json',
    }
    if seraph_api_key:
        headers['Authorization'] = f'Bearer {seraph_api_key}'

    # The actual log payload is often in 'jsonPayload' or 'textPayload'
    payload_to_send = log_entry.get('jsonPayload', log_entry.get('textPayload', str(log_entry)))

    try:
        conn.request("POST", "/logs", body=json.dumps(payload_to_send), headers=headers)
        response = conn.getresponse()
        print(f"Seraph response: {response.status} {response.reason}")
    except Exception as e:
        print(f"Error forwarding log to Seraph: {e}")
    finally:
        conn.close()

```

### 5. Configure Seraph for Intelligent Error Analysis

Customize the prompt in your `seraph.yaml` to provide a high-level summary of the error.

**Example `seraph.yaml`:**

```yaml
llm:
  provider: gemini
  model: gemini-1.5-flash
  prompt: |
    Analyze the following error log from a serverless application on GCP.
    Instead of just repeating the error, provide a summary of what likely went wrong and suggest a potential root cause.
    For example, if it\'s a database connection error, mention that the database might be down or the credentials might be wrong.
    If it\'s a NullPointerException, identify the variable that was likely null.
    Respond with only a JSON object with "decision" and "reason" fields.
    "decision" should always be "alert" for these errors.
    "reason" should be your intelligent summary of the error.

    Log entry:
    {{LOG_ENTRY}}
```

### 6. The Analysis Workflow

1.  A Cloud Run service fails to connect to a Cloud SQL database due to incorrect credentials. It logs a detailed stack trace.
2.  Cloud Logging captures this error.
3.  The log sink matches the `severity>=ERROR` filter and exports the log message to the `seraph-log-stream` Pub/Sub topic.
4.  The Pub/Sub message triggers your Cloud Function.
5.  The Cloud Function forwards the log to the Seraph agent.
6.  A Seraph worker sends the log to the Gemini LLM with the specialized prompt.
7.  The LLM analyzes the stack trace and provides a high-level, human-readable summary:
    ```json
    {
      "decision": "alert",
      "reason": "The application failed to connect to the database. This is likely due to incorrect database credentials or a network connectivity issue between the Cloud Run service and the Cloud SQL instance."
    }
    ```
8.  Seraph sends this summary to your on-call channel. Your team immediately understands the likely problem without having to parse a complex stack trace, leading to faster resolution.

```