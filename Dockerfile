# ใช้ Node 18 เป็น base image
FROM node:18

# กำหนด working directory
WORKDIR /app

# copy package.json ก่อน
COPY package*.json ./

# install dependencies
RUN npm install

# copy source code
COPY . .

# expose port
EXPOSE 3000

# start app
CMD ["npm", "start"]
