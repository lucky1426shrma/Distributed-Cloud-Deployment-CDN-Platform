FROM node:20-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package*.json ./
COPY node_modules ./node_modules
COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]
