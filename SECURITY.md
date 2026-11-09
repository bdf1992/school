# Security policy

School is a fork of LearnHarness. It stores keys, sign-in tokens, chats, and learning records locally and can send permitted context to configured external services. Reports about this fork belong with the School maintainers.

## Reporting a vulnerability

Do not publish vulnerability details, credentials, private records, or an exploit in an issue or pull request.

Use [School's private vulnerability reporting](https://github.com/bdf1992/school/security/advisories/new) when it is available. If GitHub does not offer that form, open a minimal [School issue](https://github.com/bdf1992/school/issues) asking for a private reporting channel, without describing the vulnerability or attaching a reproduction. The maintainers can arrange a private handoff before receiving details.

A private report should identify the School commit or build, operating system, prerequisites, demonstrated impact, and a synthetic reproduction. Do not send School reports to upstream LearnHarness support unless the affected upstream code has been independently confirmed and an upstream report is appropriate.

## Supported scope

School is being remodeled from source. There is no School installer, signing, update, or response-time qualification implied by the inherited upstream release history. Use the current School source and check the [remodeling issue](https://github.com/bdf1992/school/issues/1) for current limitations.

The relevant code includes the desktop host, local API, participant and tool boundaries, rendered content, episode records, credential handling, and release/update configuration. Problems in a model provider's own service should also be reported to that provider. Reports should show a concrete impact; a scanner finding alone does not establish one.
