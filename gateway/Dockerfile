FROM node:20-alpine
WORKDIR /app
COPY gateway/package.json ./package.json
RUN npm install --omit=dev
COPY gateway/index.js ./index.js
ENV NODE_ENV=production
CMD ["npm","start"]
