FROM node:20-alpine

RUN apk add --no-cache git docker-cli

WORKDIR /app

COPY package*.json ./
COPY node_modules ./node_modules
COPY . .

CMD ["npm", "run", "dev"]
