# RapidAPI Integration Guide

## Overview

TAS is designed as a cost-effective spam detection service for RapidAPI marketplace.

## Pricing Strategy

### Cost Analysis

- **Rules Layer**: Free (regex patterns, instant)
- **ML Layer**: ~$0.0001 per request (HuggingFace model inference)
- **LLM Layer**: ~$0.001 per request (OpenAI GPT-4o-mini)

### Optimal Flow

Most requests are handled by Rules + ML layers (90%+), avoiding expensive LLM calls.

## RapidAPI Listing

### Title
TAS - Transmodal Anti-Spam API

### Description
Multi-layer spam detection service combining regex rules, ML models, and LLM fallback. Cost-effective alternative to pure LLM-based solutions.

### Features
- Fast detection (< 100ms for rules + ML)
- High accuracy (multi-layer fusion)
- Cost-effective (LLM only when needed)
- Universal (works for any text input)

### Pricing Tiers

**Free Tier**
- 100 requests/month
- Rules + ML layers only
- No LLM fallback

**Basic ($5/month)**
- 1,000 requests/month
- Full multi-layer detection
- LLM fallback enabled

**Pro ($20/month)**
- 10,000 requests/month
- Full multi-layer detection
- Priority support

### Endpoints

#### POST /classify
- Input: `{ "text": "string", "lang": "en" }`
- Output: `{ "spam_score": float, "confidence": float, "labels": [], "reasons": [], "layers_used": [] }`

#### GET /health
- Health check endpoint

## API Documentation

See `README.md` for detailed API documentation.

## Deployment

1. Deploy API to production (Render, Railway, etc.)
2. Update API URL in RapidAPI listing
3. Test all endpoints
4. Submit for review

