# Performance & Optimization Guide

## Current Performance Metrics

### Test Results (report.csv, 454 samples)

**Patterns-Only Test:**
- Accuracy: 32.60%
- Precision: 91.67%
- Recall: 9.82%
- F1 Score: 17.74%

**Full Pipeline Test (with thresholds optimization):**
- Best F1: 40.17% (rules=0.5, ml=0.6)
- Current: Precision 94%, Recall 14% (rules=0.6, ml=0.7)
- Balanced: Precision 67.61%, Recall 28.57% (rules=0.5, ml=0.6)

### Layer Usage Distribution

From test results:
- **Rules only**: ~60-70% of requests
- **ML layer**: ~20-30% of requests
- **LLM layer**: ~5-10% of requests (fallback only)

### Cost Analysis

**Per Request:**
- Rules: Free (regex patterns, < 10ms)
- ML: ~$0.0001 (HuggingFace model, < 100ms)
- LLM: ~$0.001 (OpenAI GPT-4o-mini, < 1000ms)

**Average Cost:**
- 70% rules-only: $0.000
- 25% with ML: $0.0001
- 5% with LLM: $0.001
- **Weighted average**: ~$0.00005 per request

**vs Pure LLM:**
- Pure LLM: $0.001 per request
- TAS: $0.00005 per request
- **Savings**: 95% cost reduction

## Optimization Strategies

### 1. Threshold Tuning

**Current Settings:**
```python
RULES_THRESHOLD=0.55
ML_THRESHOLD=0.65
```

**Trade-offs:**
- Lower thresholds → Higher recall, lower precision
- Higher thresholds → Higher precision, lower recall

**Recommendations:**
- For maximum precision: rules=0.7, ml=0.8
- For maximum recall: rules=0.5, ml=0.6
- For balanced: rules=0.55, ml=0.65 (current)

### 2. Pattern Optimization

**High-performing patterns:**
- Contains phone number: 137 matches, avg_score=0.50
- Commercial trade offer: 70 matches, avg_score=0.54
- Job offer or work solicitation: 45 matches, avg_score=0.54

**Pattern boosts:**
- Multiple commercial indicators: +0.35 score
- Commercial + contact info: +0.25 score

### 3. Caching Strategy

**Current:**
- No caching implemented

**Recommended:**
- Cache identical text requests (LRU cache)
- Cache frequent patterns
- TTL: 1 hour for spam, 24 hours for non-spam

**Expected improvement:**
- 30-50% reduction in ML/LLM calls
- 40-60% faster response for cached requests

### 4. Batch Processing

**Current:**
- Sequential processing

**Recommended:**
- Parallel processing for batch requests
- Batch size optimization (100 requests max)

**Expected improvement:**
- 3-5x faster for batch requests

## Performance Goals

### Phase 1 (Current)
- ✅ Rules layer: < 10ms
- ✅ ML layer: < 100ms
- ✅ LLM layer: < 1000ms
- ✅ Average: < 50ms (rules + ML)

### Phase 2 (Target)
- [ ] Rules layer: < 5ms (with caching)
- [ ] ML layer: < 50ms (optimized model)
- [ ] LLM layer: < 500ms (optimized prompts)
- [ ] Average: < 30ms (with caching)

## Monitoring

### Key Metrics to Track

1. **Response Time**
   - P50 (median)
   - P95
   - P99

2. **Layer Usage**
   - Rules-only percentage
   - ML usage percentage
   - LLM usage percentage

3. **Accuracy Metrics**
   - Precision
   - Recall
   - F1 Score
   - False positive rate

4. **Cost Metrics**
   - Average cost per request
   - Total cost per day/month
   - Cost per layer

### Recommended Tools

- **APM**: Sentry, DataDog, or similar
- **Logging**: Structured logging with request IDs
- **Metrics**: Prometheus + Grafana
- **Alerts**: Threshold-based alerts for errors, latency spikes

## Optimization Checklist

- [x] Optimize thresholds
- [x] Add pattern boosts
- [ ] Implement caching
- [ ] Optimize ML model loading
- [ ] Add request batching
- [ ] Implement rate limiting
- [ ] Add monitoring and metrics
- [ ] Set up performance alerts

