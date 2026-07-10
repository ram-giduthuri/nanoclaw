# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

RUN npm ci \
    && sed -i "s#/rest/api/3/search'#/rest/api/3/search/jql'#g" node_modules/mcp-atlassian/dist/jira/handlers.js \
    && grep -c "/rest/api/3/search/jql'" node_modules/mcp-atlassian/dist/jira/handlers.js

# Copy source code
COPY agent-runner/ ./

# Build TypeScript, create workspace directories, and write entrypoint script.
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN npm run build \
    && mkdir -p \
       /workspace/group \
       /workspace/global \
       /workspace/extra \
       /workspace/ipc/messages \
       /workspace/ipc/tasks \
       /workspace/ipc/input \
    && printf '%s\n' \
    '#!/bin/bash' \
    'set -e' \
    'cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2' \
    'ln -s /app/node_modules /tmp/dist/node_modules' \
    'chmod -R a-w /tmp/dist' \
    'cat > /tmp/input.json' \
    'node /tmp/dist/index.js < /tmp/input.json' \
    > /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh \
    && chown -R node:node /workspace \
    && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
