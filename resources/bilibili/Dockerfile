FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY --chmod=644 server.py media.py .
USER 1000:1000
CMD ["python", "server.py"]
