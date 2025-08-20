# Use an official Node.js runtime as a parent image
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install app dependencies
RUN npm install

# Install git, kubectl and create a demo repository for the built-in MCP server
RUN apk add --no-cache git curl && \
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then ARCH="amd64"; elif [ "$ARCH" = "aarch64" ]; then ARCH="arm64"; fi && \
    curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/${ARCH}/kubectl" && \
    chmod +x kubectl && \
    mv kubectl /usr/local/bin/ && \
    git config --global user.email "demo@seraph.ai" && \
    git config --global user.name "Seraph Demo" && \
    git init /usr/src/app/demo-repo && \
    cd /usr/src/app/demo-repo && \
    echo "Initial content" > README.md && \
    git add README.md && \
    git commit -m "Initial commit for demo"

# Copy app source
COPY . .

# Build the app
RUN npm run build

# Make the CLI executable and create a symlink
RUN chmod +x /usr/src/app/dist/index.js
RUN ln -s /usr/src/app/dist/index.js /usr/local/bin/seraph

# Expose the port the app runs on
EXPOSE 8080

# Define the command to run the app
CMD [ "node", "dist/index.js", "start" ]
