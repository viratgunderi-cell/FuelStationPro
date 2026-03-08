FROM node:20-slim

# Create non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser appuser

WORKDIR /app

# Copy only package.json — no lock file (avoids EINTEGRITY checksum failures
# caused by stale/corrupted package-lock.json checksums on Railway builders).
COPY package.json ./

# Install production dependencies fresh every build
RUN npm install --omit=dev --no-audit --no-fund

# Copy application files
COPY . .

# Create data dir and set permissions
RUN mkdir -p /app/data && chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=15s --start-period=60s --retries=5 \
  CMD node -e "const p=process.env.PORT||3000; require('http').get('http://localhost:'+p+'/api/health', r => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
