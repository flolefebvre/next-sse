# When not to use SSE

SSE is a one-way pipe from server to client, over ordinary HTTP, carrying text. That shape is a
good fit for live updates and a poor fit for several things people reach for it anyway. Each case
below names what to use instead.

## The client needs to send on the same connection

SSE has no upstream channel at all. This library's clients talk back through ordinary server
actions and route handlers, which is enough for sends, acknowledgements and commands — the round
trip is a normal HTTP request, and the result comes back down the stream.

It stops being enough when the upstream rate is high or the latency budget is tight: cursor
positions in a collaborative editor, player input in a game, voice or video signalling. **Use
WebSockets** for those, or WebTransport where it is available.

## Request/response

If the client asks a question and waits for its answer, that is not a stream. Correlating replies
to requests over a broadcast channel means inventing request ids, timeouts and cancellation on
top of a pipe that promises none of them. **Use a normal route handler or a server action.**

## Binary or large payloads

The wire is UTF-8 text, framed line by line, and every payload here is JSON. Binary has to be
base64'd — a third bigger, and encoded and decoded on both ends — and a multi-megabyte Message
occupies the Connection while it is written, delaying everything behind it.

**Publish a reference, not the bytes**: an id or a URL, and let the client fetch the object over
HTTP where range requests, caching and resumption already work.

## Message history as a feature

The log this library keeps exists only to make reconnects gap-free. It is bounded on purpose — a
window (300 s by default) and a count cap — so it is not a record of anything: what falls outside
either bound is gone, and a client that asks for it gets a Reset rather than the old Messages.

**Use your database** for history, and let the page read it. That read is what the Snapshot wraps,
so the two fit together: the database is the truth, the stream keeps it current.

## Very high fan-out, or sub-10 ms latency

Every Instance reads the whole log and every Connection is an open response held in a Node
process. That is comfortable into the thousands of Connections per Instance and adds a few
milliseconds over the backend's own; it is not a design for hundreds of thousands of Connections
per process, or for a latency floor that a Redis Stream round trip plus a JSON encode does not
fit under.

**Use a dedicated messaging tier** — a broker with a purpose-built edge, or a managed realtime
service — when the numbers say so. Measure first: the ceiling is usually the App's, not the
pipe's.

## An environment that cannot hold connections open

Serverless functions cap response duration, some platforms buffer responses wholesale, and some
corporate proxies terminate long-lived connections whatever the headers say. SSE degrades there
into a reconnect loop that costs an invocation each time.

**Poll, or revalidate on an interval**, where you cannot keep a connection: a route that returns
what changed since a timestamp is unexciting and works everywhere. See the Vercel caveat in
[deployment.md](deployment.md) for what "works, at a cost" looks like on a platform with a
duration cap.

## Updates nobody is watching

If the data changes while the page is closed, the page will read it fresh on the next render
anyway. A Channel exists to move something that is on screen **now**. Publishing to Channels
nobody is subscribed to costs a log Entry per event and delivers nothing.

## When it does fit

- Something on screen must change without the reader doing anything.
- The server is the one that knows when.
- Payloads are small and JSON-shaped.
- The App already runs as a long-lived Node process.

That is most dashboards, notification bells, live lists, progress indicators, presence-lite
displays and collaborative views where writes go through normal actions.
