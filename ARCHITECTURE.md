# Seraph Architecture

This document provides a high-level overview of the Seraph agent's architecture.

## Overview

Seraph is a lightweight, autonomous SRE AI agent designed for log analysis and interactive chat. It operates as a standalone service that can ingest logs, analyze them for anomalies using Large Language Models (LLMs), and provide a chat interface for querying the system and its state.

The architecture is modular, consisting of several key components that work together.

## Core Components

The system is composed of the following major parts:

### 1. CLI (`src/index.ts`)

The command-line interface is the primary entry point for controlling the agent. It is built using `commander.js` and provides the following commands:

-   `seraph start`: Starts the agent, including the log ingestion server and worker pool.
-   `seraph stop`: Stops the agent.
-   `seraph status`: Checks if the agent is running.
-   `seraph chat`: Provides an interactive chat session with the agent. This command can dynamically connect to external tool servers.

### 2. Server (`src/server.ts`)

The server component is responsible for handling external communication. It runs an HTTP server and an IPC server.

-   **HTTP Server**:
    -   `/logs` (POST): The endpoint for ingesting logs. It includes rate limiting, payload size checks, and optional API key authentication.
    -   `/status` (GET): A health check endpoint.
    -   `/metrics` (GET): Exposes Prometheus-compatible metrics for monitoring.
    -   `/chat` (POST): An API endpoint for interacting with the chat functionality.
-   **IPC Server**:
    -   A local Unix socket is used for communication between the running agent process and the `seraph chat` CLI command. This is primarily used to fetch recent logs to provide context for chat sessions.

### 3. Agent (`src/agent.ts`)

The agent is the core of the log analysis functionality.

-   **AgentManager**: This class manages a pool of worker threads for concurrent log processing. It receives logs from the server, applies pre-filtering rules, and distributes the logs to the workers in a round-robin fashion.
-   **Worker Threads**: Each worker runs in a separate thread. It receives a log, constructs a prompt for the LLM, and calls the configured LLM provider to analyze the log. If the analysis result indicates an anomaly, it triggers an alert via the `AlerterClient`.

### 4. Chat (`src/chat.ts`)

This module powers the interactive chat functionality. It orchestrates the conversation between the user, the LLM, and any available tools. It can use recent logs as context for answering questions.

### 5. LLM Providers (`src/llm/`)

Seraph uses a modular approach for interacting with different LLMs. The `LLMProvider` interface (`src/llm/provider.ts`) defines a common contract for generating text. Concrete implementations for different services (like OpenAI, Anthropic, and Gemini) are provided in this directory. This makes it easy to switch between or add new LLM providers.

### 6. MCP Manager (`src/mcp-manager.ts`)

The Model Context Protocol (MCP) Manager is responsible for dynamic tool integration. When a user initiates a chat session with an `--mcp-server-url`, this manager connects to the specified server, discovers the tools it provides, and makes them available to the chat module.

## Data Flows

### Log Analysis Flow

1.  An external service sends a log entry to the `/logs` endpoint of the Seraph server.
2.  The server validates the request and passes the log to the `AgentManager`.
3.  The `AgentManager` applies pre-filters. If the log is not filtered, it is dispatched to one of the worker threads.
4.  The worker thread constructs a prompt and sends the log to the configured LLM for analysis.
5.  The LLM responds with a JSON object indicating whether the log is an "alert" or "ok".
6.  If an alert is triggered, the worker uses the `AlerterClient` to send a notification.

### Chat & Tool Usage Flow

1.  The user runs `seraph chat "your question"`.
2.  The CLI sends the message to the `chat` function.
3.  If an `--mcp-server-url` is provided, the `McpManager` connects to the server and fetches a list of available tools.
4.  The `chat` function constructs a system prompt that includes the user's question and descriptions of any available tools.
5.  The prompt is sent to the LLM.
6.  The LLM can either respond with a direct answer or with a JSON object requesting a tool call.
7.  If a tool call is requested, the `chat` function executes the tool via the `McpManager`, gets the result, and re-engages the LLM with the tool's output.
8.  The final response is streamed back to the user's console.

## Deployment

The project includes a `Dockerfile` for building a container image and a `helm/` directory containing a Helm chart for deploying Seraph to a Kubernetes cluster. This simplifies the process of running Seraph in a production environment.
