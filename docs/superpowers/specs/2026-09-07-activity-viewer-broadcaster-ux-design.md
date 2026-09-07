# Activity viewer and broadcaster UX design

## Discord Activity

The Activity is a focused viewing surface. Its only global action is “Transmitir minha tela”. Active broadcasts appear as responsive visual cards with a 16:9 thumbnail, trusted Discord avatar and display name, live badge, resolution, frame rate, audio availability, and one explicit action.

Selecting a card starts that stream and changes its action to “Parar de assistir”. Clicking it again unsubscribes, closes video/audio decoders, clears the stage, and restores the empty prompt. Selecting another card switches atomically so a viewer never consumes two relay streams.

## External broadcaster

The browser page owns capture controls: source selection, quality, system audio, live preview, codec, target bitrate, detected audio format, and a prominent stop action. Errors state the browser-provided reason instead of a generic failure. A BroadcastChannel ensures a newly opened broadcaster replaces an existing broadcaster tab from the same browser profile.

## Media compatibility

Video encoding probes browser support before configuration, trying H.264 profiles and then VP8. Capture resize constraints are advisory so Chrome tabs and windows that reject strict dimensions still work. Output is capped to the chosen profile by the encoder.

Audio uses the captured track's actual sample rate and channel count. That configuration travels in trusted stream metadata and configures the viewer's Opus decoder. The UI explicitly reports whether audio was captured.

## Thumbnails and identity

The broadcaster emits a low-quality 320×180 JPEG thumbnail every three seconds. The relay validates its type and size, associates it with the server-assigned slot, and forwards it as control metadata. The backend derives avatar and name from Discord OAuth; clients cannot choose another user's presentation identity.
