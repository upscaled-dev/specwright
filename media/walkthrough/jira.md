# Add Jira access (optional)

Xray-only credentials can read tests but can't enumerate the projects you have access to. Adding a **Jira email + API token** unlocks:

- a **project view** that lists the projects you can actually see, each annotated with its Xray test total;
- optional **issue attachments** when publishing results.

This is optional. Without it, Specwright still probes tag-derived projects, but with honest "can't verify" wording. The Jira token is stored in the secret store alongside your Xray credentials.
