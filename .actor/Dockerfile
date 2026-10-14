FROM apify/actor-node-playwright-chrome:20
WORKDIR /home/myuser
COPY --chown=myuser:myuser package.json ./
RUN npm install --omit=dev --omit=optional
COPY --chown=myuser:myuser . ./
CMD node main.js
