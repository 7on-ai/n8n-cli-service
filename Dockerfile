# Use Node 18 base image
FROM node:18

# Set working directory
WORKDIR /app

# Copy package files first
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all source code
COPY . .

# Expose port
EXPOSE 3000

# Start app
CMD ["npm", "start"]
