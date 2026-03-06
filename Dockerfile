FROM node:20-slim

# Create non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser appuser

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json ./

# Install production dependencies — no lock file to avoid EINTEGRITY errors
# Railway generates a fresh install each build from package.json only
RUN npm cache clean --force && \
    npm install --production --no-audit --no-fund --no-package-lock

# Copy application files
COPY . .

# Create data dir (for any local file needs) and set permissions
RUN mkdir -p /app/data && chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Health check so Railway/Docker knows when the app is ready
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', r => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
