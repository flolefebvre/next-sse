// PROTOTYPE. Who is this? A `name` cookie; `guest` without one.
import { cookies } from 'next/headers'

export function userFromRequest(request: Request): string {
  const match = /(?:^|;\s*)name=([^;]+)/.exec(request.headers.get('cookie') ?? '')
  return match ? decodeURIComponent(match[1]!) : 'guest'
}

export async function currentUser(): Promise<string> {
  return (await cookies()).get('name')?.value ?? 'guest'
}
