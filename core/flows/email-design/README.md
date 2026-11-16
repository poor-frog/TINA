# Tina meeting email

Authoring only: React Email produces the HTML shell and fragments shipped with the Python worker.
Node and React are not needed to send mail. The existing editable Markdown copy, SMTP adapter,
recipient links and Content-ID logo remain the runtime inputs.

```powershell
cd core/flows/email-design
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

Edit `meeting-followup.tsx`, then regenerate both files under `../src/flows_steps/templates/`.
`pnpm check` renders the same source and fails if either generated file has drifted. It also
checks Outlook button padding, safe layout primitives and size. `branding/tokens.json` supplies
the light palette; regenerate after changing those tokens.

The template follows the whitespace, sans typography and green accents of Framer's
[Convert](https://www.framer.com/marketplace/templates/convert/) as visual inspiration.
It contains no copied template code, animation, web fonts, tracking or external image requests.
The original logo PNG is attached by SMTP with `Content-ID: <tina-logo@tina>`; a production asset
host is unnecessary. `MeetingFollowup.PreviewProps` contains fictional meeting links for preview.

The export script passes opaque slot values through component props, then creates Python
`string.Template` placeholders in generated files. The worker validates artifact URLs and escapes
values before a single substitution pass. Editable mail paragraphs remain text, including line breaks.
