// PROTOTYPE. Stand-ins for the App's own auth/data code: what Authorize reaches into.
const members: Record<string, string[]> = { '42': ['u7', 'u8'], '99': ['u8'] }

export async function getSession(request: Request): Promise<{ id: string }> {
  return { id: request.headers.get('x-user') ?? 'anonymous' }
}

export function isMember(userId: string, roomId: string): boolean {
  return members[roomId]?.includes(userId) ?? false
}
