ARG BUILD_FROM
FROM ${BUILD_FROM}

ENV LANG=C.UTF-8 \
    TZ=Europe/Berlin \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/

WORKDIR /

# Install system runtime requirements & python packages
RUN apk add --no-cache \
        curl \
        jq \
        tzdata

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app/ /app/
COPY run.sh /run.sh
RUN tr -d '\r' < /run.sh > /run.sh.tmp && mv /run.sh.tmp /run.sh && chmod a+x /run.sh

EXPOSE 8099

ENTRYPOINT []
CMD [ "/run.sh" ]
