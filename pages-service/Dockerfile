FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "server.js"]
