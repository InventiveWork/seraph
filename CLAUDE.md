# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

### Build and Development
- `npm run build` - Compile TypeScript to JavaScript (output to `dist/`)
- `npm run dev` - Run the application in development mode with ts-node
- `npm start` - Run the compiled application from `dist/`

### Testing and Quality
- `npm test` - Run Jest tests with serial execution and open handle detection
- `npm run lint` - Run ESLint on TypeScript files

### Application Commands
The project provides a CLI tool `seraph` with the following commands:
- `seraph start` - Start the agent and log ingestion server
- `seraph status` - Check if the agent is running
- `seraph stop` - Stop the running agent
- `seraph chat <message>` - Chat with the agent (supports `--context`, `--mcp-server-url`, `--tools` flags)
- `seraph reports list` - List all investigation reports
- `seraph reports view <incidentId>` - View a specific report
- `seraph tools list` - List available built-in toolsets

## Architecture Overview

### Core Components
- **CLI Entry Point** (`src/index.ts`) - Commander.js-based CLI with process management via PID files
- **HTTP Server** (`src/server.ts`) - Handles log ingestion, metrics endpoint, and status checks with rate limiting and authentication
- **Agent Manager** (`src/agent-manager.ts`) - Manages worker threads for asynchronous log analysis
- **Configuration** (`src/config.ts`) - Centralized config management with environment variable fallbacks

### Key Features
- **Multi-LLM Support** - Pluggable providers (Gemini, Anthropic, OpenAI) in `src/llm/` directory
- **Model Context Protocol (MCP)** - Dynamic tool integration via MCP servers with built-in registry
- **Worker-based Processing** - Asynchronous log analysis using worker threads
- **Report Storage** - SQLite-based storage for investigation reports
- **Metrics Integration** - Prometheus metrics endpoint at `/metrics`

### Configuration
- Config file: `seraph.config.json` in project root
- Environment variables override config file settings
- API keys: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
- Server API key: `SERVER_API_KEY` for authentication

### Development Patterns
- TypeScript with strict mode enabled
- Jest for testing with serial test runner
- ESLint for code quality
- Commander.js for CLI structure
- Worker threads for CPU-intensive tasks
- SQLite for persistent storage