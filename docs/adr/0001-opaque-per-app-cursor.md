# Opaque per-App Cursor with server-side replay

A Connection resumes from a single opaque Cursor minted by the Transport (Redis: the stream entry ID; Memory: `<epoch>-<seq>`), not from a per-Channel sequence map or a timestamp. `Last-Event-ID` is one header value, a per-Channel map would grow with the Channel set, and a timestamp is not unique. The Cursor spans every Channel of the Connection because v0.1 buffers all of an App's Messages in one ordered log, yet the library only **promises** per-Channel ordering, so the buffer can later be sharded per Channel without changing the Cursor format.

Exactly-once at the reconnect boundary is the server's job: the Instance replays strictly after the Cursor and drops anything at or before the last ID it sent when the replay meets the live feed. The client stores `lastEventId` and never compares Cursors, which keeps the format private to the Transport.

## Considered Options

- Per-Channel sequences as the Cursor: rejected, the Cursor would have to travel as a structured value and could not ride in `Last-Event-ID`.
- Client-side dedup by comparing Cursors: rejected, it would make the Cursor format a public contract shared by every Transport.
- Promising global ordering across Channels: rejected, it would lock v0.1's single-log implementation in.
