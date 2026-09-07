# Activity multi-stream design

## Scope

A Discord Activity room supports up to three simultaneous publishers. Each publisher occupies one server-assigned slot from 0 through 2. Each viewer may subscribe to only one slot at a time.

## Identity and presentation

The relay obtains the publisher's display name from the authenticated Discord `/users/@me` response and embeds the sanitized, length-limited name in the signed session token. The server ignores publisher-supplied slot and name values when broadcasting stream metadata. The Activity builds labels with `textContent`.

## Relay behavior

Rooms store publishers in a map rather than a single field. The relay allocates the lowest free slot and rejects a fourth publisher. A `watch` operation clears the viewer's previous subscription before selecting the requested slot. Existing stream metadata is sent to viewers that join after transmission starts. Publisher disconnects emit a `stop` event.

## Client behavior

The external broadcaster waits for the relay's `joined` control message and uses its assigned slot in media packets. The viewer maintains a list of up to three active streams showing publisher name, dimensions, and frame rate. Selecting another stream sends `unwatch` for the old slot, configures the player for the new stream, and sends `watch` for the new slot.

## Verification

Registry tests cover the three-publisher limit, distinct slots, single-stream viewing, viewer limits, and room cleanup. Existing relay, protocol, media, UI, build, and smoke checks must continue passing.
