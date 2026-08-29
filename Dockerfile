FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs queue.mjs ./
# queue/ is a Coolify persistent volume — it must NOT be baked into the image, or a redeploy in the
# middle of a pending command would drop it on the floor.
ENV QUEUE_DIR=/data/queue
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
