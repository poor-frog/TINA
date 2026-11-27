# api/extension/download

Serves the pinned unpacked `meettina-extension.zip` archive built into the Terminal image during
Docker build (or `../extension/release/meettina-extension.zip` in local dev), or redirects with
`302` to `MEETTINA_EXTENSION_STORE_URL` once the Chrome Web Store listing is live.
