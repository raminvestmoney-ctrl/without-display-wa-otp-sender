FROM node:18-slim

# Install Python + Build Tools + GIT (Yeh missing tha!)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    git \          # ✅ Yeh add karo!
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

WORKDIR /app/wa
RUN rm -rf node_modules package-lock.json
RUN npm install @whiskeysockets/baileys@^6.5.0 @hapi/boom@^10.0.1 express@^4.18.2 pino@^8.16.0 qrcode-terminal@^0.12.0

WORKDIR /app
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip3 install --no-cache-dir flask requests

EXPOSE 5000 5001

CMD sh -c "cd /app/wa && node whatsapp_bot.js & cd /app && python3 app.py"
