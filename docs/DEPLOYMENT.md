# Deployment Guide

Seraph is designed for flexible deployment across various environments. Here are some common deployment strategies.

## Local Development

For local development, you can run the agent directly using `ts-node` or by building the project and running the output with `node`.

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/gemini/seraph-agent.git
    cd seraph-agent
    ```

2.  **Install dependencies**:
    ```bash
    npm install
    ```

3.  **Run in development mode**:
    ```bash
    npm run dev -- start
    ```

    This will run the agent using `ts-node`, with hot-reloading for any changes you make to the source code.

## On-Premise / Bare Metal Server

To deploy on a traditional server, you can run the agent as a `systemd` service to ensure it runs continuously and restarts on failure.

1.  **Install Node.js and npm** on your server.
2.  **Install the agent globally**:
    ```bash
    npm install -g seraph-agent
    ```
3.  **Create a configuration file** at `/etc/seraph/config.json`.
4.  **Create a systemd service file** at `/etc/systemd/system/seraph.service`:

    ```ini
    [Unit]
    Description=Seraph AI SRE Agent
    After=network.target

    [Service]
    Type=simple
    User=your_user
    WorkingDirectory=/home/your_user
    ExecStart=/usr/bin/seraph start
    Restart=on-failure

    [Install]
    WantedBy=multi-user.target
    ```

5.  **Enable and start the service**:
    ```bash
    sudo systemctl enable seraph
    sudo systemctl start seraph
    ```

## Cloud Environments (Containerized)

The recommended way to deploy Seraph in any cloud environment (AWS, GCP, Azure) is by using Docker containers.

1.  **Create a `Dockerfile`**:

    ```dockerfile
    FROM node:18-alpine

    WORKDIR /usr/src/app

    # Install the agent from npm
    RUN npm install -g seraph-agent

    # Copy your configuration
    COPY seraph.config.json .

    EXPOSE 8080

    CMD [ "seraph", "start" ]
    ```

2.  **Build the Docker image**:
    ```bash
    docker build -t seraph-agent:latest .
    ```

3.  **Run the container**:
    ```bash
    docker run -d -p 8080:8080 --name seraph-agent seraph-agent:latest
    ```

From here, you can push the image to a container registry (like Docker Hub, ECR, or GCR) and deploy it to any container orchestration service like Kubernetes, Amazon ECS, or Google Cloud Run.
