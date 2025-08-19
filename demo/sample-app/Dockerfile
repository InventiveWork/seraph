
# Use a lightweight Node.js image
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A simple app doesn't need a package.json, but we'll create a dummy one
RUN echo '{ "dependencies": { "express": "4.17.1" } }' > package.json
RUN npm install

# Bundle app source
COPY index.js ./

EXPOSE 3000
CMD [ "node", "index.js" ]
