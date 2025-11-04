# TAS (Transmodal Anti-Spam) - Development Plan

## Vision

Universal REST API for spam detection that combines multiple layers of protection:
1. **Fast Rules Layer** - Regex patterns (instant, free)
2. **ML Model Layer** - Lightweight transformer (fast, cheap)
3. **LLM Layer** - OpenAI GPT (slow, expensive, only when needed)

**Target**: RapidAPI marketplace as cost-effective spam detection service

## Architecture

### Multi-Layer Detection Flow

```
Text Input
  ↓
Fast Rules Check (regex patterns)
  ↓ (if confidence < 0.7)
ML Model Check (HuggingFace transformer)
  ↓ (if confidence < 0.8)
LLM Check (OpenAI GPT-4o-mini)
  ↓
Final Decision (spam_score, confidence, reasons)
```

### Key Features

- **Universal**: Works for messengers, bots, forums, any text input
- **Cost-effective**: LLM only when rules + ML can't decide
- **Fast**: Rules layer < 10ms, ML layer < 100ms
- **Accurate**: Multi-layer fusion for better precision
- **Configurable**: Customizable rules, thresholds, models

## Tasks

1. ✅ Refactor to universal REST API
   - Remove Telegram-specific code
   - Create FastAPI REST endpoints
   - Standard request/response format

2. ✅ Add lightweight ML model
   - Integrate HuggingFace transformer (multilingual-toxic-xlm-roberta)
   - Model loading and inference
   - Confidence scoring

3. ✅ Implement multi-layer detection
   - Fast rules check (regex patterns)
   - ML model check (transformer)
   - LLM check (OpenAI, fallback only)
   - Decision fusion logic

4. ✅ Create test suite
   - Load report.csv for validation
   - Accuracy metrics
   - Performance benchmarks

5. ✅ Build GitHub Pages demo
   - Interactive web interface
   - Real-time spam detection
   - Visualization of layers

6. ✅ Prepare GitHub repository
   - README with setup instructions
   - API documentation
   - Deployment guide
   - RapidAPI integration guide
   - GitHub Actions for CI/CD and Pages
