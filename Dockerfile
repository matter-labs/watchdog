FROM node:24.16.0-alpine AS builder

WORKDIR /app

COPY package.json yarn.lock ./

RUN yarn install --frozen-lockfile

COPY . .

RUN yarn build && yarn install --production --frozen-lockfile --prefer-offline

FROM node:24.16.0-alpine

# npm is unused at runtime (the service runs via yarn/node); its bundled
# node_modules carry scanner-flagged CVEs, so strip it from the final image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Create a non-root user with explicit UID/GID
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app
USER appuser

COPY --from=builder --chown=appuser:appgroup /app/package.json /app/yarn.lock ./
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist

EXPOSE 8080

ENTRYPOINT ["yarn", "start:prod"]
