FROM node:8-alpine

RUN apk add --update \
    python \
    build-base \
    libexecinfo-dev \
    && rm -rf /var/cache/apk/*

RUN apk add vips-dev fftw-dev --update-cache --repository https://dl-3.alpinelinux.org/alpine/edge/testing/

WORKDIR /fly

ADD . /fly

CMD ["node" "./fly"]