# Render / any container host. The code sandbox needs a Docker daemon, which hosted containers
# don't have; sandbox.available() turns it off and developer teammates skip running code.
FROM python:3.14-slim
WORKDIR /srv
ENV PYTHONUNBUFFERED=1 FASTEMBED_CACHE_PATH=/srv/.fastembed
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Bake the embedding model in, so a cold start doesn't download it.
RUN python -c "from fastembed import TextEmbedding; TextEmbedding('BAAI/bge-small-en-v1.5')"
COPY . .
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8787}"]
