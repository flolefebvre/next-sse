'use client'
// PROTOTYPE UI: levers against the fake Transport + the core's trace, so every situation the ADRs describe can be
// provoked from the page: out-of-band Publish, Kick, dropped Connection (native reconnect), Reset, watchdog.
import { useParams } from 'next/navigation'
import { useState, useTransition } from 'react'
import { dropAndEvict, dropAndPublish, dropConnections, kickMe, kickRoom, publishFromElsewhere, restartServer, stats } from './actions'
import { useCoreTrace } from './sse.client'

export function DebugPanel() {
  const { roomId = 'general' } = useParams<{ roomId?: string }>()
  const core = useCoreTrace()
  const [server, setServer] = useState<string>('')
  const [, start] = useTransition()
  const run = (fn: () => Promise<unknown>) => () => start(async () => { await fn(); setServer(JSON.stringify(await stats(), null, 1)) })
  return (
    <aside className="debug">
      <h4>Transport levers</h4>
      <div className="levers">
        <button onClick={run(() => publishFromElsewhere(roomId))}>Publish out-of-band</button>
        <button onClick={run(() => publishFromElsewhere(roomId, 50))}>Publish 50 (overflow log)</button>
        <button onClick={run(kickMe)}>Kick me</button>
        <button onClick={run(() => kickRoom(roomId))}>Kick room</button>
        <button onClick={run(dropConnections)}>Drop Connections</button>
        <button onClick={run(() => dropAndPublish(roomId))}>Drop + publish 3 while away</button>
        <button onClick={run(() => dropAndEvict(roomId))}>Drop + publish 2 + evict (→ reset)</button>
        <button onClick={run(restartServer)}>Restart server (new epoch → reset)</button>
      </div>
      <h4>Core</h4>
      <pre>lastEventId={core.lastEventId} phase={core.phase} channels=[{core.channels.join(',')}] attempt={core.attempt}</pre>
      <div className="trace">
        {core.events.slice(0, 12).map((e, i) => (
          <div key={i}>{new Date(e.at).toLocaleTimeString()} {e.line}</div>
        ))}
      </div>
      {server && (<><h4>Server</h4><pre>{server}</pre></>)}
    </aside>
  )
}
