FROM node:20.11.0

EXPOSE 3000

ENV DOCKER_MODE=true

WORKDIR /app

COPY package*.json ./

RUN npm install
# RUN npm ci --only=production

COPY . .

WORKDIR /app

COPY ./package*.json ./

CMD [ "npm", "run", "start" ]
