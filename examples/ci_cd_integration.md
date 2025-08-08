# Integrating Seraph with CI/CD Pipelines

This document explains how to integrate the Seraph agent into your CI/CD pipeline to provide intelligent feedback on build and test failures.

## The Problem with CI/CD Failures

When a CI/CD pipeline fails, developers often have to sift through thousands of lines of logs to find the root cause. A test failure might be buried in a huge amount of build output, making it time-consuming to diagnose the problem.

Seraph can be used to analyze these logs and provide a concise, human-readable summary of why the pipeline failed.

## Architecture

The integration involves adding a step to your CI/CD pipeline that, upon failure, sends the logs to a Seraph instance for analysis.

1.  **Seraph Instance**: You need a running Seraph instance that is accessible from your CI/CD runners.
2.  **CI/CD Platform**: This can be GitHub Actions, GitLab CI, Jenkins, or any other CI/CD platform.
3.  **Failure Hook**: You'll add a step to your pipeline that runs only when a previous step has failed. This step will capture the logs and send them to Seraph.

## Use Case: Intelligent Analysis of GitHub Actions Failures

Let's walk through how to set this up with **GitHub Actions**.

### 1. Create a Seraph Workflow for Analysis

First, configure a Seraph instance with a prompt specifically designed for analyzing CI/CD logs.

**Example `seraph.yaml`:**

```yaml
llm:
  provider: gemini
  model: gemini-1.5-flash
  prompt: |
    Analyze the following CI/CD log from a failed build or test run.
    Your task is to find the root cause of the failure. Look for compilation errors, failed tests, linting errors, or deployment script failures.
    Provide a clear and concise summary of the error. If it's a test failure, mention the name of the test that failed. If it's a compilation error, point to the file and line number.
    Respond with only a JSON object with "decision" and "reason" fields.
    "decision" should always be "alert".
    "reason" should be your summary of the failure.

    Log entry:
    {{LOG_ENTRY}}
```

### 2. Modify Your GitHub Actions Workflow

Add a final step to your existing GitHub Actions workflow that will run on failure. This step will use `curl` to send the logs of the failed job to Seraph.

**Example GitHub Actions Workflow (`.github/workflows/main.yml`):**

```yaml
name: CI

on: [push]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Set up Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm install

      - name: Run tests
        id: test
        run: npm test # This command will fail if tests fail

      # This step runs ONLY if the "Run tests" step fails
      - name: Analyze failure with Seraph
        if: failure()
        run: |
          # Get the job logs using the GitHub API
          JOB_LOGS=$(curl -s -H "Authorization: Bearer ${{ secrets.GITHUB_TOKEN }}" \
            "https://api.github.com/repos/${{ github.repository }}/actions/jobs/${{ github.job }}/logs")

          # Send the logs to Seraph for analysis
          ANALYSIS=$(curl -s -X POST \
            -H "Content-Type: text/plain" \
            -H "Authorization: Bearer ${{ secrets.SERAPH_API_KEY }}" \
            --data-binary "$JOB_LOGS" \
            http://your-seraph-instance.com/logs)
          
          # You can then post the analysis as a comment on the commit, or send it to Slack
          echo "Seraph analysis: $ANALYSIS"
```

### 3. The Workflow in Action

1.  A developer pushes code with a failing test.
2.  The GitHub Actions workflow starts. The `npm test` command fails.
3.  Because the test step failed, the `if: failure()` condition on the "Analyze failure with Seraph" step becomes true.
4.  The step uses the GitHub API to download the logs for the current job.
5.  It then sends these logs to the Seraph agent's `/logs` endpoint.
6.  Seraph's LLM analyzes the log and finds the specific test that failed. It responds with:
    ```json
    {
      "decision": "alert",
      "reason": "The pipeline failed because of a test failure in 'should correctly calculate the total price'. The test expected 100 but received 105."
    }
    ```
7.  The GitHub Actions workflow can then take this summary and:
    -   Post it as a comment on the commit that triggered the workflow.
    -   Send it to a Slack channel.
    -   Create a ticket in a project management tool.

This provides immediate, actionable feedback to the developer, saving them the time and effort of manually searching through logs.
