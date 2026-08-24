# Patterns

Ten recipes. Each page stands alone — its snippets are complete — and each links the file in the
example app that implements it, which the e2e suite drives on every push.

| Pattern                                                            | Use it when                                                     |
| ------------------------------------------------------------------ | --------------------------------------------------------------- |
| [Per-user notifications](per-user-notifications.md)                | one reader is the audience                                      |
| [Per-entity updates](per-entity-updates.md)                        | a room, an order, a document — a Channel per thing              |
| [Broadcast](broadcast.md)                                          | everybody sees the same thing                                   |
| [Server component + live takeover](server-component-live-takeover.md) | server-rendered data has to keep moving                      |
| [Optimistic sends](optimistic-sends.md)                            | the sender is the page, and it should not wait                  |
| [Publishing from a worker](publish-from-a-worker.md)               | the publisher is not a request                                  |
| [Kick](kick.md)                                                    | access changed and the open stream must not outlive it          |
| [Reset override](reset-override.md)                                | a full route refresh is too much for a gap                      |
| [Testing your app](testing-your-app.md)                            | a live component needs a test                                   |
| [Custom transport](custom-transport.md)                            | the log is not Redis                                            |

The example app itself:
[`examples/basic`](https://github.com/flolefebvre/next-sse/tree/main/examples/basic).
