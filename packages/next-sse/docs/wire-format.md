# Wire format

The envelope this library stores in its log is a **stable versioned contract**. Any service, in
any language, can publish into an App — or revoke somebody's Connections — by writing it directly.

## The envelope

One JSON object per log Entry.

```json
{ "v": 1, "type": "message", "channel": "chat:42", "event": "message", "payload": {} }
{ "v": 1, "type": "control", "control": "kick", "key": "user-7" }
{ "v": 1, "type": "control", "control": "kick", "channel": "chat:42" }
```

| Field     | Message                                | Control                            |
| --------- | -------------------------------------- | ---------------------------------- |
| `v`       | `1` — the envelope version             | `1`                                |
| `type`    | `"message"`                            | `"control"`                        |
| `channel` | the Channel **name**, params filled in | the Channel to Kick, if by Channel |
| `event`   | the event name the Channel declares    | —                                  |
| `payload` | anything JSON can carry                | —                                  |
| `control` | —                                      | `"kick"`                           |
| `key`     | —                                      | the Key to Kick, if by Key         |

**Compatibility**: additions within `v: 1` are additive, and a reader ignores what it does not
know. A breaking change would be `v: 2`. An Entry that cannot be parsed, or whose version or kind
is unknown, is skipped and reported once — never delivered.

## Writing it to Redis or Valkey

One `XADD` per Entry, into the App's stream.

```sh
redis-cli XADD '{next-sse}:log' MAXLEN '~' 10000 '*' entry \
  '{"v":1,"type":"message","channel":"announcements","event":"posted","payload":{"id":"a1","text":"we shipped"}}'
```

- **The key is `{<Prefix>}:log`**, braces included. The Prefix sits inside the hash tag, so every
  key an App owns lands in one cluster slot — and the Prefix is the only thing keeping two Apps on
  one server apart. It defaults to `next-sse`; use whatever the App's `NEXT_SSE_PREFIX` says.
- **One field, `entry`**, holding the envelope as JSON.
- **`MAXLEN ~ <cap>` rides on the write.** The Instances trim regardless; a publisher that omits
  it lets the log grow between their trims. The default cap is 10 000.
- The Cursor is the entry id `XADD` returns. Nothing outside a Transport reads one.

In Node, with the library available, `createPublisher<typeof sse>` writes this for you and type-checks
the Channel, the event and the payload against the App's Registry — see
[transport.md](transport.md).

## What an external publisher owes

Nothing validates the payload on the way in or on the way out: the Registry is not present in the
publishing process, and the read path deliberately delivers what it finds. **What you write is
what the client's typed hook hands its component.** So:

- the `channel` must be a name one of the App's patterns produces (`chat:42`, not `chat:{roomId}`);
- the `event` must be one that Channel declares;
- the `payload` must match that event's schema **Output** — the shape after validation, which is
  what the App's client types promise.

An Entry for a Channel nobody is subscribed to is dropped for free. That is normal during a
rolling deploy, and it is logged only under `NEXT_SSE_DEBUG`.

## Kicking from outside

Publishing a control entry is how a service with no Next.js revokes access:

```sh
redis-cli XADD '{next-sse}:log' MAXLEN '~' 10000 '*' entry \
  '{"v":1,"type":"control","control":"kick","key":"user-7"}'
```

Every Instance reads it, ends the Connections it names with `reconnect`, and those clients come
back and go through Authorize again. Delivery is at-least-once and live-only: a replay skips
control entries, because replaying a Kick would drop a Connection the fresh Authorize just let
back in.

## The Memory Transport

It stores the very same object. There is nothing to write into it from outside — it lives in one
process — but a custom Transport should round-trip the envelope through JSON the same way.

## The browser-facing stream

This is what a Connection looks like on the wire. It is described here for debugging with `curl`;
the contract external publishers write against is the envelope above.

```
event: ready
data: {"cursor":"1730000000000-0","refused":[],"heartbeat":15000}

retry: 3000

id: 1730000000001-0
data: {"channel":"chat:42","event":"message","payload":{"id":"m1","text":"hello"}}

event: caught-up
data: {}

event: heartbeat
data: {}
```

- **A Message is the unnamed block.** Its `id:` is the Cursor, which the browser echoes back in
  `Last-Event-ID` on a reconnect; its data carries the Channel, the event name and the payload.
  A declared event name never reaches the `event:` field, so an App may declare an event called
  `heartbeat` without it posing as a Control event.
- **Control events are the named blocks** — `ready`, `heartbeat`, `reconnect`, `caught-up`,
  `reset` — and they carry no `id:`: they are not positions in the log.
- `ready` opens every stream with the position this Connection resumes from, the refused Channels
  and the heartbeat interval. `reset` names the position the Connection continues from after its
  Cursor turned out to be unusable.
- The request is `GET /api/sse?channel=<name>&channel=<name>&cursor=<cursor>`. Before anything is
  written, the handler may answer `400` (no Channel named) or `503` with `Retry-After` (Transport
  unreachable, or the Instance is draining). Everything after the headers is a `200`.

```sh
curl -N 'http://localhost:3000/api/sse?channel=announcements'
```
