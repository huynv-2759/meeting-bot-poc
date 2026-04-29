FROM mcr.microsoft.com/playwright:v1.59.1-jammy
WORKDIR /app
COPY package*.json ./
RUN npm install
RUN npm install playwright playwright-extra puppeteer-extra-plugin-stealth ws prism-media opusscript
COPY index.js ./
COPY auth.json ./ 
CMD ["node", "index.js"]