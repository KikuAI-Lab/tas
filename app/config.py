from pydantic_settings import BaseSettings
from pydantic import ConfigDict


class Settings(BaseSettings):
    # Prefer PATAS_OPENAI_API_KEY if provided; fallback to OPENAI_API_KEY
    patas_openai_api_key: str = ""
    openai_api_key: str = ""
    patas_url: str = "http://localhost:8000"
    patas_api_key: str = ""
    
    rules_threshold: float = 0.65
    decision_threshold: float = 0.35
    llm_fallback: bool = True
    
    cache_size: int = 10000
    cache_ttl: int = 3600
    llm_cache_size: int = 5000
    llm_cache_ttl: int = 86400
    
    enable_rrs: bool = True
    enable_lur: bool = True
    enable_sig: bool = True
    enable_rol: bool = False
    enable_qzn: bool = False
    
    model_config = ConfigDict(
        env_file=".env",
        case_sensitive=False,
        extra="ignore"
    )


settings = Settings()

