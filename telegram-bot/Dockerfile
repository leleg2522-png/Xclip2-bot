FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

CMD ["node", "dist/index.js"]
