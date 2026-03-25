from flask import Flask, request, jsonify
import requests
import time
import logging
import hashlib
import os
import re
from datetime import datetime

# WhatsApp bot URL (both services run in same container)
WA_BOT_URL = os.environ.get("WA_BOT_URL", "http://127.0.0.1:5001/send_code")
SMS_FILTER_SENDER = "3737"

app = Flask(__name__)

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN")
CHAT_ID = os.environ.get("CHAT_ID")
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

recent_messages = {}

def is_duplicate(sender, content):
    msg_hash = hashlib.md5(f"{sender}{content}".encode()).hexdigest()
    current_time = time.time()
    
    if msg_hash in recent_messages:
        if current_time - recent_messages[msg_hash] < 60:
            return True
            
    recent_messages[msg_hash] = current_time
    expired = [k for k, v in recent_messages.items() if current_time - v > 300]
    for k in expired:
        del recent_messages[k]
    return False

def send_telegram(message, retries=3):
    for attempt in range(retries):
        try:
            response = requests.post(TELEGRAM_API, data={
                'chat_id': CHAT_ID,
                'text': message,
                'parse_mode': 'HTML',
                'disable_web_page_preview': True
            }, timeout=10)
            
            if response.status_code == 200:
                logger.info("✅ Telegram sent!")
                return True
            else:
                logger.warning(f"⚠️ Telegram error: {response.text}")
                
        except Exception as e:
            logger.error(f"❌ Error: {e}")
        
        time.sleep(2)
    return False

@app.route('/sms', methods=['POST', 'GET'])
def receive_sms():
    try:
        sender = request.args.get('sender') or 'Unknown'
        receiver = request.args.get('receiver') or 'Unknown'
        port = request.args.get('port') or 'N/A'
        
        raw_data = request.get_data(as_text=True)
        content = "Empty Message"
        
        if '\n\n' in raw_data:
            parts = raw_data.split('\n\n')
            if len(parts) > 1:
                content = parts[1].strip()
        else:
            lines = raw_data.strip().split('\n')
            if lines:
                content = lines[-1].strip()

        if "Sender:" in content or "SMSC:" in content:
             content = raw_data
        
        logger.info(f"📩 SMS from {sender}: {content[:50]}...")
        
        if sender != SMS_FILTER_SENDER:
            logger.info(f"⏭️ Ignored SMS from {sender}")
            return jsonify({"status": "ignored"}), 200

        if is_duplicate(sender, content):
            logger.info(f"⏳ Duplicate message - Skipping.")
            return jsonify({"status": "duplicate"}), 200

        # Extract 6-digit code
        code_match = re.search(r'\b(\d{6})\b', content)
        
        if code_match:
            code = code_match.group(1)
            logger.info(f"🎯 CODE DETECTED: {code}")
            
            # Send to WhatsApp bot (Node.js)
            try:
                wa_resp = requests.post(
                    WA_BOT_URL, 
                    json={"code": code, "message": content}, 
                    timeout=8
                )
                logger.info(f"🚀 WhatsApp bot response: {wa_resp.status_code}")
            except Exception as wa_err:
                logger.error(f"❌ WhatsApp bot unreachable: {wa_err}")
        else:
            logger.warning(f"🤔 No 6-digit code found")
        
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        
        # Send to Telegram
        message = (
            f"📩 <b>New SMS</b>\n"
            f"━━━━━━━━━━━━━━━━\n"
            f"📱 From: <code>{sender}</code>\n"
            f"📲 To: <code>{receiver}</code>\n"
            f"🕐 {timestamp}\n"
            f"━━━━━━━━━━━━━━━━\n"
            f"💬 <code>{content}</code>"
        )
        
        send_telegram(message)
        return jsonify({"status": "success"}), 200
            
    except Exception as e:
        logger.error(f"❌ ERROR: {e}")
        return jsonify({"status": "error"}), 500

@app.route('/', methods=['GET'])
def status():
    return "<h1>🟢 SMS to WhatsApp Bridge Running</h1>"

@app.route('/test', methods=['GET'])
def test():
    send_telegram("🧪 Test - Bridge is working!")
    
    try:
        wa_test = requests.post(WA_BOT_URL, json={"code": "123456", "message": "Test"}, timeout=5)
        logger.info(f"WhatsApp test: {wa_test.status_code}")
    except Exception as e:
        logger.warning(f"⚠️ WhatsApp test failed: {e}")
        
    return "OK - Check Telegram & WhatsApp", 200

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port)