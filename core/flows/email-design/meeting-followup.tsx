import * as React from "react";
import {
  Body, Button, Column, Container, Head, Heading, Hr, Html, Img,
  Preview, Row, Section, Text,
} from "react-email";
import { readFileSync } from "node:fs";

// Share the product's light palette; no web fonts or external assets in the email.
const { light: colors } = JSON.parse(
  readFileSync(new URL("../../../branding/tokens.json", import.meta.url), "utf8"),
).theme;
const font = "Arial, Helvetica, sans-serif";
const copy = { color: colors.muted, fontSize: "15px", lineHeight: "25px", margin: "0 0 20px" };

export function Paragraph({ children }: { children: React.ReactNode }) {
  return <Text style={copy}>{children}</Text>;
}

export function SampleNotice({ children }: { children: React.ReactNode }) {
  return <Text style={{ ...copy, fontSize: "12px", lineHeight: "19px", margin: "0 0 24px" }}>{children}</Text>;
}

export function ArtifactButton({ href, recording = false }: { href: string; recording?: boolean }) {
  return (
    <Section style={{ marginBottom: "12px" }}>
      <Button href={href} className="box-border" style={{
        boxSizing: "border-box", display: "block", textAlign: "center",
        backgroundColor: recording ? colors.surface : colors.brand,
        color: recording ? colors.brand : colors["on-brand"],
        border: `1px solid ${recording ? colors.line : colors.brand}`,
        borderRadius: "8px", padding: "16px 20px", fontSize: "15px", fontWeight: 600,
        lineHeight: "20px", textDecoration: "none",
      }}>
        {recording ? "Xem bản ghi" : "Xem tóm tắt"}
      </Button>
    </Section>
  );
}

interface MeetingFollowupProps {
  subject: string;
  meeting: string;
  logo: string;
  notice?: React.ReactNode;
  children: React.ReactNode;
}

export default function MeetingFollowup({ subject, meeting, logo, notice, children }: MeetingFollowupProps) {
  return (
    <Html lang="vi" dir="ltr">
      <Head><title>{subject}</title><meta name="viewport" content="width=device-width, initial-scale=1" /></Head>
      <Body lang="vi" dir="ltr" style={{ margin: "0", padding: "0", backgroundColor: colors.canvas, fontFamily: font }}>
        <Preview useTitleTag={false}>Cảm ơn bạn đã sử dụng Tina. Xem tóm tắt và bản ghi cuộc họp.</Preview>
        <div lang="vi" dir="ltr" style={{ padding: "32px 12px" }}>
          <Container style={{ maxWidth: "560px", margin: "0 auto" }}>
            {notice}
            <Section style={{ backgroundColor: colors.surface, border: `1px solid ${colors.line}`, borderRadius: "12px" }}>
              <Row><Column style={{ padding: "28px 24px 0" }}>
                <table role="presentation" cellPadding="0" cellSpacing="0" border={0}>
                  <tbody><tr>
                    <td style={{ width: "38px" }}><Img src={logo} width={30} height={32} alt="Logo Tina" /></td>
                    <td style={{ fontSize: "23px", lineHeight: "30px", fontWeight: 700, letterSpacing: "-0.6px", color: colors.ink }}>Tina</td>
                  </tr></tbody>
                </table>
                <Hr style={{ border: "none", borderTop: `1px solid ${colors.line}`, margin: "24px 0 28px" }} />
                <Heading as="h1" style={{ margin: "0 0 12px", fontSize: "28px", lineHeight: "36px", letterSpacing: "-0.7px", fontWeight: 600, color: colors.ink }}>
                  Tóm tắt cuộc họp
                </Heading>
                <Text style={{ margin: "0 0 28px", fontSize: "17px", lineHeight: "26px", color: colors.brand, overflowWrap: "anywhere" }}>{meeting}</Text>
              </Column></Row>
              <Row><Column style={{ padding: "0 24px 12px" }}>{children}</Column></Row>
            </Section>
            <Text style={{ margin: "18px 0 0", textAlign: "center", color: colors.muted, fontSize: "12px", lineHeight: "20px" }}>Email thông báo từ Tina.</Text>
          </Container>
        </div>
      </Body>
    </Html>
  );
}

MeetingFollowup.PreviewProps = {
  subject: "Tina — Tóm tắt và bản ghi cuộc họp",
  meeting: "Kế hoạch sản phẩm tuần tới",
  logo: "cid:tina-logo@tina",
  children: <>
    <Paragraph>Cảm ơn bạn đã sử dụng Tina.</Paragraph>
    <ArtifactButton href="https://tina.example/meetings/41#meeting-summary-41" />
    <ArtifactButton href="https://tina.example/meetings/41#meeting-recording-41" recording />
    <Paragraph>Đăng nhập Tina bằng email nhận thư này để xem nội dung.</Paragraph>
  </>,
} satisfies MeetingFollowupProps;
