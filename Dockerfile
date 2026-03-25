FROM node:18-slim

# Install Python
RUN apt-get update && apt-get install -y python3 python3-pip

# Set working directory
WORKDIR /app

# Copy all files
COPY . .

# Install Node.js dependencies
WORKDIR /app/wa
RUN npm install

# Install Python dependencies
WORKDIR /app
RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages

# Expose ports
EXPOSE 5000 5001

# Start both services
CMD cd /app/wa && node whatsapp_bot.js & cd /app && python3 app.py