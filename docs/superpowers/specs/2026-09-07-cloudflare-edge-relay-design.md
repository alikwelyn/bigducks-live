# Cloudflare edge relay design

## Goal

Move Activity media and signaling WebSockets from the German VPS to a Cloudflare Durable Object placed near the room's participants, while retaining the VPS for Discord OAuth, static assets, session issuance, and emergency relay fallback.

## Architecture

The existing Node service continues issuing short-lived HMAC session tokens. A Worker route at `stream.skillup.com.br/edge/*` validates the same token with a Worker secret and forwards the WebSocket upgrade to one Durable Object selected by the signed room ID. The first participant creates the room object near their Cloudflare edge; all publishers and viewers in that call connect to the same object.

The Durable Object implements the existing control and binary media protocol without decoding media. It assigns up to three publisher slots, permits up to 25 viewers, keeps one watched slot per viewer, forwards keyframe requests, attaches trusted Discord display names, and applies backpressure before forwarding binary frames.

## Security

The Worker receives `SESSION_SECRET` through Wrangler secrets. Room, role, user, and name are accepted only from a valid, unexpired HMAC token. The Worker overwrites client-supplied slot and name fields. Media sockets cannot create arbitrary rooms without a token issued by the VPS.

## Reliability

Clients try `/edge/ws` first. If the edge socket cannot open, they retry the existing `/ws` endpoint on the VPS. Existing P2P negotiation remains opportunistic above either relay. Durable Object WebSocket attachments retain connection metadata across hibernation.

## Deployment

Wrangler deploys one Worker and SQLite Durable Object migration, with a zone route for `stream.skillup.com.br/edge/*`. The existing root/domain route continues to reach Dokploy. A smoke script verifies health, rejection of invalid tokens, publisher/viewer connection, control forwarding, and binary forwarding.
