FROM node:20.18.1-alpine

# Create a non-root user with explicit UID/GID
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app
RUN chown appuser:appgroup /app
USER appuser

# Copy package files
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install --frozen-lockfile

# Copy application files
COPY . .

EXPOSE 8080

ENTRYPOINT ["yarn", "start"]
