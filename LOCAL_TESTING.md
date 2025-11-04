# Local Testing Guide

## Quick Start

### 1. Start Local API

```bash
cd tas
poetry run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

API will be available at: `http://localhost:8000`

### 2. Test API Directly

**Health Check:**
```bash
curl http://localhost:8000/health
```

**Classify Text:**
```bash
curl -X POST http://localhost:8000/classify \
  -H "Content-Type: application/json" \
  -d '{"text": "Продам iPhone 12, недорого! Звоните +79001234567", "lang": "en"}'
```

### 3. Test with Demo

**Option A: Open Demo from Local Files**
1. Open `docs/index.html` directly in your browser
2. Demo will automatically try `http://localhost:8000`

**Option B: Use Local Server**
```bash
cd tas/docs
python3 -m http.server 8080
```
Then open: `http://localhost:8080`

### 4. Swagger Documentation

Open in browser: `http://localhost:8000/docs`

## Current Status

✅ **Local API is running** on port 8000
- Health endpoint: ✅ Working
- Classify endpoint: ✅ Working  
- All endpoints: ✅ Available

## Troubleshooting

**Port already in use:**
```bash
lsof -ti:8000 | xargs kill -9
```

**API not responding:**
- Check if uvicorn process is running: `ps aux | grep uvicorn`
- Check logs: `tail -f /tmp/tas-api-local.log`
- Restart: `pkill -f uvicorn && poetry run uvicorn app.main:app --port 8000`

**CORS errors:**
- CORS is already configured in `app/main.py`
- Make sure API is running on `0.0.0.0` not `127.0.0.1`

## Fly.io Deployment

For production deployment:

```bash
flyctl deploy -a tas
flyctl scale count 1 -a tas --yes
```

URL: `https://tas.fly.dev`

