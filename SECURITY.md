# Security policy

School inherits LearnHarness's storage of API keys, sign-in tokens, chats, and learning records on your machine. Its agent reads files and fetches web content on your behalf. If you find a way to abuse any of that, please tell us privately so a fix can ship before the details are public.

## Reporting a vulnerability

**Do not open a public issue, pull request, or Discord post for a security problem.**

Use School's [private vulnerability reporting](https://github.com/bdf1992/school/security/advisories/new) when available. If it is unavailable, open a School issue asking only for a private reporting channel, without vulnerability details, credentials, or private records.

School is maintained separately from LearnHarness. Fork-specific reports belong here; this fork does not speak for upstream maintainers.

A useful report includes:

- the School commit or version and your OS;
- what an attacker can do and what they need first (a web page the agent reads, a file the learner opens, network access, and so on);
- steps to reproduce, or a proof of concept;
- any fix or mitigation you have in mind.

## What to expect

School is an early downstream project. Response times and a release schedule have not been established; the upstream project's service targets are not promises from this fork. Arrange disclosure and attribution with the School maintainer through the private reporting channel.

## Supported versions

School has not yet qualified or published its own desktop release. Identify the exact source commit in a report. School's update configuration targets this repository; upstream LearnHarness releases do not update School.

## Scope

In scope:

- the desktop app (Electron shell, window, and IPC);
- the local API server, whether started by the desktop app or run from source;
- the agent and its tools, including prompt injection from web pages, PDFs, or other content that leads to reading, changing, or sending your data;
- rendered content such as demos, figures, and markdown;
- the update and release pipeline.

Out of scope:

- attacks that already require running code as your OS user;
- bugs in third-party model or service providers themselves (report those to the provider);
- automated scanner output without a demonstrated impact on School.

