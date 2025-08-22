
# Seraph End-to-End Demo Guide

This guide walks you through setting up a complete, local Kubernetes environment to demonstrate the capabilities of the Seraph agent.

You will deploy:
- A Kubernetes cluster using `kind`.
- A sample application that generates logs.
- Fluent Bit to collect logs.
- Prometheus and Alertmanager for monitoring and alerting.
- The Seraph agent, configured to analyze logs and fire alerts.

---

### Prerequisites

Before you begin, ensure you have the following tools installed:
- [Docker](https://docs.docker.com/get-docker/)
- [kubectl](https://kubernetes.io/docs/tasks/tools/install-kubectl/)
- [Helm](https://helm.sh/docs/intro/install/)
- [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation)

---

### Step 1: Set Up the Environment

This script will create the local Kubernetes cluster, install Prometheus & Alertmanager, and build the sample application's Docker image.

```bash
# Make the scripts executable
chmod +x demo/setup.sh
chmod +x demo/cleanup.sh

# Run the setup script
./demo/setup.sh
```
This process will take a few minutes as it downloads the necessary images.

---

### Step 2: Deploy the Applications

Now, apply the Kubernetes manifests to deploy the sample app and Fluent Bit.

```bash
# Deploy the sample application
kubectl apply -f demo/kubernetes/sample-app.yaml

# Deploy Fluent Bit
kubectl apply -f demo/kubernetes/fluent-bit.yaml
```

You can check the status of the pods:
```bash
# Should show the sample-app pod running
kubectl get pods -l app=sample-app

# Should show fluent-bit pods on each node
kubectl get pods -l app.kubernetes.io/name=fluent-bit
```

---

### Step 3: Deploy Seraph

1.  **Create a Secret for the API Key**:
    Replace `"YOUR_GEMINI_API_KEY"` with your actual Gemini API key.

    ```bash
    kubectl create secret generic seraph-secrets --from-literal=GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
    ```

2.  **Create a Secret for the GitHub MCP (Optional)**:
    If you want to use the `git_clone` tool with private repositories, create a separate secret for the GitHub MCP. This secret's key will be the name of the environment variable.
    Replace `"YOUR_GITHUB_TOKEN"` with your actual token.

    ```bash
    kubectl create secret generic github-mcp-secret --from-literal=GITHUB_TOKEN="YOUR_GITHUB_TOKEN"
    ```

3.  **Install Seraph using Helm**:
    This command uses the project's local Helm chart and applies the demo-specific configuration, which includes mounting the `github-mcp-secret`.

    ```bash
    helm install seraph-agent ./helm -f demo/helm/seraph-demo-values.yaml
    ```

Check that the Seraph pod is running:
```bash
kubectl get pods -l app.kubernetes.io/name=seraph
```

---

### Step 4: The User Plan - See Seraph in Action

Now that the entire stack is running, you can simulate traffic and see Seraph detect anomalies.

1.  **Access the Alertmanager UI**:
    Open a new terminal and run `kubectl port-forward` to access the Alertmanager dashboard.

    ```bash
    kubectl port-forward svc/prometheus-alertmanager 8080:9093 --namespace monitoring
    ```
    Now, open your web browser and navigate to `http://localhost:8080`. You should see the Alertmanager UI.

2.  **Generate Normal Logs**:
    Open another terminal and use `kubectl port-forward` to send requests to the sample app.

    ```bash
    kubectl port-forward svc/sample-app 3000:80
    ```
    Now, in a new terminal, generate some normal traffic.
    ```bash
    curl http://localhost:3000/
    curl http://localhost:3000/
    ```
    You can view the logs of the Seraph agent to see it processing these "ok" logs.
    ```bash
    # Get the Seraph pod name
    SERAPH_POD=$(kubectl get pods -l app.kubernetes.io/name=seraph -o jsonpath='{.items[0].metadata.name}')
    
    # View the logs
    kubectl logs -f $SERAPH_POD
    ```
    You should see lines like `[Worker X] Received log: ...`

3.  **Trigger an Anomaly**:
    Now, send a request to the `/error` endpoint to generate an anomalous log.

    ```bash
    curl http://localhost:3000/error
    ```

4.  **Observe the Result**:
    - **In the Seraph logs (`kubectl logs -f $SERAPH_POD`)**: You will see the worker detect the anomaly and fire an initial alert. Shortly after, you'll see the ReAct investigation begin and a final report being saved.
    - **In the Alertmanager UI (http://localhost:8080)**: Within a minute, you should see a new alert appear. It will first appear as `SeraphAnomalyTriage` and then be updated or joined by a `SeraphAnomalyInvestigationComplete` alert with the detailed root cause analysis.

5.  **(Optional) Inspect the Reports Database**:
    You can `exec` into the Seraph pod to query the SQLite database and see the full, detailed report that was saved.

    ```bash
    # Exec into the pod
    kubectl exec -it $SERAPH_POD -- /bin/sh

    # Install sqlite client if not present
    # apk add --no-cache sqlite

    # Query the database
    sqlite3 reports.db "SELECT incidentId, triageReason, status FROM reports;"
    .exit
    ```

---

### Advanced Scenario: Investigation with Tools

The demo is pre-configured to use the `git` toolset during an investigation. When an anomaly is detected, Seraph will not only analyze the log but will also use the `git` tool to gather more context about recent code changes.

**How it Works:**

1.  When you trigger the `/error` endpoint, the agent detects the anomaly as before.
2.  During the investigation phase, the agent's prompt is now augmented with the available `git` tools.
3.  The agent will reason that it should check recent code changes. It will formulate a call to the `git` tool to get the latest commit information.
4.  The final report will include the output from the `git` tool in its root cause analysis.

**Observe the Advanced Investigation:**

When you view the Seraph logs (`kubectl logs -f $SERAPH_POD`) after triggering the error, you will see the investigation "scratchpad" being printed. You can see the agent deciding to use the `git` tool, executing it, and then using the result in its final analysis.

---

### Step 5: Cleanup

Once you are finished with the demo, you can delete the entire environment with a single command.

```bash
./demo/cleanup.sh
```
