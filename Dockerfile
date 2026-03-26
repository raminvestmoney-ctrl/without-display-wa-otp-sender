FROM node:18-slim

# Install Python and dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy all files
COPY . .

# Install Node.js dependencies
WORKDIR /app/wa
RUN rm -rf node_modules package-lock.json
RUN npm install @whiskeysockets/baileys@^6.5.0 @hapi/boom@^10.0.1 express@^4.18.2 pino@^8.16.0 qrcode-terminal@^0.12.0 qrcode@^1.5.3

# Install Python dependencies
WORKDIR /app
RUN pip3 install --no-cache-dir flask requests --break-system-packages

# Expose ports
EXPOSE 5000 5001

# Start both services
CMD cd /app/wa && node whatsapp_bot.js & cd /app && python3 app.py
