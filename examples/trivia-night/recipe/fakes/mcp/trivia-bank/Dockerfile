# The trivia bank as an eval sidecar. server.mjs is bundled from the example's
# lib/ by `pnpm bank:bundle`; seeds/ holds a bank state a case starts from.
FROM node:24-slim
WORKDIR /app
COPY server.mjs ./
COPY seeds ./seeds
EXPOSE 8000
CMD ["node", "server.mjs"]
