// PROTOTYPE. Lets a test script publish out-of-band while a page is rendering: GET /api/debug?room=general&n=1
import { publishFromElsewhere } from '@/app/actions'

export async function GET(request: Request) {
  const url = new URL(request.url)
  await publishFromElsewhere(url.searchParams.get('room') ?? 'general', Number(url.searchParams.get('n') ?? 1))
  return Response.json({ ok: true })
}
