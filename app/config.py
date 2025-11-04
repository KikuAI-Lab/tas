from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    openai_api_key: str = ""
    model_name: str = "unitary/multilingual-toxic-xlm-roberta"
    
    rules_threshold: float = 0.6  # Optimized for better recall
    ml_threshold: float = 0.7  # Optimized for better recall
    llm_fallback: bool = True
    
    cache_size: int = 10000
    cache_ttl: int = 3600
    
    class Config:
        env_file = ".env"
        case_sensitive = False
        extra = "ignore"


settings = Settings()

