# Sử dụng hình ảnh Node.js chính thức làm nền tảng
FROM node:18-slim

# Cài đặt ffmpeg và ffprobe trực tiếp vào môi trường Linux container của Render
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Thiết lập thư mục làm việc bên trong container
WORKDIR /app

# Sao chép file khai báo phụ thuộc package.json và package-lock.json
COPY package*.json ./

# Cài đặt các gói phụ thuộc Node.js
RUN npm install

# Sao chép toàn bộ mã nguồn và thư mục (input, output, ...) vào container
COPY . .

# Mở cổng chạy ứng dụng (Render sẽ tự map port thông qua biến môi trường PORT)
EXPOSE 3000

# Lệnh khởi động ứng dụng
CMD ["node", "server.js"]