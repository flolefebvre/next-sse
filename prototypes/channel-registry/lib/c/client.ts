// PROTOTYPE, variant C. Client: `useChannel(instance, handlers)`; the instance comes from the shared channels.ts.
import { subscriptions, type AnyInstance, type Handlers } from '../channel.ts'

export function useChannel<I extends AnyInstance>(instance: I, handlers: Handlers<I>): void {
  subscriptions.push({ name: instance.name, events: Object.keys(handlers) })
}
