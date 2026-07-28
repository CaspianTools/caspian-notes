# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately, not via public issues.

1. **Preferred:** use [GitHub Private Vulnerability Reporting](https://github.com/CaspianTools/caspian-notes/security/advisories/new).
2. **Email fallback:** `fuad.jalilov@gmail.com` with subject prefix `[caspian-notes security]`.

Please include:

- Extension version (see Extensions view in VS Code).
- Reproducer or proof-of-concept.
- Impact assessment (what could an attacker accomplish?).
- Whether the issue has been publicly disclosed anywhere.

## Response commitments

- **Acknowledge:** within 72 hours.
- **Triage / confirm:** within 7 days.
- **Patch target:** critical / high severity in ≤14 days; medium / low in the next minor release.

## Scope

**In scope**
- Webview escaping / CSP bypasses.
- Command injection via `chatCommand` setting.
- Filesystem issues in `NoteStore` (path traversal via crafted frontmatter, etc.).
- Information leakage from note storage.

**Out of scope**
- Vulnerabilities in VS Code itself (report to Microsoft).
- Vulnerabilities in chat extensions invoked via `chatCommand` (report to their maintainers).
- Issues that require compromising the user's local account before exploitation.

## Coordinated disclosure

We prefer coordinated disclosure — please allow a reasonable window (typically the patch SLA above) before publishing technical details. CVE assignment is available via GitHub advisories for qualifying issues.
