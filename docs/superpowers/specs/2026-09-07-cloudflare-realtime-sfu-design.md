# Cloudflare Realtime SFU media design

## Goal

Move live audio/video from per-frame Durable Object WebSocket relay to native WebRTC tracks forwarded by Cloudflare Realtime SFU. Keep the existing authenticated room, presence, cards, thumbnails, and WebCodecs relay as an automatic compatibility fallback.

## Security boundary

Discord OAuth continues to issue short-lived HMAC room tokens. The Cloudflare Realtime App Secret remains server-side. Browser calls target authenticated origin proxy endpoints; they never receive the App Secret.

A publisher may create an SFU session and publish local tracks. The origin signs the returned SFU session and track identifiers into a short-lived media capability. A viewer may subscribe only when both its room token and the media capability identify the same room. The proxy builds remote-track requests itself rather than accepting arbitrary Cloudflare track identifiers.

## Publisher flow

1. Capture a native `MediaStream` in the external Chrome page.
2. Create one SFU session and `RTCPeerConnection`.
3. Add video and optional audio as send-only transceivers.
4. Apply the selected bitrate and frame-rate ceiling to the video sender.
5. Publish tracks through the authenticated origin proxy.
6. Announce the signed media capability through the existing room control socket.
7. Keep the WebCodecs encoder warm but prevent binary packets from entering the Durable Object unless a viewer explicitly requests fallback.

If SFU setup fails, enable WebCodecs relay immediately. If an individual viewer cannot subscribe to SFU, it sends a targeted fallback request; the publisher enables binary relay and forces a keyframe for that viewer.

## Viewer flow

A viewer creates a fresh receive-only SFU session for the selected stream, subscribes to the capability's tracks, completes renegotiation, and attaches the resulting native audio/video tracks to the existing video surface. Switching or returning closes the PeerConnection and clears the media element, maintaining one watched stream.

If SFU connection or first-frame delivery times out, the viewer transparently requests relay fallback and uses the existing WebCodecs player. The UI reports whether playback is using Cloudflare SFU or compatibility relay.

## Cost controls

Native media uses the shared Cloudflare Realtime free allocation. Durable Object traffic is reduced to connection, presence, metadata, thumbnail, and exceptional compatibility relay messages. Default quality remains 720p/30. No Realtime credentials are exposed to clients.

## Rollout

SFU is feature-detected from backend configuration. Deploying code without SFU credentials preserves current relay behavior. Once credentials are installed, new broadcasts prefer SFU while runtime fallback preserves availability.
