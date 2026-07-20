# Create an Xray API key

Xray authenticates with a **client id / client secret** pair, not your Jira password.

1. In Jira, open **Xray → API Keys** (Global Settings).
2. Create a key. Xray shows a **Client ID** and a **Client Secret**.
3. Copy both — the secret is shown once.

These credentials are used only to obtain a short-lived token; Specwright never persists the token and never writes the secret to settings or the repo.
