import { NextRequest, NextResponse } from 'next/server';
import { resolveApiKey } from '../../proxyAuth';

export const dynamic = 'force-dynamic';
const GATEWAY_URL = (process.env.GATEWAY_URL || 'http://127.0.0.1:18056').replace(/\/$/, '');

export async function POST(req: NextRequest, context: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await context.params;
  if (!/^\d+$/.test(meetingId)) return NextResponse.json({ detail: 'Invalid meeting ID' }, { status: 422 });
  try {
    const key = await resolveApiKey();
    const upstream = await fetch(`${GATEWAY_URL}/agent/meeting-state-metrics/${meetingId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) },
      body: await req.text(), cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    return new NextResponse(await upstream.text(), { status: upstream.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ detail: 'Timing telemetry unavailable' }, { status: 502 });
  }
}
