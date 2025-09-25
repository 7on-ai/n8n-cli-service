# Use Node 18 base image
FROM node:18-alpine

# Install system dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    sqlite \
    curl

# Set working directory
WORKDIR /app

# Copy package files first
COPY package*.json ./

# Install dependencies
RUN npm install

# Install n8n globally AFTER main dependencies
RUN npm install -g n8n@latest

# Verify n8n CLI is available
RUN n8n --help

# Copy all source code
COPY . .

# Create n8n user folder
RUN mkdir -p /tmp/.n8n && chmod 777 /tmp/.n8n

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start app
CMD ["npm", "start"]
