import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../gate';

export const dynamic = 'force-dynamic';

async function forward(req: NextRequest, context: { params: Promise<{ meetingId: string }> }) {
  if (!await requireAdmin()) return new NextResponse(null, { status: 404 });
  const { meetingId } = await context.params;
  if (!/^\d+$/.test(meetingId)) return new NextResponse(null, { status: 404 });
  const base = (process.env.AGENT_API_URL || 'http://127.0.0.1:18100').replace(/\/$/, '');
  try {
    const response = await fetch(`${base}/api/admin/meeting-state/${meetingId}`, {
      method: req.method, headers: { 'X-Internal-Secret': process.env.TINA_INTERNAL_API_SECRET || '' },
      cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    return new NextResponse(await response.text(), { status: response.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ detail: 'Meeting-state diagnostics unavailable' }, { status: 502 });
  }
}
export const GET = forward;
export const POST = forward;
