from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    llm_api_base_url: str = Field("http://host.docker.internal:8000/v1")
    llm_api_key: str = ""
    database_url: str = "data/workflows.db"
    project_root: str = "data/project"
    debug: bool = False


settings = Settings()
