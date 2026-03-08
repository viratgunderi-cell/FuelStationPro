FROM node:20-slim

# Create non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser appuser

WORKDIR /app

# Copy package files first for better layer caching
# BOTH files must be present before npm ci runs — npm ci reads package-lock.json
COPY package.json package-lock.json ./

# Use npm ci for reproducible builds — respects package-lock.json exactly.
RUN npm cache clean --force && \
    npm ci --production --no-audit --no-fund

# Copy application files
COPY . .

# Create data dir (for any local file needs) and set permissions
RUN mkdir -p /app/data && chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Environment
ENV NODE_ENV=production
# PORT is injected by Railway automatically — don't hardcode it
# Fallback to 3000 for local development only
ENV PORT=3000

EXPOSE 3000

# Health check — uses $PORT via node process.env.PORT
HEALTHCHECK --interval=30s --timeout=15s --start-period=60s --retries=5 \
  CMD node -e "const p=process.env.PORT||3000; require('http').get('http://localhost:'+p+'/api/health', r => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
