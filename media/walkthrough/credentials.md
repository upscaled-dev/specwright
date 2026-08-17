# Save and test the connection

In Jira, open **Xray → API Keys**, create a key, then paste its **Client ID** and **Client Secret** into the setup form.

Choose **Save & Test Connection** to store the form as one setup and immediately probe the selected region. **Save** stores the same form and runs a smaller authentication check. Xray and optional Jira credentials are stored in the operating system's secret store, keyed by site, never in `settings.json` and never in git.
