/** `/meetings/<id>` — addressable meeting deep-link inside the Production User UI. */
import { WebApp } from "../../../web/WebApp";

export default async function MeetingPage({
  params,
}: {
  params: Promise<{ meetingId: string }>;
}) {
  const { meetingId } = await params;
  return <WebApp initialMeetingId={decodeURIComponent(meetingId)} />;
}
