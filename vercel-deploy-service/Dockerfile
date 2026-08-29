FROM node:20-alpine

RUN apk add --no-cache git docker-cli

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 3002

CMD ["npm", "start"]
