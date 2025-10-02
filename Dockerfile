# Dockerfile (estable para Render)
FROM node:20-bookworm

# Toolchain + dependencias para node-canvas/pdfjs
RUN apt-get update && apt-get install -y \
  build-essential \
  python3 \
  pkg-config \
  libcairo2-dev \
  libpango1.0-dev \
  libjpeg-dev \
  libgif-dev \
  librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Solo package files para cache de dependencias
COPY package*.json ./

# Instalar deps (canvas se compila aquí)
RUN npm ci --omit=dev

# Copiar el resto
COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
