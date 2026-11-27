# api/extension

Browser-extension distribution routes and runtime Chrome Web Store configuration for the
MeetTINA Chrome extension. Reads `MEETTINA_EXTENSION_STORE_URL` at request time so staging and
production can switch from the bundled unpacked ZIP to the Chrome Web Store listing without
rebuilding the Terminal image.
