FROM node:latest AS base
WORKDIR /app
COPY package.json .
COPY yarn.lock .
RUN yarn install --no-progress --prod
RUN cp -R node_modules prod_node_modules
RUN yarn install --no-progress
RUN yarn
COPY . .
RUN yarn build

FROM node:latest
WORKDIR /app
COPY package.json .
COPY --from=base /app/prod_node_modules ./node_modules
COPY --from=base /app/lib ./lib
ENV neuron-app_port 3000
ENV NODE_ENV production
CMD ["yarn", "start"]
