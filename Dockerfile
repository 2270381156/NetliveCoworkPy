FROM python:3.11-slim

WORKDIR /app

COPY pyproject.toml .
COPY src/ src/

RUN pip install --no-cache-dir -e ".[host,llm]"

EXPOSE 8000

CMD ["loomem-host", "serve", "--port", "8000"]
