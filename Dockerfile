FROM node:18-slim

# Install Python and build tools
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy all files
COPY . .

# Install Node.js dependencies (Force clean install)
WORKDIR /app/wa
RUN npm install --omit=dev --legacy-peer-deps

# Setup Python Environment
WORKDIR /app
# Create virtual environment to avoid system package conflicts
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install Python dependencies
RUN pip3 install --no-cache-dir -r requirements.txt

# Expose ports
EXPOSE 5000 5001

# Start both services
CMD sh -c "cd /app/wa && node whatsapp_bot.js & cd /app && python3 app.py"
