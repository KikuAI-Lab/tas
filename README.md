# TAS - Transmodal Anti-Spam API

**Transmodal commercial spam detection service** for messengers, forums, and marketplaces. Processes text, images, and other formats with unified scoring across detection layers.

> **Focus**: Commercial spam (buy/sell, job offers, services) - not toxicity or hate speech.

[![Demo](https://img.shields.io/badge/demo-live-green)](https://kiku-jw.github.io/tas/)
[![API](https://img.shields.io/badge/API-Fly.io-blue)](https://tas-api.fly.dev)
[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.104+-green.svg)](https://fastapi.tiangolo.com/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Cost-effective alternative to pure LLM-based spam detection** - 95%+ of requests avoid expensive LLM calls.

## Features

- **Multi-layer detection**: Rules → ML → LLM pipeline for accurate spam detection
- **Cost-effective**: LLM used only when rules + ML can't decide (95%+ requests avoid LLM)
- **Fast**: Rules layer < 10ms, ML layer < 100ms
- **Simple API**: One endpoint, simple response
- **Commercial Focus**: Specialized for buy/sell, job offers, services

## What TAS Detects

✅ **Commercial spam:**
- Buy/sell offers
- Job offers and work solicitations
- Service offers (repair, tutoring, etc.)
- Real estate (rent, sale)
- Car sales
- Promotions and discounts

❌ **TAS does NOT detect:**
- Toxicity or hate speech
- Insults or offensive language
- Political content
- Personal conflicts

## Architecture

```
Text Input
  ↓
Fast Rules Check (regex patterns)
  ├─ Confidence ≥ 0.7 → Return immediately (free, instant)
  ↓ Confidence < 0.7
ML Model Check (HuggingFace transformer)
  ├─ Confidence ≥ 0.8 → Return (cheap, fast)
  ↓ Confidence < 0.8
LLM Check (OpenAI GPT-4o-mini, fallback only)
  └─ Final decision (expensive, but accurate)
```

**Cost Analysis:**
- Rules: Free (regex patterns)
- ML: ~$0.0001 per request
- LLM: ~$0.001 per request (only 5-10% of requests)

## Quick Start

### Installation

```bash
cd tas
poetry install
cp env.example .env
# Edit .env with your OpenAI API key (optional, LLM is fallback only)
```

### Run

```bash
poetry run uvicorn app.main:app --reload
```

API will be available at `http://localhost:8000`

### API Usage

```bash
curl -X POST http://localhost:8000/classify \
  -H "Content-Type: application/json" \
  -d '{"text": "Earn money from home! Click here https://...", "lang": "en"}'
```

### Response

```json
{
  "spam_score": 0.87,
  "confidence": 0.92,
  "labels": ["spam", "scam"],
  "category": "job_offer",
  "reasons": ["Contains URL", "Job offer or work solicitation"],
  "layers_used": ["rules", "ml"],
  "version": "1.0.1"
}
```

## Configuration

Environment variables (`.env`):

- `OPENAI_API_KEY` - OpenAI API key for LLM fallback (optional)

## Deployment

### Fly.io

```bash
flyctl deploy
```

API will be available at: `https://tas-api.fly.dev`

### Docker

```bash
docker build -t tas .
docker run -p 8000:8000 --env-file .env tas
```

### Demo

Live demo: https://kiku-jw.github.io/tas/

## License

MIT License - see [LICENSE](LICENSE) file for details.
