# Waku Configuration Guide

## Environment Variables

See `.env-example` in this directory, copy to `.env` & fill out.

## Bootstrap Nwaku node & Caddy reverse proxy

`docker-compose up -d`

## Finding Your Node's Peer ID

When you start your nwaku node with docker, the Peer ID is truncated in the logs, so instead make a request its the REST API info endpoint:

`curl "https://${WAKU_API_DOMAIN}/debug/v1/info"


## Running a Local Nwaku Node

More information about configuration and setup in the [nwaku documentation](https://docs.waku.org/guides/nwaku/run-nwaku/).
