import * as React from "react";
import {
  Body, Button, Column, Container, Head, Heading, Hr, Html, Img, Link,
  Preview, Row, Section, Text,
} from "react-email";
import { readFileSync } from "node:fs";

// Share the product's light palette; no web fonts, gradients, shadows, or external assets.
const tokens = JSON.parse(
  readFileSync(new URL("../../../branding/tokens.json", import.meta.url), "utf8"),
);
const colors = tokens.theme.light;
const dark = tokens.theme.dark;
const teal = tokens.primitive.teal;
const font = "Arial, Helvetica, sans-serif";
const copy = { color: colors.muted, fontSize: "14px", lineHeight: "23px", margin: "0 0 14px" };

export function Paragraph({ children }: { children: React.ReactNode }) {
  return <Text style={copy}>{children}</Text>;
}

export function SampleNotice({ children }: { children: React.ReactNode }) {
  return (
    <Text style={{ color: colors.muted, fontSize: "12px", lineHeight: "19px", margin: "0 0 18px", textAlign: "center" }}>
      {children}
    </Text>
  );
}

export function OrganizerMeta({ name, email }: { name: string; email: string }) {
  return (
    <Section style={{ margin: "12px 0 0", textAlign: "center" }}>
      <Text style={{ margin: "0", fontSize: "13px", lineHeight: "20px", color: colors.muted }}>
        Người tạo:{" "}
        <strong style={{ color: colors.ink, fontWeight: 700 }}>{name}</strong>
      </Text>
      <Text style={{ margin: "2px 0 0", fontSize: "12px", lineHeight: "18px", color: colors.muted }}>
        {email}
      </Text>
    </Section>
  );
}

export function OrganizerEmailOnly({ email }: { email: string }) {
  return (
    <Section style={{ margin: "12px 0 0", textAlign: "center" }}>
      <Text style={{ margin: "0", fontSize: "13px", lineHeight: "20px", color: colors.muted }}>
        Người tạo:{" "}
        <strong style={{ color: colors.ink, fontWeight: 700 }}>{email}</strong>
      </Text>
    </Section>
  );
}

export function MeetingTime({ children }: { children: React.ReactNode }) {
  return (
    <Text style={{ margin: "3px 0 0", fontSize: "13px", lineHeight: "19px", color: colors.muted }}>
      {children}
    </Text>
  );
}

export function StatCardPair({ leftText, rightText }: { leftText: string; rightText: string }) {
  return (
    <table role="presentation" width="100%" cellPadding="0" cellSpacing="0" border={0} style={{ marginBottom: "20px" }}>
      <tbody>
        <tr>
          <td width="48%" valign="middle" style={{
            backgroundColor: colors["draft-bg"], border: "1px solid #E5D4A3",
            borderRadius: "10px", padding: "14px 12px", textAlign: "center",
          }}>
            <Text style={{ margin: "0", fontSize: "13px", lineHeight: "19px", fontWeight: 600, color: colors.draft }}>
              {leftText}
            </Text>
          </td>
          <td width="4%" style={{ fontSize: "1px", lineHeight: "1px" }}>&nbsp;</td>
          <td width="48%" valign="middle" style={{
            backgroundColor: colors.subtle, border: `1px solid ${colors.line}`,
            borderRadius: "10px", padding: "14px 12px", textAlign: "center",
          }}>
            <Text style={{ margin: "0", fontSize: "13px", lineHeight: "19px", fontWeight: 600, color: colors.brand }}>
              {rightText}
            </Text>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export function StatCardSingle({ text }: { text: string }) {
  return (
    <table role="presentation" width="100%" cellPadding="0" cellSpacing="0" border={0} style={{ marginBottom: "20px" }}>
      <tbody>
        <tr>
          <td align="center">
            <table role="presentation" cellPadding="0" cellSpacing="0" border={0}>
              <tbody>
                <tr>
                  <td style={{
                    backgroundColor: colors.subtle, border: `1px solid ${colors.line}`,
                    borderRadius: "10px", padding: "13px 22px", textAlign: "center",
                  }}>
                    <Text style={{ margin: "0", fontSize: "13px", lineHeight: "19px", fontWeight: 600, color: colors.brand }}>
                      {text}
                    </Text>
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export function TopicChip({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-block", backgroundColor: colors.canvas,
      border: `1px solid ${colors.line}`, borderRadius: "16px",
      padding: "5px 12px", margin: "3px 4px", fontSize: "12px",
      lineHeight: "18px", fontWeight: 500, color: colors.ink,
    }}>
      {children}
    </span>
  );
}

export function TopicsBlock({ chips }: { chips: React.ReactNode }) {
  return (
    <Section style={{ marginBottom: "18px", textAlign: "center" }}>
      <Text style={{
        margin: "0 0 10px", fontSize: "11px", lineHeight: "16px",
        fontWeight: 700, letterSpacing: "0.8px", color: colors.muted,
        textTransform: "uppercase",
      }}>
        Chủ đề thảo luận trong cuộc họp
      </Text>
      <div style={{ textAlign: "center", lineHeight: "30px" }}>{chips}</div>
    </Section>
  );
}

export function InsightsSection({
  stats, topics, moreUrl,
}: { stats: React.ReactNode; topics: React.ReactNode; moreUrl: string }) {
  return (
    <Section>
      <Hr style={{ border: "none", borderTop: `1px solid ${colors.line}`, margin: "24px 0" }} />
      <Text style={{
        margin: "0 0 16px", fontSize: "15px", lineHeight: "22px",
        fontWeight: 700, color: colors.ink, textAlign: "center",
      }}>
        Trong cuộc họp này
      </Text>
      {stats}
      {topics}
      <table role="presentation" width="100%" cellPadding="0" cellSpacing="0" border={0}>
        <tbody>
          <tr>
            <td align="center">
              <Button href={moreUrl} className="box-border" style={{
                boxSizing: "border-box", display: "inline-block", textAlign: "center",
                backgroundColor: colors.subtle, color: colors.brand,
                border: `1px solid ${colors.line}`, borderRadius: "8px",
                padding: "11px 26px", fontSize: "13px", fontWeight: 600,
                lineHeight: "18px", textDecoration: "none",
              }}>
                Xem thêm phân tích cuộc họp
              </Button>
            </td>
          </tr>
        </tbody>
      </table>
    </Section>
  );
}

export function OverviewItemTitled({ title, text }: { title: string; text: string }) {
  return (
    <li style={{ margin: "0 0 10px", fontSize: "14px", lineHeight: "22px", color: colors.ink }}>
      <strong style={{ fontWeight: 700, color: colors.ink }}>{`${title}:`}</strong>{" "}
      <span style={{ color: colors.muted }}>{text}</span>
    </li>
  );
}

export function OverviewItemPlain({ text }: { text: string }) {
  return (
    <li style={{ margin: "0 0 10px", fontSize: "14px", lineHeight: "22px", color: colors.muted }}>
      {text}
    </li>
  );
}

export function ActionItemsBlock({ items }: { items: React.ReactNode }) {
  return (
    <Section style={{
      margin: "16px 0 0", padding: "14px 16px",
      backgroundColor: colors.canvas, border: `1px solid ${colors.line}`,
      borderRadius: "10px",
    }}>
      <Text style={{
        margin: "0 0 8px", fontSize: "12px", lineHeight: "18px",
        fontWeight: 700, letterSpacing: "0.5px", color: colors.brand,
        textTransform: "uppercase",
      }}>
        Việc cần làm
      </Text>
      <ul style={{ margin: "0", paddingLeft: "18px", color: colors.ink }}>
        {items}
      </ul>
    </Section>
  );
}

export function OverviewSection({
  items, actions, notesUrl,
}: { items: React.ReactNode; actions: React.ReactNode; notesUrl: string }) {
  return (
    <Section>
      <Hr style={{ border: "none", borderTop: `1px solid ${colors.line}`, margin: "24px 0" }} />
      <Heading as="h2" style={{
        margin: "0 0 14px", fontSize: "16px", lineHeight: "24px",
        fontWeight: 700, color: colors.ink,
      }}>
        Tổng quan cuộc họp
      </Heading>
      <ul style={{ margin: "0", paddingLeft: "18px", color: colors.ink }}>
        {items}
      </ul>
      {actions}
      <table role="presentation" width="100%" cellPadding="0" cellSpacing="0" border={0} style={{ marginTop: "22px" }}>
        <tbody>
          <tr>
            <td align="center">
              <Button href={notesUrl} className="box-border" style={{
                boxSizing: "border-box", display: "inline-block", textAlign: "center",
                backgroundColor: colors.brand, color: colors["on-brand"],
                border: `1px solid ${colors.brand}`, borderRadius: "8px",
                padding: "13px 26px", fontSize: "14px", fontWeight: 600,
                lineHeight: "20px", textDecoration: "none",
              }}>
                Xem toàn bộ ghi chú cuộc họp
              </Button>
            </td>
          </tr>
        </tbody>
      </table>
    </Section>
  );
}

export function ArtifactButton({ href, recording = false }: { href: string; recording?: boolean }) {
  return (
    <Section style={{ marginBottom: "12px" }}>
      <Button href={href} className="box-border" style={{
        boxSizing: "border-box", display: "block", textAlign: "center",
        backgroundColor: recording ? colors.surface : colors.brand,
        color: recording ? colors.brand : colors["on-brand"],
        border: `1px solid ${recording ? colors.line : colors.brand}`,
        borderRadius: "8px", padding: "14px 18px", fontSize: "14px", fontWeight: 600,
        lineHeight: "20px", textDecoration: "none",
      }}>
        {recording ? "Xem bản ghi" : "Xem tóm tắt"}
      </Button>
    </Section>
  );
}

interface MeetingFollowupProps {
  subject: string;
  preheader: string;
  meeting: string;
  logo: string;
  calendarDay: string;
  summaryUrl: string;
  recordingUrl: string;
  appUrl: string;
  settingsUrl: string;
  notice?: React.ReactNode;
  organizerBlock?: React.ReactNode;
  meetingTimeBlock?: React.ReactNode;
  insightsSection?: React.ReactNode;
  overviewSection?: React.ReactNode;
  children?: React.ReactNode;
}

export default function MeetingFollowup({
  subject, preheader, meeting, logo, calendarDay,
  summaryUrl, recordingUrl, appUrl, settingsUrl,
  notice, organizerBlock, meetingTimeBlock,
  insightsSection, overviewSection, children,
}: MeetingFollowupProps) {
  return (
    <Html lang="vi" dir="ltr">
      <Head>
        <title>{subject}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <Body lang="vi" dir="ltr" style={{ margin: "0", padding: "0", backgroundColor: colors.canvas, fontFamily: font }}>
        <Preview useTitleTag={false}>{preheader}</Preview>
        <div lang="vi" dir="ltr" style={{ padding: "28px 12px 36px" }}>
          <Container style={{ maxWidth: "580px", margin: "0 auto" }}>
            {notice}
            <Section style={{
              backgroundColor: colors.surface,
              border: `1px solid ${colors.line}`,
              borderRadius: "14px",
            }}>
              <Row>
                <Column style={{ padding: "32px 28px 28px" }}>
                  {/* Hero circular Tina mark + 2-line headline + organizer */}
                  <table role="presentation" width="100%" cellPadding="0" cellSpacing="0" border={0}>
                    <tbody>
                      <tr>
                        <td align="center" style={{ paddingBottom: "16px" }}>
                          <table role="presentation" cellPadding="0" cellSpacing="0" border={0}>
                            <tbody>
                              <tr>
                                <td align="center" valign="middle" width="68" height="68" style={{
                                  width: "68px", height: "68px", borderRadius: "34px",
                                  backgroundColor: colors.subtle, border: `1px solid ${colors.line}`,
                                  textAlign: "center",
                                }}>
                                  <Img src={logo} width={32} height={34} alt="Logo Tina" style={{ margin: "0 auto", display: "block" }} />
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  <Heading as="h1" style={{
                    margin: "0", fontSize: "24px", lineHeight: "32px",
                    letterSpacing: "-0.4px", fontWeight: 700, color: colors.ink,
                    textAlign: "center",
                  }}>
                    Bản tóm tắt cuộc họp
                    <br />
                    <span style={{ color: colors.brand }}>đã sẵn sàng</span>
                  </Heading>

                  {organizerBlock}

                  {/* Meeting Info Card */}
                  <table role="presentation" width="100%" cellPadding="0" cellSpacing="0" border={0} style={{
                    marginTop: "22px", backgroundColor: colors.surface,
                    border: `1px solid ${colors.line}`, borderRadius: "10px",
                  }}>
                    <tbody>
                      <tr>
                        <td style={{ padding: "14px 16px" }}>
                          <table role="presentation" width="100%" cellPadding="0" cellSpacing="0" border={0}>
                            <tbody>
                              <tr>
                                <td width="44" valign="top" style={{ paddingRight: "12px" }}>
                                  <table role="presentation" width="38" cellPadding="0" cellSpacing="0" border={0} style={{
                                    width: "38px", border: `1px solid ${colors.line}`,
                                    borderRadius: "8px", backgroundColor: colors.surface,
                                  }}>
                                    <tbody>
                                      <tr>
                                        <td height="10" style={{
                                          height: "10px", backgroundColor: colors.brand,
                                          borderRadius: "7px 7px 0 0", fontSize: "1px", lineHeight: "1px",
                                        }}>
                                          &nbsp;
                                        </td>
                                      </tr>
                                      <tr>
                                        <td align="center" valign="middle" height="26" style={{
                                          height: "26px", fontSize: "13px", lineHeight: "26px",
                                          fontWeight: 700, color: colors.ink, textAlign: "center",
                                        }}>
                                          {calendarDay}
                                        </td>
                                      </tr>
                                    </tbody>
                                  </table>
                                </td>
                                <td valign="middle">
                                  <Text style={{
                                    margin: "0", fontSize: "15px", lineHeight: "22px",
                                    fontWeight: 700, color: colors.ink, overflowWrap: "anywhere",
                                  }}>
                                    {meeting}
                                  </Text>
                                  {meetingTimeBlock}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  {/* Dual Side-by-Side CTA Buttons */}
                  <table role="presentation" width="100%" cellPadding="0" cellSpacing="0" border={0} style={{ marginTop: "14px" }}>
                    <tbody>
                      <tr>
                        <td width="49%" valign="top">
                          <Button href={summaryUrl} className="box-border" style={{
                            boxSizing: "border-box", display: "block", textAlign: "center",
                            backgroundColor: colors.brand, color: colors["on-brand"],
                            border: `1px solid ${colors.brand}`, borderRadius: "8px",
                            padding: "13px 12px", fontSize: "14px", fontWeight: 600,
                            lineHeight: "20px", textDecoration: "none",
                          }}>
                            Xem tóm tắt cuộc họp
                          </Button>
                        </td>
                        <td width="2%" style={{ fontSize: "1px", lineHeight: "1px" }}>&nbsp;</td>
                        <td width="49%" valign="top">
                          <Button href={recordingUrl} className="box-border" style={{
                            boxSizing: "border-box", display: "block", textAlign: "center",
                            backgroundColor: colors.subtle, color: colors.brand,
                            border: `1px solid ${colors.line}`, borderRadius: "8px",
                            padding: "13px 12px", fontSize: "14px", fontWeight: 600,
                            lineHeight: "20px", textDecoration: "none",
                          }}>
                            Xem bản ghi cuộc họp
                          </Button>
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  {/* Dynamic Insights, Overview & Fallback Copy */}
                  {insightsSection}
                  {overviewSection}
                  {children}
                </Column>
              </Row>

              {/* Dark Tina Feature Banner (email-safe solid teal-ink surface) */}
              <Row>
                <Column style={{ padding: "0 20px 24px" }}>
                  <table role="presentation" width="100%" cellPadding="0" cellSpacing="0" border={0} style={{
                    backgroundColor: colors.ink, borderRadius: "12px",
                  }}>
                    <tbody>
                      <tr>
                        <td style={{ padding: "26px 24px", textAlign: "center" }}>
                          <Text style={{
                            margin: "0 0 8px", fontSize: "20px", lineHeight: "28px",
                            fontWeight: 700, color: colors["on-brand"], textAlign: "center",
                          }}>
                            Hỏi Tina ngay sau cuộc họp
                          </Text>
                          <Text style={{
                            margin: "0 0 18px", fontSize: "13px", lineHeight: "20px",
                            color: teal["100"], textAlign: "center",
                          }}>
                            Tra cứu nhanh quyết định, việc cần làm theo đúng bản chép lời gốc hoặc dùng tiện ích Tina trên trình duyệt.
                          </Text>
                          <table role="presentation" cellPadding="0" cellSpacing="0" border={0} align="center" style={{ margin: "0 auto 18px" }}>
                            <tbody>
                              <tr>
                                <td align="center">
                                  <Button href={summaryUrl} className="box-border" style={{
                                    boxSizing: "border-box", display: "inline-block", textAlign: "center",
                                    backgroundColor: colors.surface, color: colors.ink,
                                    border: `1px solid ${colors.surface}`, borderRadius: "8px",
                                    padding: "11px 22px", fontSize: "13px", fontWeight: 700,
                                    lineHeight: "18px", textDecoration: "none",
                                  }}>
                                    Mở Ask Tina →
                                  </Button>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                          <table role="presentation" width="100%" cellPadding="0" cellSpacing="0" border={0} style={{
                            backgroundColor: dark.surface, border: `1px solid ${dark.line}`,
                            borderRadius: "10px",
                          }}>
                            <tbody>
                              <tr>
                                <td style={{ padding: "12px 14px", textAlign: "left" }}>
                                  <Text style={{
                                    margin: "0 0 4px", fontSize: "13px", lineHeight: "20px",
                                    color: dark.ink,
                                  }}>
                                    <span style={{
                                      backgroundColor: dark.subtle, color: dark.brand,
                                      padding: "2px 6px", borderRadius: "4px", fontWeight: 700,
                                    }}>@Tina</span>{" "}
                                    tóm tắt các đầu việc ưu tiên và hạn hoàn thành của cuộc họp này giúp mình!
                                  </Text>
                                  <Text style={{
                                    margin: "0", fontSize: "11px", lineHeight: "16px",
                                    color: dark.muted,
                                  }}>
                                    Trả lời có trích dẫn đối chiếu trực tiếp từ bản chép lời gốc.
                                  </Text>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </Column>
              </Row>

              {/* Brand Footer inside card */}
              <Row>
                <Column style={{ padding: "4px 28px 28px", textAlign: "center" }}>
                  <table role="presentation" cellPadding="0" cellSpacing="0" border={0} align="center" style={{ margin: "0 auto 14px" }}>
                    <tbody>
                      <tr>
                        <td style={{ paddingRight: "8px" }} valign="middle">
                          <Img src={logo} width={22} height={24} alt="Logo Tina" style={{ display: "block" }} />
                        </td>
                        <td valign="middle" style={{
                          fontSize: "17px", lineHeight: "22px", fontWeight: 700,
                          letterSpacing: "-0.4px", color: colors.ink,
                        }}>
                          Tina
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  <table role="presentation" width="100%" cellPadding="0" cellSpacing="0" border={0} style={{
                    backgroundColor: colors["accepted-bg"], borderRadius: "6px", marginBottom: "16px",
                  }}>
                    <tbody>
                      <tr>
                        <td style={{
                          padding: "9px 12px", textAlign: "center", fontSize: "11px",
                          lineHeight: "16px", fontWeight: 700, letterSpacing: "0.4px",
                          color: colors.accepted, textTransform: "uppercase",
                        }}>
                          Riêng tư trong workspace Tina · Chỉ người được cấp quyền mới xem được
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  <Text style={{ margin: "0 0 10px", fontSize: "12px", lineHeight: "19px", color: colors.muted, textAlign: "center" }}>
                    <strong style={{ color: colors.ink }}>Tina</strong> là trợ lý AI cho cuộc họp của bạn — ghi chép, tóm tắt, trích xuất việc cần làm và lưu giữ tri thức nhóm.
                  </Text>
                  <Text style={{ margin: "0", fontSize: "12px", lineHeight: "19px", color: colors.muted, textAlign: "center" }}>
                    <Link href={appUrl} style={{ color: colors.brand, textDecoration: "underline" }}>Mở Tina</Link>
                    {"  ·  "}
                    <Link href={settingsUrl} style={{ color: colors.brand, textDecoration: "underline" }}>Cài đặt thông báo email</Link>
                  </Text>
                </Column>
              </Row>
            </Section>
          </Container>
        </div>
      </Body>
    </Html>
  );
}

MeetingFollowup.PreviewProps = {
  subject: "Tina — Tóm tắt và bản ghi: Test email Tina",
  preheader: "Bản tóm tắt cuộc họp Test email Tina đã sẵn sàng.",
  meeting: "Test email Tina",
  logo: "cid:tina-logo@tina",
  calendarDay: "28",
  summaryUrl: "https://tina.example/meetings/41#meeting-summary-41",
  recordingUrl: "https://tina.example/meetings/41#meeting-recording-41",
  appUrl: "https://tina.example",
  settingsUrl: "https://tina.example/?nav=settings&settingsSection=account",
  organizerBlock: <OrganizerMeta name="Quang Thanh" email="lethanhquang094@gmail.com" />,
  meetingTimeBlock: <MeetingTime>28 Thg 11 lúc 17:45 ICT</MeetingTime>,
  insightsSection: (
    <InsightsSection
      stats={<StatCardPair leftText="11 câu hỏi được đặt ra" rightText="3 việc cần làm được ghi nhận" />}
      topics={
        <TopicsBlock
          chips={
            <>
              <TopicChip>Token</TopicChip>
              <TopicChip>Mô hình bịa thông tin</TopicChip>
              <TopicChip>Prompt Injection</TopicChip>
              <TopicChip>+3 chủ đề khác</TopicChip>
            </>
          }
        />
      }
      moreUrl="https://tina.example/meetings/41#meeting-summary-41"
    />
  ),
  overviewSection: (
    <OverviewSection
      items={
        <>
          <OverviewItemTitled title="Vấn đề kỹ thuật" text="Thảo luận token, mô hình bịa thông tin và giới hạn ngữ cảnh." />
          <OverviewItemTitled title="An toàn hệ thống" text="Đề cập Prompt Injection và chặn tác vụ nguy hiểm." />
        </>
      }
      actions={
        <ActionItemsBlock
          items={<OverviewItemPlain text="Kiểm tra giới hạn token cho 10.000 người dùng trước thứ Sáu." />}
        />
      }
      notesUrl="https://tina.example/meetings/41#meeting-summary-41"
    />
  ),
} satisfies MeetingFollowupProps;
