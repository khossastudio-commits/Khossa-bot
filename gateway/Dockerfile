FROM node:20-alpine
WORKDIR /app
COPY index.js ./index.js
COPY purge_once.js ./purge_once.js
ENV NODE_ENV=production
CMD ["node","index.js"]
