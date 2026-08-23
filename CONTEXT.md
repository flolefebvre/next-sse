# next-sse

Live server-to-client updates for Next.js apps over Server-Sent Events, working identically on one Instance and on many Instances behind a load balancer.

## Language

**App**:
One Next.js application using the library. Several Apps may share one Redis/Valkey; the App's Prefix keeps them apart.
_Avoid_: Project, site, tenant

**Instance**:
One running server process of an App. A multi-instance deployment is several Instances of the same App behind a load balancer.
_Avoid_: Node, replica, pod, server

**Channel**:
A named stream of Messages that Connections subscribe to and server code publishes to. A plain string; per-user or per-entity channels are naming conventions, not separate concepts.
_Avoid_: Topic, room, stream, feed

**Message**:
One unit published to a Channel: an event name and a typed payload.
_Avoid_: Event (reserved for the SSE wire field), notification, update

**Publish**:
Sending a Message to a Channel from server code, in any Instance or in a process outside Next.js.
_Avoid_: Send, emit, broadcast, push

**Connection**:
One open SSE connection from a client to an Instance, carrying the set of Channels that client is subscribed to. One client holds one Connection.
_Avoid_: Socket, stream, session, subscriber

**Transport**:
The pluggable backend that carries Messages between Instances. The library ships a Memory Transport (single Instance) and a Redis Transport (Redis and Valkey); anyone can write another.
_Avoid_: Adapter, driver, backend, broker

**Authorize**:
The App-supplied decision whether a Connection may subscribe to a given Channel, taken when the Connection is opened (and again on every reconnect).
_Avoid_: Auth, guard, permission check

**Prefix**:
The per-App namespace applied to everything the Redis Transport writes or subscribes to, so several Apps can share one Redis/Valkey.
_Avoid_: Namespace, key prefix, scope
