FROM docker.io/library/node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 7353
CMD ["node_modules/.bin/eval-simulate", "serve"]
