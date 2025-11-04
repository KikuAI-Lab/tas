from openai import AsyncOpenAI
from typing import Dict, Optional
from app.config import settings
import logging
import json

logger = logging.getLogger(__name__)


class LLMCheck:
    def __init__(self):
        self.enabled = bool(settings.openai_api_key)
        if self.enabled:
            self.client = AsyncOpenAI(api_key=settings.openai_api_key)
        else:
            self.client = None

    async def check(self, text: str) -> Optional[Dict[str, float]]:
        if not self.enabled or not self.client:
            return None

        try:
            prompt = f"""Analyze the following message for spam indicators. Consider:
- Job offers, work solicitations, vacancies
- Adult services, escort content
- Sales, promotions, discounts
- Cryptocurrency scams
- Illegal services
- Repetitive patterns
- Short spam phrases
- Context and language

Message: "{text[:2000]}"

Respond with JSON: {{"is_spam": boolean, "confidence": 0.0-1.0, "reasons": ["reason1", "reason2"]}}"""

            response = await self.client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {
                        "role": "system",
                        "content": "You are a spam detection expert. Analyze messages and return JSON with is_spam, confidence, and reasons.",
                    },
                    {"role": "user", "content": prompt},
                ],
                temperature=0.3,
                max_tokens=200,
            )

            content = response.choices[0].message.content
            if not content:
                return None

            json_start = content.find("{")
            json_end = content.rfind("}") + 1
            if json_start >= 0 and json_end > json_start:
                json_str = content[json_start:json_end]
                parsed = json.loads(json_str)
                
                return {
                    "spam": 1.0 if parsed.get("is_spam") else 0.0,
                    "confidence": max(0.0, min(1.0, parsed.get("confidence", 0.5))),
                    "reasons": parsed.get("reasons", []),
                }
            return None
        except Exception as e:
            logger.error(f"LLM check error: {e}")
            return None


llm_check = LLMCheck()

